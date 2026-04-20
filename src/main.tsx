import React, { Suspense, lazy } from 'react';
import ReactDOM from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { Analytics } from '@vercel/analytics/react';
import { SpeedInsights } from '@vercel/speed-insights/react';
import './i18n';
import './index.css';
import ThemePicker from './components/shared/ThemePicker';
import ThemeModeToggle from './components/shared/ThemeModeToggle';
import LanguageSwitcher from './components/shared/LanguageSwitcher';
import ErrorBoundary from './components/shared/ErrorBoundary';
import { initBrowserCompatibility } from './utils/browserDetection';

// R2A FIX-CRITIQUE-1: browserDetection was dead code in production — nothing
// imported it, so Round 1's Android/Linux detection fix and iOS resize leak
// fix were never running. Wire it here so the browser-class CSS hooks and
// iOS --vh fix actually take effect.
initBrowserCompatibility();

// U4.1: split MentorTablePage off the entry chunk. It's the heaviest
// component in the app (FontAwesome icons + mentor engine + person-lookup
// + CSS modules); pulling it out of the initial JS lets the shell, theme
// controls, and i18n boot first paint without waiting on it.
//
// Theme controls + LanguageSwitcher stay eager — they're above-the-fold
// chrome and lazy-loading them would cause a flash of missing UI.
const MentorTablePage = lazy(() => import('./components/pages/MentorTablePage'));

// Layout-preserving skeleton: matches MentorTablePage's silhouette (hero
// strip, top action bar, workspace grid) so the chunk swap is CLS-free.
// role=status + aria-live so AT users hear the loading state. Inline
// styles only — no Tailwind in this project, no extra deps (KISS).
function PageSkeleton() {
  const block: React.CSSProperties = {
    background: 'rgba(255,255,255,0.06)',
    borderRadius: 8,
  };
  const pulse: React.CSSProperties = {
    animation: 'mt-skeleton-pulse 1.4s ease-in-out infinite',
  };
  return (
    <div
      role="status"
      aria-live="polite"
      aria-label="Loading"
      style={{
        minHeight: '100vh',
        width: '100%',
        background: 'var(--bg, #0b1020)',
        color: 'var(--text-muted, #9aa3b2)',
        fontFamily: 'system-ui, -apple-system, sans-serif',
        display: 'flex',
        flexDirection: 'column',
        boxSizing: 'border-box',
        padding: '24px clamp(16px, 4vw, 48px)',
        gap: 20,
      }}
    >
      <style>{`@keyframes mt-skeleton-pulse{0%,100%{opacity:.55}50%{opacity:.9}}`}</style>
      {/* hero strip */}
      <div style={{ ...block, ...pulse, height: 56, width: '40%' }} />
      {/* top action bar */}
      <div style={{ display: 'flex', gap: 12 }}>
        <div style={{ ...block, ...pulse, height: 36, flex: 1 }} />
        <div style={{ ...block, ...pulse, height: 36, width: 120 }} />
      </div>
      {/* workspace: left column (people grid) + right column (session) */}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'minmax(0, 2fr) minmax(0, 1fr)',
          gap: 20,
          flex: 1,
        }}
      >
        <div style={{ ...block, ...pulse, minHeight: 360 }} />
        <div style={{ ...block, ...pulse, minHeight: 360 }} />
      </div>
      <span style={{ position: 'absolute', left: -9999 }}>Loading…</span>
    </div>
  );
}

const root = document.getElementById('root');
if (root) {
  ReactDOM.createRoot(root).render(
    <React.StrictMode>
      <MemoryRouter>
        <ErrorBoundary>
          <Suspense fallback={<PageSkeleton />}>
            <MentorTablePage standalone />
          </Suspense>
          {/* Mount theme controls at app root so they're reachable from the
           * standalone render path (which bypasses Layout). Without this the
           * 🎨 picker + ☀️/🌙 toggle never appear on the main site. */}
          <ThemeModeToggle />
          <ThemePicker />
          <LanguageSwitcher />
          {/* U8.1: Vercel observability. Both components are no-ops when
           * not deployed on Vercel, so local dev is unaffected. Mounted
           * inside the router/boundary so their own render errors are
           * caught by ErrorBoundary too.
           *
           * F60 (U8.1 R2): respect Do-Not-Track. The `beforeSend` filter
           * drops every event when the browser advertises DNT=1 — no
           * pageviews, no `client_error` from ErrorBoundary, no perf
           * beacons from Speed Insights. PIPL/GDPR posture documented
           * in RUNBOOK.md → "Analytics & Privacy". */}
          <Analytics
            beforeSend={(event) => {
              if (typeof navigator !== 'undefined' && navigator.doNotTrack === '1') return null;
              return event;
            }}
          />
          <SpeedInsights />
        </ErrorBoundary>
      </MemoryRouter>
    </React.StrictMode>
  );
}
