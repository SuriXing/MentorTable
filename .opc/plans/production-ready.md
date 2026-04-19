# Production-Ready Plan — MentorTable

**Goal:** Take MentorTable from "works on my machine" to a polished, performant, fully-covered, tasteful production deployment on Vercel.

**Quality tier:** `delightful` (consumer-facing showcase product — UI craft matters).

**How to run:** Paste the "Loop Prompt" section below into a new session as `/opc loop <paste>`. The orchestrator will decompose into units, schedule a cron, and execute unattended.

---

## Pre-flight Snapshot (as of 2026-04-19)

- Stack: React 18 + Vite 4 + TS 5 + Express 4 (dev) + Vercel Functions (prod) + Supabase
- Tests: Vitest (unit) + Cypress (E2E w/ Istanbul coverage) + Playwright + axe-core (a11y)
- Coverage: c8 reports 100% **on instrumented files**, but `include` list excludes some real code paths and mixes a stale `/Users/surixing/Code/MentorTable` path — coverage is currently **misleading**.
- Deploy: vercel.json has CSP, but uses `unsafe-inline` + `unsafe-eval` (script) — not production-grade.
- Outdated deps: Vite 4 (current 6+), Vitest 0.30 (current 2+), `@vitest/coverage-c8` deprecated → must migrate to `@vitest/coverage-v8` or `istanbul`. Cypress 12 (current 13+). Node types 18 (Vercel default is now Node 24).
- Dev server: spawns `node server.js & vite` — fragile process management, no graceful shutdown.
- `vite.config.js` AND `vite.config.ts` both exist — Vite picks one nondeterministically.

---

## Loop Prompt

> Copy everything below the line into `/opc loop ...`

---

You are operating in autonomous loop mode on the **MentorTable** repo (`/Users/surixing/Code/SuriWorld/MentorTable`). Your mission: ship a production-ready release. Quality tier is **delightful**. Run independent OPC ticks per unit; never combine build + review in one tick.

### Definition of Done (global — every unit must satisfy)

1. `npm run lint` passes with zero warnings (custom rules in `eslint-rules/` honored).
2. `npm run type-check` passes.
3. `npm run test` passes with **measured** ≥95% line + branch coverage on the *real* `src/`, `api/`, `lib/` trees (no exclusion gaming).
4. `npm run build` produces a deterministic `dist/` with sourcemaps; bundle budget enforced (see Unit 4).
5. E2E suite (`npm run test:e2e`) green on Chromium + WebKit; axe-core a11y suite (`e2e/a11y-r3.spec.ts`) reports zero serious/critical violations.
6. `vercel build` (or preview deploy) succeeds; CSP headers verified via curl on the preview URL.
7. Lighthouse mobile run on the preview URL: Performance ≥90, A11y ≥95, Best Practices ≥95, SEO ≥90.
8. Visual verification (webapp-testing skill) confirms dark/light, responsive (375 / 768 / 1280), loading/error/empty states, focus rings, favicon.

### Units (execute in order; each is one OPC tick of build → independent review → gate)

#### Unit 1 — Repo hygiene & config dedup
- Delete the stale duplicate config: pick `vite.config.ts` as canonical, remove `vite.config.js`. Reconcile differences first.
- Remove the stale `/Users/surixing/Code/MentorTable/...` paths embedded in `coverage/coverage-summary.json` and `.nyc_output` (regenerate, don't hand-edit).
- Add `.nvmrc` pinning Node 24 LTS (Vercel default).
- Add `engines` field in `package.json`.
- Replace `npm` lockfile with the package manager actually in use (verify against `.npmrc`); if it's npm, ensure `package-lock.json` is committed and `npm ci` works clean.
- Move `dist/`, `coverage/`, `.nyc_output/`, `test-results/`, `tsconfig*.tsbuildinfo` into `.gitignore` if not already, and untrack them.

#### Unit 2 — Dependency upgrades
- Vitest 0.30 → 2.x (or current). Replace `@vitest/coverage-c8` with `@vitest/coverage-v8`. Update `vite.config.ts` `test.coverage.provider`.
- Vite 4 → 6 (read official migration guide; do NOT guess API).
- Cypress 12 → 13.
- `@types/node` 18 → 24.
- `i18next` 22 → current major (validate breaking changes against `src/i18n.ts`).
- After each major bump: run lint + type-check + test + e2e. If anything breaks, fix in the same unit.

#### Unit 3 — Coverage truthfulness (the 100% lie)
- Audit `vite.config.ts` `test.coverage.include`/`exclude`. Currently excludes `src/main.tsx`, `src/types/**`, `src/locales/**` — justify each or remove.
- Add coverage for: `src/components/shared/ErrorBoundary.tsx`, `src/components/shared/LanguageSwitcher.tsx`, `src/components/shared/ThemeModeToggle.tsx`, `src/features/mentorTable/mentorApi.ts`, `server.js`, all `api/__tests__` are integration — verify they cover error paths (4xx/5xx, malformed JSON, rate-limit edges).
- Add coverage thresholds to `vite.config.ts`:
  ```ts
  coverage: {
    thresholds: { lines: 95, branches: 95, functions: 95, statements: 95 },
    all: true,  // include un-tested files in report
  }
  ```
- Reject any "exclude this file to hit 100%" suggestion. If a file is hard to test, write the test.

#### Unit 4 — Performance
- Run `vite build` and inspect `dist/` sizes. Add `rollup-plugin-visualizer` to generate a treemap; commit screenshot.
- Code-split routes via `React.lazy` + `Suspense` for `MentorTablePage` and any heavy feature. Target initial JS ≤ 170KB gzipped.
- Drop `target: 'es2015'` in favor of `'es2020'` or browserslist-driven target — saves polyfill weight.
- Add bundle budget to `vite.config.ts` build options or via `rollup` `output.manualChunks`.
- Audit FontAwesome imports — ensure tree-shaking (import individual icons, not the whole pack).
- Add `<link rel="preconnect">` for Supabase + any third-party origin.
- Add image optimization: replace `<img>` with `next/image`-equivalent or use Vercel's `/_vercel/image` URL pattern; ensure `width`/`height` set to prevent CLS.
- Verify Lighthouse on preview URL hits the targets in DoD #7. Iterate until green.

#### Unit 5 — Security hardening
- Tighten CSP in `vercel.json`: remove `'unsafe-inline'` and `'unsafe-eval'` from `script-src`. Use nonces or hashes. Use Vite's CSP plugin if needed.
- Add `Strict-Transport-Security: max-age=63072000; includeSubDomains; preload`.
- Add `Permissions-Policy` (camera=(), microphone=(), geolocation=()).
- Audit `lib/security.js` for: rate limit storage (in-memory will not survive Fluid Compute warm reuse correctly across instances — document or move to Edge Config / Upstash).
- Run `npm audit --omit=dev` and resolve all high/critical.
- Verify no secrets in `.env.example`; ensure `.env` is gitignored (currently is, confirm).
- Add `BotID` integration via Vercel BotID (now GA) for `/api/mentor-*` endpoints if abuse is a concern.

#### Unit 6 — Accessibility & i18n polish
- Run `e2e/a11y-r3.spec.ts` against every route, every theme, every language. Zero serious/critical.
- Verify `useFocusTrap` works for all modal/dialog instances.
- Verify color contrast in both dark and light themes (WCAG AA minimum, AAA target for body text).
- Verify all interactive elements have visible focus rings (no `outline: none` without replacement).
- Verify `lang` attribute updates with i18n language change.
- Add `prefers-reduced-motion` honoring on Aurora.tsx and any animation.
- Verify keyboard-only navigation traverses every interactive element in a logical order.

#### Unit 7 — UX polish ("good taste")
- Add real loading states (skeleton or spinner) for any async boundary.
- Add real empty states (illustration + helpful copy + CTA).
- Add real error states with retry actions (not raw error text).
- Verify favicon, apple-touch-icon, OG image, theme-color meta.
- Add proper `<title>` and meta description per route.
- Smooth out theme transitions (no flash of unthemed content) — read theme synchronously before paint.
- Add subtle micro-interactions: button press scale, hover lift, focus glow — all motion-reduced respecting.
- Use webapp-testing skill to take screenshots at 375 / 768 / 1280 in both themes for every route. Attach to PR.

#### Unit 8 — Observability & ops
- Add `@vercel/analytics` and `@vercel/speed-insights`.
- Add structured logging in `api/*.js` handlers (no PII; redact via `lib/security.js`).
- Add health endpoint `/api/health` returning `{ ok: true, version, sha }` with a 1-line uptime check.
- Add error boundary fallback that reports to Vercel (not just console).
- Document runbook in `RUNBOOK.md`: rollback, env vars, common 5xx triage.

#### Unit 9 — Deployment pipeline
- Migrate `vercel.json` to `vercel.ts` (current best practice — 2026 default). Type the config, drive headers/rewrites/redirects through `@vercel/config`.
- Add a GitHub Action (or Vercel Build Plugin) running: lint, type-check, test, build, e2e on every PR. Block merge on red.
- Configure a preview deploy comment with Lighthouse scores via Vercel Speed Insights or `treosh/lighthouse-ci-action`.
- Configure Rolling Releases (GA since 2025-06) for production: 10% → 50% → 100%.

#### Unit 10 — Final verification (independent)
- Dispatch a fresh OPC review tick with roles `[security, a11y, designer, pm, devil-advocate]` against the *deployed preview URL* (not local).
- Generate `.harness/report.html`.
- If any 🔴 → loop back to the relevant unit. Do not self-pass.

### Loop discipline

- **Never** combine implementation and review in one tick.
- **Never** mark a unit done without running all DoD checks for that unit's scope.
- After each unit's gate PASSes, commit with `feat(prod): unit N — <summary>` and push.
- If a unit blocks (e.g., dependency conflict that needs human judgment), write a `BLOCKED` handshake and surface to user — do not silently downgrade.
- Cycle limits: max 3 attempts per unit. On 3rd FAIL, escalate to user with a concrete diff of what's blocking.
- Use webapp-testing skill for ALL UI verification. Don't trust "I changed CSS, looks fine."
- Use Vercel-plugin skills (`vercel-plugin:deployments-cicd`, `vercel-plugin:nextjs` is irrelevant — this is Vite — but `vercel-plugin:vercel-cli`, `vercel-plugin:env-vars`, `vercel-plugin:verification` ARE relevant) when touching deploy config.

### Stop condition

Loop terminates when Unit 10 produces a PASS gate AND the preview deploy URL passes Lighthouse mobile thresholds in DoD #7.

---

## Why this plan (the "why" behind the units)

- **Units 1–3 first** because everything else lies on top of false coverage and stale config. Fix the foundation before polishing the roof.
- **Performance before security** because perf budgets shape what code/deps you keep — security review on the *final* bundle is more meaningful.
- **A11y + UX in the middle** because they need stable code to test against; doing them too early means redoing them after refactors.
- **Observability before deploy pipeline** so the pipeline can wire monitoring in once.
- **Independent final review (Unit 10)** because the agent who built it cannot be the agent who certifies it. This is the OPC core principle.

## Estimated scope

10 units × ~3 ticks each (build + review + gate) ≈ 30 ticks. At a 20-minute cadence that's roughly 10 hours of unattended work. Set the cron accordingly.
