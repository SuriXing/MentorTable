var __assign = (this && this.__assign) || function () {
    __assign = Object.assign || function(t) {
        for (var s, i = 1, n = arguments.length; i < n; i++) {
            s = arguments[i];
            for (var p in s) if (Object.prototype.hasOwnProperty.call(s, p))
                t[p] = s[p];
        }
        return t;
    };
    return __assign.apply(this, arguments);
};
import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import istanbul from 'vite-plugin-istanbul';
import path from 'path';
export default defineConfig(function (_a) {
    var mode = _a.mode;
    var env = loadEnv(mode, process.cwd(), '');
    var shouldInstrument = process.env.VITE_COVERAGE === '1';
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
            'process.env': __assign({}, env),
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
                    'lib/**/*.js',
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
