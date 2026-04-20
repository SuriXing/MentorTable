# U5.1 — Security Hardening (run_1)

**Verdict:** PASS

## Changes

- `vercel.json:14-22` — CSP tightened: dropped `unsafe-inline` and `unsafe-eval` from `script-src`; removed `https:` fallback from `style-src`/`font-src`/`img-src`/`connect-src`; added `object-src 'none'` and `form-action 'self'`. Added `Strict-Transport-Security` and `Permissions-Policy` headers.
- `vite.config.mts:8` — F6 fix: `loadEnv(mode, cwd, '')` → `loadEnv(mode, cwd, 'VITE_')`. Previously every shell env var (including `LLM_API_KEY`, `DASHSCOPE_*`) was injected into the client bundle via the `define: { 'process.env': {...env} }` block. Now only `VITE_`-prefixed vars are exposed. `src/` only reads `process.env.NODE_ENV`, which Vite injects automatically — no other usages.

## CSP Rationale

Final CSP value:

```
default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self' data:; img-src 'self' data: blob:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; object-src 'none'; form-action 'self'
```

- **`script-src 'self'`**: verified `dist/index.html` ships only one external `<script type="module" crossorigin src="/assets/...">`. No inline scripts. No `eval` needed (Vite production output uses static imports). `unsafe-inline`/`unsafe-eval` removed.
- **`style-src 'self' 'unsafe-inline'`**: kept `'unsafe-inline'` because React inline `style={}` props are used across `src/main.tsx`, `src/components/shared/ThemeModeToggle.tsx`, etc. Migrating to nonces would require refactoring every inline style — out of scope. Honest trade-off documented here.
- **`connect-src 'self'`**: grep of `src/` for `dashscope` returns zero matches. Frontend talks only to same-origin `/api/*`; the Vercel Function fans out to DashScope server-side. Wildcard `https:` removed.
- **`font-src 'self' data:`**: `data:` retained for any base64-inlined fonts; no remote font CDN in use.
- **`img-src 'self' data: blob:`**: covers React-generated blobs and inline data URIs; no remote image CDN.
- **Removed `https:` wildcards** from style/font/img/connect — they were defense-in-name-only since they accepted any HTTPS origin.
- Added `object-src 'none'` (block legacy Flash/PDF embeds) and `form-action 'self'` (block form-action XSS exfil).

## Rate-Limit Decision

`lib/security.js:127-188` — in-memory token bucket per Vercel Function instance. Documented limitation already present in the file header (lines 14-19) and inline at line 130. Decision: **keep in-memory, do not add Redis dependency.**

Rationale (KISS):
- No Upstash/Vercel KV URL in current `.env.example`; adding the integration is non-trivial infra, not a drop-in.
- Per-instance bucket still catches naive single-source flooding within a warm instance.
- Real DDoS mitigation belongs at the CDN / WAF layer, not in handler code.
- Added clarifying comment block already present (BACKGROUND section, lines 16-21).

If a future deploy adds Upstash, swap `enforceRateLimit` for `@upstash/ratelimit`'s `slidingWindow`. No code change needed today.

## Verify Gate (raw output)

```
$ npm run lint
> mentor-table@0.1.0 lint
> eslint src --ext ts,tsx --rulesdir eslint-rules
(exit 0)

$ npm run type-check
> mentor-table@0.1.0 type-check
> tsc --noEmit
(exit 0)

$ npm test -- --coverage
 Test Files  28 passed (28)
      Tests  904 passed (904)
Coverage summary
Statements   : 99.55% ( 7456/7489 )
Branches     : 99.02% ( 2340/2363 )
Functions    : 100% ( 264/264 )
Lines        : 99.55% ( 7456/7489 )
(≥95% on all four metrics)

$ npm run build
vite v6.4.2 building for production...
✓ 99 modules transformed.
dist/index.html                             1.27 kB │ gzip:  0.65 kB
dist/assets/index-DkfaxWTp.js              33.65 kB │ gzip: 13.37 kB
dist/assets/vendor-react-DY-ziO7r.js      151.80 kB │ gzip: 49.23 kB
✓ built in 607ms

$ npm audit --omit=dev --audit-level=high
found 0 vulnerabilities
(exit 0)

$ git ls-files | grep -E '^\.env'
(empty)

$ grep -r "LLM_API_KEY\|DASHSCOPE" dist/ 2>/dev/null && echo "FAIL: secret leaked" || echo "OK: no secrets in bundle"
OK: no secrets in bundle
```

## Verify-Gate Per-Check

| Check | Result |
|---|---|
| `npm run lint` | PASS |
| `npm run type-check` | PASS |
| `npm test --coverage` (≥95%) | PASS (99.55%) |
| `npm run build` | PASS |
| `npm audit --omit=dev --audit-level=high` | PASS (0 vulns) |
| `.env` not committed | PASS |
| Secret-grep on `dist/` | PASS |
| CSP drops `unsafe-inline`/`unsafe-eval` from `script-src` | PASS |
| HSTS + Permissions-Policy headers added | PASS |
| F6 client-bundle env leak fixed | PASS |
