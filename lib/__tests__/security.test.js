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
  _resetRateLimitBuckets,
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
    expect(enforceRateLimit(mockReq(), denyRes, options)).toBe(false);
    expect(denyRes._status).toBe(429);
    expect(denyRes._headers['Retry-After']).toBeTruthy();
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

  it('passes through a normal POST request in test mode', () => {
    process.env.NODE_ENV = 'test';
    const req = mockReq({ method: 'POST' });
    const res = mockRes();
    expect(applyApiSecurity(req, res, { maxBodyBytes: '1mb' })).toBe(true);
    expect(res._headers['Access-Control-Allow-Origin']).toBe('*');
  });

  it('short-circuits OPTIONS requests (returns false, 204 sent)', () => {
    const req = mockReq({ method: 'OPTIONS' });
    const res = mockRes();
    expect(applyApiSecurity(req, res, {})).toBe(false);
    expect(res.statusCode).toBe(204);
  });

  it('short-circuits oversized requests (returns false, 413 sent)', () => {
    const req = mockReq({ headers: { 'content-length': String(2 * 1024 * 1024) } });
    const res = mockRes();
    expect(applyApiSecurity(req, res, { maxBodyBytes: '1mb' })).toBe(false);
    expect(res._status).toBe(413);
  });

  it('respects NODE_ENV=test to skip rate limiting', () => {
    process.env.NODE_ENV = 'test';
    const opts = { rateLimit: { capacity: 1, refillPerSecond: 0 } };
    // Hit it 5 times — should all pass because rate limit is disabled in test env
    for (let i = 0; i < 5; i += 1) {
      const res = mockRes();
      expect(applyApiSecurity(mockReq(), res, opts)).toBe(true);
    }
  });

  it('respects DISABLE_RATE_LIMIT=1 to skip rate limiting', () => {
    delete process.env.NODE_ENV;
    process.env.DISABLE_RATE_LIMIT = '1';
    const opts = { rateLimit: { capacity: 1, refillPerSecond: 0 } };
    for (let i = 0; i < 5; i += 1) {
      const res = mockRes();
      expect(applyApiSecurity(mockReq(), res, opts)).toBe(true);
    }
  });

  it('rate-limits when not in test mode', () => {
    delete process.env.NODE_ENV;
    delete process.env.DISABLE_RATE_LIMIT;
    const opts = { rateLimit: { capacity: 2, refillPerSecond: 0, key: 'apitest' } };
    expect(applyApiSecurity(mockReq(), mockRes(), opts)).toBe(true);
    expect(applyApiSecurity(mockReq(), mockRes(), opts)).toBe(true);
    const denyRes = mockRes();
    expect(applyApiSecurity(mockReq(), denyRes, opts)).toBe(false);
    expect(denyRes._status).toBe(429);
  });

  it('allows callers to opt out of rate limiting entirely', () => {
    delete process.env.NODE_ENV;
    delete process.env.DISABLE_RATE_LIMIT;
    const opts = { rateLimit: false };
    for (let i = 0; i < 10; i += 1) {
      expect(applyApiSecurity(mockReq(), mockRes(), opts)).toBe(true);
    }
  });
});
