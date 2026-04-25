/**
 * Single source of truth for the production security headers.
 *
 * Consumed by:
 * - vercel.ts        → deployed response headers (via @vercel/config)
 * - vite.config.mts  → `vite preview` serves the SAME headers locally,
 *                      so e2e can exercise the production header posture
 * - e2e/prod-headers.spec.ts → asserts every header verbatim (F153)
 *
 * Change headers HERE only. The e2e spec fails on any drift between this
 * module and what the preview server actually emits.
 */
export const SECURITY_HEADERS = [
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
