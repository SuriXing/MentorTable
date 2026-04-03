/**
 * Tests for server.js — Express app integration tests.
 *
 * Uses the real exported app from server.js (not a recreation).
 */

const http = require('http');

// server.js now exports the app (listen() only runs when require.main === module)
const app = require('../../server.js');
const { stripWrappingQuotes } = app.__test__;

function startServer(expressApp) {
  return new Promise((resolve) => {
    const server = expressApp.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({ server, port });
    });
  });
}

function request(port, options) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { hostname: '127.0.0.1', port, ...options },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const body = Buffer.concat(chunks).toString('utf-8');
          resolve({
            status: res.statusCode,
            headers: res.headers,
            body,
            json() { return JSON.parse(body); },
          });
        });
      }
    );
    req.on('error', reject);
    req.end();
  });
}

describe('Express server (real app)', () => {
  let server;
  let port;

  beforeAll(async () => {
    const result = await startServer(app);
    server = result.server;
    port = result.port;
  });

  afterAll(() => {
    server.close();
  });

  it('GET /api/health returns { ok: true, service: "mentor-api" }', async () => {
    const res = await request(port, { path: '/api/health', method: 'GET' });
    expect(res.status).toBe(200);
    const data = res.json();
    expect(data.ok).toBe(true);
    expect(data.service).toBe('mentor-api');
  });

  it('sets CORS headers on regular requests', async () => {
    const res = await request(port, { path: '/api/health', method: 'GET' });
    expect(res.headers['access-control-allow-origin']).toBe('*');
    expect(res.headers['access-control-allow-methods']).toBe('GET,POST,OPTIONS');
    expect(res.headers['access-control-allow-headers']).toContain('Content-Type');
  });

  it('OPTIONS request returns 204 with CORS headers', async () => {
    const res = await request(port, { path: '/api/health', method: 'OPTIONS' });
    expect(res.status).toBe(204);
    expect(res.headers['access-control-allow-origin']).toBe('*');
    expect(res.body).toBe('');
  });

  it('returns 404 for unknown routes', async () => {
    const res = await request(port, { path: '/api/nonexistent', method: 'GET' });
    expect(res.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// stripWrappingQuotes — testing the REAL exported function from server.js
// ---------------------------------------------------------------------------
describe('stripWrappingQuotes (real export)', () => {
  it('strips double quotes', () => {
    expect(stripWrappingQuotes('"hello"')).toBe('hello');
  });

  it('strips single quotes', () => {
    expect(stripWrappingQuotes("'hello'")).toBe('hello');
  });

  it('does not strip mismatched quotes', () => {
    expect(stripWrappingQuotes('"hello\'')).toBe('"hello\'');
  });

  it('returns non-string values as-is', () => {
    expect(stripWrappingQuotes(42)).toBe(42);
    expect(stripWrappingQuotes(null)).toBe(null);
  });

  it('returns short strings as-is', () => {
    expect(stripWrappingQuotes('a')).toBe('a');
    expect(stripWrappingQuotes('')).toBe('');
  });

  it('does not strip inner quotes', () => {
    expect(stripWrappingQuotes('he"llo')).toBe('he"llo');
  });
});
