import React, { useState, useRef, useEffect } from 'react';
import { useTranslation } from 'react-i18next';

const LANGS = ['zh-CN', 'en', 'ja', 'ko', 'es'] as const;
type Lang = typeof LANGS[number];

/**
 * R2-FIX: minimal floating language switcher. The app shipped 5 locale
 * bundles (~45KB gzip) but had no UI to reach ja/ko/es. This renders as
 * a globe button next to the theme controls and opens a compact menu of
 * the 5 supported languages. Selection is persisted to localStorage via
 * i18next's LanguageDetector config (`lookupLocalStorage: 'language'`).
 */
const LanguageSwitcher: React.FC = () => {
  const { i18n, t } = useTranslation();
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  const current = (i18n.language || 'en').toLowerCase();
  const activeCode: Lang =
    LANGS.find((l) => current.startsWith(l.toLowerCase())) || 'en';

  useEffect(() => {
    if (!open) return;
    const onDocClick = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, [open]);

  const changeLang = (lng: Lang) => {
    void i18n.changeLanguage(lng);
    try {
      localStorage.setItem('language', lng);
    } catch { /* Safari Private — session-only */ }
    setOpen(false);
  };

  const label = String(t('language', { defaultValue: 'Language' }));

  return (
    <div
      ref={rootRef}
      style={{
        position: 'fixed',
        right: 140,
        bottom: 20,
        zIndex: 9999,
      }}
    >
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-label={label}
        aria-haspopup="listbox"
        aria-expanded={open}
        title={label}
        style={{
          width: 44,
          height: 44,
          borderRadius: '50%',
          background: 'rgba(18, 20, 34, 0.92)',
          color: '#fff',
          border: '1px solid rgba(91, 123, 250, 0.4)',
          cursor: 'pointer',
          boxShadow: '0 4px 20px rgba(0,0,0,0.25)',
          fontSize: 18,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        🌐
      </button>
      {open && (
        <div
          role="listbox"
          aria-label={label}
          style={{
            position: 'absolute',
            right: 0,
            bottom: 54,
            minWidth: 160,
            padding: 6,
            borderRadius: 10,
            background: 'rgba(18, 20, 34, 0.96)',
            color: '#fff',
            border: '1px solid rgba(91, 123, 250, 0.4)',
            boxShadow: '0 8px 24px rgba(0,0,0,0.35)',
            fontSize: 14,
          }}
        >
          {LANGS.map((lng) => {
            const name = String(
              t(`languageNames.${lng}`, { defaultValue: lng })
            );
            const active = lng === activeCode;
            return (
              <button
                key={lng}
                type="button"
                role="option"
                aria-selected={active}
                onClick={() => changeLang(lng)}
                style={{
                  display: 'block',
                  width: '100%',
                  textAlign: 'left',
                  padding: '8px 10px',
                  borderRadius: 6,
                  border: 'none',
                  background: active ? 'rgba(91, 123, 250, 0.25)' : 'transparent',
                  color: '#fff',
                  cursor: 'pointer',
                  fontWeight: active ? 700 : 400,
                }}
              >
                {name}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
};

export default LanguageSwitcher;
