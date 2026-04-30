/**
 * T4 close-out: the theme×mode×language axe matrix used to scan the invite
 * phase only — the live session surface (conversation bubbles, source
 * chips, note markers, seat layout) was covered under a single combo in
 * a11y-r3. This file runs the session phase across the full matrix plus a
 * mobile-viewport pass, so contrast or structure regressions in the
 * conversation UI surface in CI, not in a manual audit.
 */
import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

const themes = ['blue', 'purple', 'teal', 'sunset', 'forest'] as const;
const modes = ['light', 'dark'] as const;
const languages = ['en', 'zh-CN'] as const;

async function enterLiveSession(page: import('@playwright/test').Page) {
  // Deterministic session view: mock the mentor-table API (the rest of the
  // stack — person search, image proxy — runs for real against server.js).
  await page.route('**/api/mentor-table', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        schemaVersion: 'mentor_table.v1',
        language: 'en',
        safety: { riskLevel: 'low', needsProfessionalHelp: false, emergencyMessage: '' },
        mentorReplies: [
          {
            mentorId: 'bill_gates',
            mentorName: 'Bill Gates',
            likelyResponse: 'I would identify the bottleneck.',
            whyThisFits: 'Analytical approach.',
            oneActionStep: 'List 3 issues and pick the highest-impact one.',
            confidenceNote: 'AI-simulated.',
          },
        ],
        meta: { disclaimer: 'AI sim.', generatedAt: new Date().toISOString(), source: 'llm' },
      }),
    });
  });

  const search = page.getByTestId('mentor-person-input');
  await search.fill('Bill Gates');
  const menu = page.locator('[class*="suggestionMenu"]');
  await expect(menu).toBeVisible({ timeout: 5000 });
  const first = menu.locator('[class*="suggestionItem"]').first();
  if (await first.isVisible()) {
    await first.click();
  } else {
    await search.press('Enter');
  }
  await expect(search).toHaveValue('', { timeout: 3000 });

  await page.getByTestId('mentor-continue-wish').click();
  await page.getByTestId('mentor-problem-input').fill('How do I stay motivated?');
  await page.getByTestId('mentor-begin-session').click();

  await expect(page.getByTestId('mentor-conversation-panel')).toBeVisible({ timeout: 15000 });
  // Let the reply bubble mount (reveal timer) before scanning.
  await page.waitForTimeout(3200);
}

for (const theme of themes) {
  for (const mode of modes) {
    for (const lang of languages) {
      test(`session axe: theme=${theme} mode=${mode} lang=${lang}`, async ({ page }) => {
        await page.addInitScript(
          ({ theme, mode, lang }) => {
            localStorage.setItem('anoncafe_theme', theme);
            localStorage.setItem('anoncafe_theme_mode', mode);
            localStorage.setItem('language', lang);
            localStorage.setItem('mentorTableOnboardingHiddenV2', '1');
          },
          { theme, mode, lang }
        );
        await page.goto('/', { waitUntil: 'networkidle' });
        await expect(page.getByTestId('mentor-person-input')).toBeVisible({ timeout: 10000 });

        await enterLiveSession(page);

        const results = await new AxeBuilder({ page })
          .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
          .analyze();

        const criticalOrSerious = results.violations.filter(
          (v) => v.impact === 'critical' || v.impact === 'serious'
        );
        if (criticalOrSerious.length > 0) {
          console.log(`Session-phase a11y violations (theme=${theme} mode=${mode} lang=${lang}):`);
          for (const v of criticalOrSerious) {
            console.log(`  [${v.impact}] ${v.id}: ${v.description}`);
          }
        }
        expect(criticalOrSerious).toEqual([]);
      });
    }
  }
}

test.describe('mobile viewport a11y', () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test('invite phase passes axe at phone width', async ({ page }) => {
    await page.addInitScript(() => {
      localStorage.setItem('mentorTableOnboardingHiddenV2', '1');
    });
    await page.goto('/', { waitUntil: 'networkidle' });
    await expect(page.getByTestId('mentor-person-input')).toBeVisible({ timeout: 10000 });

    const results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
      .analyze();
    const criticalOrSerious = results.violations.filter(
      (v) => v.impact === 'critical' || v.impact === 'serious'
    );
    expect(criticalOrSerious).toEqual([]);
  });

  test('session phase passes axe at phone width', async ({ page }) => {
    await page.addInitScript(() => {
      localStorage.setItem('mentorTableOnboardingHiddenV2', '1');
    });
    await page.goto('/', { waitUntil: 'networkidle' });
    await expect(page.getByTestId('mentor-person-input')).toBeVisible({ timeout: 10000 });

    await enterLiveSession(page);

    const results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
      .analyze();
    const criticalOrSerious = results.violations.filter(
      (v) => v.impact === 'critical' || v.impact === 'serious'
    );
    expect(criticalOrSerious).toEqual([]);
  });
});
