/**
 * Playwright fixture that collects `window.__coverage__` after each test
 * and writes it to .nyc_output so `nyc report` can aggregate coverage.
 *
 * Only active when COLLECT_UI_COVERAGE=1 is set.
 */
import { test as base } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';

const COVERAGE_DIR = path.join(process.cwd(), '.nyc_output');
const SHOULD_COLLECT = process.env.COLLECT_UI_COVERAGE === '1';

if (SHOULD_COLLECT && !fs.existsSync(COVERAGE_DIR)) {
  fs.mkdirSync(COVERAGE_DIR, { recursive: true });
}

export const test = base.extend({
  page: async ({ page }, use, testInfo) => {
    await use(page);

    if (!SHOULD_COLLECT) return;

    // Pull window.__coverage__ from the browser (if present) and persist it.
    try {
      const coverage = await page.evaluate(() => (window as any).__coverage__);
      if (coverage && Object.keys(coverage).length > 0) {
        const hash = crypto
          .createHash('md5')
          .update(testInfo.title + testInfo.retry)
          .digest('hex')
          .slice(0, 8);
        const file = path.join(COVERAGE_DIR, `ui-${hash}-${Date.now()}.json`);
        fs.writeFileSync(file, JSON.stringify(coverage));
      }
    } catch {
      // Page may have been closed; ignore.
    }
  },
});

export { expect } from '@playwright/test';
