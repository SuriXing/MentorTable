import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');

  return {
    plugins: [react()],
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
      coverage: {
        provider: 'c8',
        reporter: ['text', 'text-summary'],
        include: [
          'src/features/**/*.ts',
          'src/utils/**/*.ts',
          'src/hooks/**/*.ts',
          'api/**/*.js',
        ],
        exclude: [
          '**/*.d.ts',
          '**/*.test.*',
          '**/index.ts',
        ],
      },
    },
  };
});
