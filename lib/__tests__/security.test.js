/**
 * Tests for lib/security.js — shared middleware helpers used by
 * api/*.js handlers and the dev-only server.js wrapper.
 */
const {
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
  stripControlChars,
  stripControlCharsArray,
  sanitizeMentorField,
  sanitizeMentorFieldArray,
  checkLlmCircuitBreaker,
  recordLlmCall,
  enforceLlmBreaker,
  getLlmHourlyBudget,
  _resetLlmCircuitBreaker,
  _resetRateLimitBuckets,
  checkKvRateLimit,
  _setKvRateLimitFetch,
  kvRateLimitEnv,
} = require('../security.js');

// ---------- Mock req/res factories ----------

function mockReq(overrides = {}) {
  return {
    method: 'POST',
    headers: {},
    socket: { remoteAddress: '127.0.0.1' },
    ...overrides,
  };
}

function mockRes() {
  const headers = {};
  const res = {
    _status: null,
    _json: null,
    _body: null,
    _ended: false,
    statusCode: 200,
    status(code) { res._status = code; res.statusCode = code; return res; },
    json(data) { res._json = data; res._ended = true; return res; },
    end(data) { res._body = data; res._ended = true; return res; },
    setHeader(k, v) { headers[k] = v; return res; },
    getHeader(k) { return headers[k]; },
    _headers: headers,
  };
  return res;
}

// ---------- parseSizeString ----------

describe('parseSizeString', () => {
  it('parses raw bytes', () => {
    expect(parseSizeString('1024')).toBe(1024);
    expect(parseSizeString('1024b')).toBe(1024);
  });

  it('parses kb/mb/gb units', () => {
    expect(parseSizeString('256kb')).toBe(256 * 1024);
    expect(parseSizeString('1mb')).toBe(1024 * 1024);
    expect(parseSizeString('2gb')).toBe(2 * 1024 * 1024 * 1024);
  });

  it('handles fractional values', () => {
    expect(parseSizeString('1.5mb')).toBe(Math.floor(1.5 * 1024 * 1024));
  });

  it('is case-insensitive with spaces', () => {
    expect(parseSizeString('  256 KB  ')).toBe(256 * 1024);
  });

  it('accepts a raw number as input', () => {
    expect(parseSizeString(2048)).toBe(2048);
    expect(parseSizeString(-5)).toBe(0);
  });

  it('returns 0 for invalid values', () => {
    expect(parseSizeString('abc')).toBe(0);
    expect(parseSizeString('')).toBe(0);
    expect(parseSizeString(null)).toBe(0);
    expect(parseSizeString(undefined)).toBe(0);
    expect(parseSizeString(NaN)).toBe(0);
  });
});

// ---------- CORS allowlist ----------

describe('resolveAllowOrigin', () => {
  const saved = process.env.ALLOWED_ORIGINS;
  afterEach(() => {
    if (saved === undefined) delete process.env.ALLOWED_ORIGINS;
    else process.env.ALLOWED_ORIGINS = saved;
  });

  it('falls back to * when allowlist is empty', () => {
    delete process.env.ALLOWED_ORIGINS;
    expect(resolveAllowOrigin('https://attacker.com')).toBe('*');
  });

  it('falls back to * when allowlist env is only whitespace/commas', () => {
    process.env.ALLOWED_ORIGINS = ' , , , ';
    expect(resolveAllowOrigin('https://attacker.com')).toBe('*');
  });

  it('returns the matching origin when request origin is in the allowlist', () => {
    process.env.ALLOWED_ORIGINS = 'https://foo.com,https://bar.com';
    expect(resolveAllowOrigin('https://bar.com')).toBe('https://bar.com');
  });

  it('returns the first allowlist entry when origin is NOT in the list', () => {
    process.env.ALLOWED_ORIGINS = 'https://foo.com,https://bar.com';
    expect(resolveAllowOrigin('https://attacker.com')).toBe('https://foo.com');
  });

  it('returns the first allowlist entry when request origin is missing', () => {
    process.env.ALLOWED_ORIGINS = 'https://foo.com';
    expect(resolveAllowOrigin(undefined)).toBe('https://foo.com');
    expect(resolveAllowOrigin('')).toBe('https://foo.com');
  });
});

describe('getAllowedOriginList', () => {
  const saved = process.env.ALLOWED_ORIGINS;
  afterEach(() => {
    if (saved === undefined) delete process.env.ALLOWED_ORIGINS;
    else process.env.ALLOWED_ORIGINS = saved;
  });

  it('parses comma-separated env values', () => {
    process.env.ALLOWED_ORIGINS = 'a.com, b.com,c.com ';
    expect(getAllowedOriginList()).toEqual(['a.com', 'b.com', 'c.com']);
  });

  it('returns empty array when unset', () => {
    delete process.env.ALLOWED_ORIGINS;
    expect(getAllowedOriginList()).toEqual([]);
  });
});

// ---------- applyCorsHeaders ----------

describe('applyCorsHeaders', () => {
  const saved = process.env.ALLOWED_ORIGINS;
  afterEach(() => {
    if (saved === undefined) delete process.env.ALLOWED_ORIGINS;
    else process.env.ALLOWED_ORIGINS = saved;
  });

  it('sets Access-Control-* headers on the response with *', () => {
    delete process.env.ALLOWED_ORIGINS;
    const req = mockReq({ headers: { origin: 'https://example.com' } });
    const res = mockRes();
    applyCorsHeaders(req, res);
    expect(res._headers['Access-Control-Allow-Origin']).toBe('*');
    expect(res._headers['Access-Control-Allow-Methods']).toBe('GET,POST,OPTIONS');
    expect(res._headers['Access-Control-Allow-Headers']).toContain('Content-Type');
    expect(res._headers['Access-Control-Max-Age']).toBe('86400');
    // Vary: Origin is ONLY set when we're echoing a specific origin, not *
    expect(res._headers.Vary).toBeUndefined();
  });

  it('sets Vary: Origin when echoing a specific allowlisted origin', () => {
    process.env.ALLOWED_ORIGINS = 'https://foo.com,https://bar.com';
    const req = mockReq({ headers: { origin: 'https://bar.com' } });
    const res = mockRes();
    applyCorsHeaders(req, res);
    expect(res._headers['Access-Control-Allow-Origin']).toBe('https://bar.com');
    expect(res._headers.Vary).toBe('Origin');
  });

  it('handles missing req.headers gracefully', () => {
    const req = { method: 'GET' };
    const res = mockRes();
    applyCorsHeaders(req, res);
    expect(res._headers['Access-Control-Allow-Origin']).toBe('*');
  });
});

// ---------- handleCorsPreflight ----------

describe('handleCorsPreflight', () => {
  it('returns true and sends 204 on OPTIONS', () => {
    const req = mockReq({ method: 'OPTIONS' });
    const res = mockRes();
    const handled = handleCorsPreflight(req, res);
    expect(handled).toBe(true);
    expect(res.statusCode).toBe(204);
    expect(res._ended).toBe(true);
  });

  it('returns false on non-OPTIONS methods', () => {
    for (const method of ['GET', 'POST', 'PUT', 'DELETE', 'HEAD']) {
      const req = mockReq({ method });
      const res = mockRes();
      expect(handleCorsPreflight(req, res)).toBe(false);
      expect(res._ended).toBe(false);
    }
  });

  it('works with raw Node-style res (no status() method)', () => {
    const req = mockReq({ method: 'OPTIONS' });
    // Simulate raw Node http ServerResponse: no status() helper
    const res = {
      statusCode: 0,
      _ended: false,
      setHeader() {},
      end() { this._ended = true; },
    };
    const handled = handleCorsPreflight(req, res);
    expect(handled).toBe(true);
    expect(res.statusCode).toBe(204);
    expect(res._ended).toBe(true);
  });
});

// ---------- checkBodySizeCap ----------

describe('checkBodySizeCap', () => {
  const savedLimit = process.env.MENTOR_JSON_LIMIT;
  afterEach(() => {
    if (savedLimit === undefined) delete process.env.MENTOR_JSON_LIMIT;
    else process.env.MENTOR_JSON_LIMIT = savedLimit;
  });

  it('returns true when Content-Length is within the cap', () => {
    const req = mockReq({ headers: { 'content-length': '100' } });
    const res = mockRes();
    expect(checkBodySizeCap(req, res, '1kb')).toBe(true);
    expect(res._status).toBe(null);
  });

  it('returns false and sends 413 when Content-Length exceeds the cap', () => {
    const req = mockReq({ headers: { 'content-length': '2000' } });
    const res = mockRes();
    expect(checkBodySizeCap(req, res, '1kb')).toBe(false);
    expect(res._status).toBe(413);
    expect(res._json.error).toContain('byte limit');
  });

  it('uses env MENTOR_JSON_LIMIT as default', () => {
    process.env.MENTOR_JSON_LIMIT = '500';
    const req = mockReq({ headers: { 'content-length': '1000' } });
    const res = mockRes();
    expect(checkBodySizeCap(req, res)).toBe(false);
    expect(res._status).toBe(413);
  });

  it('returns true when no Content-Length header is present', () => {
    const req = mockReq({});
    const res = mockRes();
    expect(checkBodySizeCap(req, res, '1kb')).toBe(true);
  });

  it('returns true when cap is 0 or negative (disabled)', () => {
    const req = mockReq({ headers: { 'content-length': '999999999' } });
    const res = mockRes();
    expect(checkBodySizeCap(req, res, '0')).toBe(true);
  });

  it('falls back to 256kb default when MENTOR_JSON_LIMIT is unset', () => {
    delete process.env.MENTOR_JSON_LIMIT;
    const req = mockReq({ headers: { 'content-length': String(512 * 1024) } });
    const res = mockRes();
    expect(checkBodySizeCap(req, res)).toBe(false);
    expect(res._status).toBe(413);
  });

  it('uses raw Node fallback when res.status is missing', () => {
    const req = mockReq({ headers: { 'content-length': '2000' } });
    const sent = {};
    const res = {
      statusCode: 0,
      _ended: false,
      setHeader(k, v) { sent[k] = v; },
      end(body) { sent.body = body; this._ended = true; },
    };
    expect(checkBodySizeCap(req, res, '1kb')).toBe(false);
    expect(res.statusCode).toBe(413);
    expect(sent['Content-Type']).toBe('application/json');
    expect(JSON.parse(sent.body).error).toContain('byte limit');
  });
});

// ---------- checkKvRateLimit (F166 / P22) ----------

describe('checkKvRateLimit', () => {
  const ENV_KEYS = ['KV_REST_API_URL', 'KV_REST_API_TOKEN', 'UPSTASH_REDIS_REST_URL', 'UPSTASH_REDIS_REST_TOKEN'];

  beforeEach(() => {
    _resetRateLimitBuckets();
    for (const k of ENV_KEYS) delete process.env[k];
    _setKvRateLimitFetch(global.fetch);
  });

  afterEach(() => {
    for (const k of ENV_KEYS) delete process.env[k];
    _setKvRateLimitFetch(global.fetch);
  });

  it('returns null when KV env is not configured (memory fallback path)', async () => {
    const res = mockRes();
    await expect(checkKvRateLimit(mockReq(), res, { kvLimit: 10, kvWindowSeconds: 60 })).resolves.toBe(null);
  });

  it('allows requests under the global limit and blocks beyond it with 429', async () => {
    process.env.KV_REST_API_URL = 'https://kv.example.com';
    process.env.KV_REST_API_TOKEN = 'tok';
    let count = 0;
    _setKvRateLimitFetch(async () => {
      count += 1;
      return { ok: true, json: async () => [{ result: count }, { result: 'OK' }] };
    });
    const req = mockReq({ headers: { 'x-forwarded-for': '9.9.9.9' } });
    await expect(checkKvRateLimit(req, mockRes(), { kvLimit: 2, kvWindowSeconds: 60 })).resolves.toBe(true);
    await expect(checkKvRateLimit(req, mockRes(), { kvLimit: 2, kvWindowSeconds: 60 })).resolves.toBe(true);
    const res3 = mockRes();
    await expect(checkKvRateLimit(req, res3, { kvLimit: 2, kvWindowSeconds: 60 })).resolves.toBe(false);
    expect(res3._status).toBe(429);
    expect(res3._headers['Retry-After']).toBeTruthy();
  });

  it('degrades to null (memory fallback) when KV fetch fails', async () => {
    process.env.KV_REST_API_URL = 'https://kv.example.com';
    process.env.KV_REST_API_TOKEN = 'tok';
    _setKvRateLimitFetch(async () => { throw new Error('ECONNREFUSED'); });
    const res = mockRes();
    await expect(checkKvRateLimit(mockReq(), res, { kvLimit: 10, kvWindowSeconds: 60 })).resolves.toBe(null);
    expect(res._status).not.toBe(429);
  });

  it('degrades to null on non-OK or malformed KV responses', async () => {
    process.env.KV_REST_API_URL = 'https://kv.example.com';
    process.env.KV_REST_API_TOKEN = 'tok';
    _setKvRateLimitFetch(async () => ({ ok: false, status: 500 }));
    await expect(checkKvRateLimit(mockReq(), mockRes(), { kvLimit: 10, kvWindowSeconds: 60 })).resolves.toBe(null);
    _setKvRateLimitFetch(async () => ({ ok: true, json: async () => ({ unexpected: 'shape' }) }));
    await expect(checkKvRateLimit(mockReq(), mockRes(), { kvLimit: 10, kvWindowSeconds: 60 })).resolves.toBe(null);
  });

  it('kvRateLimitEnv prefers Vercel KV vars and strips trailing slash', () => {
    process.env.KV_REST_API_URL = 'https://kv.vercel.com/';
    process.env.KV_REST_API_TOKEN = 't1';
    expect(kvRateLimitEnv()).toEqual({ url: 'https://kv.vercel.com', token: 't1' });
    delete process.env.KV_REST_API_URL;
    delete process.env.KV_REST_API_TOKEN;
    process.env.UPSTASH_REDIS_REST_URL = 'https://upstash.example.com';
    process.env.UPSTASH_REDIS_REST_TOKEN = 't2';
    expect(kvRateLimitEnv()).toEqual({ url: 'https://upstash.example.com', token: 't2' });
  });
});

// ---------- enforceRateLimit ----------

describe('enforceRateLimit', () => {
  beforeEach(() => {
    _resetRateLimitBuckets();
  });

  it('allows requests under the burst capacity', () => {
    for (let i = 0; i < 5; i += 1) {
      const req = mockReq({ headers: { 'x-forwarded-for': '1.1.1.1' } });
      const res = mockRes();
      expect(enforceRateLimit(req, res, { capacity: 10, refillPerSecond: 0.1 })).toBe(true);
    }
  });

  it('returns false with 429 after capacity is exhausted', () => {
    const options = { capacity: 3, refillPerSecond: 0, key: 'test-burst' };
    for (let i = 0; i < 3; i += 1) {
      const res = mockRes();
      expect(enforceRateLimit(mockReq(), res, options)).toBe(true);
    }
    const denyRes = mockRes();
    const logSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(enforceRateLimit(mockReq(), denyRes, options)).toBe(false);
    expect(denyRes._status).toBe(429);
    expect(denyRes._headers['Retry-After']).toBeTruthy();
    // F170 (P26): denial is observable.
    const event = logSpy.mock.calls.map((c) => c[0]).find((line) => {
      try { return JSON.parse(line).event === 'rate_limited'; } catch { return false; }
    });
    expect(event).toBeTruthy();
    logSpy.mockRestore();
  });

  it('separates buckets by IP (via X-Forwarded-For)', () => {
    const opts = { capacity: 2, refillPerSecond: 0 };
    // IP A exhausts
    expect(enforceRateLimit(mockReq({ headers: { 'x-forwarded-for': 'A' } }), mockRes(), opts)).toBe(true);
    expect(enforceRateLimit(mockReq({ headers: { 'x-forwarded-for': 'A' } }), mockRes(), opts)).toBe(true);
    expect(enforceRateLimit(mockReq({ headers: { 'x-forwarded-for': 'A' } }), mockRes(), opts)).toBe(false);
    // IP B still has full bucket
    expect(enforceRateLimit(mockReq({ headers: { 'x-forwarded-for': 'B' } }), mockRes(), opts)).toBe(true);
  });

  it('uses the first IP in X-Forwarded-For chain', () => {
    const req = mockReq({ headers: { 'x-forwarded-for': '10.0.0.1, 10.0.0.2, 10.0.0.3' } });
    const res = mockRes();
    expect(enforceRateLimit(req, res, { capacity: 1, refillPerSecond: 0 })).toBe(true);
    // Second request from same first-IP should be rate-limited
    expect(enforceRateLimit(
      mockReq({ headers: { 'x-forwarded-for': '10.0.0.1' } }),
      mockRes(),
      { capacity: 1, refillPerSecond: 0 }
    )).toBe(false);
  });

  it('evicts least-recently-ADMITTED buckets (true LRU, denials do not touch)', () => {
    // A is exhausted up front, so its later re-requests are denials. T is
    // admitted early and re-admitted late, moving it to the back of the
    // eviction order. When the map overflows, A (front) must be evicted
    // while T (touched, exhausted) must survive.
    const cap = (n) => ({ capacity: n, refillPerSecond: 0 });
    const ipReq = (ip) => mockReq({ headers: { 'x-forwarded-for': ip } });

    expect(enforceRateLimit(ipReq('A'), mockRes(), cap(2))).toBe(true);
    expect(enforceRateLimit(ipReq('A'), mockRes(), cap(2))).toBe(true); // A exhausted
    expect(enforceRateLimit(ipReq('T'), mockRes(), cap(2))).toBe(true); // 1 left
    for (let i = 0; i < 4997; i += 1) {
      expect(enforceRateLimit(ipReq(`F${i}`), mockRes(), cap(50))).toBe(true);
    }
    // Denied re-requests must NOT refresh A's eviction position.
    expect(enforceRateLimit(ipReq('A'), mockRes(), cap(2))).toBe(false);
    // Admitted re-request moves T to the back of the eviction order.
    expect(enforceRateLimit(ipReq('T'), mockRes(), cap(2))).toBe(true); // T exhausted
    // Map is now at 5000; the next admission overflows and evicts 500.
    expect(enforceRateLimit(ipReq('F4997'), mockRes(), cap(50))).toBe(true);
    expect(enforceRateLimit(ipReq('F4998'), mockRes(), cap(50))).toBe(true);

    // A was at the front (never admitted since) -> evicted -> fresh bucket.
    expect(enforceRateLimit(ipReq('A'), mockRes(), cap(2))).toBe(true);
    // T was touched but exhausted -> still alive -> still denied.
    expect(enforceRateLimit(ipReq('T'), mockRes(), cap(2))).toBe(false);
  });

  it('falls back to socket.remoteAddress when no X-Forwarded-For', () => {
    const req = mockReq({ socket: { remoteAddress: '192.168.1.10' } });
    const res = mockRes();
    expect(enforceRateLimit(req, res, { capacity: 1, refillPerSecond: 0 })).toBe(true);
    const req2 = mockReq({ socket: { remoteAddress: '192.168.1.10' } });
    expect(enforceRateLimit(req2, mockRes(), { capacity: 1, refillPerSecond: 0 })).toBe(false);
  });

  it('returns unknown when both IP sources are missing', () => {
    const req = { method: 'POST', headers: {}, socket: {} };
    expect(getClientIp(req)).toBe('unknown');
  });

  it('refills tokens over time', async () => {
    const opts = { capacity: 1, refillPerSecond: 100, key: 'refill-test' };
    expect(enforceRateLimit(mockReq(), mockRes(), opts)).toBe(true);
    // Exhausted
    expect(enforceRateLimit(mockReq(), mockRes(), opts)).toBe(false);
    // Wait 50ms — should refill 5 tokens at 100/sec
    await new Promise((r) => setTimeout(r, 60));
    expect(enforceRateLimit(mockReq(), mockRes(), opts)).toBe(true);
  });

  it('falls back to default capacity=30 when options.capacity is not supplied', () => {
    // Exercises the `options.capacity || 30` default branch on line 199.
    // Call enforceRateLimit with an empty options bag and a unique key so
    // this test is isolated from the token-bucket map used by sibling tests.
    const key = 'default-capacity-test';
    // 30 allowed calls, refill default 0.5/s — in a tight loop only the
    // initial 30 tokens matter.
    for (let i = 0; i < 30; i += 1) {
      const res = mockRes();
      expect(enforceRateLimit(mockReq(), res, { key })).toBe(true);
    }
    // 31st request should fail — default bucket is exhausted.
    const denyRes = mockRes();
    expect(enforceRateLimit(mockReq(), denyRes, { key })).toBe(false);
    expect(denyRes._status).toBe(429);
  });

  it('works with no options argument at all (all defaults)', () => {
    // Same as above but omit the options argument entirely. This exercises
    // the signature default (`options = {}`) plus the `capacity || 30`
    // fallback on line 199.
    _resetRateLimitBuckets();
    const req = mockReq({ headers: { 'x-forwarded-for': 'default-opts-ip' } });
    expect(enforceRateLimit(req, mockRes())).toBe(true);
  });

  it('evicts old buckets when the map grows past the soft cap', () => {
    // Force past-max insertion — can't cleanly test without exposing the cap,
    // so just verify no crash and subsequent requests still work.
    const opts = { capacity: 1, refillPerSecond: 0 };
    for (let i = 0; i < 6000; i += 1) {
      enforceRateLimit(mockReq({ headers: { 'x-forwarded-for': `ip-${i}` } }), mockRes(), opts);
    }
    // Fresh key still gets a full bucket after eviction
    expect(enforceRateLimit(
      mockReq({ headers: { 'x-forwarded-for': 'fresh-ip' } }),
      mockRes(),
      opts
    )).toBe(true);
  });
});

// ---------- getClientIp ----------

describe('getClientIp', () => {
  it('prefers x-forwarded-for first entry', () => {
    expect(getClientIp(mockReq({ headers: { 'x-forwarded-for': '1.2.3.4, 5.6.7.8' } }))).toBe('1.2.3.4');
  });

  it('falls back to socket.remoteAddress', () => {
    expect(getClientIp(mockReq({ socket: { remoteAddress: '9.9.9.9' } }))).toBe('9.9.9.9');
  });

  it('returns "unknown" when nothing is available', () => {
    expect(getClientIp({ method: 'POST', headers: {}, socket: {} })).toBe('unknown');
  });

  it('handles missing socket entirely', () => {
    expect(getClientIp({ method: 'POST', headers: {} })).toBe('unknown');
  });
});

// ---------- applyApiSecurity (composite) ----------

describe('applyApiSecurity', () => {
  const saved = { NODE_ENV: process.env.NODE_ENV, ALLOWED_ORIGINS: process.env.ALLOWED_ORIGINS, DISABLE_RATE_LIMIT: process.env.DISABLE_RATE_LIMIT };
  beforeEach(() => {
    _resetRateLimitBuckets();
  });
  afterEach(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it('passes through a normal POST request in test mode', async () => {
    process.env.NODE_ENV = 'test';
    const req = mockReq({ method: 'POST' });
    const res = mockRes();
    await expect(applyApiSecurity(req, res, { maxBodyBytes: '1mb' })).resolves.toBe(true);
    expect(res._headers['Access-Control-Allow-Origin']).toBe('*');
  });

  it('short-circuits OPTIONS requests (returns false, 204 sent)', async () => {
    const req = mockReq({ method: 'OPTIONS' });
    const res = mockRes();
    await expect(applyApiSecurity(req, res, {})).resolves.toBe(false);
    expect(res.statusCode).toBe(204);
  });

  it('short-circuits oversized requests (returns false, 413 sent)', async () => {
    const req = mockReq({ headers: { 'content-length': String(2 * 1024 * 1024) } });
    const res = mockRes();
    await expect(applyApiSecurity(req, res, { maxBodyBytes: '1mb' })).resolves.toBe(false);
    expect(res._status).toBe(413);
  });

  it('respects NODE_ENV=test to skip rate limiting', async () => {
    process.env.NODE_ENV = 'test';
    const opts = { rateLimit: { capacity: 1, refillPerSecond: 0 } };
    // Hit it 5 times — should all pass because rate limit is disabled in test env
    for (let i = 0; i < 5; i += 1) {
      const res = mockRes();
      await expect(applyApiSecurity(mockReq(), res, opts)).resolves.toBe(true);
    }
  });

  it('respects DISABLE_RATE_LIMIT=1 to skip rate limiting', async () => {
    delete process.env.NODE_ENV;
    process.env.DISABLE_RATE_LIMIT = '1';
    const opts = { rateLimit: { capacity: 1, refillPerSecond: 0 } };
    for (let i = 0; i < 5; i += 1) {
      const res = mockRes();
      await expect(applyApiSecurity(mockReq(), res, opts)).resolves.toBe(true);
    }
  });

  it('rate-limits when not in test mode', async () => {
    delete process.env.NODE_ENV;
    delete process.env.DISABLE_RATE_LIMIT;
    const opts = { rateLimit: { capacity: 2, refillPerSecond: 0, key: 'apitest' } };
    await expect(applyApiSecurity(mockReq(), mockRes(), opts)).resolves.toBe(true);
    await expect(applyApiSecurity(mockReq(), mockRes(), opts)).resolves.toBe(true);
    const denyRes = mockRes();
    await expect(applyApiSecurity(mockReq(), denyRes, opts)).resolves.toBe(false);
    expect(denyRes._status).toBe(429);
  });

  it('applies default rate limit when options.rateLimit is not supplied', async () => {
    // Exercises the `options.rateLimit || {}` fallback on line 339.
    // NODE_ENV must not be 'test' so the rate limiter actually runs.
    delete process.env.NODE_ENV;
    delete process.env.DISABLE_RATE_LIMIT;
    const req = mockReq({ headers: { 'x-forwarded-for': 'default-rl-ip' } });
    // No rateLimit option — the handler should still apply the default
    // token-bucket settings (capacity=30, refill=0.5/s).
    await expect(applyApiSecurity(req, mockRes(), { maxBodyBytes: '1mb' })).resolves.toBe(true);
  });

  it('applies default rate limit when options is entirely empty', async () => {
    // Same branch as above, but with a completely empty options bag. This
    // specifically hits the `options.rateLimit || {}` short-circuit with
    // `rateLimit` being `undefined`.
    delete process.env.NODE_ENV;
    delete process.env.DISABLE_RATE_LIMIT;
    const req = mockReq({ headers: { 'x-forwarded-for': 'empty-opts-ip' } });
    await expect(applyApiSecurity(req, mockRes(), {})).resolves.toBe(true);
  });

  it('allows callers to opt out of rate limiting entirely', async () => {
    delete process.env.NODE_ENV;
    delete process.env.DISABLE_RATE_LIMIT;
    const opts = { rateLimit: false };
    for (let i = 0; i < 10; i += 1) {
      await expect(applyApiSecurity(mockReq(), mockRes(), opts)).resolves.toBe(true);
    }
  });

  it('F176: KV outage degrades to memory-bucket limiting, never fail-open', async () => {
    // The dangerous failure mode for a distributed limiter is not "KV is
    // down" — it is "KV is down AND the endpoint keeps admitting". This
    // pins the composite path end to end: KV env configured, every KV call
    // throwing, NODE_ENV production-like — the per-instance memory bucket
    // must still enforce, and the denial must stay observable as a
    // rate_limited event naming the memory limiter.
    delete process.env.NODE_ENV;
    delete process.env.DISABLE_RATE_LIMIT;
    const KV_KEYS = ['KV_REST_API_URL', 'KV_REST_API_TOKEN', 'UPSTASH_REDIS_REST_URL', 'UPSTASH_REDIS_REST_TOKEN'];
    const kvSaved = KV_KEYS.map((k) => [k, process.env[k]]);
    try {
      process.env.KV_REST_API_URL = 'https://kv.example.com';
      process.env.KV_REST_API_TOKEN = 'tok';
      _setKvRateLimitFetch(async () => { throw new Error('ECONNREFUSED'); });

      const opts = {
        rateLimit: { capacity: 2, refillPerSecond: 0, key: 'f176-outage', kvLimit: 100, kvWindowSeconds: 60 },
      };
      const req = mockReq({ headers: { 'x-forwarded-for': '10.10.10.10' } });
      await expect(applyApiSecurity(req, mockRes(), opts)).resolves.toBe(true);
      await expect(applyApiSecurity(req, mockRes(), opts)).resolves.toBe(true);

      const logSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const denyRes = mockRes();
      await expect(applyApiSecurity(req, denyRes, opts)).resolves.toBe(false);
      expect(denyRes._status).toBe(429);
      expect(denyRes._headers['Retry-After']).toBeTruthy();
      const event = logSpy.mock.calls.map((c) => c[0]).find((line) => {
        try { return JSON.parse(line).event === 'rate_limited'; } catch { return false; }
      });
      expect(event).toBeTruthy();
      expect(JSON.parse(event).limiter).toBe('memory');
      logSpy.mockRestore();
    } finally {
      for (const [k, v] of kvSaved) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
      _setKvRateLimitFetch(global.fetch);
    }
  });
});

// ---------- redactSensitive (F21: LTAI coverage) ----------

describe('redactSensitive', () => {
  it('redacts Aliyun RAM access keys (LTAI prefix)', () => {
    const msg = 'upstream error: invalid signature for accessKey LTAIabcdefg1234567890XYZ';
    const out = redactSensitive(msg);
    expect(out).not.toContain('LTAIabcdefg1234567890XYZ');
    expect(out).toContain('LTAI[REDACTED]');
  });

  it('redacts LTAI keys embedded in JSON-like error previews', () => {
    const msg = '{"error":{"code":"InvalidAccessKey","message":"LTAI5tFooBarBaz123abcdef"}}';
    const out = redactSensitive(msg);
    expect(out).not.toContain('LTAI5tFooBarBaz123abcdef');
    expect(out).toMatch(/LTAI\[REDACTED\]/);
  });

  it('still redacts other secret formats (regression guard)', () => {
    expect(redactSensitive('Bearer abc.def.ghi')).toContain('Bearer [REDACTED]');
    expect(redactSensitive('sk-ant-api03-AAAAAAAAAAAA')).toContain('sk-ant-[REDACTED]');
    expect(redactSensitive('AKIAABCDEFGHIJKLMNOP')).toContain('AKIA[REDACTED]');
  });

  it('returns non-strings unchanged', () => {
    expect(redactSensitive(null)).toBe(null);
    expect(redactSensitive(42)).toBe(42);
  });
});

// ---------- stripControlChars (F22 rename) ----------

describe('stripControlChars', () => {
  it('strips C0/C1 control chars and trims', () => {
    expect(stripControlChars('hello\u0000world')).toBe('hello world');
    expect(stripControlChars('  trim me  ')).toBe('trim me');
  });

  it('truncates to maxLen', () => {
    expect(stripControlChars('a'.repeat(500), 10)).toBe('aaaaaaaaaa');
  });

  it('returns empty string for null/undefined', () => {
    expect(stripControlChars(null)).toBe('');
    expect(stripControlChars(undefined)).toBe('');
  });

  it('legacy alias sanitizeMentorField still works', () => {
    expect(sanitizeMentorField('x\u200by')).toBe('x y');
  });

  it('stripControlCharsArray bounds items and length', () => {
    const arr = Array.from({ length: 20 }, (_, i) => `item-${i}`);
    const out = stripControlCharsArray(arr, 10, 5);
    expect(out).toHaveLength(5);
    expect(out[0]).toBe('item-0');
  });

  it('legacy sanitizeMentorFieldArray alias still works', () => {
    expect(sanitizeMentorFieldArray(['a', 'b'])).toEqual(['a', 'b']);
  });

  it('stripControlCharsArray returns [] for non-arrays', () => {
    expect(stripControlCharsArray('not an array')).toEqual([]);
    expect(stripControlCharsArray(null)).toEqual([]);
  });
});

// ---------- F19 LLM circuit breaker ----------

describe('LLM circuit breaker (F19)', () => {
  const saved = {
    LLM_DISABLED: process.env.LLM_DISABLED,
    LLM_HOURLY_BUDGET: process.env.LLM_HOURLY_BUDGET,
  };
  beforeEach(() => {
    delete process.env.LLM_DISABLED;
    delete process.env.LLM_HOURLY_BUDGET;
    _resetLlmCircuitBreaker();
  });
  afterEach(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    _resetLlmCircuitBreaker();
  });

  it('allows calls when budget is fresh', () => {
    expect(checkLlmCircuitBreaker().allowed).toBe(true);
  });

  it('blocks all calls when LLM_DISABLED=1 (kill switch)', () => {
    process.env.LLM_DISABLED = '1';
    const v = checkLlmCircuitBreaker();
    expect(v.allowed).toBe(false);
    expect(v.status).toBe(503);
    expect(v.retryAfter).toBeGreaterThan(0);
  });

  it('also accepts LLM_DISABLED=true', () => {
    process.env.LLM_DISABLED = 'true';
    expect(checkLlmCircuitBreaker().allowed).toBe(false);
  });

  it('opens after recordLlmCall exceeds LLM_HOURLY_BUDGET', () => {
    process.env.LLM_HOURLY_BUDGET = '5';
    for (let i = 0; i < 5; i += 1) {
      expect(checkLlmCircuitBreaker().allowed).toBe(true);
      recordLlmCall(1);
    }
    const v = checkLlmCircuitBreaker();
    expect(v.allowed).toBe(false);
    expect(v.status).toBe(503);
    expect(v.reason).toMatch(/budget exceeded/i);
  });

  it('getLlmHourlyBudget defaults to 1000 and honours env override', () => {
    expect(getLlmHourlyBudget()).toBe(1000);
    process.env.LLM_HOURLY_BUDGET = '50';
    expect(getLlmHourlyBudget()).toBe(50);
    process.env.LLM_HOURLY_BUDGET = '0';
    expect(getLlmHourlyBudget()).toBe(1000); // ignores non-positive
    process.env.LLM_HOURLY_BUDGET = 'abc';
    expect(getLlmHourlyBudget()).toBe(1000);
  });

  it('enforceLlmBreaker sends 503 + Retry-After when blocked', () => {
    process.env.LLM_DISABLED = '1';
    const res = mockRes();
    expect(enforceLlmBreaker(mockReq(), res)).toBe(false);
    expect(res._status).toBe(503);
    expect(res._headers['Retry-After']).toBeTruthy();
    expect(res._json.error).toMatch(/disabled/i);
  });

  it('enforceLlmBreaker passes through when allowed', () => {
    expect(enforceLlmBreaker(mockReq(), mockRes())).toBe(true);
  });

  it('recordLlmCall accepts arbitrary positive counts', () => {
    process.env.LLM_HOURLY_BUDGET = '10';
    recordLlmCall(7);
    recordLlmCall(2);
    expect(checkLlmCircuitBreaker().allowed).toBe(true);
    recordLlmCall(1);
    expect(checkLlmCircuitBreaker().allowed).toBe(false);
  });

  it('recordLlmCall coerces invalid counts to 1', () => {
    process.env.LLM_HOURLY_BUDGET = '2';
    recordLlmCall('not a number');
    recordLlmCall(NaN);
    expect(checkLlmCircuitBreaker().allowed).toBe(false);
  });
});
