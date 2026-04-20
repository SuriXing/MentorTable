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
// npm_package_version is set by `npm run` scripts — prefer it when present
// so the handler reflects the *invoked* package, not whatever require() hit.
if (process.env.npm_package_version) {
  VERSION = process.env.npm_package_version;
}

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
