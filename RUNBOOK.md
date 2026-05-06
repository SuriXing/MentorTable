# MentorTable — Operations Runbook

Quick-reference for rollback, env vars, and 5xx triage. All commands assume
the repo is linked to Vercel (`.vercel/project.json` present) and the caller
is authenticated on the right team (`vercel whoami`).

## Rollback

Use Vercel's immutable-deployment rollback — do NOT revert commits and
redeploy. Promoting a previous deployment is instant and atomic; a fresh
build could fail for a new reason and leave prod broken.

### 1. Find the last-good deployment

```bash
# Show recent deployments for the linked project (most recent first).
vercel ls

# Filter to production only (ignore preview deploys).
vercel ls --prod

# Deeper inspection of a specific deployment URL:
vercel inspect <deployment-url>
```

Pick the most recent `● Ready` production deployment that predates the
incident. Copy its URL (e.g. `mentor-table-xxxx.vercel.app`).

### 2. Promote it

```bash
# Interactive: pick from a list.
vercel rollback

# Non-interactive: promote a specific deployment URL to production.
vercel rollback <deployment-url> --yes

# Example (replace with a real URL from `vercel ls --prod`):
vercel rollback mentor-table-a1b2c3d4.vercel.app --yes
```

The production alias (`mentor-table.vercel.app` or custom domain) flips
within seconds. No rebuild happens.

### 3. Verify

```bash
# Hit the health endpoint and confirm the sha matches the rolled-back deploy.
curl -sS https://<your-prod-domain>/api/health | jq

# Tail live logs to confirm 5xx rate is back to baseline.
vercel logs <your-prod-domain> --follow
```

### 4. Follow up

- File an incident note (what broke, which sha was bad, which sha we
  rolled back to).
- Do NOT delete the bad deployment — keep it for post-mortem.
- Fix forward on a branch; merge to `main` only after tests + manual QA
  on a preview URL.

## Environment Variables

All secrets live in Vercel project env (Production + Preview scopes).
Local dev reads from `.env` at repo root (gitignored). Never commit keys.

| Name | Required? | Where set | Purpose |
|---|---|---|---|
| `LLM_API_KEY` | Yes (prod) | Vercel env (Production, Preview) | Primary DashScope / OpenAI-compatible API key used by `api/mentor-table.js` and `api/mentor-debug-prompt.js`. Handlers fall through to `OPENAI_API_KEY` → `LLM_API_TOKEN` → `OPENAI_KEY` if unset; in practice we set this one. |
| `OPENAI_API_KEY` | No | Vercel env | Fallback key if `LLM_API_KEY` is missing. Kept for local dev parity with OpenAI tooling. |
| `LLM_API_TOKEN` | No | Vercel env | Secondary fallback key (legacy alias). |
| `OPENAI_KEY` | No | Vercel env | Tertiary fallback key (legacy alias). |
| `LLM_MODEL` | No | Vercel env | Model id for the OpenAI-compatible chat endpoint. Default: `qwen-max`. |
| `OPENAI_MODEL` | No | Vercel env | Fallback for `LLM_MODEL`. |
| `LLM_API_BASE_URL` | Yes (prod) | Vercel env | Chat-completions base URL, e.g. `https://dashscope.aliyuncs.com/compatible-mode/v1`. Default: `https://api.openai.com/v1`. |
| `OPENAI_BASE_URL` | No | Vercel env | Fallback for `LLM_API_BASE_URL`. |
| `MENTOR_UPSTREAM_TIMEOUT_MS` | No | Vercel env | Per-request upstream timeout in ms. Default: `25000`. Tune downward if cold starts eat into the 30s function limit. |
| `MENTOR_HISTORY_MAX_ITEMS` | No | Vercel env | Max conversation turns kept before compaction. Default: `36`. |
| `MENTOR_HISTORY_MAX_CHARS` | No | Vercel env | Max character budget for kept history. Default: `6000`. |
| `MENTOR_HISTORY_COMPRESS_TOKENS` | No | Vercel env | Token threshold triggering LLM-side history compression. Default: `100000`. |
| `MENTOR_HISTORY_COMPRESS_TIMEOUT_MS` | No | Vercel env | Timeout (ms) for the compression round-trip. Default: `12000`. |
| `MENTOR_JSON_LIMIT` | No | Vercel env / local | Max request body size (e.g. `256kb`). Default: `256kb`. Enforced by `lib/security.js:checkBodySizeCap`. |
| `ALLOWED_ORIGINS` | Yes (prod) | Vercel env | Comma-separated CORS allowlist. Empty in prod triggers a loud warning and disables wildcard (`lib/security.js:resolveAllowOrigin`). |
| `LLM_DISABLED` | No (operator kill switch) | Vercel env | Set to `1` or `true` to 503 every LLM call. Use during an incident. |
| `LLM_HOURLY_BUDGET` | No | Vercel env | Per-instance rolling-hour cap on upstream LLM calls. Default: `1000`. |
| `DISABLE_RATE_LIMIT` | No | local only | Set to `1` to skip per-IP rate limiting — test harness only. |
| `KV_REST_API_URL` / `KV_REST_API_TOKEN` | No | Vercel env (or Upstash equivalents `UPSTASH_REDIS_REST_*`) | F166 (P22): enables GLOBAL rate limiting via Vercel KV / Upstash REST fixed-window counters. Unset → per-instance in-memory buckets only. |
| `MENTOR_TABLE_KV_LIMIT` | No | Vercel env | Global per-IP request budget per 60s window for `/api/mentor-table` when KV is configured. Default: `30`. |
| `MENTOR_IMAGE_KV_LIMIT` | No | Vercel env | Same for `/api/mentor-image`. Default: `120`. |
| `MENTOR_LLM_CACHE` | No | Vercel env | F167 (P23): set to `0` to disable the per-instance LLM reply cache. Default: on. |
| `MENTOR_LLM_CACHE_TTL_SECONDS` | No | Vercel env | Reply cache freshness window. Default: `900` (15 min). |
| `MENTOR_LLM_MAX_ATTEMPTS` | No | Vercel env | F168 (P24): upstream retry attempts for transient failures (429/5xx/network). Default: `3`; `1` disables retries. |
| `NODE_ENV` | Auto | Vercel / local | `production` in prod; disables in-process rate limiter when `test`. |
| `VERCEL_ENV` | Auto | Vercel-injected | `production` / `preview` / `development`. Used by CORS posture and health endpoint. |
| `VERCEL_GIT_COMMIT_SHA` | Auto | Vercel-injected | Commit SHA returned by `/api/health`. |
| `GIT_SHA` | No | local only | Fallback sha for `/api/health` when running outside Vercel. |
| `MENTOR_API_PORT` | No | local only | Dev Express port. Default: `8787`. |
| `MENTOR_API_HOST` | No | local only | Dev Express host. Default: `127.0.0.1`. |
| `VITE_COVERAGE` | No | local only | Set to `1` to enable Istanbul coverage in the Vite dev build. |
| `VITE_MENTOR_API_URL` | No | **build time (Vite inlines)** | Override the production `/api/mentor-table` endpoint URL at build time. Read in `src/features/mentorTable/mentorApi.ts`. Changing it requires a rebuild + redeploy. |
| `VITE_MENTOR_DEBUG_API_URL` | No | **build time (Vite inlines)** | Override the `/api/mentor-debug-prompt` endpoint URL. Same build-time semantics as above. |
| `VITE_MENTOR_API_TIMEOUT_MS` | No | **build time (Vite inlines)** | Client-side fetch timeout (ms) for mentor API calls. Default in code: `28000` — must stay between the upstream budget (25s) and the 30s function ceiling (F175). Build time only. |
| `VITE_MENTOR_NOTE_COORDINATE_ALL` | No | **build time (Vite inlines)** | Feature flag: `1` to enable cross-mentor note coordination on `MentorTablePage`. Build time only. |
| `COLLECT_UI_COVERAGE` | No | local only (Playwright) | Set to `1` to collect Istanbul UI coverage during `playwright` runs. Read in `playwright.config.ts`. |
| `ANALYZE` | No | local only | Set to `1` to emit bundle-stats HTML/JSON outside `dist/`. |
| `SOURCEMAP` | No | local only | Set to `1` to emit prod source maps (off by default — never ship publicly). |

Verify current Vercel env wiring:

```bash
vercel env ls production
vercel env ls preview
vercel env pull .env.local      # snapshot to disk for local dev
```

## Common 5xx Triage

Start every incident with `vercel logs <domain> --follow` in one pane and
`curl -sS https://<domain>/api/health` in another. The health endpoint is
no-DB / no-LLM — if it 5xxs, the platform is down (skip to Vercel status
page). If it's 200 but `/api/mentor-table` 5xxs, drill into the buckets
below.

### Bucket A — Rate-limit exhaustion (429, not 5xx, but often misreported)

**Symptom.** Clients see `429 Rate limit exceeded`. `lib/security.js`
returns this from `enforceRateLimit` once a per-IP token bucket is empty
(memory limiter) or the KV fixed-window count exceeds the budget
(F166/P22 — filter by `limiter` to tell them apart).

**Log query.**

```bash
vercel logs <domain> --since 15m | grep -E '"event":"rate_limited"'
# KV-limiting vs memory-limiting:
vercel logs <domain> --since 15m | grep 'rate_limited' | grep -c '"limiter":"kv"'
```

**Remediation.**

```bash
# F64 (U8.1 R2): rate-limit cap is hardcoded at 30 in lib/security.js;
# changing it requires a code edit + deploy. There is no env-var override.
# Option 1 (real flood): confirm it's not a single hot client. Look at
# distinct x-forwarded-for first-hop addresses in the past 15m:
vercel logs <domain> --since 15m | grep -oE '"xff":"[^"]+"' | sort -u | wc -l
# Option 2: if the flood is hitting LLM endpoints, flip the kill switch:
vercel env add LLM_DISABLED production   # value: 1
vercel redeploy <last-good-deployment-url>  # or wait for next deploy
```

### Bucket B — DashScope / upstream LLM outage (502 / 503 from `/api/mentor-table`)

**Symptom.** `/api/mentor-table` returns 502 or 503. Users see "mentor
isn't responding". Error responses include `upstream_error` or
`upstream_timeout` fields.

**Log query.**

```bash
vercel logs <domain> --since 30m | grep -E '"event":"(api_error|llm_breaker_blocked|llm_retry|rate_limited)"'
```

Check DashScope status directly:

```bash
curl -sS -o /dev/null -w "%{http_code}\n" https://dashscope.aliyuncs.com/compatible-mode/v1/
```

**Remediation.**

```bash
# Flip the kill switch so every call returns 503 with Retry-After instead
# of hammering a broken upstream (and burning budget on timeouts):
vercel env add LLM_DISABLED production    # value: 1
# Force a redeploy so the env change takes effect on warm instances:
vercel redeploy --prod

# When DashScope is back:
vercel env rm LLM_DISABLED production --yes
vercel redeploy --prod
```

If a specific model is broken, fail over:

```bash
vercel env add LLM_MODEL production       # value: qwen-plus  (or next-best)
vercel redeploy --prod
```

### Bucket C — Wikimedia 429 / image lookup failures (`/api/mentor-image`)

**Symptom.** Mentor avatars fall back to defaults. `/api/mentor-image`
returns non-200, or its upstream Wikimedia/Wikipedia call returned 429.

**Log query.**

```bash
vercel logs <domain> --since 30m | grep -E 'mentor-image|wikimedia|wikipedia|429'
```

**Remediation.** Wikimedia rate-limits by User-Agent + IP. We already send
a contact-email UA; if we're still throttled, back off and cache.

```bash
# Short term: let clients keep rendering with fallback avatars — no
# deploy needed (the endpoint already fails soft). Confirm by hitting:
curl -sS "https://<domain>/api/mentor-image?name=Confucius" -o /dev/null -w "%{http_code}\n"
# If it stays 429 for >30 min, raise with Wikimedia ops or add a CDN
# cache layer in front of the endpoint before retrying at scale.
```

### Bucket D — Vercel cold-start timeouts (504 / function-timeout)

**Symptom.** Intermittent 504s on the first request after idle. Logs show
`Task timed out after 30.00s` or no response body. Correlates with low
traffic periods.

**Log query.**

```bash
vercel logs <domain> --since 1h | grep -E 'Task timed out|FUNCTION_INVOCATION_TIMEOUT|cold'
```

**Remediation.**

```bash
# 1. Shrink the LLM upstream timeout so the function errors with a
#    structured 504 instead of Vercel killing it cold:
vercel env add MENTOR_UPSTREAM_TIMEOUT_MS production   # value: 20000
# 2. Inspect the function's recent p95:
vercel inspect <deployment-url> --logs
# 3. If cold starts are the real issue, keep an instance warm by pinging
#    /api/health every ~4 min from an external uptime monitor (cheaper
#    than Vercel "always-on" for current traffic).
# 4. As a nuclear option, roll back per the "Rollback" section above if
#    the timeout regression correlates with a specific deployment.
```

## Analytics & Privacy

**What we collect.** The app mounts `<Analytics />` and `<SpeedInsights />`
from `@vercel/analytics` and `@vercel/speed-insights` (`src/main.tsx`). These
fire:

- **Vercel Analytics** — automatic pageviews on every route change.
- **Speed Insights** — Core Web Vitals (LCP, CLS, INP, FCP, TTFB) per
  pageview, sampled by Vercel.
- **`client_error`** — custom event from `ErrorBoundary.componentDidCatch`
  carrying `{ name, message_first_200_chars, component_stack_first_500 }`.
  The message is run through an inline regex that scrubs Bearer/sk-/LTAI/JWT
  shapes BEFORE the 200-char slice (`src/components/shared/ErrorBoundary.tsx`).

**Data classes & PII posture.** No emails, IDs, IP addresses, or auth
tokens are emitted from the client. Vercel Analytics anonymizes IPs at the
edge before recording. Custom event payloads carry only the truncated +
secret-scrubbed error message and component stack — no `req.body`, no
user-authored prompt text.

**Data residency.** Vercel Analytics & Speed Insights are hosted in
Vercel's US/EU edge regions. The primary audience is in mainland China
(DashScope backend, bilingual copy); this is a relevant disclosure for
PIPL/GDPR risk reviews. If a future legal posture requires CN residency,
the entire analytics layer must be removed (see "Kill switch" below).

**Runtime opt-out (Do-Not-Track).** The `<Analytics />` mount in
`src/main.tsx` passes a `beforeSend` callback that returns `null` when the
browser advertises `navigator.doNotTrack === '1'`:

```tsx
<Analytics
  beforeSend={(event) =>
    typeof navigator !== 'undefined' && navigator.doNotTrack === '1'
      ? null
      : event
  }
/>
```

Users who enable DNT in their browser send no pageview, no `client_error`,
no perf beacon. (Speed Insights does not currently expose `beforeSend`; if
strict DNT compliance for perf beacons is required, also remove the
`<SpeedInsights />` mount.)

**Kill switch (disable entirely).** To remove all client-side telemetry on
the next deploy:

1. Delete `<Analytics />` and `<SpeedInsights />` from `src/main.tsx`.
2. Delete the `w.va?.track?.('client_error', …)` block from
   `src/components/shared/ErrorBoundary.tsx`.
3. Optionally drop `@vercel/analytics` + `@vercel/speed-insights` from
   `package.json` and `npm install` to shrink the bundle.
4. `git commit && vercel --prod` — the next deploy carries no analytics.

For a faster operator-side kill (no code edit), block the
`/_vercel/insights/event` path at the CDN/firewall, or set
`window.va = () => {}` before the analytics script loads via a custom
`<script>` injection.

## Deployment Pipeline

Owner: U9.1. Last reviewed: 2026/04/21.

### Configuration source

We use **`vercel.ts`** at the repo root, not `vercel.json`. The Vercel CLI
auto-compiles `vercel.ts` → `vercel.json` during `vercel build`,
`vercel dev`, and `vercel deploy` via the `@vercel/config` package
(devDependency, v0.2.x).

To preview the compiled JSON locally:

```bash
npx @vercel/config compile     # print to stdout
npx @vercel/config validate    # type-check + summary
npx @vercel/config generate    # write vercel.json (DO NOT COMMIT)
```

If you ever need to roll back to JSON: `npx @vercel/config generate >
vercel.json`, delete `vercel.ts` + the devDependency, and commit. (Not
recommended — the TS form is the source of truth.)

### Rolling Releases (production)

Production traffic is shifted to a new deployment in three stages:

| Stage | Traffic | Hold |
|-------|---------|------|
| 1     | 10%     | 5 minutes  |
| 2     | 50%     | 10 minutes |
| 3     | 100%    | —          |

**Where this is configured.** As of `@vercel/config@0.2.1`, rolling
release stages are NOT exposed in the TypeScript schema. Configure them in
the Vercel dashboard:

1. Project → **Settings** → **Deployment Protection** → **Rolling Releases**.
2. Set stages 10% / 5m, 50% / 10m, 100%.
3. Save. The setting applies to all subsequent production promotions.

A `// TODO` in `vercel.ts` tracks this so we move it back into code once
the schema supports it.

**Rollback path.** Two equivalent options — pick whichever is faster in
the moment:

- **Dashboard (one-click):** Project → **Deployments** → find the
  previous green production deploy → **⋯** → **Promote to Production**.
  Vercel atomically re-aliases `mentor-table.vercel.app` to the older
  build. Rolling release does NOT re-stage on rollback — traffic flips
  100% immediately, which is what you want during an incident.
- **CLI:** `vercel rollback <previous-deployment-url>` (requires
  `vercel login` + project link). Same behaviour, scriptable.

After rollback: open an incident note, then bisect the bad deploy on a
preview branch before re-promoting.

### CI gates (block merge)

`.github/workflows/ci.yml` runs on every `pull_request` and must be green
before merge:

1. `npm ci`
2. `npm run lint`
3. `npm run type-check`
4. `npm test -- --coverage` — coverage gate **≥95%** (configured in
   `vite.config.mts`; do not bypass without writing the missing tests).
5. `npm run build`
6. **E2E** — Playwright only, against a single shared dev server (`vite`
   on `:3001`, `node server.js` on `:8787`) started by the workflow
   before the runner:
   - `npx playwright test` — primary suite (`e2e/*.spec.ts`,
     Chromium only per `playwright.config.ts`; WebKit was dropped in
     U9.1 R3 because the config has no `projects:` array, so installing
     it would download a browser that never executes — F89).
   - Cypress was removed (P28): the Playwright suite superseded it and
     the duplicate smoke cost a 10MB dev dependency plus a second
     browser install in CI.

To make this a hard merge gate (one-time, in GitHub UI):

> Settings → Branches → Branch protection rules → `main` → **Require
> status checks to pass** → add `Lint • Type-check • Test • Build • E2E`.

**F113 — required pre-U10.1 step.** Branch protection on `main` is
currently absent (`gh api repos/{owner}/{repo}/branches/main/protection`
returns 404), which makes every CI red advisory rather than blocking.
Run this ONCE before merging any U10.1 work to `main`:

```bash
# Replace OWNER/REPO. Requires admin on the repo.
gh api -X PUT repos/OWNER/REPO/branches/main/protection \
  -F required_status_checks[strict]=true \
  -F required_status_checks[contexts][]='Lint • Type-check • Test • Build • E2E' \
  -F required_status_checks[contexts][]='Lighthouse audit on Vercel preview' \
  -F enforce_admins=true \
  -F required_pull_request_reviews[required_approving_review_count]=1 \
  -F restrictions= \
  -F allow_force_pushes=false \
  -F allow_deletions=false

# Verify (should return 200 with the rule body, not 404):
gh api repos/OWNER/REPO/branches/main/protection | jq '.required_status_checks.contexts'
```

`.github/workflows/lighthouse.yml` runs Lighthouse CI against the Vercel
preview URL on each PR, asserts score budgets from `lighthouserc.json`
(perf ≥0.90, a11y ≥0.95, best-practices ≥0.95, SEO ≥0.90 — matches
OUT-6), and posts a comment with report links. It uses
`patrickedqvist/wait-for-vercel-preview@v1.3.2` to discover the preview
URL; this requires no extra secret beyond the default `GITHUB_TOKEN`.
The job fails (red X on the PR) if any budget is missed. To make it a
hard merge gate: Settings → Branches → branch protection on `main` →
**Require status checks** → add `Lighthouse audit on Vercel preview`.

### Verifying CI catches a broken commit

To prove the gate works (do this once after any major workflow edit):

```bash
git checkout -b ci-self-test
# Introduce a deliberate type error:
node -e "require('fs').appendFileSync('src/main.tsx', '\nconst x: number = \"oops\";\n')"
git add -A && git commit -m "test: deliberately break type-check"
git push -u origin ci-self-test
gh pr create --fill
# Expect: type-check step red, merge button disabled.
gh pr close --delete-branch
```

### Rollback drill (rehearse before you need it at 2am)

Do this once per quarter on a low-traffic window so muscle memory is real,
not theoretical. Total time: ~2 minutes.

```bash
# 1. Capture current prod for the post-drill restore.
CURRENT=$(vercel ls --prod | awk '/Ready/ {print $2; exit}')
echo "current prod: $CURRENT"

# 2. Pick the deployment immediately prior — that's the rollback target.
PREVIOUS=$(vercel ls --prod | awk '/Ready/ {print $2}' | sed -n '2p')
echo "rollback target: $PREVIOUS"

# 3. Promote the previous deployment.
vercel rollback "$PREVIOUS" --yes

# 4. Verify alias flipped (sha should match $PREVIOUS, not $CURRENT).
curl -sS https://mentor-table.vercel.app/api/health | jq .sha

# 5. Restore — promote what was prod before the drill.
vercel rollback "$CURRENT" --yes
curl -sS https://mentor-table.vercel.app/api/health | jq .sha
```

If step 4 doesn't flip the sha within ~10s, the dashboard path is the
fallback: Deployments → previous → ⋯ → Promote to Production.


## Observability Events (F170 / P26)

Every server log line is one JSON object: `{ ts, level, event, ...fields }`.
Events an operator will actually filter on:

| Event | Level | Meaning |
|---|---|---|
| `request_complete` | info | One per successful `/api/mentor-table` request: `mode` (batch/fanout), `mentorCount`, `failedCount`, `provider` (api / partial-fallback / server-fallback), `latencyMs`. Baseline health signal — alert on failedCount spikes. |
| `rate_limited` | warn | A 429 was sent (`limiter`: memory vs kv). Sustained kv-limiting means real traffic pressure; sustained memory-limiting on ONE instance means a hot client. |
| `llm_breaker_blocked` | warn | F19 cost ceiling tripped — the instance is 503ing LLM work until the hour window rolls. Flip `LLM_DISABLED` only if you need a longer stop. |
| `llm_retry` | warn | F168 transient-failure retry (`status`, `retryAfterMs`). A burst of these with eventual `request_complete` is healthy vendor flakiness; retries with `api_error` after = vendor outage. |
| `api_cache_hit` | info | F167 reply cache served a replay (does NOT count against the LLM hourly budget). |
| `api_request` / `api_ok` | info | Per-mentor upstream lifecycle (fan-out and batch). |
| `api_error` | error | Upstream non-OK or parse failure, body redacted to 200 chars. |

Quick dashboards (Vercel Logs → filter by event):

```bash
# error budget: share of requests degrading to fallback
vercel logs <domain> --since 1h | grep request_complete | grep -c '"provider":"server-fallback"'
# retry storm check
vercel logs <domain> --since 1h | grep -c '"event":"llm_retry"'
```

## Dependency Audit Posture (P30)

`npm audit --omit=dev` (the set that ships to Vercel): **0
vulnerabilities**. The API endpoints run on raw Node `http` via
`api/*.js` — express is NOT in the request path in production.

Known dev-chain advisories (accepted, reviewed 2026-04-30):

| Package | Severity | Exposure | Disposition |
|---|---|---|---|
| `body-parser` (via express) | moderate (DoS via invalid limit) + `qs` chain | local dev server only (`server.js`) | Accepted — no fix available upstream; the dev server binds `127.0.0.1`. Revisit when express patches ship. |
| `brace-expansion` | high (DoS in glob expansion) | transitive via dev tooling (vitest/eslint chains) | Accepted — build-time only, no untrusted glob input. Patch with `npm update brace-expansion` when registry access allows. |
| `esbuild` (via vitest/vite-node) | moderate (dev server request smuggling) | dev/test only | Accepted — the advisory affects `--host` dev servers; local dev binds localhost. |

Rotation policy: re-run `npm audit` before each release; any PROD-chain
finding is a release blocker, dev-chain findings are triaged by
exposure. Node engines: `>=24` (matches the Vercel Node.js 24 runtime).

## Load Smoke (P31 / F172)

`scripts/load-smoke.mjs` drives N concurrent virtual users against a
LOCAL `server.js` and reports latency percentiles, error rate, and 429
count. It requires a mock upstream so the full path (middleware →
fan-out → normalize → finalize) executes:

```bash
node scripts/mock-llm.mjs &                                # :8790
LLM_API_KEY=smoke LLM_API_BASE_URL=http://127.0.0.1:8790/v1 \
  LLM_MODEL=mock node server.js &                          # :8787
npm run test:load                                          # 10 VUs / 30s
```

Baseline (2026-04-30, MacBook local, 10 VUs / 25s): 5,010 requests,
280 ok (full 3-mentor fan-out through the mock), 4,730 rate-limited
(the 0.3/s refill + 20 burst per IP is the DESIGN under sustained
overload), **0 errors, p50 21ms / p95 24ms / p99 25ms**.

Pass criteria: non-429 error rate < 1% and p95 < 500ms. Do NOT set
`LLM_DISABLED=1` during a smoke — the breaker 503s every table request
by design and the run will read as an error storm.

## v1.0.0 Release Checklist (P32)

Verified locally before tag (2026-04-30):

- 986/986 unit tests (33 files), type-check (tsconfig + tsconfig.node),
  lint, production build — all green.
- Load smoke: 10 VUs / full API path through mock upstream — 0 errors,
  p95 24ms (`npm run test:load`).
- Dependency posture: prod chain 0 vulnerabilities (see Dependency
  Audit Posture above).
- Rollback path: `vercel rollback` steps rehearsed in the Rollback
  section; the drill itself needs operator Vercel access.

Operator steps at release time (require Vercel auth, cannot run from a
dev machine CI:

1. `vercel deploy --prod` (or merge to `main` and let the pipeline).
2. Prod smoke: `curl -sS https://mentor-table.vercel.app/api/health`
   → 200 with the new sha; one real mentor-table round-trip with a
   configured key; confirm `request_complete` in Logs.
3. Rollback drill (quarterly): run the script in the Rollback section,
   confirm the alias sha flips and restores.
4. Tag: `git tag v1.0.0 && git push origin v1.0.0`.
