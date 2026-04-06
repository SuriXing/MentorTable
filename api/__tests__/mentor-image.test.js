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

    const mockStream = { pipe(dest) { dest._piped = true; return dest; } };
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

    const mockStream = { pipe(dest) { dest._piped = true; return dest; } };
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
    const mockStream = { pipe(dest) { dest._piped = true; return dest; } };
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
    const mockStream = { pipe(dest) { dest._piped = true; return dest; } };
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

    // Verify the retry actually happened: callIndex should reach 3
    // (summary lookup → 429 → retry success)
    expect(callIndex).toBeGreaterThanOrEqual(3);
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

  it('uses http module when URL scheme is http (not https)', async () => {
    // Exercise the `url.startsWith('https') ? https : http` ternary's http branch
    vi.spyOn(fs, 'existsSync').mockReturnValue(false);
    vi.spyOn(fs, 'mkdirSync').mockReturnValue(undefined);
    vi.spyOn(fs, 'writeFileSync').mockReturnValue(undefined);

    const https = require('https');
    const http = require('http');

    // Wikipedia REST API (https) returns a summary pointing to an http:// thumbnail URL
    vi.spyOn(https, 'get').mockImplementation((url, opts, callback) => {
      if (typeof opts === 'function') callback = opts;
      const summaryData = {
        title: 'HTTP Person',
        thumbnail: { source: 'http://upload.example.com/thumb/100px-HttpPerson.jpg' },
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

    // http.get serves the final image
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

    expect(httpGetSpy).toHaveBeenCalled();
    expect(res._headers['Content-Type']).toBe('image/jpeg');
    expect(res._body).toBeTruthy();
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
