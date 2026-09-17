import { describe, expect, it } from 'vitest';
import {
  ADVICE_LANGUAGE_STORE_KEY,
  loadAdviceLanguagePreference,
  parseAdviceLanguage,
  saveAdviceLanguagePreference,
} from '../adviceLanguage';

describe('advice language preference', () => {
  it('accepts only the two languages supported by the API contract', () => {
    expect(parseAdviceLanguage('en')).toBe('en');
    expect(parseAdviceLanguage('zh-CN')).toBe('zh-CN');
    expect(parseAdviceLanguage('ja')).toBeNull();
    expect(parseAdviceLanguage('')).toBeNull();
    expect(parseAdviceLanguage(null)).toBeNull();
  });

  it('loads a valid preference and ignores stale values', () => {
    expect(loadAdviceLanguagePreference({ getItem: () => 'zh-CN' })).toBe('zh-CN');
    expect(loadAdviceLanguagePreference({ getItem: () => 'es' })).toBeNull();
  });

  it('returns null when storage is unavailable', () => {
    expect(loadAdviceLanguagePreference({
      getItem: () => {
        throw new DOMException('blocked', 'SecurityError');
      },
    })).toBeNull();
  });

  it('persists a valid preference and reports storage failure', () => {
    const values = new Map<string, string>();
    expect(saveAdviceLanguagePreference('en', {
      setItem: (key, value) => {
        values.set(key, value);
      },
    })).toBe(true);
    expect(values.get(ADVICE_LANGUAGE_STORE_KEY)).toBe('en');

    expect(saveAdviceLanguagePreference('zh-CN', {
      setItem: () => {
        throw new DOMException('quota', 'QuotaExceededError');
      },
    })).toBe(false);
  });
});
