/**
 * Tests for api/mentor-image.js
 *
 * No real network calls. Tests validation, helper functions, cache paths,
 * and error responses.
 */

const { vi } = await import('vitest');
const fs = require('fs');
const path = require('path');

// We need to mock fs and the network layer before importing the handler.
// Since the handler uses raw http/https.get + fs at module scope for CACHE_DIR,
// we mock at the function-call level.

const handler = require('../mentor-image.js');

function mockReq(overrides = {}) {
  return { method: 'GET', query: {}, headers: {}, ...overrides };
}

function mockRes() {
  const res = {
    _status: null,
    _json: null,
    _headers: {},
    _body: null,
    _piped: false,
    statusCode: 200,
    status(code) { res._status = code; return res; },
    json(data) { res._json = data; return res; },
    setHeader(key, val) { res._headers[key] = val; return res; },
    end(data) { res._body = data; return res; },
    // For pipe support
    write() {},
    on() { return res; },
    once() { return res; },
    emit() { return res; },
  };
  return res;
}

// ---------------------------------------------------------------------------
// Helper function tests (via module internals exposed through behavior)
// ---------------------------------------------------------------------------
describe('mentor-image validation', () => {
  it('returns 400 when name is missing', async () => {
    const res = mockRes();
    await handler(mockReq({ query: {} }), res);
    expect(res._status).toBe(400);
    expect(res._json.error).toMatch(/name.*required/i);
  });

  it('returns 400 when name is empty string', async () => {
    const res = mockRes();
    await handler(mockReq({ query: { name: '' } }), res);
    expect(res._status).toBe(400);
  });

  it('returns 400 when name is whitespace only', async () => {
    const res = mockRes();
    await handler(mockReq({ query: { name: '   ' } }), res);
    expect(res._status).toBe(400);
  });

  it('returns 400 when name produces empty slug (special chars only)', async () => {
    const res = mockRes();
    await handler(mockReq({ query: { name: '!!!@@@###' } }), res);
    expect(res._status).toBe(400);
    expect(res._json.error).toMatch(/invalid name/i);
  });
});

describe('mentor-image cached file serving', () => {
  const CACHE_DIR = path.resolve(__dirname, '../../public/assets/mentors');

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('serves cached jpg file with correct content-type and cache-control', async () => {
    const slug = 'lisa-su';
    const cachedPath = path.join(CACHE_DIR, slug + '.jpg');

    // Mock fs.existsSync to say the .jpg cache file exists
    vi.spyOn(fs, 'existsSync').mockImplementation((p) => p === cachedPath);

    // Mock fs.createReadStream to return a mock readable
    const mockStream = {
      on() { return mockStream; },
      pipe(dest) { dest._piped = true; return dest; },
    };
    vi.spyOn(fs, 'createReadStream').mockReturnValue(mockStream);

    const res = mockRes();
    await handler(mockReq({ query: { name: 'Lisa Su' } }), res);

    expect(res._headers['Content-Type']).toBe('image/jpeg');
    expect(res._headers['Cache-Control']).toContain('604800');
    expect(res._piped).toBe(true);
  });

  it('serves cached png file with correct mime', async () => {
    const slug = 'elon-musk';
    const jpgPath = path.join(CACHE_DIR, slug + '.jpg');
    const pngPath = path.join(CACHE_DIR, slug + '.png');

    vi.spyOn(fs, 'existsSync').mockImplementation((p) => {
      if (p === jpgPath) return false;
      if (p === pngPath) return true;
      return false;
    });

    const mockStream = { on() { return mockStream; }, pipe(dest) { dest._piped = true; return dest; } };
    vi.spyOn(fs, 'createReadStream').mockReturnValue(mockStream);

    const res = mockRes();
    await handler(mockReq({ query: { name: 'Elon Musk' } }), res);

    expect(res._headers['Content-Type']).toBe('image/png');
  });

  it('serves cached webp file with correct mime', async () => {
    const slug = 'bill-gates';
    const jpgPath = path.join(CACHE_DIR, slug + '.jpg');
    const pngPath = path.join(CACHE_DIR, slug + '.png');
    const webpPath = path.join(CACHE_DIR, slug + '.webp');

    vi.spyOn(fs, 'existsSync').mockImplementation((p) => {
      if (p === webpPath) return true;
      return false;
    });

    const mockStream = { on() { return mockStream; }, pipe(dest) { dest._piped = true; return dest; } };
    vi.spyOn(fs, 'createReadStream').mockReturnValue(mockStream);

    const res = mockRes();
    await handler(mockReq({ query: { name: 'Bill Gates' } }), res);

    expect(res._headers['Content-Type']).toBe('image/webp');
  });
});

describe('mentor-image Wikipedia lookup (no cache)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns 404 when no Wikipedia image is found', async () => {
    // No cache hit
    vi.spyOn(fs, 'existsSync').mockReturnValue(false);

    const https = require('https');
    vi.spyOn(https, 'get').mockImplementation((url, opts, callback) => {
      const mockResponse = {
        statusCode: 200,
        headers: { 'content-type': 'application/json' },
        on(event, handler) {
          if (event === 'data') {
            handler(Buffer.from(JSON.stringify({ title: 'Nobody', extract: 'text' })));
          }
          if (event === 'end') handler();
          return mockResponse;
        },
        resume() {},
      };
      if (typeof opts === 'function') {
        callback = opts;
      }
      callback(mockResponse);
      return { on() {}, destroy() {} };
    });

    const res = mockRes();
    await handler(mockReq({ query: { name: 'Completely Unknown Person XYZ123' } }), res);
    expect(res._status).toBe(404);
    expect(res._json.error).toMatch(/no image/i);
  });

  it('fetches from Wikipedia, caches to disk, and serves the image', async () => {
    vi.spyOn(fs, 'existsSync').mockReturnValue(false);
    vi.spyOn(fs, 'mkdirSync').mockReturnValue(undefined);
    vi.spyOn(fs, 'writeFileSync').mockReturnValue(undefined);

    const https = require('https');
    let callIndex = 0;
    vi.spyOn(https, 'get').mockImplementation((url, opts, callback) => {
      callIndex += 1;
      if (typeof opts === 'function') {
        callback = opts;
      }

      if (callIndex === 1) {
        // First call: Wikipedia REST API summary with thumbnail
        const summaryData = {
          title: 'Test Person',
          thumbnail: { source: 'https://upload.wikimedia.org/thumb/100px-Test.jpg' },
        };
        const mockResponse = {
          statusCode: 200,
          headers: { 'content-type': 'application/json' },
          on(event, handler) {
            if (event === 'data') handler(Buffer.from(JSON.stringify(summaryData)));
            if (event === 'end') handler();
            return mockResponse;
          },
          resume() {},
        };
        callback(mockResponse);
      } else {
        // Subsequent calls: fetch the actual image bytes
        const fakeImageBuffer = Buffer.alloc(200, 0xFF);
        const mockResponse = {
          statusCode: 200,
          headers: { 'content-type': 'image/jpeg' },
          on(event, handler) {
            if (event === 'data') handler(fakeImageBuffer);
            if (event === 'end') handler();
            return mockResponse;
          },
          resume() {},
        };
        callback(mockResponse);
      }
      return { on() {}, destroy() {} };
    });

    const res = mockRes();
    await handler(mockReq({ query: { name: 'Test Person' } }), res);

    expect(res._headers['Content-Type']).toBe('image/jpeg');
    expect(res._headers['Cache-Control']).toContain('604800');
    expect(res._body).toBeTruthy();
    expect(res._body.length).toBeGreaterThanOrEqual(100);
    expect(fs.mkdirSync).toHaveBeenCalled();
    expect(fs.writeFileSync).toHaveBeenCalled();
  });

  it('returns 502 when image fetch fails (buffer too small)', async () => {
    vi.spyOn(fs, 'existsSync').mockReturnValue(false);

    const https = require('https');
    let callIndex = 0;
    vi.spyOn(https, 'get').mockImplementation((url, opts, callback) => {
      callIndex += 1;
      if (typeof opts === 'function') {
        callback = opts;
      }

      if (callIndex === 1) {
        // Wikipedia summary with thumbnail
        const summaryData = {
          title: 'Broken',
          thumbnail: { source: 'https://upload.wikimedia.org/thumb/100px-Broken.jpg' },
        };
        const mockResponse = {
          statusCode: 200,
          headers: { 'content-type': 'application/json' },
          on(event, handler) {
            if (event === 'data') handler(Buffer.from(JSON.stringify(summaryData)));
            if (event === 'end') handler();
            return mockResponse;
          },
          resume() {},
        };
        callback(mockResponse);
      } else {
        // Image fetch returns tiny buffer (< 100 bytes)
        const tinyBuffer = Buffer.alloc(10, 0x00);
        const mockResponse = {
          statusCode: 200,
          headers: { 'content-type': 'image/jpeg' },
          on(event, handler) {
            if (event === 'data') handler(tinyBuffer);
            if (event === 'end') handler();
            return mockResponse;
          },
          resume() {},
        };
        callback(mockResponse);
      }
      return { on() {}, destroy() {} };
    });

    const res = mockRes();
    await handler(mockReq({ query: { name: 'Broken Image' } }), res);

    expect(res._status).toBe(502);
    expect(res._json.error).toMatch(/failed to fetch/i);
  });

  it('uses search API fallback when REST summary has no thumbnail', async () => {
    vi.spyOn(fs, 'existsSync').mockReturnValue(false);
    vi.spyOn(fs, 'mkdirSync').mockReturnValue(undefined);
    vi.spyOn(fs, 'writeFileSync').mockReturnValue(undefined);

    const https = require('https');
    let callIndex = 0;
    vi.spyOn(https, 'get').mockImplementation((url, opts, callback) => {
      callIndex += 1;
      if (typeof opts === 'function') {
        callback = opts;
      }

      if (callIndex === 1) {
        // REST summary with NO thumbnail
        const summaryData = { title: 'Obscure Person', extract: 'Some text' };
        const mockResponse = {
          statusCode: 200,
          headers: { 'content-type': 'application/json' },
          on(event, handler) {
            if (event === 'data') handler(Buffer.from(JSON.stringify(summaryData)));
            if (event === 'end') handler();
            return mockResponse;
          },
          resume() {},
        };
        callback(mockResponse);
      } else if (callIndex === 2) {
        // Search API returns results
        const searchData = {
          query: { search: [{ title: 'Obscure Person (scientist)' }] },
        };
        const mockResponse = {
          statusCode: 200,
          headers: { 'content-type': 'application/json' },
          on(event, handler) {
            if (event === 'data') handler(Buffer.from(JSON.stringify(searchData)));
            if (event === 'end') handler();
            return mockResponse;
          },
          resume() {},
        };
        callback(mockResponse);
      } else if (callIndex === 3) {
        // Page images query returns thumbnail
        const pageData = {
          query: {
            pages: {
              '123': {
                title: 'Obscure Person (scientist)',
                thumbnail: { source: 'https://upload.wikimedia.org/thumb/Obscure.jpg' },
              },
            },
          },
        };
        const mockResponse = {
          statusCode: 200,
          headers: { 'content-type': 'application/json' },
          on(event, handler) {
            if (event === 'data') handler(Buffer.from(JSON.stringify(pageData)));
            if (event === 'end') handler();
            return mockResponse;
          },
          resume() {},
        };
        callback(mockResponse);
      } else {
        // Fetch the actual image
        const fakeImage = Buffer.alloc(200, 0xFF);
        const mockResponse = {
          statusCode: 200,
          headers: { 'content-type': 'image/png' },
          on(event, handler) {
            if (event === 'data') handler(fakeImage);
            if (event === 'end') handler();
            return mockResponse;
          },
          resume() {},
        };
        callback(mockResponse);
      }
      return { on() {}, destroy() {} };
    });

    const res = mockRes();
    await handler(mockReq({ query: { name: 'Obscure Person' } }), res);

    expect(res._headers['Content-Type']).toBe('image/png');
    expect(res._body).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// Slug generation behavior (tested through handler validation)
// ---------------------------------------------------------------------------
describe('slug generation via handler behavior', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('normalizes names with mixed case and spaces', async () => {
    // If we pass "Lisa   Su", the slug should be "lisa-su"
    // Verify by checking cache lookup path
    const CACHE_DIR = path.resolve(__dirname, '../../public/assets/mentors');
    const expectedCachedPath = path.join(CACHE_DIR, 'lisa-su.jpg');

    vi.spyOn(fs, 'existsSync').mockImplementation((p) => p === expectedCachedPath);
    const mockStream = { on() { return mockStream; }, pipe(dest) { dest._piped = true; return dest; } };
    vi.spyOn(fs, 'createReadStream').mockReturnValue(mockStream);

    const res = mockRes();
    await handler(mockReq({ query: { name: '  Lisa   Su  ' } }), res);

    // If the slug was correctly generated, it found the cached file
    expect(res._piped).toBe(true);
  });

  it('strips special characters from slug', async () => {
    const CACHE_DIR = path.resolve(__dirname, '../../public/assets/mentors');
    const expectedPath = path.join(CACHE_DIR, 'dr-jane-doe.jpg');

    vi.spyOn(fs, 'existsSync').mockImplementation((p) => p === expectedPath);
    const mockStream = { on() { return mockStream; }, pipe(dest) { dest._piped = true; return dest; } };
    vi.spyOn(fs, 'createReadStream').mockReturnValue(mockStream);

    const res = mockRes();
    await handler(mockReq({ query: { name: 'Dr. Jane Doe!' } }), res);
    expect(res._piped).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// fetchBuffer edge cases: redirect, 429 retry, non-200, fetchJson parse error
// ---------------------------------------------------------------------------
describe('fetchBuffer redirect following', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('follows 301 redirect to a new URL', async () => {
    vi.spyOn(fs, 'existsSync').mockReturnValue(false);
    vi.spyOn(fs, 'mkdirSync').mockReturnValue(undefined);
    vi.spyOn(fs, 'writeFileSync').mockReturnValue(undefined);

    const https = require('https');
    let callIndex = 0;
    vi.spyOn(https, 'get').mockImplementation((url, opts, callback) => {
      callIndex += 1;
      if (typeof opts === 'function') {
        callback = opts;
      }

      if (callIndex === 1) {
        // Wikipedia REST summary with thumbnail pointing to redirect URL
        const summaryData = {
          title: 'Redirect Person',
          thumbnail: { source: 'https://upload.wikimedia.org/thumb/Redirect.jpg' },
        };
        const mockResponse = {
          statusCode: 200,
          headers: { 'content-type': 'application/json' },
          on(event, handler) {
            if (event === 'data') handler(Buffer.from(JSON.stringify(summaryData)));
            if (event === 'end') handler();
            return mockResponse;
          },
          resume() {},
        };
        callback(mockResponse);
      } else if (callIndex === 2) {
        // Image fetch returns 301 redirect
        const mockResponse = {
          statusCode: 301,
          headers: { location: 'https://upload.wikimedia.org/final/Redirect.jpg' },
          on() { return mockResponse; },
          resume() {},
        };
        callback(mockResponse);
      } else {
        // Final fetch after redirect — actual image
        const fakeImage = Buffer.alloc(200, 0xFF);
        const mockResponse = {
          statusCode: 200,
          headers: { 'content-type': 'image/jpeg' },
          on(event, handler) {
            if (event === 'data') handler(fakeImage);
            if (event === 'end') handler();
            return mockResponse;
          },
          resume() {},
        };
        callback(mockResponse);
      }
      return { on() {}, destroy() {} };
    });

    const res = mockRes();
    await handler(mockReq({ query: { name: 'Redirect Person' } }), res);

    expect(res._headers['Content-Type']).toBe('image/jpeg');
    expect(res._body).toBeTruthy();
  });

  it('handles 429 rate limit with retry', async () => {
    vi.spyOn(fs, 'existsSync').mockReturnValue(false);
    vi.spyOn(fs, 'mkdirSync').mockReturnValue(undefined);
    vi.spyOn(fs, 'writeFileSync').mockReturnValue(undefined);
    vi.useFakeTimers();

    const https = require('https');
    let callIndex = 0;
    vi.spyOn(https, 'get').mockImplementation((url, opts, callback) => {
      callIndex += 1;
      if (typeof opts === 'function') {
        callback = opts;
      }

      if (callIndex === 1) {
        // Wikipedia REST summary with thumbnail
        const summaryData = {
          title: 'Rate Limited',
          thumbnail: { source: 'https://upload.wikimedia.org/thumb/RateLimit.jpg' },
        };
        const mockResponse = {
          statusCode: 200,
          headers: { 'content-type': 'application/json' },
          on(event, handler) {
            if (event === 'data') handler(Buffer.from(JSON.stringify(summaryData)));
            if (event === 'end') handler();
            return mockResponse;
          },
          resume() {},
        };
        callback(mockResponse);
      } else if (callIndex === 2) {
        // First image fetch attempt — 429
        const mockResponse = {
          statusCode: 429,
          headers: {},
          on() { return mockResponse; },
          resume() {},
        };
        callback(mockResponse);
        // Advance timer to trigger retry
        vi.advanceTimersByTime(3000);
      } else {
        // Retry succeeds
        const fakeImage = Buffer.alloc(200, 0xFF);
        const mockResponse = {
          statusCode: 200,
          headers: { 'content-type': 'image/jpeg' },
          on(event, handler) {
            if (event === 'data') handler(fakeImage);
            if (event === 'end') handler();
            return mockResponse;
          },
          resume() {},
        };
        callback(mockResponse);
      }
      return { on() {}, destroy() {} };
    });

    const res = mockRes();
    const resultPromise = handler(mockReq({ query: { name: 'Rate Limited' } }), res);
    await vi.runAllTimersAsync();
    await resultPromise;

    vi.useRealTimers();

    // Verify the retry happened EXACTLY once: summary lookup → 429 → retry.
    // An exact count catches both "no retry" (<3) and "runaway retry loop"
    // (>3) regressions.
    expect(callIndex).toBe(3);
    // Verify the eventual successful response was served
    expect(res._headers['Content-Type']).toBe('image/jpeg');
    expect(res._body).toBeTruthy();
    expect(res._body.length).toBeGreaterThan(100);
  });

  it('returns null (404) for non-200 status codes', async () => {
    vi.spyOn(fs, 'existsSync').mockReturnValue(false);

    const https = require('https');
    vi.spyOn(https, 'get').mockImplementation((url, opts, callback) => {
      if (typeof opts === 'function') {
        callback = opts;
      }
      // All requests return 403
      const mockResponse = {
        statusCode: 403,
        headers: {},
        on() { return mockResponse; },
        resume() {},
      };
      callback(mockResponse);
      return { on() {}, destroy() {} };
    });

    const res = mockRes();
    await handler(mockReq({ query: { name: 'Forbidden Person' } }), res);

    // fetchBuffer returns null for non-200 → no Wikipedia image found → 404
    expect(res._status).toBe(404);
  });

  it('rejects http:// Wikimedia thumbnails (BYPASS-7: https only)', async () => {
    // Exercise the `url.startsWith('https') ? https : http` ternary's http branch
    vi.spyOn(fs, 'existsSync').mockReturnValue(false);
    vi.spyOn(fs, 'mkdirSync').mockReturnValue(undefined);
    vi.spyOn(fs, 'writeFileSync').mockReturnValue(undefined);

    const https = require('https');
    const http = require('http');

    // Wikipedia REST API (https) returns a summary pointing to an http:// thumbnail URL.
    // Must be on an allowlisted host — bug #5 SSRF fix rejects any host not in
    // ALLOWED_HOSTS/ALLOWED_HOST_SUFFIXES before fetch. upload.wikimedia.org is
    // allowlisted; the test is verifying the scheme branch (http vs https), not
    // the allowlist.
    vi.spyOn(https, 'get').mockImplementation((url, opts, callback) => {
      if (typeof opts === 'function') callback = opts;
      const summaryData = {
        title: 'HTTP Person',
        thumbnail: { source: 'http://upload.wikimedia.org/thumb/100px-HttpPerson.jpg' },
      };
      const mockResponse = {
        statusCode: 200,
        headers: { 'content-type': 'application/json' },
        on(event, handler) {
          if (event === 'data') handler(Buffer.from(JSON.stringify(summaryData)));
          if (event === 'end') handler();
          return mockResponse;
        },
        resume() {},
      };
      callback(mockResponse);
      return { on() {}, destroy() {} };
    });

    // http.get must NEVER be invoked after BYPASS-7 — isAllowedUrl rejects
    // plain http:// outright. The handler should see no valid candidate URL
    // and return 502 "failed to fetch image".
    const httpGetSpy = vi.spyOn(http, 'get').mockImplementation((url, opts, callback) => {
      if (typeof opts === 'function') callback = opts;
      const fakeImage = Buffer.alloc(200, 0xAB);
      const mockResponse = {
        statusCode: 200,
        headers: { 'content-type': 'image/jpeg' },
        on(event, handler) {
          if (event === 'data') handler(fakeImage);
          if (event === 'end') handler();
          return mockResponse;
        },
        resume() {},
      };
      callback(mockResponse);
      return { on() {}, destroy() {} };
    });

    const res = mockRes();
    await handler(mockReq({ query: { name: 'HTTP Person' } }), res);

    // BYPASS-7: http module must not be called
    expect(httpGetSpy).not.toHaveBeenCalled();
    // Handler falls through to the "no image" 502 path.
    expect(res._status).toBe(502);
    expect(res._json.error).toMatch(/failed to fetch/i);
  });

  it('caches as .webp when content-type includes webp', async () => {
    // Exercise extFromContentType webp branch (line 37)
    vi.spyOn(fs, 'existsSync').mockReturnValue(false);
    vi.spyOn(fs, 'mkdirSync').mockReturnValue(undefined);
    const writeSpy = vi.spyOn(fs, 'writeFileSync').mockReturnValue(undefined);

    const https = require('https');
    let callIndex = 0;
    vi.spyOn(https, 'get').mockImplementation((url, opts, callback) => {
      callIndex += 1;
      if (typeof opts === 'function') callback = opts;
      if (callIndex === 1) {
        // Summary with thumbnail
        const summaryData = {
          title: 'Webp Person',
          thumbnail: { source: 'https://upload.wikimedia.org/thumb/100px-Webp.webp' },
        };
        const mockResponse = {
          statusCode: 200,
          headers: { 'content-type': 'application/json' },
          on(event, handler) {
            if (event === 'data') handler(Buffer.from(JSON.stringify(summaryData)));
            if (event === 'end') handler();
            return mockResponse;
          },
          resume() {},
        };
        callback(mockResponse);
      } else {
        // Image with webp content-type
        const fakeImage = Buffer.alloc(200, 0xAA);
        const mockResponse = {
          statusCode: 200,
          headers: { 'content-type': 'image/webp' },
          on(event, handler) {
            if (event === 'data') handler(fakeImage);
            if (event === 'end') handler();
            return mockResponse;
          },
          resume() {},
        };
        callback(mockResponse);
      }
      return { on() {}, destroy() {} };
    });

    const res = mockRes();
    await handler(mockReq({ query: { name: 'Webp Person' } }), res);

    // Verify the cache file was written with .webp extension
    expect(writeSpy).toHaveBeenCalled();
    const writtenPath = writeSpy.mock.calls[0][0];
    expect(writtenPath).toMatch(/\.webp$/);
    expect(res._headers['Content-Type']).toBe('image/webp');
  });

  it('caches as .jpg when content-type header is missing (falls back to empty string → .jpg)', async () => {
    // Exercise extFromContentType !ct branch (line 35) via line 81 `|| ''` fallback
    vi.spyOn(fs, 'existsSync').mockReturnValue(false);
    vi.spyOn(fs, 'mkdirSync').mockReturnValue(undefined);
    const writeSpy = vi.spyOn(fs, 'writeFileSync').mockReturnValue(undefined);

    const https = require('https');
    let callIndex = 0;
    vi.spyOn(https, 'get').mockImplementation((url, opts, callback) => {
      callIndex += 1;
      if (typeof opts === 'function') callback = opts;
      if (callIndex === 1) {
        const summaryData = {
          title: 'No Content Type',
          thumbnail: { source: 'https://upload.wikimedia.org/thumb/100px-NoCT.jpg' },
        };
        const mockResponse = {
          statusCode: 200,
          headers: { 'content-type': 'application/json' },
          on(event, handler) {
            if (event === 'data') handler(Buffer.from(JSON.stringify(summaryData)));
            if (event === 'end') handler();
            return mockResponse;
          },
          resume() {},
        };
        callback(mockResponse);
      } else {
        // Image response with NO content-type header
        const fakeImage = Buffer.alloc(200, 0x11);
        const mockResponse = {
          statusCode: 200,
          headers: {}, // missing content-type
          on(event, handler) {
            if (event === 'data') handler(fakeImage);
            if (event === 'end') handler();
            return mockResponse;
          },
          resume() {},
        };
        callback(mockResponse);
      }
      return { on() {}, destroy() {} };
    });

    const res = mockRes();
    await handler(mockReq({ query: { name: 'No Content Type' } }), res);

    expect(writeSpy).toHaveBeenCalled();
    const writtenPath = writeSpy.mock.calls[0][0];
    expect(writtenPath).toMatch(/\.jpg$/);
  });

  it('returns single-URL array when thumbnail URL has no size marker (larger === original)', async () => {
    // Exercise findWikipediaImageUrl ternary branch: larger === original → [original]
    vi.spyOn(fs, 'existsSync').mockReturnValue(false);
    vi.spyOn(fs, 'mkdirSync').mockReturnValue(undefined);
    vi.spyOn(fs, 'writeFileSync').mockReturnValue(undefined);

    const https = require('https');
    let callIndex = 0;
    vi.spyOn(https, 'get').mockImplementation((url, opts, callback) => {
      callIndex += 1;
      if (typeof opts === 'function') callback = opts;
      if (callIndex === 1) {
        // Thumbnail URL has NO /\d+px-/ pattern
        const summaryData = {
          title: 'No Size Marker',
          thumbnail: { source: 'https://upload.wikimedia.org/original.jpg' },
        };
        const mockResponse = {
          statusCode: 200,
          headers: { 'content-type': 'application/json' },
          on(event, handler) {
            if (event === 'data') handler(Buffer.from(JSON.stringify(summaryData)));
            if (event === 'end') handler();
            return mockResponse;
          },
          resume() {},
        };
        callback(mockResponse);
      } else {
        const fakeImage = Buffer.alloc(200, 0xCC);
        const mockResponse = {
          statusCode: 200,
          headers: { 'content-type': 'image/jpeg' },
          on(event, handler) {
            if (event === 'data') handler(fakeImage);
            if (event === 'end') handler();
            return mockResponse;
          },
          resume() {},
        };
        callback(mockResponse);
      }
      return { on() {}, destroy() {} };
    });

    const res = mockRes();
    await handler(mockReq({ query: { name: 'No Size Marker' } }), res);

    expect(res._headers['Content-Type']).toBe('image/jpeg');
    expect(res._body).toBeTruthy();
    // Should have made exactly 2 calls: summary + image (no retries, single URL)
    expect(callIndex).toBe(2);
  });

  it('returns 404 when search API finds titles but pageimages query has no pages', async () => {
    // Exercise line 145 `pageData?.query?.pages ? Object.values(...) : []` falsy branch
    vi.spyOn(fs, 'existsSync').mockReturnValue(false);

    const https = require('https');
    let callIndex = 0;
    vi.spyOn(https, 'get').mockImplementation((url, opts, callback) => {
      callIndex += 1;
      if (typeof opts === 'function') callback = opts;

      if (callIndex === 1) {
        // REST summary: no thumbnail
        const mockResponse = {
          statusCode: 200,
          headers: { 'content-type': 'application/json' },
          on(event, handler) {
            if (event === 'data') handler(Buffer.from(JSON.stringify({ title: 'x' })));
            if (event === 'end') handler();
            return mockResponse;
          },
          resume() {},
        };
        callback(mockResponse);
      } else if (callIndex === 2) {
        // Search API returns one title
        const searchData = { query: { search: [{ title: 'Somebody' }] } };
        const mockResponse = {
          statusCode: 200,
          headers: { 'content-type': 'application/json' },
          on(event, handler) {
            if (event === 'data') handler(Buffer.from(JSON.stringify(searchData)));
            if (event === 'end') handler();
            return mockResponse;
          },
          resume() {},
        };
        callback(mockResponse);
      } else {
        // pageimages query returns an object WITHOUT query.pages
        const pageData = { batchcomplete: '' };
        const mockResponse = {
          statusCode: 200,
          headers: { 'content-type': 'application/json' },
          on(event, handler) {
            if (event === 'data') handler(Buffer.from(JSON.stringify(pageData)));
            if (event === 'end') handler();
            return mockResponse;
          },
          resume() {},
        };
        callback(mockResponse);
      }
      return { on() {}, destroy() {} };
    });

    const res = mockRes();
    await handler(mockReq({ query: { name: 'Page Missing' } }), res);

    expect(res._status).toBe(404);
  });

  it('returns 400 when name exceeds 200-char cap', async () => {
    // Exercises the length-cap guard (lines 228-231)
    const res = mockRes();
    await handler(mockReq({ query: { name: 'A'.repeat(201) } }), res);
    expect(res._status).toBe(400);
    expect(res._json.error).toMatch(/too long/i);
  });

  it('serves CJK-only name via sha1 hash-based slug fallback', async () => {
    // Exercises line 64 — crypto hash slug for names that normalize to empty
    // but contain letters (Unicode \p{L}).
    const CACHE_DIR = path.resolve(__dirname, '../../public/assets/mentors');
    const crypto = require('crypto');
    const cjkName = '张三丰';
    const expectedSlug = crypto.createHash('sha1').update(cjkName).digest('hex').slice(0, 16);
    const expectedPath = path.join(CACHE_DIR, expectedSlug + '.jpg');

    vi.spyOn(fs, 'existsSync').mockImplementation((p) => p === expectedPath);
    const mockStream = { on() { return mockStream; }, pipe(dest) { dest._piped = true; return dest; } };
    vi.spyOn(fs, 'createReadStream').mockReturnValue(mockStream);

    const res = mockRes();
    await handler(mockReq({ query: { name: cjkName } }), res);

    // If the hash-slug was correct, existsSync matched and we piped the cache
    expect(res._piped).toBe(true);
    expect(res._headers['Content-Type']).toBe('image/jpeg');
  });

  it('swallows fs.existsSync errors in findCached (cold-start /tmp missing)', async () => {
    // Exercises the empty catch block at lines 73-75
    const existsSpy = vi.spyOn(fs, 'existsSync').mockImplementation(() => {
      throw new Error('ENOENT: no such dir');
    });

    const https = require('https');
    vi.spyOn(https, 'get').mockImplementation((url, opts, callback) => {
      if (typeof opts === 'function') callback = opts;
      // Return summary without thumbnail → not found
      const mockResponse = {
        statusCode: 200,
        headers: { 'content-type': 'application/json' },
        on(event, handler) {
          if (event === 'data') handler(Buffer.from(JSON.stringify({ title: 'x' })));
          if (event === 'end') handler();
          return mockResponse;
        },
        resume() {},
      };
      callback(mockResponse);
      return { on() {}, destroy() {} };
    });

    const res = mockRes();
    await handler(mockReq({ query: { name: 'Cache Err Person' } }), res);

    // Existence checks were attempted (swallowed), then Wikipedia lookup ran,
    // found nothing → 404
    expect(existsSpy).toHaveBeenCalled();
    expect(res._status).toBe(404);
  });

  it('logs cache write failure but still serves buffer from memory', async () => {
    // Exercises lines 279-281 — fs.writeFileSync throws (read-only fs etc.)
    vi.spyOn(fs, 'existsSync').mockReturnValue(false);
    vi.spyOn(fs, 'mkdirSync').mockReturnValue(undefined);
    const writeErr = new Error('EROFS: read-only file system');
    writeErr.code = 'EROFS';
    vi.spyOn(fs, 'writeFileSync').mockImplementation(() => { throw writeErr; });
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const https = require('https');
    let callIndex = 0;
    vi.spyOn(https, 'get').mockImplementation((url, opts, callback) => {
      callIndex += 1;
      if (typeof opts === 'function') callback = opts;
      if (callIndex === 1) {
        const summaryData = {
          title: 'RO Person',
          thumbnail: { source: 'https://upload.wikimedia.org/thumb/100px-RO.jpg' },
        };
        const mockResponse = {
          statusCode: 200,
          headers: { 'content-type': 'application/json' },
          on(event, handler) {
            if (event === 'data') handler(Buffer.from(JSON.stringify(summaryData)));
            if (event === 'end') handler();
            return mockResponse;
          },
          resume() {},
        };
        callback(mockResponse);
      } else {
        const fakeImage = Buffer.alloc(200, 0xAA);
        const mockResponse = {
          statusCode: 200,
          headers: { 'content-type': 'image/jpeg' },
          on(event, handler) {
            if (event === 'data') handler(fakeImage);
            if (event === 'end') handler();
            return mockResponse;
          },
          resume() {},
        };
        callback(mockResponse);
      }
      return { on() {}, destroy() {} };
    });

    const res = mockRes();
    await handler(mockReq({ query: { name: 'RO Person' } }), res);

    // F57 (U8.1 R2): the legacy `console.warn('[mentor-image] cache write failed', ...)`
    // duplicate has been removed. The structured logger's 'warn' level routes
    // through console.warn — assert the JSON line carries the EROFS code.
    expect(warnSpy).toHaveBeenCalled();
    const structured = warnSpy.mock.calls.find((c) => {
      if (typeof c[0] !== 'string') return false;
      try {
        const p = JSON.parse(c[0]);
        return p.stage === 'cache_write' && p.errorCode === 'EROFS';
      } catch { return false; }
    });
    expect(structured).toBeTruthy();
    // Image still served from the in-memory buffer
    expect(res._headers['Content-Type']).toBe('image/jpeg');
    expect(res._body).toBeTruthy();
    expect(res._body.length).toBeGreaterThanOrEqual(100);
  });

  it('logs bare error (no .code) from cache write failure', async () => {
    // Exercises the `err && err.code ? err.code : err` branch when err has no
    // `code` property — ensures the raw error is logged as the fallback.
    vi.spyOn(fs, 'existsSync').mockReturnValue(false);
    vi.spyOn(fs, 'mkdirSync').mockReturnValue(undefined);
    vi.spyOn(fs, 'writeFileSync').mockImplementation(() => {
      // eslint-disable-next-line no-throw-literal
      throw 'string-error-no-code';
    });
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const https = require('https');
    let callIndex = 0;
    vi.spyOn(https, 'get').mockImplementation((url, opts, callback) => {
      callIndex += 1;
      if (typeof opts === 'function') callback = opts;
      if (callIndex === 1) {
        const summaryData = {
          title: 'No Code',
          thumbnail: { source: 'https://upload.wikimedia.org/thumb/100px-NoCode.jpg' },
        };
        const mockResponse = {
          statusCode: 200,
          headers: { 'content-type': 'application/json' },
          on(event, handler) {
            if (event === 'data') handler(Buffer.from(JSON.stringify(summaryData)));
            if (event === 'end') handler();
            return mockResponse;
          },
          resume() {},
        };
        callback(mockResponse);
      } else {
        const fakeImage = Buffer.alloc(200, 0xBB);
        const mockResponse = {
          statusCode: 200,
          headers: { 'content-type': 'image/jpeg' },
          on(event, handler) {
            if (event === 'data') handler(fakeImage);
            if (event === 'end') handler();
            return mockResponse;
          },
          resume() {},
        };
        callback(mockResponse);
      }
      return { on() {}, destroy() {} };
    });

    const res = mockRes();
    await handler(mockReq({ query: { name: 'No Code' } }), res);

    // F57 (U8.1 R2): the legacy console.warn duplicate that printed the
    // raw thrown string is gone. Assert the structured logger captured it
    // via errorMessageTruncated instead.
    expect(warnSpy).toHaveBeenCalled();
    const structured = warnSpy.mock.calls.find((c) => {
      if (typeof c[0] !== 'string') return false;
      try {
        const p = JSON.parse(c[0]);
        return p.stage === 'cache_write' && typeof p.errorMessageTruncated === 'string' && p.errorMessageTruncated.includes('string-error-no-code');
      } catch { return false; }
    });
    expect(structured).toBeTruthy();
    expect(res._body).toBeTruthy();
  });

  it('rejects thumbnail URL with non-http(s) scheme', async () => {
    // Exercises the protocol guard in isAllowedUrl (line 42) — ftp://, file://,
    // gopher://, etc. must be rejected even if the hostname is on the allowlist.
    vi.spyOn(fs, 'existsSync').mockReturnValue(false);

    const https = require('https');
    let callIndex = 0;
    vi.spyOn(https, 'get').mockImplementation((url, opts, callback) => {
      callIndex += 1;
      if (typeof opts === 'function') callback = opts;
      const summaryData = {
        title: 'FTP Person',
        // Host is allowlisted but scheme is ftp — must still be rejected
        thumbnail: { source: 'ftp://upload.wikimedia.org/evil.jpg' },
      };
      const mockResponse = {
        statusCode: 200,
        headers: { 'content-type': 'application/json' },
        on(event, handler) {
          if (event === 'data') handler(Buffer.from(JSON.stringify(summaryData)));
          if (event === 'end') handler();
          return mockResponse;
        },
        resume() {},
      };
      callback(mockResponse);
      return { on() {}, destroy() {} };
    });

    const res = mockRes();
    await handler(mockReq({ query: { name: 'FTP Person' } }), res);

    // Summary fetch happened; ftp:// thumbnail was blocked before https.get
    expect(callIndex).toBe(1);
    expect(res._status).toBe(502);
  });

  it('rejects unparseable thumbnail URL (isAllowedUrl catch branch)', async () => {
    // Exercises the catch {} in isAllowedUrl (lines 46-48). An invalid URL
    // string makes `new URL(url)` throw; fetchBuffer short-circuits to null.
    vi.spyOn(fs, 'existsSync').mockReturnValue(false);

    const https = require('https');
    let callIndex = 0;
    vi.spyOn(https, 'get').mockImplementation((url, opts, callback) => {
      callIndex += 1;
      if (typeof opts === 'function') callback = opts;
      // Only the summary fetch should run; the bogus thumbnail URL must be
      // rejected by isAllowedUrl before reaching https.get.
      const summaryData = {
        title: 'Bad URL Person',
        thumbnail: { source: 'not a url at all' },
      };
      const mockResponse = {
        statusCode: 200,
        headers: { 'content-type': 'application/json' },
        on(event, handler) {
          if (event === 'data') handler(Buffer.from(JSON.stringify(summaryData)));
          if (event === 'end') handler();
          return mockResponse;
        },
        resume() {},
      };
      callback(mockResponse);
      return { on() {}, destroy() {} };
    });

    const res = mockRes();
    await handler(mockReq({ query: { name: 'Bad URL Person' } }), res);

    // Only the summary fetch happened. The unparseable thumbnail never reached https.get.
    expect(callIndex).toBe(1);
    expect(res._status).toBe(502);
  });

  it('rejects Wikipedia thumbnail pointing to non-allowlisted host (SSRF guard)', async () => {
    // Exercises isAllowedUrl → false path (lines 101-103) inside fetchBuffer.
    // The REST summary points the thumbnail at attacker.example.com; fetchBuffer
    // short-circuits to resolve(null) and the handler returns 502 after the image
    // fetch loop fails.
    vi.spyOn(fs, 'existsSync').mockReturnValue(false);

    const https = require('https');
    let callIndex = 0;
    vi.spyOn(https, 'get').mockImplementation((url, opts, callback) => {
      callIndex += 1;
      if (typeof opts === 'function') callback = opts;
      // Only the Wikipedia REST summary (on allowlisted host) should be hit.
      // The follow-up fetchBuffer for the attacker thumbnail must NEVER reach
      // https.get because isAllowedUrl filters it out first.
      const summaryData = {
        title: 'SSRF Person',
        thumbnail: { source: 'https://attacker.example.com/thumb/100px-Evil.jpg' },
      };
      const mockResponse = {
        statusCode: 200,
        headers: { 'content-type': 'application/json' },
        on(event, handler) {
          if (event === 'data') handler(Buffer.from(JSON.stringify(summaryData)));
          if (event === 'end') handler();
          return mockResponse;
        },
        resume() {},
      };
      callback(mockResponse);
      return { on() {}, destroy() {} };
    });

    const res = mockRes();
    await handler(mockReq({ query: { name: 'SSRF Person' } }), res);

    // Only the summary fetch should have gone out, no second hit for the evil URL
    expect(callIndex).toBe(1);
    // Handler returns 502 (no image candidates succeeded)
    expect(res._status).toBe(502);
  });

  it('rejects redirect Location pointing to non-allowlisted host (SSRF redirect guard)', async () => {
    // Exercises lines 127-130 — redirect target not on allowlist → resolve null.
    vi.spyOn(fs, 'existsSync').mockReturnValue(false);

    const https = require('https');
    let callIndex = 0;
    vi.spyOn(https, 'get').mockImplementation((url, opts, callback) => {
      callIndex += 1;
      if (typeof opts === 'function') callback = opts;

      if (callIndex === 1) {
        const summaryData = {
          title: 'Evil Redirect',
          // No /\d+px-/ size marker → findWikipediaImageUrl returns a single
          // candidate URL, so the redirect guard is exercised exactly once.
          thumbnail: { source: 'https://upload.wikimedia.org/evil.jpg' },
        };
        const mockResponse = {
          statusCode: 200,
          headers: { 'content-type': 'application/json' },
          on(event, handler) {
            if (event === 'data') handler(Buffer.from(JSON.stringify(summaryData)));
            if (event === 'end') handler();
            return mockResponse;
          },
          resume() {},
        };
        callback(mockResponse);
      } else {
        // Image fetch responds with 302 redirect to non-allowlisted host
        const mockResponse = {
          statusCode: 302,
          headers: { location: 'https://attacker.example.com/final.jpg' },
          on() { return mockResponse; },
          resume() {},
        };
        callback(mockResponse);
      }
      return { on() {}, destroy() {} };
    });

    const res = mockRes();
    await handler(mockReq({ query: { name: 'Evil Redirect' } }), res);

    // Summary (1) + image fetch (2) redirect to evil host — blocked before the
    // attacker URL is fetched. The thumbnail has no size marker so
    // findWikipediaImageUrl only returns one candidate URL.
    expect(callIndex).toBe(2);
    expect(res._status).toBe(502);
  });

  it('rejects malformed redirect Location header', async () => {
    // Exercises lines 123-126 — `new URL(...)` throws inside the redirect branch.
    vi.spyOn(fs, 'existsSync').mockReturnValue(false);

    const https = require('https');
    let callIndex = 0;
    vi.spyOn(https, 'get').mockImplementation((url, opts, callback) => {
      callIndex += 1;
      if (typeof opts === 'function') callback = opts;

      if (callIndex === 1) {
        const summaryData = {
          title: 'Bad Redirect',
          // No /\d+px-/ size marker → single candidate URL
          thumbnail: { source: 'https://upload.wikimedia.org/bad.jpg' },
        };
        const mockResponse = {
          statusCode: 200,
          headers: { 'content-type': 'application/json' },
          on(event, handler) {
            if (event === 'data') handler(Buffer.from(JSON.stringify(summaryData)));
            if (event === 'end') handler();
            return mockResponse;
          },
          resume() {},
        };
        callback(mockResponse);
      } else {
        // Redirect with a garbage Location that `new URL()` cannot parse.
        // Use a bare colon — `new URL(':garbage', base)` throws.
        const mockResponse = {
          statusCode: 301,
          headers: { location: 'http://[::bad::url' },
          on() { return mockResponse; },
          resume() {},
        };
        callback(mockResponse);
      }
      return { on() {}, destroy() {} };
    });

    const res = mockRes();
    await handler(mockReq({ query: { name: 'Bad Redirect' } }), res);

    expect(callIndex).toBe(2);
    expect(res._status).toBe(502);
  });

  it('stops following redirects after MAX_REDIRECTS hops', async () => {
    // Exercises lines 117-119 — redirectsLeft <= 0.
    // MAX_REDIRECTS = 3, so 4 consecutive 301s should exhaust the budget.
    vi.spyOn(fs, 'existsSync').mockReturnValue(false);

    const https = require('https');
    let callIndex = 0;
    vi.spyOn(https, 'get').mockImplementation((url, opts, callback) => {
      callIndex += 1;
      if (typeof opts === 'function') callback = opts;

      if (callIndex === 1) {
        const summaryData = {
          title: 'Loopy',
          // No /\d+px-/ marker → single candidate URL so redirect budget math
          // is crisp: 1 summary + 4 hops (3 followed + 1 blocked) = 5.
          thumbnail: { source: 'https://upload.wikimedia.org/loop.jpg' },
        };
        const mockResponse = {
          statusCode: 200,
          headers: { 'content-type': 'application/json' },
          on(event, handler) {
            if (event === 'data') handler(Buffer.from(JSON.stringify(summaryData)));
            if (event === 'end') handler();
            return mockResponse;
          },
          resume() {},
        };
        callback(mockResponse);
        return { on() {}, destroy() {} };
      }

      // Every subsequent response is a 301 to another allowlisted URL
      const mockResponse = {
        statusCode: 301,
        headers: { location: `https://upload.wikimedia.org/hop/${callIndex}.jpg` },
        on() { return mockResponse; },
        resume() {},
      };
      callback(mockResponse);
      return { on() {}, destroy() {} };
    });

    const res = mockRes();
    await handler(mockReq({ query: { name: 'Loopy' } }), res);

    // 1 summary + 4 redirect hops (3 followed + 1 blocked) = 5 total calls
    expect(callIndex).toBe(5);
    expect(res._status).toBe(502);
  });

  it('handles JSON parse error in fetchJson (invalid JSON body)', async () => {
    vi.spyOn(fs, 'existsSync').mockReturnValue(false);

    const https = require('https');
    let callIndex = 0;
    vi.spyOn(https, 'get').mockImplementation((url, opts, callback) => {
      callIndex += 1;
      if (typeof opts === 'function') {
        callback = opts;
      }

      // Return invalid JSON for all requests — triggers the catch in fetchJson
      const mockResponse = {
        statusCode: 200,
        headers: { 'content-type': 'application/json' },
        on(event, handler) {
          if (event === 'data') handler(Buffer.from('not valid json {{{'));
          if (event === 'end') handler();
          return mockResponse;
        },
        resume() {},
      };
      callback(mockResponse);
      return { on() {}, destroy() {} };
    });

    const res = mockRes();
    await handler(mockReq({ query: { name: 'Json Error Person' } }), res);

    // fetchJson returns null → no image found → 404
    expect(res._status).toBe(404);
  });
});
