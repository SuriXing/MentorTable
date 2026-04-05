import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  timeout: 60000,
  retries: 0,
  // Use single worker when collecting coverage so that the coverage fixture
  // writes sequentially to .nyc_output without races.
  workers: process.env.COLLECT_UI_COVERAGE === '1' ? 1 : undefined,
  use: {
    baseURL: 'http://localhost:3001',
    headless: true,
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
          ? 'VITE_COVERAGE=1 npx vite --port 3001 --force'
          : 'npx vite --port 3001',
      port: 3001,
      reuseExistingServer: !process.env.COLLECT_UI_COVERAGE,
    },
  ],
});
