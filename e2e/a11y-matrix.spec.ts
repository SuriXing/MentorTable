/**
 * U6.1: matrix axe scan across (theme × language) on the single SPA route.
 *
 * The existing a11y-r3.spec.ts covers the invite + session phases under a
 * single (theme=blue, mode=light, language=auto) combo. This file extends
 * that to confirm 0 serious/critical violations across every theme palette,
 * both light/dark modes, and both supported languages (en + zh).
 *
 * KISS: only the invite-phase axe scan is parametrized — that's the surface
 * with the most diverse contrast (cards, search, theme toggles, ratings).
 * Session phase contrast is structurally identical and already covered.
 */
import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

const themes = ['blue', 'purple', 'teal', 'sunset', 'forest'] as const;
const modes = ['light', 'dark'] as const;
const languages = ['en', 'zh-CN'] as const;

for (const theme of themes) {
  for (const mode of modes) {
    for (const lang of languages) {
      test(`axe: theme=${theme} mode=${mode} lang=${lang}`, async ({ page }) => {
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
        await expect(page.getByTestId('mentor-person-input')).toBeVisible({
          timeout: 10000,
        });

        // Confirm <html lang> sync fired.
        const htmlLang = await page.evaluate(() => document.documentElement.lang);
        expect(htmlLang).toBe(lang);

        const results = await new AxeBuilder({ page })
          .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
          .analyze();

        const criticalOrSerious = results.violations.filter(
          (v) => v.impact === 'critical' || v.impact === 'serious'
        );

        if (criticalOrSerious.length > 0) {
          console.log(`Violations for ${theme}/${mode}/${lang}:`);
          for (const v of criticalOrSerious) {
            console.log(`  [${v.impact}] ${v.id}: ${v.description}`);
            for (const node of v.nodes.slice(0, 3)) {
              console.log(`    - ${node.target}`);
            }
          }
        }

        expect(criticalOrSerious).toEqual([]);
      });
    }
  }
}
