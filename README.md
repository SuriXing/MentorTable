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

## Operations

- [RUNBOOK.md](./RUNBOOK.md) — deployment, env vars, rate limiting, the
  LLM cost breaker, load-smoke and shed-curve sweeps, incident triage.
- [docs/audit-2026-05-08.md](./docs/audit-2026-05-08.md) — external
  review ledger and its fix disposition.

## Gates

Every push runs lint (ESLint 9 flat config, frontend + backend), type
check, the unit suite with a 95% coverage floor, build, and Playwright
e2e — locally enforced by husky `pre-commit` (lint-staged) and
`pre-push` (full gate).

## License

[MIT](./LICENSE)
