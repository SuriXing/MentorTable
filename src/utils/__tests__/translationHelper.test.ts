 
import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';

// --- Mocks ---------------------------------------------------------------

// Mutable state the mocks will read. Each test sets these.
const state = {
  language: 'en',
  // key -> translation for the "current" language
  currentTranslations: {} as Record<string, string>,
  // lang -> key -> translation for fallback languages
  fixedTranslations: {} as Record<string, Record<string, string>>,
  // when true, i18next.t throws
  throwOnCurrent: false,
};

function makeTFn(table: Record<string, string>) {
  return (key: string, options?: any) => {
    const val = table[key];
    if (val !== undefined) return val;
    // Mimic i18next: return defaultValue if provided, else the key
    if (options && 'defaultValue' in options) return options.defaultValue;
    return key;
  };
}

vi.mock('i18next', () => {
  return {
    default: {
      t: (key: string, options?: any) => {
        if (state.throwOnCurrent) throw new Error('boom');
        const val = state.currentTranslations[key];
        if (val !== undefined) return val;
        if (options && 'defaultValue' in options) return options.defaultValue;
        return key;
      },
      getFixedT: (lang: string) => {
        const table = state.fixedTranslations[lang] || {};
        return makeTFn(table);
      },
    },
  };
});

import { getCurrentLanguage, translate } from '../translationHelper';

// Helper to reset state between tests
function resetState() {
  state.language = 'en';
  state.currentTranslations = {};
  state.fixedTranslations = {};
  state.throwOnCurrent = false;
}

describe('translationHelper', () => {
  beforeEach(() => {
    resetState();
    localStorage.clear();
    vi.restoreAllMocks();
  });

  afterEach(() => {
    resetState();
    localStorage.clear();
  });

  // ------------------------------------------------------------------------
  describe('getCurrentLanguage', () => {
    const origNavigator = global.navigator;

    function setNavigatorLanguage(lang: string) {
      Object.defineProperty(window, 'navigator', {
        value: { ...origNavigator, language: lang },
        configurable: true,
      });
    }

    afterEach(() => {
      Object.defineProperty(window, 'navigator', {
        value: origNavigator,
        configurable: true,
      });
    });

    it('returns saved language from localStorage when supported', () => {
      localStorage.setItem('language', 'ja');
      expect(getCurrentLanguage()).toBe('ja');
    });

    it('ignores unsupported saved language and falls back', () => {
      localStorage.setItem('language', 'de');
      setNavigatorLanguage('en');
      expect(getCurrentLanguage()).toBe('en');
    });

    it('maps a zh browser to the English default', () => {
      setNavigatorLanguage('zh-TW');
      expect(getCurrentLanguage()).toBe('en');
    });

    it('maps ja browser language to ja', () => {
      setNavigatorLanguage('ja');
      expect(getCurrentLanguage()).toBe('ja');
    });

    it('maps ko browser language to ko', () => {
      setNavigatorLanguage('ko');
      expect(getCurrentLanguage()).toBe('ko');
    });

    it('maps es browser language to es', () => {
      setNavigatorLanguage('es');
      expect(getCurrentLanguage()).toBe('es');
    });

    it('maps en browser language to en', () => {
      setNavigatorLanguage('en');
      expect(getCurrentLanguage()).toBe('en');
    });

    it('strips the region suffix when resolving the browser language', () => {
      setNavigatorLanguage('en-US');
      expect(getCurrentLanguage()).toBe('en');
    });

    it('defaults to en for unknown browser languages', () => {
      setNavigatorLanguage('de');
      expect(getCurrentLanguage()).toBe('en');
    });

    it('falls back to browser detection when storage access throws', () => {
      // Safari private mode / sandboxed iframe: getItem throws SecurityError.
      const realStorage = window.localStorage;
      Object.defineProperty(window, 'localStorage', {
        value: { getItem() { throw new Error('SecurityError'); } },
        configurable: true,
      });
      try {
        setNavigatorLanguage('ja');
        expect(getCurrentLanguage()).toBe('ja');
      } finally {
        Object.defineProperty(window, 'localStorage', { value: realStorage, configurable: true });
      }
    });

    it('defaults to en when both storage and navigator are unavailable', () => {
      const realStorage = window.localStorage;
      Object.defineProperty(window, 'localStorage', {
        value: { getItem() { throw new Error('SecurityError'); } },
        configurable: true,
      });
      Object.defineProperty(window, 'navigator', {
        value: { get language() { throw new Error('navigator unavailable'); } },
        configurable: true,
      });
      try {
        expect(getCurrentLanguage()).toBe('en');
      } finally {
        Object.defineProperty(window, 'localStorage', { value: realStorage, configurable: true });
      }
    });
  });

  // ------------------------------------------------------------------------
  describe('translate (non-hook)', () => {
    it('returns the current-language translation if present', () => {
      state.currentTranslations = { hello: 'Hello' };
      expect(translate('hello')).toBe('Hello');
    });

    it('uses zh-CN fallback when current is missing', () => {
      state.fixedTranslations = {
        'zh-CN': { hello: '你好' },
      };
      expect(translate('hello')).toBe('你好');
    });

    it('uses en fallback when zh-CN also missing', () => {
      state.fixedTranslations = {
        'zh-CN': {},
        en: { hello: 'Hi' },
      };
      expect(translate('hello')).toBe('Hi');
    });

    it('returns key when no translation is found anywhere', () => {
      expect(translate('nope.key')).toBe('nope.key');
    });

    it('catches errors and returns the key', () => {
      state.throwOnCurrent = true;
      const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      expect(translate('some.key')).toBe('some.key');
      expect(errSpy).toHaveBeenCalled();
    });
  });
});
