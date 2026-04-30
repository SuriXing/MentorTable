/**
 * F153 — production-header parity suite.
 *
 * Until this spec existed, every e2e test ran against a bare `vite dev`
 * server, so the security headers configured in vercel.ts had ZERO CI
 * coverage: they could rot (or contradict the client code) and nothing
 * would fail. This suite runs against `vite preview`, which serves dist/
 * with the exact headers deployed to production (single source:
 * ../security-headers.ts).
 *
 * It asserts three things a header-presence snapshot cannot:
 *   1. Every production header arrives verbatim on the document response.
 *   2. The CSP actually ENFORCES — an external image request is blocked by
 *      the browser, not merely absent from an allowlist.
 *   3. Same-origin assets still load under `img-src 'self'`.
 *   4. The axe a11y matrix passes WITH the production headers active (CSP
 *      and a11y interact only in an environment that has both).
 *
 * Requires a prior `npm run build` (CI builds before this step) and the
 * preview server on :5001 (started by playwright.config.ts webServer).
 */
import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { SECURITY_HEADERS } from '../security-headers';

// CI uses the bundled chromium (installed via `playwright install`). Local
// machines can skip that download entirely — `PLAYWRIGHT_CHANNEL=chrome
// npx playwright test e2e/prod-headers.spec.ts` drives the system Chrome.
// The env override exists because the playwright browser CDN stalls on some
// networks (observed: <2KB/s for 20+ minutes).
test.use({ channel: (process.env.PLAYWRIGHT_CHANNEL || undefined) as 'chrome' | undefined });

test.use({ baseURL: 'http://127.0.0.1:5001' });

test.describe('Production security headers (F153)', () => {
  test('document response carries every production security header verbatim', async ({ request }) => {
    const res = await request.get('/');
    expect(res.status()).toBe(200);
    const responseHeaders = res.headersArray();
    for (const { key, value } of SECURITY_HEADERS) {
      const found = responseHeaders.find((h) => h.name.toLowerCase() === key.toLowerCase());
      expect(found, `${key} must be present on the document response`).toBeTruthy();
      expect(found?.value, `${key} value drift vs security-headers.ts`).toBe(value);
    }
  });

  test('CSP actually blocks an external image request in the browser', async ({ page }) => {
    const violations: string[] = [];
    page.on('console', (msg) => {
      if (msg.type() === 'error') violations.push(msg.text());
    });
    await page.goto('/', { waitUntil: 'domcontentloaded' });

    await page.evaluate(() => {
      const img = document.createElement('img');
      // Any https:// host outside img-src 'self' data: blob: must be refused.
      img.src = 'https://upload.wikimedia.org/wikipedia/commons/8/88/Bill_Gates_at_the_European_Commission_-_2025_-_P067383-987995_%28cropped%29.jpg';
      document.body.appendChild(img);
    });

    await expect
      .poll(() => violations.join('\n'), { timeout: 10_000 })
      // Chrome's CSP enforcement wording; requiring the img-src directive too
      // pins WHICH policy refused the load, not just any error.
      .toMatch(/violates the following Content Security Policy directive[\s\S]*img-src/);
  });

  test('same-origin bundled mentor assets remain loadable under img-src self', async ({ request }) => {
    const res = await request.get('/assets/mentors/albert-einstein.jpg');
    expect(res.status()).toBe(200);
    expect(res.headers()['content-type']).toContain('image/jpeg');
  });

  test('axe scan passes with production headers active', async ({ page }) => {
    await page.addInitScript(() => {
      localStorage.setItem('mentorTableOnboardingHiddenV2', '1');
    });
    await page.goto('/', { waitUntil: 'networkidle' });
    await expect(page.getByTestId('mentor-person-input')).toBeVisible({ timeout: 10_000 });

    const results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
      .analyze();

    const criticalOrSerious = results.violations.filter(
      (v) => v.impact === 'critical' || v.impact === 'serious'
    );
    expect(
      criticalOrSerious.map((v) => ({ id: v.id, impact: v.impact, nodes: v.nodes.length })),
      'axe found critical/serious violations under production headers'
    ).toEqual([]);
  });
});
