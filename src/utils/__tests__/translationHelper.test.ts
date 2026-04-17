/* eslint-disable no-missing-i18n-key -- this file contains test fixtures with
 * synthetic keys that intentionally don't exist in the canonical EN catalog. */
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
  // when true, useTranslation().t throws
  throwOnHookCurrent: false,
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

vi.mock('react-i18next', () => {
  return {
    useTranslation: () => ({
      t: (key: string, options?: any) => {
        if (state.throwOnHookCurrent) throw new Error('boom');
        const val = state.currentTranslations[key];
        if (val !== undefined) return val;
        if (options && 'defaultValue' in options) return options.defaultValue;
        return key;
      },
      i18n: {
        language: state.language,
      },
    }),
  };
});

import {
  useTypeSafeTranslation,
  getCurrentLanguage,
  translate,
  getTranslation,
  getSiteName,
} from '../translationHelper';
import i18next from 'i18next';

// Helper to reset state between tests
function resetState() {
  state.language = 'en';
  state.currentTranslations = {};
  state.fixedTranslations = {};
  state.throwOnCurrent = false;
  state.throwOnHookCurrent = false;
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
  describe('useTypeSafeTranslation (hook)', () => {
    it('returns translation from current language when available', () => {
      state.currentTranslations = { hello: 'Hello' };
      const { t } = useTypeSafeTranslation();
      expect(t('hello')).toBe('Hello');
    });

    it('falls back to zh-CN when current language has no value', () => {
      state.currentTranslations = {}; // current empty
      state.fixedTranslations = {
        'zh-CN': { hello: '你好' },
        en: { hello: 'Hello' },
      };
      const { t } = useTypeSafeTranslation();
      expect(t('hello')).toBe('你好');
    });

    it('falls back to en when zh-CN also missing', () => {
      state.fixedTranslations = {
        'zh-CN': {},
        en: { hello: 'Hello' },
      };
      const { t } = useTypeSafeTranslation();
      expect(t('hello')).toBe('Hello');
    });

    it('returns key when all fallbacks fail and warns in development', () => {
      const prev = process.env.NODE_ENV;
      process.env.NODE_ENV = 'development';
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const { t } = useTypeSafeTranslation();
      expect(t('missing.key')).toBe('missing.key');
      expect(warnSpy).toHaveBeenCalled();
      process.env.NODE_ENV = prev;
    });

    it('does not warn when not in development and key is missing', () => {
      const prev = process.env.NODE_ENV;
      process.env.NODE_ENV = 'production';
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const { t } = useTypeSafeTranslation();
      expect(t('missing.key')).toBe('missing.key');
      expect(warnSpy).not.toHaveBeenCalled();
      process.env.NODE_ENV = prev;
    });

    it('catches errors and returns the key', () => {
      state.throwOnHookCurrent = true;
      const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const { t } = useTypeSafeTranslation();
      expect(t('some.key')).toBe('some.key');
      expect(errSpy).toHaveBeenCalled();
    });

    it('passes options through to the t function', () => {
      state.currentTranslations = { greet: 'Hi {{name}}' };
      const { t } = useTypeSafeTranslation();
      // Our mock does not interpolate; still, the mock returns the raw value.
      expect(t('greet', { name: 'Suri' })).toBe('Hi {{name}}');
    });
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

    it('detects zh from browser and maps to zh-CN', () => {
      setNavigatorLanguage('zh-TW');
      expect(getCurrentLanguage()).toBe('zh-CN');
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

    it('defaults to zh-CN for unknown browser languages', () => {
      setNavigatorLanguage('de');
      expect(getCurrentLanguage()).toBe('zh-CN');
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

  // ------------------------------------------------------------------------
  describe('getTranslation', () => {
    it('returns translation when present', () => {
      state.currentTranslations = { a: 'A' };
      expect(getTranslation('a', 'fallback')).toBe('A');
    });

    it('returns fallback when translation is missing', () => {
      expect(getTranslation('missing', 'fallback value')).toBe('fallback value');
    });

    it('returns empty string when no fallback provided and key missing', () => {
      expect(getTranslation('missing')).toBe('');
    });
  });

  // ------------------------------------------------------------------------
  describe('getSiteName', () => {
    it('calls i18n.t with siteName key and default', () => {
      const fakeI18n = {
        t: vi.fn().mockReturnValue('My Site'),
      } as any;
      expect(getSiteName(fakeI18n)).toBe('My Site');
      expect(fakeI18n.t).toHaveBeenCalledWith('siteName', 'Anon cafe');
    });

    it('works with the mocked i18next default export too', () => {
      state.currentTranslations = { siteName: 'Anon Cafe Local' };
      // getSiteName uses whatever i18n you pass in. Use mocked i18next.
      expect(getSiteName(i18next as any)).toBe('Anon Cafe Local');
    });
  });
});
