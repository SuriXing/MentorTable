import React, { Suspense, lazy } from 'react';
import ReactDOM from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
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

// Layout-preserving skeleton: occupies the same viewport box as the real
// page so the chunk swap is CLS-free. role=status + aria-live so AT users
// hear the loading state without a visual spinner.
function PageSkeleton() {
  return (
    <div
      role="status"
      aria-live="polite"
      aria-label="Loading"
      style={{
        minHeight: '100vh',
        width: '100%',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: 'var(--bg, #0b1020)',
        color: 'var(--text-muted, #9aa3b2)',
        fontFamily: 'system-ui, -apple-system, sans-serif',
        fontSize: 14,
        letterSpacing: '0.04em',
      }}
    >
      <span>Loading…</span>
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
        </ErrorBoundary>
      </MemoryRouter>
    </React.StrictMode>
  );
}
