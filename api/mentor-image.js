/**
 * GET /api/mentor-image?name=Lisa+Su
 *
 * Server-side image proxy + cache for mentor photos.
 * 1. Check local disk cache (public/assets/mentors/<slug>.<ext>)
 * 2. If not cached, query Wikipedia REST API for the person's thumbnail
 * 3. Fetch the image server-side (no CORS/rate-limit issues for client)
 * 4. Save to disk cache and serve
 *
 * Works for ANY person/character searchable on Wikipedia.
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');
const crypto = require('crypto');
const { URL } = require('url');
const { applyApiSecurity } = require('../lib/security.js');

// Vercel serverless functions only allow writes under /tmp. Keep the repo-local
// `public/assets/mentors` directory as a read-only fallback for pre-baked
// assets, but always write fresh cache entries under /tmp.
const WRITABLE_CACHE_DIR = '/tmp/mentor-image-cache';
const BUNDLED_CACHE_DIR = path.resolve(__dirname, '../public/assets/mentors');
const WIKI_REST = 'https://en.wikipedia.org/api/rest_v1/page/summary/';
const WIKI_API = 'https://en.wikipedia.org/w/api.php';

// Host allowlist applied to every fetch and every redirect hop. Prevents SSRF
// via attacker-controlled Location headers.
const ALLOWED_HOSTS = new Set([
  'en.wikipedia.org',
  'upload.wikimedia.org',
  'commons.wikimedia.org',
  'meta.wikimedia.org',
]);
const ALLOWED_HOST_SUFFIXES = ['.wikipedia.org', '.wikimedia.org'];
const MAX_REDIRECTS = 3;

function isAllowedUrl(url) {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return false;
    const host = parsed.hostname.toLowerCase();
    if (ALLOWED_HOSTS.has(host)) return true;
    return ALLOWED_HOST_SUFFIXES.some((suffix) => host.endsWith(suffix));
  } catch {
    return false;
  }
}

function toSlug(name) {
  const normalized = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
  if (normalized) return normalized;
  // Fallback: names with only non-ASCII letters (CJK, Cyrillic, Arabic, etc.)
  // get a deterministic hash-based slug so the handler still works. The caller
  // already validated non-empty + trimmed, so we only need the letter guard to
  // keep punctuation-only names (e.g. "!!!") rejecting with invalid slug.
  const trimmed = name.trim();
  if (!/\p{L}/u.test(trimmed)) return '';
  return crypto.createHash('sha1').update(trimmed).digest('hex').slice(0, 16);
}

function findCached(slug) {
  for (const dir of [WRITABLE_CACHE_DIR, BUNDLED_CACHE_DIR]) {
    for (const ext of ['.jpg', '.png', '.webp']) {
      const p = path.join(dir, slug + ext);
      try {
        if (fs.existsSync(p)) return p;
      } catch {
        // ignore — /tmp may not exist yet on cold start
      }
    }
  }
  return null;
}

function extFromContentType(ct) {
  if (!ct) return '.jpg';
  if (ct.includes('png')) return '.png';
  if (ct.includes('webp')) return '.webp';
  return '.jpg';
}

function mimeFromExt(ext) {
  if (ext === '.png') return 'image/png';
  if (ext === '.webp') return 'image/webp';
  return 'image/jpeg';
}

/**
 * Fetch a URL and return { buffer, contentType } or null.
 * Follows redirects (capped, host-allowlisted), retries on 429.
 */
function fetchBuffer(url, retries = 3, accept = 'image/*', redirectsLeft = MAX_REDIRECTS) {
  return new Promise((resolve) => {
    if (!isAllowedUrl(url)) {
      resolve(null);
      return;
    }
    const attempt = (n) => {
      const mod = url.startsWith('https') ? https : http;
      const req = mod.get(url, {
        headers: {
          'User-Agent': 'ProblemSolverBot/1.0 (educational; image cache)',
          Accept: accept,
        },
        timeout: 10000,
      }, (res) => {
        // Follow redirects — host-allowlisted, depth-capped.
        if ([301, 302, 307, 308].includes(res.statusCode) && res.headers.location) {
          res.resume();
          if (redirectsLeft <= 0) {
            resolve(null);
            return;
          }
          let nextUrl;
          try {
            nextUrl = new URL(res.headers.location, url).toString();
          } catch {
            resolve(null);
            return;
          }
          if (!isAllowedUrl(nextUrl)) {
            resolve(null);
            return;
          }
          resolve(fetchBuffer(nextUrl, n, accept, redirectsLeft - 1));
          return;
        }
        if (res.statusCode === 429 && n > 0) {
          setTimeout(() => attempt(n - 1), 2000);
          return;
        }
        if (res.statusCode !== 200) {
          res.resume();
          resolve(null);
          return;
        }
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          resolve({
            buffer: Buffer.concat(chunks),
            contentType: res.headers['content-type'] || '',
          });
        });
        res.on('error', () => resolve(null));
      });
      req.on('error', () => resolve(null));
      req.on('timeout', () => { req.destroy(); resolve(null); });
    };
    attempt(retries);
  });
}

/**
 * Fetch JSON from a URL.
 */
async function fetchJson(url) {
  const result = await fetchBuffer(url, 2, 'application/json');
  if (!result) return null;
  try {
    return JSON.parse(result.buffer.toString('utf-8'));
  } catch {
    return null;
  }
}

/**
 * Find the best image URL for a person via Wikipedia.
 * Tries REST API summary first, then search API.
 */
async function findWikipediaImageUrl(name) {
  // 1. Try REST API summary (most reliable for well-known people)
  const title = name.trim().replace(/\s+/g, '_');
  const summary = await fetchJson(`${WIKI_REST}${encodeURIComponent(title)}`);
  if (summary?.thumbnail?.source) {
    // Try original size from API first (most reliable), then attempt larger
    const original = summary.thumbnail.source;
    const larger = original.replace(/\/\d+px-/, '/512px-');
    return larger !== original ? [larger, original] : [original];
  }

  // 2. Fall back to search API
  const searchParams = new URLSearchParams({
    action: 'query',
    format: 'json',
    origin: '*',
    list: 'search',
    srsearch: name,
    srnamespace: '0',
    srlimit: '3',
  });
  const searchData = await fetchJson(`${WIKI_API}?${searchParams}`);
  const titles = (searchData?.query?.search || []).map((r) => r.title);

  for (const t of titles) {
    const pageParams = new URLSearchParams({
      action: 'query',
      format: 'json',
      origin: '*',
      prop: 'pageimages',
      piprop: 'thumbnail',
      pithumbsize: '512',
      titles: t,
    });
    const pageData = await fetchJson(`${WIKI_API}?${pageParams}`);
    const pages = pageData?.query?.pages ? Object.values(pageData.query.pages) : [];
    const page = pages.find((p) => p?.thumbnail?.source);
    if (page?.thumbnail?.source) return [page.thumbnail.source];
  }

  return null;
}

module.exports = async function mentorImageHandler(req, res) {
  // Apply shared security middleware (CORS + OPTIONS + body cap + rate limit).
  // image proxy is GET-only; body cap is tiny, rate limit is more generous
  // since browsers may legitimately burst 10 image requests when a table
  // with 10 mentors first loads.
  if (!applyApiSecurity(req, res, {
    maxBodyBytes: '4kb',
    rateLimit: { capacity: 60, refillPerSecond: 2 },
  })) return;

  const name = (req.query && req.query.name ? String(req.query.name) : '').trim();
  if (!name) {
    res.status(400).json({ error: 'name parameter required' });
    return;
  }

  // Hard length cap — prevents abusive names flooding Wikipedia queries.
  if (name.length > 200) {
    res.status(400).json({ error: 'name too long' });
    return;
  }

  const slug = toSlug(name);
  if (!slug) {
    res.status(400).json({ error: 'invalid name' });
    return;
  }

  // 1. Check disk cache (both /tmp writable cache and bundled fallback)
  const cached = findCached(slug);
  if (cached) {
    const ext = path.extname(cached);
    res.setHeader('Content-Type', mimeFromExt(ext));
    res.setHeader('Cache-Control', 'public, max-age=604800'); // 7 days
    fs.createReadStream(cached).pipe(res);
    return;
  }

  // 2. Find image URL(s) from Wikipedia
  const imageUrls = await findWikipediaImageUrl(name);
  if (!imageUrls) {
    res.status(404).json({ error: 'no image found', name });
    return;
  }

  // 3. Fetch image server-side — try each candidate URL.
  // findWikipediaImageUrl only ever returns a string[] or null, so imageUrls is
  // guaranteed to be an array here.
  let result = null;
  for (const url of imageUrls) {
    result = await fetchBuffer(url);
    if (result && result.buffer.length >= 100) break;
    result = null;
  }
  if (!result) {
    res.status(502).json({ error: 'failed to fetch image', name });
    return;
  }

  const ext = extFromContentType(result.contentType);

  // 4. Save to /tmp cache. On Vercel, only /tmp is writable; on any filesystem
  // failure (read-only fs, disk full, permission denied) we still serve the
  // buffer we already have in memory.
  try {
    fs.mkdirSync(WRITABLE_CACHE_DIR, { recursive: true });
    const cachePath = path.join(WRITABLE_CACHE_DIR, slug + ext);
    fs.writeFileSync(cachePath, result.buffer);
  } catch (err) {
    console.warn('[mentor-image] cache write failed:', err && err.code ? err.code : err);
  }

  // 5. Serve
  res.setHeader('Content-Type', mimeFromExt(ext));
  res.setHeader('Cache-Control', 'public, max-age=604800');
  res.end(result.buffer);
};
