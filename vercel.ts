/**
 * Vercel project configuration (TypeScript).
 *
 * Compiled to vercel.json automatically during `vercel build` / `vercel dev` /
 * `vercel deploy`. To preview the compiled output locally, run:
 *
 *   npx @vercel/config compile
 *
 * Migrated from vercel.json on 2026/04/21 (U9.1 — deployment pipeline).
 */
import type { VercelConfig } from '@vercel/config/v1';

const SECURITY_HEADERS = [
  {
    key: 'Content-Security-Policy',
    value:
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; " +
      "font-src 'self' data:; img-src 'self' data: blob:; connect-src 'self'; " +
      "frame-ancestors 'none'; base-uri 'self'; object-src 'none'; form-action 'self'",
  },
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'X-Frame-Options', value: 'DENY' },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  {
    key: 'Strict-Transport-Security',
    value: 'max-age=63072000; includeSubDomains; preload',
  },
  {
    key: 'Permissions-Policy',
    value:
      'camera=(), microphone=(), geolocation=(), payment=(), usb=(), bluetooth=(), ' +
      'accelerometer=(), gyroscope=(), magnetometer=(), browsing-topics=(), ' +
      'display-capture=(), interest-cohort=()',
  },
] as const;

export const config: VercelConfig = {
  buildCommand: 'vite build',
  outputDirectory: 'dist',
  alias: ['mentor-table.vercel.app'],

  rewrites: [
    { source: '/api/mentor-table', destination: '/api/mentor-table' },
    { source: '/api/mentor-image', destination: '/api/mentor-image' },
    { source: '/api/mentor-debug-prompt', destination: '/api/mentor-debug-prompt' },
    // SPA fallback — must be LAST.
    { source: '/(.*)', destination: '/index.html' },
  ],

  headers: [
    {
      source: '/(.*)',
      headers: [...SECURITY_HEADERS],
    },
  ],

  // TODO: Rolling Releases (10% → 50% → 100%) are NOT yet exposed in the
  // @vercel/config v0.2.x typings. Configure via the Vercel dashboard:
  //   Project → Settings → Deployment Protection → Rolling Releases
  // Recommended stages:
  //   - Stage 1: 10% for 5 minutes
  //   - Stage 2: 50% for 10 minutes
  //   - Stage 3: 100% (full)
  // Rollback: `vercel rollback <previous-deployment-url>` or one-click in the
  // dashboard (Deployments → previous prod deploy → "Promote to Production").
  // See RUNBOOK.md → Deployment Pipeline.
};

export default config;
