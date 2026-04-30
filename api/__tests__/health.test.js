/**
 * Tests for api/health.js — GET /api/health liveness probe.
 *
 * Covers:
 *  - 200 with { ok:true, version, sha } shape on GET.
 *  - Same on HEAD (monitors often probe with HEAD).
 *  - 405 on POST/PUT/DELETE with Allow header.
 *  - Cache-Control: no-store header is always set on success.
 *  - No side effects: no fetch/DB calls — the handler completes
 *    synchronously from the request-response point of view.
 *  - sha prefers VERCEL_GIT_COMMIT_SHA, then GIT_SHA, then 'unknown'.
 *  - version is a non-empty string (falls back to 'unknown' if missing).
 */

const handler = require('../health.js');

/** Minimal res mock compatible with Vercel/Express-style handlers. */
function mockRes() {
  const res = {
    statusCode: 200,
    headers: {},
    body: undefined,
    ended: false,
    setHeader(k, v) { this.headers[k.toLowerCase()] = v; },
    status(code) { this.statusCode = code; return this; },
    json(body) {
      // Vercel/Express `res.json` sets Content-Type when not already set.
      if (!this.headers['content-type']) {
        this.headers['content-type'] = 'application/json; charset=utf-8';
      }
      this.body = body;
      this.ended = true;
      return this;
    },
    end(body) { if (body !== undefined) this.body = body; this.ended = true; return this; },
  };
  return res;
}

describe('api/health', () => {
  const savedEnv = {
    VERCEL_GIT_COMMIT_SHA: process.env.VERCEL_GIT_COMMIT_SHA,
    GIT_SHA: process.env.GIT_SHA,
  };

  beforeEach(() => {
    delete process.env.VERCEL_GIT_COMMIT_SHA;
    delete process.env.GIT_SHA;
  });

  afterEach(() => {
    if (savedEnv.VERCEL_GIT_COMMIT_SHA === undefined) delete process.env.VERCEL_GIT_COMMIT_SHA;
    else process.env.VERCEL_GIT_COMMIT_SHA = savedEnv.VERCEL_GIT_COMMIT_SHA;
    if (savedEnv.GIT_SHA === undefined) delete process.env.GIT_SHA;
    else process.env.GIT_SHA = savedEnv.GIT_SHA;
  });

  it('GET returns 200 with { ok:true, version, sha } shape', () => {
    const res = mockRes();
    handler({ method: 'GET', headers: {} }, res);
    expect(res.statusCode).toBe(200);
    expect(res.body).toBeDefined();
    expect(res.body.ok).toBe(true);
    expect(typeof res.body.version).toBe('string');
    expect(res.body.version.length).toBeGreaterThan(0);
    expect(typeof res.body.sha).toBe('string');
  });

  it('sets Cache-Control: no-store', () => {
    const res = mockRes();
    handler({ method: 'GET', headers: {} }, res);
    expect(res.headers['cache-control']).toBe('no-store');
  });

  it('emits application/json Content-Type via res.json', () => {
    // F63-backend (U8.1 R2): contract-locks the JSON content type so a
    // future change that swaps res.json for res.end won't silently flip
    // the response to text/plain.
    const res = mockRes();
    handler({ method: 'GET', headers: {} }, res);
    expect(res.headers['content-type']).toMatch(/^application\/json/);
  });

  it('HEAD is allowed (monitors often use HEAD)', () => {
    const res = mockRes();
    handler({ method: 'HEAD', headers: {} }, res);
    expect(res.statusCode).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it('rejects non-GET/HEAD with 405 + Allow header', () => {
    for (const method of ['POST', 'PUT', 'DELETE', 'PATCH']) {
      const res = mockRes();
      handler({ method, headers: {} }, res);
      expect(res.statusCode).toBe(405);
      expect(res.headers.allow).toBe('GET, HEAD');
      expect(res.body).toEqual({ error: 'Method not allowed' });
    }
  });

  it('prefers VERCEL_GIT_COMMIT_SHA for sha', () => {
    process.env.VERCEL_GIT_COMMIT_SHA = 'abc1234';
    process.env.GIT_SHA = 'should-not-win';
    const res = mockRes();
    handler({ method: 'GET', headers: {} }, res);
    expect(res.body.sha).toBe('abc1234');
  });

  it('falls back to GIT_SHA when VERCEL_GIT_COMMIT_SHA is missing', () => {
    process.env.GIT_SHA = 'local-sha';
    const res = mockRes();
    handler({ method: 'GET', headers: {} }, res);
    expect(res.body.sha).toBe('local-sha');
  });

  it("falls back to 'unknown' sha when neither env is set", () => {
    const res = mockRes();
    handler({ method: 'GET', headers: {} }, res);
    expect(res.body.sha).toBe('unknown');
  });

  it('has no side effects (no fetch, no upstream, completes synchronously)', () => {
    const origFetch = global.fetch;
    let fetchCalled = false;
    global.fetch = () => { fetchCalled = true; return Promise.resolve(); };
    try {
      const res = mockRes();
      const ret = handler({ method: 'GET', headers: {} }, res);
      // The handler should return undefined (no Promise) — it's pure sync.
      expect(ret).toBeUndefined();
      expect(fetchCalled).toBe(false);
      expect(res.ended).toBe(true);
    } finally {
      global.fetch = origFetch;
    }
  });

  it('tolerates a missing req.method (Node raw http edge case)', () => {
    const res = mockRes();
    handler({ headers: {} }, res);
    expect(res.statusCode).toBe(200);
    expect(res.body.ok).toBe(true);
  });
});
