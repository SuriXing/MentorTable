/**
 * Shared security middleware helpers for API handlers.
 *
 * BACKGROUND: before 2026-04, Round 1 added CORS allowlist + 256kb body
 * limit + ALLOWED_ORIGINS support in server.js as Express middleware. But
 * vercel.json routes /api/* directly to api/*.js files, bypassing server.js
 * entirely — so in production NONE of that middleware ran. Round 2 R2A
 * caught this "files vs execution" audit gap. This module centralizes the
 * security posture so both server.js (dev) and api/*.js handlers (prod)
 * apply the same checks.
 *
 * Design notes:
 * - No Express dependency — pure Node http req/res style so it works on
 *   Vercel Functions runtime and Express wrappers alike.
 * - Body size check uses Content-Length header as a cheap pre-check, then
 *   the handler's own body parser can double-check against the buffered
 *   string.
 * - Rate limiting is BEST-EFFORT in-memory per warm instance. Vercel
 *   serverless has no shared state across cold starts or instances, so this
 *   catches naive flooding but NOT a distributed attack. For real rate
 *   limiting in production, use Vercel KV / Upstash Redis.
 */

// ---------------------------------------------------------------------------
// CORS
// ---------------------------------------------------------------------------

function getAllowedOriginList() {
  // Read at call time, not module load, so tests can mutate process.env.
  return (process.env.ALLOWED_ORIGINS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

function resolveAllowOrigin(reqOrigin) {
  const list = getAllowedOriginList();
  if (list.length === 0) {
    // No explicit list — dev-safe fallback. In production, ALLOWED_ORIGINS
    // should be set; without it we still return '*' to preserve the existing
    // dev behavior.
    return '*';
  }
  if (reqOrigin && list.includes(reqOrigin)) return reqOrigin;
  // No match — return first allowed origin so the browser rejects the request
  // cleanly rather than echoing an attacker-controlled Origin header.
  return list[0];
}

/**
 * Apply CORS headers to a response. Safe to call multiple times. Does not
 * end the response — callers handle OPTIONS via handleCorsPreflight.
 */
function applyCorsHeaders(req, res) {
  const reqOrigin = (req.headers && req.headers.origin) || '';
  const allowOrigin = resolveAllowOrigin(reqOrigin);
  res.setHeader('Access-Control-Allow-Origin', allowOrigin);
  if (allowOrigin !== '*') {
    res.setHeader('Vary', 'Origin');
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Access-Control-Max-Age', '86400');
}

/**
 * Send a JSON error response. Works on:
 *  - Vercel Node runtime (res.status is injected)
 *  - Express (res.status is native)
 *  - Raw Node http (fallback to res.statusCode + res.end)
 */
function sendJsonError(res, code, body) {
  if (typeof res.status === 'function') {
    res.status(code);
    if (typeof res.json === 'function') {
      res.json(body);
      return;
    }
  } else {
    res.statusCode = code;
  }
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(body));
}

/**
 * Handle CORS preflight OPTIONS request. Returns true if the request was an
 * OPTIONS preflight and has been fully handled (204 sent) — callers should
 * return immediately if this returns true.
 */
function handleCorsPreflight(req, res) {
  if (req.method === 'OPTIONS') {
    if (typeof res.status === 'function') {
      res.status(204);
    } else {
      res.statusCode = 204;
    }
    res.end();
    return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Body size cap (pre-parse check via Content-Length header)
// ---------------------------------------------------------------------------

function parseSizeString(str) {
  // Accepts '256kb', '1mb', or raw integer bytes. Returns bytes (Number).
  if (typeof str === 'number' && Number.isFinite(str)) return Math.max(0, Math.floor(str));
  if (typeof str !== 'string') return 0;
  const m = str.trim().toLowerCase().match(/^(\d+(?:\.\d+)?)\s*(kb|mb|gb|b)?$/);
  if (!m) return 0;
  const n = Number(m[1]);
  const unit = m[2] || 'b';
  if (unit === 'kb') return Math.floor(n * 1024);
  if (unit === 'mb') return Math.floor(n * 1024 * 1024);
  if (unit === 'gb') return Math.floor(n * 1024 * 1024 * 1024);
  return Math.floor(n);
}

/**
 * Check that the declared Content-Length does not exceed the cap. Returns
 * true if the request is within bounds, false if the handler should abort
 * (413 already sent). The cap default comes from env MENTOR_JSON_LIMIT
 * (e.g. '256kb') or falls back to 256kb.
 */
function checkBodySizeCap(req, res, maxBytes = null) {
  const cap = maxBytes != null
    ? parseSizeString(maxBytes)
    : parseSizeString(process.env.MENTOR_JSON_LIMIT || '256kb');
  if (cap <= 0) return true; // disabled
  const headerSize = Number((req.headers && req.headers['content-length']) || 0);
  if (Number.isFinite(headerSize) && headerSize > cap) {
    sendJsonError(res, 413, { error: `Request body exceeds ${cap} byte limit` });
    return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Per-IP rate limiting (best-effort, in-memory)
// ---------------------------------------------------------------------------
//
// Token bucket per IP, refilling at a steady rate. Since Vercel serverless
// has no cross-instance shared state, this only protects within a warm
// instance. For production-grade rate limiting, front with Vercel KV /
// Upstash Redis via a middleware layer. This is still useful as a first
// line of defense against naive loops.

const RATE_LIMIT_BUCKETS = new Map();
const RATE_LIMIT_BUCKET_MAX = 5000; // hard cap on distinct IPs kept in memory

function getClientIp(req) {
  const fwd = (req.headers && req.headers['x-forwarded-for']) || '';
  const first = String(fwd).split(',')[0].trim();
  if (first) return first;
  // Fallback for local dev (Express + Node http)
  return (req.socket && req.socket.remoteAddress) || 'unknown';
}

/**
 * Enforce a token-bucket per IP. Returns true if the request should proceed,
 * false if a 429 was already sent.
 *
 * Options:
 *   capacity — max tokens per bucket (burst allowance). Default: 30.
 *   refillPerSecond — tokens added per second. Default: 0.5 (30 req/minute).
 *   key — optional override for bucket key (defaults to getClientIp).
 */
function enforceRateLimit(req, res, options = {}) {
  const capacity = Number(options.capacity || 30);
  const refillPerSecond = Number(options.refillPerSecond || 0.5);
  const key = options.key || getClientIp(req);
  const now = Date.now();

  // Evict if map is too large (LRU-ish: drop oldest arbitrary entries).
  if (RATE_LIMIT_BUCKETS.size > RATE_LIMIT_BUCKET_MAX) {
    const toDrop = Math.max(1, Math.floor(RATE_LIMIT_BUCKETS.size / 10));
    let dropped = 0;
    for (const k of RATE_LIMIT_BUCKETS.keys()) {
      if (dropped >= toDrop) break;
      RATE_LIMIT_BUCKETS.delete(k);
      dropped += 1;
    }
  }

  let bucket = RATE_LIMIT_BUCKETS.get(key);
  if (!bucket) {
    bucket = { tokens: capacity, lastRefill: now };
    RATE_LIMIT_BUCKETS.set(key, bucket);
  } else {
    const elapsed = (now - bucket.lastRefill) / 1000;
    bucket.tokens = Math.min(capacity, bucket.tokens + elapsed * refillPerSecond);
    bucket.lastRefill = now;
  }

  if (bucket.tokens < 1) {
    const retryAfter = Math.max(1, Math.ceil((1 - bucket.tokens) / refillPerSecond));
    res.setHeader('Retry-After', String(retryAfter));
    sendJsonError(res, 429, { error: 'Rate limit exceeded — please slow down.' });
    return false;
  }

  bucket.tokens -= 1;
  return true;
}

// Test helper to reset rate limit state between test runs.
function _resetRateLimitBuckets() {
  RATE_LIMIT_BUCKETS.clear();
}

// ---------------------------------------------------------------------------
// Composite middleware runner
// ---------------------------------------------------------------------------

/**
 * Run all default security middleware for an API handler. Returns true if
 * the request should proceed to the handler body, false if a response has
 * already been sent (CORS preflight, 413, or 429).
 *
 * Usage:
 *   if (!applyApiSecurity(req, res, { rateLimit: { capacity: 30 } })) return;
 *   // handler body continues here
 */
function applyApiSecurity(req, res, options = {}) {
  applyCorsHeaders(req, res);
  if (handleCorsPreflight(req, res)) return false;
  if (!checkBodySizeCap(req, res, options.maxBodyBytes)) return false;
  // Disable rate limiting in test runs (NODE_ENV=test or DISABLE_RATE_LIMIT=1)
  // so parallel/sequential test calls don't trip the token bucket. Tests that
  // specifically exercise the rate limiter should unset this flag.
  const rateLimitDisabled =
    process.env.NODE_ENV === 'test' ||
    process.env.DISABLE_RATE_LIMIT === '1';
  if (!rateLimitDisabled && options.rateLimit !== false) {
    if (!enforceRateLimit(req, res, options.rateLimit || {})) return false;
  }
  return true;
}

module.exports = {
  applyApiSecurity,
  applyCorsHeaders,
  handleCorsPreflight,
  checkBodySizeCap,
  enforceRateLimit,
  resolveAllowOrigin,
  getAllowedOriginList,
  getClientIp,
  parseSizeString,
  _resetRateLimitBuckets,
};
