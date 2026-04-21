// U7.1 + F150: FOUC kill, served from /theme-bootstrap.js as a same-origin
// script so it runs synchronously before paint without needing
// `unsafe-inline` in script-src CSP. Vite copies public/* to dist root
// unchanged at build, so the served path stays /theme-bootstrap.js in
// production. Coordinates with src/hooks/useTheme.ts (keys:
// anoncafe_theme, anoncafe_theme_mode) and src/i18n.ts (key: language).
// All wrapped in try/catch — Safari Private Browsing throws SecurityError
// on localStorage access.
(function () {
  try {
    var THEMES = {
      blue:   { p: '#4360D3', d: '#3149a8', l: '#8A9FFC' },
      purple: { p: '#9F6BFF', d: '#7C3AED', l: '#C4A6FF' },
      teal:   { p: '#2DD4BF', d: '#0D9488', l: '#5EEAD4' },
      sunset: { p: '#FB7185', d: '#E11D48', l: '#FDA4AF' },
      forest: { p: '#4ADE80', d: '#16A34A', l: '#86EFAC' }
    };
    var theme = 'blue';
    var mode = 'dark';
    var lang = 'zh-CN';
    try { var t = localStorage.getItem('anoncafe_theme'); if (t && THEMES[t]) theme = t; } catch (e) {}
    try { var m = localStorage.getItem('anoncafe_theme_mode'); if (m === 'light' || m === 'dark') mode = m; } catch (e) {}
    try { var l = localStorage.getItem('language'); if (l) lang = l; } catch (e) {}
    if (mode === 'dark' && !localStorage.getItem('anoncafe_theme_mode')) {
      // honor system preference when nothing persisted
      try {
        if (window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches) mode = 'light';
      } catch (e) {}
    }
    var root = document.documentElement;
    var t2 = THEMES[theme];
    root.style.setProperty('--primary', t2.p);
    root.style.setProperty('--primary-dark', t2.d);
    root.style.setProperty('--primary-light', t2.l);
    root.style.setProperty('--primary-color', t2.p);
    root.style.setProperty('--color-primary', t2.p);
    root.style.setProperty('--color-primary-dark', t2.d);
    root.style.setProperty('--border-focus', t2.p);
    root.dataset.themeMode = mode;
    root.dataset.theme = mode;
    root.lang = lang;
  } catch (e) {
    // best-effort only; React boot will re-apply.
  }
})();
