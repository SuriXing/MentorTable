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
 *   catches naive flooding but NOT a distributed attack. See F19 below for
 *   the global circuit breaker + LLM_DISABLED kill switch added in U5.1 R2
 *   to bound autoscale cost. For real rate limiting in production, use
 *   Vercel KV / Upstash Redis.
 */

// ---------------------------------------------------------------------------
// CORS
// ---------------------------------------------------------------------------

// Track whether we've already warned about a misconfigured ALLOWED_ORIGINS so
// we don't spam the console on every request. Keyed by raw env string so the
// warning re-fires if the env variable is mutated (tests do this).
let _blankOriginsWarnedFor = null;

function getAllowedOriginList() {
  // Read at call time, not module load, so tests can mutate process.env.
  const raw = process.env.ALLOWED_ORIGINS || '';
  const list = raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  // USER-3: env was set but every entry was blank (e.g. "," or " , , ").
  // This almost always means a typo/misconfig, so surface a warning.
  if (raw.length > 0 && list.length === 0 && _blankOriginsWarnedFor !== raw) {
    _blankOriginsWarnedFor = raw;
    // eslint-disable-next-line no-console
    console.warn(
      `[security] ALLOWED_ORIGINS is set to "${raw}" but contains no non-blank entries — ignoring it and falling back to default origin policy.`
    );
  }
  return list;
}

function resolveAllowOrigin(reqOrigin) {
  const list = getAllowedOriginList();
  if (list.length === 0) {
    // NEW-7: in production, refuse to return the wide-open '*' CORS value —
    // the API has no user auth, so '*' + no allowlist = any site on the
    // internet can burn our LLM budget. Log a warning and echo the request
    // origin (if present) so misconfig is loud but the app doesn't break.
    if (process.env.VERCEL_ENV === 'production' || process.env.NODE_ENV === 'production') {
      // eslint-disable-next-line no-console
      console.warn(
        '[security] ALLOWED_ORIGINS is empty in production — refusing wildcard CORS. Set ALLOWED_ORIGINS to your deployment URL.'
      );
      // Return a safe sentinel: either the caller's origin (so browser sends
      // the request but without a wildcard) or 'null'. Never '*'.
      return reqOrigin || 'null';
    }
    // Dev fallback — wildcard for local tools, curl, etc.
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

// F23: Vercel trust boundary for x-forwarded-for.
// -----------------------------------------------------------------------
// Vercel terminates TLS at its edge and prepends the connecting IP to the
// x-forwarded-for chain. The chain looks like:
//
//     x-forwarded-for: <client-claimed>, <proxy-1>, ..., <vercel-edge-ip>
//
// Only the LAST entry is trustworthy because Vercel writes it. The FIRST
// entry is whatever the client sent in its own xff header (or its actual
// IP if it sent none). For a public, unauthenticated endpoint a hostile
// client can spoof the first entry to evade per-IP rate limiting by
// rotating the claimed IP each request.
//
// We still use the FIRST entry as the rate-limit key here, because:
//   1) it matches what most users perceive as "their IP" in logs, and
//   2) the F19 global circuit breaker + LLM_DISABLED kill switch are the
//      real cost ceiling — per-IP buckets are best-effort UX/anti-abuse,
//      not a security boundary.
// If you ever need a trustworthy client IP, take the LAST entry of the
// xff chain when running behind Vercel, NOT the first.
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
// F19 — Global LLM cost ceiling (autoscale circuit breaker + kill switch)
// ---------------------------------------------------------------------------
//
// Per-instance token-bucket limiting is not a real cost cap when Vercel
// autoscales: under sustained attack ~50 warm instances × per-instance limit
// can still exceed budget. R2 adds two complementary controls:
//
//   1) LLM_DISABLED env var (kill switch). Operator flips this in the Vercel
//      dashboard during an incident; effect is near-instant on next request.
//
//   2) In-process rolling-hour counter of upstream LLM calls. When a single
//      warm instance's count crosses LLM_HOURLY_BUDGET (default 1000), this
//      instance returns 503 until the window rolls. Counter is per-instance
//      so the effective global ceiling is approximately
//      (instance_count × LLM_HOURLY_BUDGET); we set the per-instance budget
//      low enough that even pessimistic autoscale (50 instances) stays under
//      ~50,000 calls/hr — a worst-case bound the operator can size against.
//
// RESIDUAL RISK (documented in docs/SECURITY.md): this is still best-effort.
// True global accounting requires Vercel KV / Upstash. KISS choice for now:
// breaker + kill switch are sufficient for current traffic and the operator
// has a documented sub-minute mitigation path.

const LLM_CALL_WINDOW_MS = 60 * 60 * 1000; // 1 hour rolling window
let _llmCallCount = 0;
let _llmCallWindowStart = Date.now();

function _resetLlmCircuitBreaker() {
  _llmCallCount = 0;
  _llmCallWindowStart = Date.now();
}

function _rollLlmWindowIfStale(now) {
  if (now - _llmCallWindowStart >= LLM_CALL_WINDOW_MS) {
    _llmCallCount = 0;
    _llmCallWindowStart = now;
  }
}

function getLlmHourlyBudget() {
  const env = Number(process.env.LLM_HOURLY_BUDGET);
  if (Number.isFinite(env) && env > 0) return Math.floor(env);
  return 1000; // default per-instance cap
}

/**
 * Check whether the LLM is currently allowed to be called. Returns:
 *   { allowed: true }  — proceed and call recordLlmCall() after dispatch
 *   { allowed: false, reason, status, retryAfter } — send 503 and abort
 *
 * Operator-facing controls:
 *   - LLM_DISABLED=1            — hard kill switch (manual incident response)
 *   - LLM_HOURLY_BUDGET=<n>     — per-instance rolling-hour call budget
 */
function checkLlmCircuitBreaker() {
  if (process.env.LLM_DISABLED === '1' || process.env.LLM_DISABLED === 'true') {
    return {
      allowed: false,
      reason: 'LLM service temporarily disabled by operator',
      status: 503,
      retryAfter: 300,
    };
  }
  const now = Date.now();
  _rollLlmWindowIfStale(now);
  const budget = getLlmHourlyBudget();
  if (_llmCallCount >= budget) {
    const retryAfter = Math.max(
      1,
      Math.ceil((LLM_CALL_WINDOW_MS - (now - _llmCallWindowStart)) / 1000)
    );
    return {
      allowed: false,
      reason: 'LLM hourly budget exceeded — service temporarily unavailable',
      status: 503,
      retryAfter,
    };
  }
  return { allowed: true };
}

/**
 * Record that an upstream LLM call is being dispatched. Counts against the
 * per-instance hourly budget. Call this AFTER checkLlmCircuitBreaker
 * returns allowed:true and BEFORE the upstream fetch fans out.
 */
function recordLlmCall(count = 1) {
  const now = Date.now();
  _rollLlmWindowIfStale(now);
  _llmCallCount += Math.max(1, Number(count) || 1);
}

/**
 * Composite helper for handlers that fan out to LLM upstream. Sends 503 and
 * returns false if the breaker is open. Caller must invoke recordLlmCall()
 * with the actual fan-out count after the breaker passes.
 */
function enforceLlmBreaker(req, res) {
  const verdict = checkLlmCircuitBreaker();
  if (verdict.allowed) return true;
  res.setHeader('Retry-After', String(verdict.retryAfter));
  sendJsonError(res, verdict.status, { error: verdict.reason });
  return false;
}

// ---------------------------------------------------------------------------
// Sensitive-data redaction for error previews
// ---------------------------------------------------------------------------
//
// BYPASS-1 / FIX-CRITIQUE-4: the Round 1 redactor covered sk-, Bearer, and
// an overly broad 32+ char catch-all. The catch-all over-redacted legit UUIDs
// / URLs / hashes in error previews AND missed the vast majority of real
// secret formats. This replacement enumerates specific well-known secret
// formats, and drops the catch-all so SHA-256 hex and UUIDs pass through.

// Build the full redactor as a single pass so the order of patterns is
// deterministic.
function redactSensitive(str) {
  if (typeof str !== 'string') return str;
  let out = str;
  // 1. URL credentials: https://user:pass@host/path
  out = out.replace(/\b(https?:\/\/)([^\s:/@]+):([^\s@/]+)@/gi, '$1[REDACTED]:[REDACTED]@');
  // 2. HTTP Basic auth header
  out = out.replace(/\bBasic\s+[A-Za-z0-9+/=_\-]+/gi, 'Basic [REDACTED]');
  // 3. Bearer tokens (order matters: must come before generic sk- match)
  out = out.replace(/\bBearer\s+[A-Za-z0-9_\-.=+/]+/gi, 'Bearer [REDACTED]');
  // 4. Anthropic keys: sk-ant-...
  out = out.replace(/\bsk-ant-[A-Za-z0-9_\-]{8,}/gi, 'sk-ant-[REDACTED]');
  // 5. Stripe keys: sk_live_/sk_test_/rk_live_/rk_test_/pk_live_/pk_test_
  out = out.replace(/\b(sk|rk|pk)_(live|test)_[A-Za-z0-9]{8,}/gi, '$1_$2_[REDACTED]');
  // 6. OpenAI-style legacy keys: sk-<base62>{20+}
  out = out.replace(/\bsk-[A-Za-z0-9_\-]{16,}/g, 'sk-[REDACTED]');
  // 7. Google API keys: AIza + 35 chars
  out = out.replace(/\bAIza[0-9A-Za-z_\-]{35}\b/g, 'AIza[REDACTED]');
  // 8. AWS access keys: AKIA + 16 uppercase alnum
  out = out.replace(/\bAKIA[0-9A-Z]{16}\b/g, 'AKIA[REDACTED]');
  // 9. xAI keys: xai-<40+ alphanumeric>
  out = out.replace(/\bxai-[A-Za-z0-9]{40,}/g, 'xai-[REDACTED]');
  // 10. Aliyun RAM access keys: LTAI<base62>{12,24}. F21: previous redactor
  // missed this prefix even though Aliyun DashScope is the project's actual
  // upstream — a leaked LTAI key in an error preview would be the highest-
  // impact secret leak the codebase could realistically produce.
  out = out.replace(/\bLTAI[A-Za-z0-9]{12,30}\b/g, 'LTAI[REDACTED]');
  // 11. JWT: three base64url segments separated by dots, starting with eyJ
  out = out.replace(
    /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g,
    'eyJ[REDACTED]'
  );
  return out;
}

// ---------------------------------------------------------------------------
// Mentor field sanitization (prompt-injection defense)
// ---------------------------------------------------------------------------
//
// BYPASS-3 / FIX-CRITIQUE-5: the Round 1 regex stripped only C0 control
// chars + DEL. Attackers can still smuggle invisible "instructions" via C1
// controls, line/paragraph separators, bidi overrides, and zero-width chars.
// This extended regex catches all of them.
//
// F22 (U5.1 R2): the function used to be named `sanitizeMentorField` which
// implied HTML-escaping. It does NOT escape HTML — it strips control chars
// and bounds length. The mentor fields are rendered as text in React, which
// auto-escapes, so HTML escape is unnecessary AND would produce visible
// `&amp;` strings if the value was ever passed verbatim into the LLM prompt.
// Renamed to `stripControlChars` so the contract is honest. The legacy
// names remain exported as deprecated aliases for back-compat.

// eslint-disable-next-line no-control-regex
const UNSAFE_FIELD_CHAR_RE = /[\u0000-\u0008\u000a-\u001f\u007f\u0080-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069\u200b-\u200d\u2060\ufeff]/g;

function stripControlChars(value, maxLen = 300) {
  if (value === null || value === undefined) return '';
  const str = typeof value === 'string' ? value : String(value);
  const cleaned = str.replace(UNSAFE_FIELD_CHAR_RE, ' ').trim();
  return cleaned.length > maxLen ? cleaned.slice(0, maxLen) : cleaned;
}

function stripControlCharsArray(arr, perItemMax = 200, maxItems = 12) {
  if (!Array.isArray(arr)) return [];
  return arr
    .slice(0, maxItems)
    .map((item) => stripControlChars(item, perItemMax))
    .filter(Boolean);
}

// Deprecated aliases — kept so external callers and historical commits keep
// compiling. Prefer stripControlChars / stripControlCharsArray in new code.
const sanitizeMentorField = stripControlChars;
const sanitizeMentorFieldArray = stripControlCharsArray;

// Test helper: reset the warning dedupe cache so consecutive tests that flip
// ALLOWED_ORIGINS can both observe the warning.
function _resetBlankOriginsWarning() {
  _blankOriginsWarnedFor = null;
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
  redactSensitive,
  // Preferred names (F22):
  stripControlChars,
  stripControlCharsArray,
  // Deprecated aliases — keep callers compiling:
  sanitizeMentorField,
  sanitizeMentorFieldArray,
  // F19 LLM circuit breaker:
  checkLlmCircuitBreaker,
  recordLlmCall,
  enforceLlmBreaker,
  getLlmHourlyBudget,
  _resetLlmCircuitBreaker,
  _resetRateLimitBuckets,
  _resetBlankOriginsWarning,
};
