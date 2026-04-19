import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import istanbul from 'vite-plugin-istanbul';
import { visualizer } from 'rollup-plugin-visualizer';
import path from 'path';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  const shouldInstrument = process.env.VITE_COVERAGE === '1';

  return {
    plugins: [
      react(),
      shouldInstrument && istanbul({
        include: ['src/**/*.ts', 'src/**/*.tsx'],
        exclude: ['node_modules', 'test/', '**/*.test.*', '**/*.spec.*'],
        extension: ['.ts', '.tsx'],
        requireEnv: false,
      }),
      // U4.1: bundle composition evidence. HTML for humans, JSON for the
      // verify-gate; gzip+brotli sizes match what the CDN actually serves.
      visualizer({
        filename: 'dist/stats.html',
        template: 'treemap',
        gzipSize: true,
        brotliSize: true,
        sourcemap: true,
        emitFile: false,
      }),
      visualizer({
        filename: 'dist/stats.json',
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
    define: {
      'process.env': { ...env },
    },
    build: {
      outDir: 'dist',
      sourcemap: true,
      // U4.1: pin to evergreen 2024+ baselines (Chrome/Edge/Firefox 120,
      // Safari 17). Avoids `esnext` (no transpile, breaks older Safari)
      // and the wide ES2015 target that bloats output.
      target: ['chrome120', 'firefox120', 'safari17', 'edge120'],
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
              id.includes('/scheduler/')
            ) return 'vendor-react';
            if (id.includes('/@supabase/')) return 'vendor-supabase';
            if (
              id.includes('/i18next') ||
              id.includes('/react-i18next')
            ) return 'vendor-i18n';
            if (id.includes('/@fortawesome/')) return 'vendor-icons';
            return undefined;
          },
        },
      },
    },
    test: {
      globals: true,
      environment: 'jsdom',
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
