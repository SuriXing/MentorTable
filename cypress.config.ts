import { defineConfig } from 'cypress';

// Cypress E2E config. CI starts a vite dev server on port 3001 and the
// Express API on port 8787 before invoking `cypress run` (see
// .github/workflows/ci.yml). Locally: `npm run dev` then
// `npm run test:e2e:open`.
export default defineConfig({
  e2e: {
    baseUrl: 'http://localhost:3001',
    specPattern: 'cypress/e2e/**/*.cy.{js,jsx,ts,tsx}',
    supportFile: false,
    video: false,
    screenshotOnRunFailure: true,
    defaultCommandTimeout: 10000,
  },
});
