import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import istanbul from 'vite-plugin-istanbul';
import { visualizer } from 'rollup-plugin-visualizer';
import path from 'path';
// Single source of truth for prod headers; also consumed by vercel.ts and
// e2e/prod-headers.spec.ts (F153).
import { SECURITY_HEADERS } from './security-headers';

export default defineConfig(({ mode }) => {
  // F6: previously loadEnv(..., '') exposed ALL shell env vars (incl.
  // LLM_API_KEY, DASHSCOPE_*) into the client bundle via the define block
  // below. Restrict to the VITE_ prefix so server-only secrets stay out
  // of the bundle. src/ only reads process.env.NODE_ENV, which Vite
  // injects automatically.
  const env = loadEnv(mode, process.cwd(), 'VITE_');
  const shouldInstrument = process.env.VITE_COVERAGE === '1';
  // F13/F18: visualizer is opt-in only (ANALYZE=1) AND writes outside
  // dist/ so it can never be served from the CDN even when enabled.
  const shouldAnalyze = process.env.ANALYZE === '1';

  return {
    plugins: [
      react(),
      shouldInstrument && istanbul({
        include: ['src/**/*.ts', 'src/**/*.tsx'],
        exclude: ['node_modules', 'test/', '**/*.test.*', '**/*.spec.*'],
        extension: ['.ts', '.tsx'],
        requireEnv: false,
      }),
      shouldAnalyze && visualizer({
        filename: '.bundle-stats/stats.html',
        template: 'treemap',
        gzipSize: true,
        brotliSize: true,
        sourcemap: true,
        emitFile: false,
      }),
      shouldAnalyze && visualizer({
        filename: '.bundle-stats/stats.json',
        template: 'raw-data',
        gzipSize: true,
        brotliSize: true,
        sourcemap: true,
        emitFile: false,
      }),
    ].filter(Boolean),
    resolve: {
      alias: {
        '@': path.resolve(__dirname, './src'),
      },
    },
    base: '/',
    server: {
      port: 3001,
      open: true,
      proxy: {
        '/api': {
          target: 'http://127.0.0.1:8787',
          changeOrigin: true,
        },
      },
    },
    // F153: `vite preview` serves dist/ with the EXACT production security
    // headers, so the prod-header e2e suite exercises the deployed header
    // posture instead of a bare dev server. Source of truth:
    // ./security-headers.ts (same module vercel.ts deploys from).
    preview: {
      port: 5001,
      strictPort: true,
      headers: Object.fromEntries(SECURITY_HEADERS.map((h) => [h.key, h.value])),
    },
    define: {
      'process.env': { ...env },
    },
    build: {
      outDir: 'dist',
      // F14: do NOT ship sourcemaps publicly. Opt-in via SOURCEMAP=1 for
      // local debugging or error-tool uploads.
      sourcemap: process.env.SOURCEMAP === '1',
      // F11: target derived from package.json "browserslist" — do NOT
      // hardcode evergreen-only here (excluded ~70% of CN users).
      rollupOptions: {
        output: {
          // U4.1: vendor-split for cache-friendly long-term hashing. App
          // code churns; vendors don't. A lib bump invalidates one vendor
          // chunk, not the whole entry.
          manualChunks: (id: string) => {
            if (!id.includes('node_modules')) return undefined;
            if (
              id.includes('/react/') ||
              id.includes('/react-dom/') ||
              id.includes('/react-router') ||
              id.includes('/@remix-run/') ||
              id.includes('/scheduler/')
            ) return 'vendor-react';
            if (
              id.includes('/i18next') ||
              id.includes('/react-i18next')
            ) return 'vendor-i18n';
            if (id.includes('/@fortawesome/')) return 'vendor-icons';
            // F16: catch-all so any new dep lands in vendor-misc instead
            // of silently fattening the entry chunk.
            return 'vendor-misc';
          },
        },
      },
    },
    test: {
      globals: true,
      environment: 'jsdom',
      // Normalize localStorage/sessionStorage to jsdom's per-file stores.
      // Node 25+ exposes an experimental file-backed global that either
      // shadows jsdom's (with --localstorage-file) or is an unusable stub
      // (without it) — see vitest.setup.ts.
      setupFiles: ['./vitest.setup.ts'],
      exclude: ['e2e/**', 'node_modules/**', 'cypress/**'],
      coverage: {
        provider: 'v8',
        reporter: ['text', 'text-summary', 'json-summary', 'json'],
        // U3.1: count every file in include even if no test imports it.
        all: true,
        include: [
          'src/features/**/*.ts',
          'src/utils/**/*.ts',
          'src/hooks/**/*.ts',
          'src/components/**/*.{ts,tsx}',
          'src/context/**/*.{ts,tsx}',
          'src/i18n.ts',
          'api/**/*.js',
          'lib/**/*.js',
          'server.js',
        ],
        exclude: [
          // Type-only files have no executable code.
          '**/*.d.ts',
          // Test files themselves should not count toward source coverage.
          '**/*.test.*',
          '**/__tests__/**',
          // index.ts barrels are pure re-exports — no logic to cover.
          '**/index.ts',
          // Browser entrypoint: invokes ReactDOM.render once at boot.
          // Excluded from unit coverage; exercised by Cypress/Playwright e2e.
          'src/main.tsx',
          // Pure TypeScript type declarations.
          'src/types/**',
          // Static i18n JSON resource bundles — no executable code.
          'src/locales/**',
        ],
        thresholds: {
          lines: 95,
          branches: 95,
          functions: 95,
          statements: 95,
          autoUpdate: false,
        },
      },
    },
  };
});
