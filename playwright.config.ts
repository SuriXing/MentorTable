import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  timeout: 30000,
  retries: 0,
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
      command: 'npx vite --port 3001',
      port: 3001,
      reuseExistingServer: true,
    },
  ],
});
