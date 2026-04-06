import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import istanbul from 'vite-plugin-istanbul';
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
      target: 'es2015',
    },
    test: {
      globals: true,
      environment: 'jsdom',
      exclude: ['e2e/**', 'node_modules/**', 'cypress/**'],
      coverage: {
        provider: 'c8',
        reporter: ['text', 'text-summary', 'json-summary', 'json'],
        include: [
          'src/features/**/*.ts',
          'src/utils/**/*.ts',
          'src/hooks/**/*.ts',
          'src/components/**/*.{ts,tsx}',
          'src/context/**/*.{ts,tsx}',
          'src/i18n.ts',
          'api/**/*.js',
        ],
        exclude: [
          '**/*.d.ts',
          '**/*.test.*',
          '**/index.ts',
          'src/main.tsx',
          'src/types/**',
          'src/locales/**',
        ],
      },
    },
  };
});
