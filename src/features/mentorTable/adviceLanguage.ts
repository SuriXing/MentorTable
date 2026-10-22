export const ADVICE_LANGUAGES = ['en', 'zh-CN', 'ja', 'ko', 'es'] as const;

export type AdviceLanguage = (typeof ADVICE_LANGUAGES)[number];

export const ADVICE_LANGUAGE_STORE_KEY = 'mentorTableAdviceLanguage';

export function parseAdviceLanguage(value: unknown): AdviceLanguage | null {
  return typeof value === 'string' && (ADVICE_LANGUAGES as readonly string[]).includes(value)
    ? (value as AdviceLanguage)
    : null;
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
