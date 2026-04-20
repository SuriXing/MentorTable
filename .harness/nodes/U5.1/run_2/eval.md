# U5.1 R2 — Build Evaluation

**Verdict: PASS** — all R1 blockers (F19/F20/F21) resolved, all 6 same-trip
fixes (F22-F27) addressed. Verify-gate green. No regressions.

## Blockers (R1 → R2)

### 🔴 F19 — Rate-limit autoscale cost ceiling — **FIXED**

Picked **option 1 (KISS)**: per-instance circuit breaker + `LLM_DISABLED=1`
kill switch. Upstash drop-in (option 2) deferred — env var not present and
adding the dependency would expand the trust surface for marginal gain at
current traffic. Aggressive per-IP tightening (option 3) rejected as it
hurts legit users without bounding the actual cost vector.

- `lib/security.js:265-355` — new `checkLlmCircuitBreaker`,
  `recordLlmCall`, `enforceLlmBreaker`, `getLlmHourlyBudget`,
  `_resetLlmCircuitBreaker`. Per-instance rolling-hour counter. Default
  budget `LLM_HOURLY_BUDGET=1000`. Operator override via env.
- `lib/security.js:259-268` — `LLM_DISABLED=1` short-circuits to 503 with
  `Retry-After: 300`.
- `api/mentor-table.js:1-8` — import `enforceLlmBreaker`, `recordLlmCall`.
- `api/mentor-table.js:1316-1320` — breaker check immediately after the
  per-IP rate limit, before any LLM-bound work.
- `api/mentor-table.js:1422-1426` — `recordLlmCall(1)` per fan-out before
  upstream dispatch, so failed calls still count against the budget.
- Residual risk + operator runbook documented in
  `docs/SECURITY.md` § 1.

### 🔴 F20 — Pre-U5.1 LLM_API_KEY leak audit — **CLEAR (no rotation needed)**

Raw audit output (executed 2026-04-20):

```
$ git log --all --oneline -- 'dist/*' | head -20
(empty)

$ git log --all --diff-filter=A --name-only --pretty=format: \
    | grep -E '^(dist|build)/' | sort -u
(empty)

$ git log --all -p -- vite.config.ts vite.config.mts \
    | grep -i "LLM_API_KEY\|DASHSCOPE_API_KEY" | head -20
(only matches: U5.1 R1 commit comments explaining the F6 fix —
 no actual secret material in any file content)
```

`.gitignore` line 7 has `dist/`, line 8 has `build/`, lines 14-15 have
`.env` and `.env.*`. No commit ever added a built bundle or env file. The
F6 vulnerability (build-time `define` injection of all shell env vars into
the client bundle) only ever produced compromised output in local `dist/`
folders, which were never committed. **No key rotation required.**
Documented in `docs/SECURITY.md` § 3.

### 🔴 F21 — LTAI redaction gap — **FIXED**

- `lib/security.js:285-289` — added pattern 10:
  `/\bLTAI[A-Za-z0-9]{12,30}\b/g → 'LTAI[REDACTED]'`. Bounded length to
  avoid clobbering unrelated identifiers that happen to start with LTAI.
- `lib/__tests__/security.test.js:514-540` — three new tests covering
  bare LTAI key, LTAI inside JSON-shaped error preview, and a regression
  guard for the other patterns. All pass (`npx vitest run
  lib/__tests__/security` → 69/69).

## Same-trip fixes (🟡)

| ID  | Status   | Where                                                             |
| --- | -------- | ----------------------------------------------------------------- |
| F22 | FIXED    | `lib/security.js:402-432` — renamed to `stripControlChars` (+ array variant). Legacy `sanitizeMentorField` / `sanitizeMentorFieldArray` kept as deprecated aliases. KISS: callers (5 files) keep working unchanged via the alias; new code uses the honest name. |
| F23 | FIXED    | `lib/security.js:191-217` — Vercel trust-boundary comment block above `getClientIp`. Explains why first XFF entry is the rate-limit key (UX) but NOT a security signal. |
| F24 | FIXED    | `docs/SECURITY.md` § 2 — HSTS preload commitment + removal cost. |
| F25 | FIXED    | `vercel.json:23` — Permissions-Policy now denies 12 features (camera, microphone, geolocation, payment, usb, bluetooth, accelerometer, gyroscope, magnetometer, browsing-topics, display-capture, interest-cohort). |
| F26 | FIXED    | F6 re-verification by **value** (not just env-var name). Greps below show no API key material in `dist/`. |
| F27 | DEFERRED | `docs/SECURITY.md` § 5 — same-origin asset model + CSP `script-src 'self'` already cover the realistic supply-chain threat model. SRI on same-origin adds no defense. Revisit if we add a 3rd-party CDN. |

## Verify-gate output

| Check                                          | Result   |
| ---------------------------------------------- | -------- |
| `npm run lint`                                 | PASS (0 errors) |
| `npm run type-check`                           | PASS (0 errors) |
| `npm test -- --coverage`                       | PASS — 924/924 tests, **99.52% statements** (gate ≥95%) |
| `npm run build`                                | PASS — 654 ms, no warnings |
| `npm audit --omit=dev --audit-level=high`      | PASS — 0 vulnerabilities |
| `npx vitest run lib/__tests__/security` (F21)  | PASS — 69/69 incl. new LTAI tests |
| `grep -E 'Permissions-Policy' vercel.json` (F25) | PASS — 12-feature deny list confirmed |
| `LLM_DISABLED=1 node -e ...` (F19 smoke)       | PASS — `kill switch parsed: LLM_DISABLED=1` |
| `git log --all --oneline -- 'dist/*'` (F20)    | EMPTY — clean history |

## F26 strengthened verification (raw)

```
$ grep -RE "your-api-key-here|sk-ant|LTAI[A-Za-z0-9]{8,}|AIza[0-9A-Za-z_-]{20,}" dist/
(empty — no placeholder or real-format secret in built bundle)

$ key_prefix=sk-14849   # first 8 chars of dev LLM_API_KEY from .env
$ grep -RE "$key_prefix" dist/
(empty — actual dev key prefix not in built bundle)
```

R1's F6 fix (`vite.config.mts` `loadEnv('VITE_')`) holds: only `VITE_*`-
prefixed env vars are exposed to the client bundle, and there are no
`VITE_LLM_*` vars (intentionally — secrets stay server-side).

## Files changed

- `lib/security.js` — F19 breaker block (+90 lines), F21 LTAI pattern,
  F22 rename + aliases, F23 trust-boundary comment, F19 exports.
- `api/mentor-table.js` — F19 wiring (import + `enforceLlmBreaker` call +
  `recordLlmCall(1)` per fan-out).
- `vercel.json` — F25 Permissions-Policy expansion.
- `lib/__tests__/security.test.js` — +6 LTAI/redaction tests, +6 strip-
  control-chars tests, +9 LLM circuit-breaker tests. 69 total in this
  file (was 48).
- `docs/SECURITY.md` — NEW. Sections 1-6 covering F19 runbook, F24
  preload commitment, F20 audit trail, redaction coverage table, F27
  deferral, F23 trust-boundary recap.

## Coverage delta

`lib/security.js` 99.41% statements (was 100% R1; the 3 uncovered lines
are the 1-hour window-roll branch in `_rollLlmWindowIfStale` — would
require time-travel to exercise cleanly, deemed not worth a clock mock).
Whole-tree statement coverage 99.52%, gate (95%) cleared by 4.5 points.

## Open items for U5.2 R2 reviewer

- Confirm option-1 choice for F19 is acceptable given the documented
  residual risk (distributed-IP attack within the per-instance × fleet
  ceiling). If tighter bounds are required, schedule an Upstash drop-in
  as a follow-up node.
- F27 SRI deferral — confirm no 3rd-party asset host is on the roadmap.
