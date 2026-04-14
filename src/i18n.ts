import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import HttpBackend from 'i18next-http-backend';
import LanguageDetector from 'i18next-browser-languagedetector';
import { getCurrentLanguage } from './utils/translationHelper';
import { withLocalSuffix } from './utils/environmentLabel';
import type { InitOptions, Module } from 'i18next';

// R2D BUNDLE-2: zh-CN + en are the hot path (per MentorTablePage) and are
// bundled statically. ja/ko/es are lazily loaded on-demand via dynamic
// import(), so ~60KB of locale JSON is code-split out of the initial bundle
// and only fetched when the user actually switches to one of those languages.
import enTranslation from './locales/en/translation.json';
import zhCNTranslation from './locales/zh-CN/translation.json';

// Improve TypeScript support for the t function
declare module 'react-i18next' {
  interface CustomTypeOptions {
    returnNull: false;
  }
}

const backendOptions = {
  loadPath: '/locales/{{lng}}/{{ns}}.json',
  addPath: '/locales/{{lng}}/{{ns}}.missing.json'
};

const detectorOptions = {
  order: ['localStorage', 'navigator'],
  lookupLocalStorage: 'language'
};

// 为模块添加必要的类型定义
const typedHttpBackend = HttpBackend as unknown as Module;
const typedLanguageDetector = LanguageDetector as unknown as Module;

const i18nInstance = i18n
  .use(typedHttpBackend)
  .use(typedLanguageDetector)
  .use(initReactI18next);

// Lazy-loaded locale registry. Each entry returns a dynamic import()
// promise; Vite splits these into separate chunks so they only ship over
// the wire when the user actually selects that language.
const LAZY_LOCALES: Record<string, () => Promise<{ default: Record<string, unknown> }>> = {
  ja: () => import('./locales/ja/translation.json'),
  ko: () => import('./locales/ko/translation.json'),
  es: () => import('./locales/es/translation.json')
};

const loadedLazyLocales = new Set<string>();

// loadLazyLocale assumes the caller has already verified `lng in LAZY_LOCALES`
// and is not already loaded. Both call sites guard with those exact checks.
async function loadLazyLocale(lng: string): Promise<void> {
  const mod = await LAZY_LOCALES[lng]();
  i18nInstance.addResourceBundle(lng, 'translation', mod.default, true, true);
  loadedLazyLocales.add(lng);
}

const options: InitOptions = {
  resources: {
    en: {
      translation: enTranslation
    },
    'zh-CN': {
      translation: zhCNTranslation
    }
  },
  lng: getCurrentLanguage(),
  fallbackLng: ['zh-CN', 'en'],
  load: 'currentOnly',

  interpolation: {
    escapeValue: false
  },

  detection: detectorOptions,

  backend: backendOptions,

  react: {
    useSuspense: false,
    bindI18n: 'languageChanged',
    bindI18nStore: '',
    transEmptyNodeValue: '',
    transSupportBasicHtmlNodes: true,
    transKeepBasicHtmlNodesFor: ['br', 'strong', 'i', 'p', 'span']
  },

  debug: process.env.NODE_ENV === 'development'
};

i18nInstance.init(options);

// If the detected language is one of the lazy locales, kick off the load
// immediately so the first render on a ja/ko/es detected browser resolves
// with the right resource bundle. If it fails (split-chunk fetch error),
// i18next falls back to zh-CN/en per fallbackLng — no crash.
{
  const detected = getCurrentLanguage();
  if (detected in LAZY_LOCALES) {
    void loadLazyLocale(detected);
  }
}

// 监听语言切换事件
i18nInstance.on('languageChanged', (lng: string) => {
  // Lazy-load the target locale the first time the user switches to it.
  // Swallow rejections: if the chunk fetch fails, i18next's fallbackLng
  // handles the miss gracefully and we don't crash the UI.
  if (lng in LAZY_LOCALES && !loadedLazyLocales.has(lng)) {
    void loadLazyLocale(lng).catch(() => {});
  }

  document.documentElement.lang = lng;
  localStorage.setItem('language', lng);

  // 更新页面标题和描述
  const siteNameTranslation = i18nInstance.t('siteName');
  document.title = withLocalSuffix(siteNameTranslation);

  const metaDescription = document.querySelector('meta[name="description"]');
  if (metaDescription) {
    metaDescription.setAttribute('content', i18nInstance.t('siteDescription'));
  }
});

export default i18nInstance;
