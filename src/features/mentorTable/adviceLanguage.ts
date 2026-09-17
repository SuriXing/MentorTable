export type AdviceLanguage = 'en' | 'zh-CN';

export const ADVICE_LANGUAGE_STORE_KEY = 'mentorTableAdviceLanguage';

export function parseAdviceLanguage(value: unknown): AdviceLanguage | null {
  return value === 'en' || value === 'zh-CN' ? value : null;
}

export function loadAdviceLanguagePreference(
  storage: Pick<Storage, 'getItem'> = localStorage
): AdviceLanguage | null {
  try {
    return parseAdviceLanguage(storage.getItem(ADVICE_LANGUAGE_STORE_KEY));
  } catch {
    return null;
  }
}

export function saveAdviceLanguagePreference(
  language: AdviceLanguage,
  storage: Pick<Storage, 'setItem'> = localStorage
): boolean {
  try {
    storage.setItem(ADVICE_LANGUAGE_STORE_KEY, language);
    return true;
  } catch {
    return false;
  }
}
