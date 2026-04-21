/**
 * GET /api/health — liveness probe.
 *
 * U8.1: must be cheap (no DB, no upstream LLM, no filesystem I/O in the hot
 * path) so deploy-health monitors and load balancers can hit it freely.
 *
 * Contract:
 *   200 application/json  { ok: true, version: "<semver>", sha: "<git-sha>" }
 *   Cache-Control: no-store   (monitors must see fresh status every call)
 *
 * `version` is the package.json "version" — read once at module load from
 * the bundled package.json. `sha` is the build/deploy commit SHA, injected
 * by Vercel via VERCEL_GIT_COMMIT_SHA. Falls back to GIT_SHA or the string
 * 'unknown' so the endpoint never 500s because of missing env.
 */

// Resolve version eagerly so request-time cost is a single property read.
// A failure here is unreachable in practice (package.json is part of the
// deployed bundle), but fall back to 'unknown' rather than crashing.
let VERSION = 'unknown';
try {
  // eslint-disable-next-line global-require
  const pkg = require('../package.json');
  if (pkg && typeof pkg.version === 'string') VERSION = pkg.version;
} catch {
  VERSION = 'unknown';
}
// F66 (U8.1 R2): on Vercel runtime `npm_package_version` is NOT set — it's
// only populated by `npm run <script>`. The override branch was dead code in
// prod and added a misleading code path. Removed; the bundled package.json
// read above is authoritative.

function healthHandler(req, res) {
  if (req.method && req.method !== 'GET' && req.method !== 'HEAD') {
    res.setHeader('Allow', 'GET, HEAD');
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }
  const sha =
    process.env.VERCEL_GIT_COMMIT_SHA ||
    process.env.GIT_SHA ||
    'unknown';
  res.setHeader('Cache-Control', 'no-store');
  res.status(200).json({ ok: true, version: VERSION, sha });
}

module.exports = healthHandler;
