const fs = require('fs');
const path = require('path');
const express = require('express');
const mentorTableHandler = require('./api/mentor-table.js');
const mentorDebugPromptHandler = require('./api/mentor-debug-prompt.js');
const mentorImageHandler = require('./api/mentor-image.js');

function stripWrappingQuotes(value) {
  if (typeof value !== 'string' || value.length < 2) return value;
  const first = value[0];
  const last = value[value.length - 1];
  if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
    return value.slice(1, -1);
  }
  return value;
}

function loadDotEnvFile(filename) {
  const filePath = path.join(__dirname, filename);
  if (!fs.existsSync(filePath)) return;
  const content = fs.readFileSync(filePath, 'utf8');
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!match) continue;
    const key = match[1];
    if (Object.prototype.hasOwnProperty.call(process.env, key)) continue;
    const rawValue = match[2].replace(/\s+#.*$/, '');
    const value = stripWrappingQuotes(rawValue);
    process.env[key] = value;
  }
}

loadDotEnvFile('.env.local');
loadDotEnvFile('.env');

const app = express();
const port = Number(process.env.MENTOR_API_PORT || 8787);
const host = process.env.MENTOR_API_HOST || '127.0.0.1';

app.use(express.json({ limit: process.env.MENTOR_JSON_LIMIT || '256kb' }));

// CORS: read allowlist from env. In dev (VERCEL_ENV !== 'production') and
// when no allowlist is configured, fall back to '*' for convenience. In prod
// deploys an explicit ALLOWED_ORIGINS list is required.
const allowedOriginList = (process.env.ALLOWED_ORIGINS || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

function resolveAllowOrigin(reqOrigin) {
  if (allowedOriginList.length === 0) {
    // No explicit list. In production this should be set; fall back to '*'
    // to preserve existing dev behavior.
    return '*';
  }
  if (reqOrigin && allowedOriginList.includes(reqOrigin)) return reqOrigin;
  // No match — return first allowed origin so the browser rejects the request
  // cleanly rather than echoing an attacker-controlled Origin header.
  return allowedOriginList[0];
}

app.use((req, res, next) => {
  const allowOrigin = resolveAllowOrigin(req.headers && req.headers.origin);
  res.setHeader('Access-Control-Allow-Origin', allowOrigin);
  if (allowOrigin !== '*') {
    res.setHeader('Vary', 'Origin');
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Access-Control-Max-Age', '86400');
  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return;
  }
  next();
});

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, service: 'mentor-api' });
});

app.all('/api/mentor-table', async (req, res) => {
  await mentorTableHandler(req, res);
});

app.all('/api/mentor-debug-prompt', async (req, res) => {
  await mentorDebugPromptHandler(req, res);
});

app.get('/api/mentor-image', async (req, res) => {
  await mentorImageHandler(req, res);
});

if (require.main === module) {
  app.listen(port, host, () => {
    console.log(`Mentor API listening on http://${host}:${port}`);
  });
}

module.exports = app;
module.exports.__test__ = { stripWrappingQuotes, loadDotEnvFile };
