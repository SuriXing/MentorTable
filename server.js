const fs = require('fs');
const path = require('path');
const express = require('express');
const mentorTableHandler = require('./api/mentor-table.js');
const mentorDebugPromptHandler = require('./api/mentor-debug-prompt.js');
const mentorImageHandler = require('./api/mentor-image.js');

// Security middleware lives in lib/security.js and is applied twice:
// (1) each api/*.js handler calls applyApiSecurity at its top — this is the
//     production path on Vercel (direct routing to api/*.js).
// (2) server.js mirrors the CORS + OPTIONS layer below for the dev-only
//     /api/health endpoint so local browsers don't hit CORS errors when
//     probing health. The body cap and rate limit are intentionally NOT
//     applied here because the api/*.js handlers apply them themselves
//     when reached via the app.all(...) routes below.
const { applyCorsHeaders, handleCorsPreflight } = require('./lib/security.js');

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

// Express body parser (needed so req.body is populated before each api/*.js
// handler's applyApiSecurity call reads it).
app.use(express.json({ limit: process.env.MENTOR_JSON_LIMIT || '256kb' }));

// CORS + OPTIONS for all routes in dev. The api/*.js handlers also apply
// their own CORS headers via applyApiSecurity — they're idempotent with
// the dev-side headers here. See lib/security.js header.
app.use((req, res, next) => {
  applyCorsHeaders(req, res);
  if (handleCorsPreflight(req, res)) return;
  next();
});

// Health endpoint is dev-only (server.js is bypassed on Vercel).
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
