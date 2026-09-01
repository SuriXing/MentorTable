# MentorTable

Throw your problem onto a table of mentors — historical figures, MBTI
types, game/film characters — and get each one's take in parallel: a
likely response, why it fits, and one smallest executable next step.
Multi-round follow-ups, per-mentor private notes, a reply-all round
table, saved memories that survive refreshes. Five UI languages
(en / zh-CN / ja / ko / es).

**The mentors are AI-simulated perspectives inspired by public figures.
They are not real statements from real people.**

## Quickstart

```bash
npm install
npm run dev            # vite dev server
npm run server         # local API proxy on :8787 (server.js)
npm test               # vitest unit suite
npm run test:e2e       # Playwright (needs `npx playwright install chromium`)
```

Without an LLM key the API degrades to deterministic server-fallback
replies — the full middleware chain still runs. Point it at any
OpenAI-compatible upstream:

```bash
LLM_API_KEY=... LLM_API_BASE_URL=https://.../v1 LLM_MODEL=... npm run server
```

### Switching LLM providers

Endpoints and default models live in the provider registry
(`api/lib/llm-providers.js`; keys stay in env vars, one per provider; the
claude entry speaks Anthropic-native /v1/messages, all others speak
OpenAI-compatible chat/completions). Select per request with a `provider`
field in the API body, as a failover chain with
`providers: ["dashscope", "claude", "deepseek"]` (failed mentors
re-dispatch on the next link; the chain shares the existing upstream
budget), or globally with `LLM_PROVIDER_CHAIN` / `LLM_PROVIDER`. Model
IDs are per-endpoint namespaces — DashScope serves qwen/deepseek/kimi/glm
under its own IDs, so each registry entry carries an ordered model list
(tried left to right before the chain moves on; override per provider with
a comma-separated env value). Requests without a
provider use the legacy env config above. Unknown names are rejected
with 400 (body) or fall back with a warning (env). See
[.env.example](./.env.example) for the full variable list.

## Operations

- [RUNBOOK.md](./RUNBOOK.md) — deployment, env vars, rate limiting, the
  LLM cost breaker, load-smoke and shed-curve sweeps, incident triage.

## Gates

Every push runs lint (ESLint 9 flat config, frontend + backend), type
check, the unit suite with a 95% coverage floor, build, and Playwright
e2e — locally enforced by husky `pre-commit` (lint-staged) and
`pre-push` (full gate).

## License

[MIT](./LICENSE)
