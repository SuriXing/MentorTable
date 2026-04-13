import React from 'react';
import ReactDOM from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import './i18n';
import './index.css';
import MentorTablePage from './components/pages/MentorTablePage';
import { initBrowserCompatibility } from './utils/browserDetection';

// R2A FIX-CRITIQUE-1: browserDetection was dead code in production — nothing
// imported it, so Round 1's Android/Linux detection fix and iOS resize leak
// fix were never running. Wire it here so the browser-class CSS hooks and
// iOS --vh fix actually take effect.
initBrowserCompatibility();

const root = document.getElementById('root');
if (root) {
  ReactDOM.createRoot(root).render(
    <React.StrictMode>
      <MemoryRouter>
        <MentorTablePage standalone />
      </MemoryRouter>
    </React.StrictMode>
  );
}
