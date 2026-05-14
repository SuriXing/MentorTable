import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  timeout: 60000,
  retries: 0,
  // Use single worker when collecting coverage so that the coverage fixture
  // writes sequentially to .nyc_output without races.
  workers: process.env.COLLECT_UI_COVERAGE === '1' ? 1 : undefined,
  use: {
    baseURL: 'http://127.0.0.1:3001',
    headless: true,
    // Local sandbox has no Playwright-managed chromium cache; CI installs
    // chromium and uses it, while local runs fall back to system Chrome.
    channel: process.env.PLAYWRIGHT_CHANNEL || undefined,
  },
  webServer: [
    {
      command: 'node server.js',
      port: 8787,
      reuseExistingServer: true,
    },
    {
      // When COLLECT_UI_COVERAGE=1, start Vite with istanbul instrumentation
      command:
        process.env.COLLECT_UI_COVERAGE === '1'
          ? 'VITE_COVERAGE=1 npx vite --port 3001 --host 127.0.0.1 --force'
          : 'npx vite --port 3001 --host 127.0.0.1',
      port: 3001,
      reuseExistingServer: !process.env.COLLECT_UI_COVERAGE,
    },
    {
      // F153: prod-header preview server (serves dist/ with the vercel.ts
      // security headers). Requires `npm run build` first — CI always builds
      // before e2e; locally run `npm run build` once before playwright.
      command: 'npx vite preview --port 5001 --strictPort --host 127.0.0.1',
      port: 5001,
      reuseExistingServer: true,
    },
  ],
});
