# MentorTable Security Operations

This document covers the security posture, the operator kill switches, and the
known residual risks. Update this file whenever the security middleware
(`lib/security.js`) or `vercel.json` headers change.

## 1. Rate-limit residual risk and the LLM kill switch (F19)

### Threat model

- The public API endpoint `/api/mentor-table` fans out **N upstream LLM calls
  per request** (one per mentor in the table — typically 4-10).
- Each upstream call costs real money against the Aliyun DashScope account.
- Vercel Functions auto-scale: under sustained load there can be ~50 warm
  instances. The per-IP, per-instance token-bucket in `lib/security.js` is
  therefore not a real cost ceiling — distributed or rotating-IP attackers
  can multiply the per-instance limit by the instance count.

### Controls

Three layers, in order of response time:

1. **`LLM_DISABLED=1` env var (kill switch).** Set in the Vercel dashboard
   (Project → Settings → Environment Variables → add `LLM_DISABLED=1` for
   Production). Effect propagates to new function invocations within
   seconds. Every request to `/api/mentor-table` returns
   `503 Service Temporarily Unavailable` with a `Retry-After: 300` header.
   To restore service, delete the env var (or set it to `0`).

2. **`LLM_HOURLY_BUDGET=<n>` per-instance breaker.** Default: `1000` calls
   per instance per rolling hour. When breached, that instance returns 503
   until its window rolls. With ~50 instances the worst-case global ceiling
   is ~50,000 calls/hr. Tune lower if the bill spikes.

3. **Per-IP token bucket (`enforceRateLimit`).** Best-effort UX guard
   against naive flooding from a single source. Not a security boundary.

### Residual risk

- A coordinated distributed attack across many IPs can still reach
  `instance_count × LLM_HOURLY_BUDGET` LLM calls before the breaker trips.
  At today's defaults that's a finite, knowable bound; the operator must
  watch dashboards and trigger the kill switch within minutes if abuse is
  observed. **True global accounting requires Vercel KV / Upstash Redis**
  (option 2 in the U5.1 R2 task brief — deferred for KISS).
- The breaker counter resets on cold start. A fresh instance starts with
  full budget. This is acceptable because cold-start frequency is bounded
  by Vercel's autoscale logic; abuse that triggers many cold starts is
  visible in metrics.

### Operator runbook

| Symptom                                          | Action                                                       |
| ------------------------------------------------ | ------------------------------------------------------------ |
| Bill alert fires; abuse confirmed                | Set `LLM_DISABLED=1`. Investigate. Rotate keys if needed.    |
| Sustained traffic spike, want to throttle hard   | Lower `LLM_HOURLY_BUDGET` (e.g., `100`) and redeploy.        |
| Single noisy IP                                  | Already capped by per-IP bucket. Check logs and consider WAF rule. |

## 2. HSTS preload commitment (F24)

`vercel.json` sets:

```
Strict-Transport-Security: max-age=63072000; includeSubDomains; preload
```

By including `preload`, MentorTable commits to **HTTPS-only on every
`*.mentor-table.vercel.app` subdomain** for the foreseeable future. The
`preload` directive ships in Chromium / Firefox / Safari preload lists; once
included, **removal requires submitting a removal request to
[hstspreload.org](https://hstspreload.org/removal/) and the change can take
weeks to months to propagate** through browser updates. Do not enable
`preload` on a domain that may need to serve plain HTTP again.

## 3. F20 audit — pre-U5.1 LLM_API_KEY leak check (CLEAR)

Performed 2026-04-20 against the full repo history.

Commands and results:

```
$ git log --all --oneline -- 'dist/*' | head -20
(empty — no commits ever touched dist/)

$ git log --all --diff-filter=A --name-only --pretty=format: \
    | grep -E '^(dist|build)/' | sort -u
(empty — neither dist/ nor build/ has ever been added to the index)

$ git log --all -p -- vite.config.mts | grep -i "LLM_API_KEY\|DASHSCOPE_API_KEY"
(only matches: comments in U5.1 R1 commit explaining the F6 fix — no
actual key material in any committed file)
```

`.gitignore` has had `dist/` and `build/` entries throughout the relevant
history, and `.env*` is gitignored. The pre-R1 vulnerability described in
the F6 commit message was a build-time `define` injection that exposed shell
env vars **into the client bundle at build time** — the bundle (`dist/`)
itself was never committed to git, so **no historical commit contains the
production LLM_API_KEY**. **No key rotation is required.**

If you ever change the deployment pipeline so `dist/` is committed, redo
this audit before pushing.

## 4. Secret redaction regex coverage

`redactSensitive` in `lib/security.js` covers (order matters — first match wins):

| #  | Format                                 | Pattern marker        |
| -- | -------------------------------------- | --------------------- |
| 1  | URL credentials `https://user:pass@`   | `[REDACTED]:[REDACTED]@` |
| 2  | HTTP Basic auth header                 | `Basic [REDACTED]`    |
| 3  | Bearer tokens                          | `Bearer [REDACTED]`   |
| 4  | Anthropic `sk-ant-...`                 | `sk-ant-[REDACTED]`   |
| 5  | Stripe `sk_/rk_/pk_ live/test`         | `..._[REDACTED]`      |
| 6  | OpenAI legacy `sk-...`                 | `sk-[REDACTED]`       |
| 7  | Google `AIza...`                       | `AIza[REDACTED]`      |
| 8  | AWS `AKIA...`                          | `AKIA[REDACTED]`      |
| 9  | xAI `xai-...`                          | `xai-[REDACTED]`      |
| 10 | **Aliyun RAM `LTAI...`** (F21, R2)     | `LTAI[REDACTED]`      |
| 11 | JWT `eyJ...`                           | `eyJ[REDACTED]`       |

The redactor runs over all error messages emitted by the API handlers before
they reach client-facing JSON or server logs.

## 5. Subresource Integrity (SRI) — deferred (F27)

Vite does not natively emit SRI hashes for built assets. We could add
`vite-plugin-sri3`, but the same-origin asset model + CSP `script-src
'self'` already prevent supply-chain attacks via 3rd-party CDN — there is
no 3rd-party CDN in the loading path. SRI on same-origin assets only
defends against an attacker who can already write to our origin (in which
case SRI doesn't help — they can rewrite the integrity attribute too).
Deferred as low-leverage. Revisit if we ever serve assets from a CDN
outside the deployment domain.

## 6. Vercel `x-forwarded-for` trust boundary (F23)

See the comment block above `getClientIp` in `lib/security.js`. The TL;DR:
Vercel terminates TLS and prepends its edge IP to the chain. Only the
**last** entry of `x-forwarded-for` is trustworthy. The first entry is
client-claimed. We use the first entry as a rate-limit key (best-effort
UX), not as an authentication signal.
