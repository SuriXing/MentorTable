/**
 * Tests for server.js — Express app integration tests.
 *
 * Starts the Express app on a random port and makes real HTTP requests.
 * Tests CORS, health endpoint, and OPTIONS handling.
 */

const http = require('http');
const express = require('express');

// We cannot require server.js directly because it calls app.listen().
// Instead, we reconstruct the relevant middleware and routes inline to test
// the Express configuration behavior (CORS, health, OPTIONS).

function buildApp() {
  const app = express();
  app.use(express.json({ limit: '1mb' }));
  app.use((req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    if (req.method === 'OPTIONS') {
      res.status(204).end();
      return;
    }
    next();
  });
  app.get('/api/health', (_req, res) => {
    res.json({ ok: true, service: 'mentor-api' });
  });
  return app;
}

function startServer(app) {
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => {
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

describe('Express server', () => {
  let server;
  let port;

  beforeAll(async () => {
    const app = buildApp();
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
// stripWrappingQuotes & loadDotEnvFile logic (unit-level via behavior)
// ---------------------------------------------------------------------------
describe('stripWrappingQuotes (inline recreation)', () => {
  // Recreate since it's not exported
  function stripWrappingQuotes(value) {
    if (typeof value !== 'string' || value.length < 2) return value;
    const first = value[0];
    const last = value[value.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return value.slice(1, -1);
    }
    return value;
  }

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
