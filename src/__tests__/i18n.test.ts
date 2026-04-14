import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Store a reference to the mock methods so assertions can reach them
const initSpy = vi.fn();
const useSpy = vi.fn();
const onSpy = vi.fn();
const addResourceBundleSpy = vi.fn();
const tMock = vi.fn((key: string, _fallback?: any) => {
  if (key === 'siteName') return 'My Site';
  if (key === 'siteDescription') return 'My Description';
  return key;
});

// Capture the handler registered for 'languageChanged' so tests can fire it
let languageChangedHandler: ((lng: string) => void) | null = null;

// Mutable language detector return value so tests can simulate a browser
// whose preferred language is one of the lazy locales (ja/ko/es).
let currentDetectedLanguage = 'en';

vi.mock('i18next', () => {
  const instance: any = {
    use: (..._args: any[]) => {
      useSpy(..._args);
      return instance;
    },
    init: (opts: any) => {
      initSpy(opts);
      return Promise.resolve();
    },
    on: (event: string, handler: (lng: string) => void) => {
      onSpy(event, handler);
      if (event === 'languageChanged') languageChangedHandler = handler;
    },
    addResourceBundle: (lng: string, ns: string, res: any) => {
      addResourceBundleSpy(lng, ns, res);
      return instance;
    },
    t: tMock,
    language: 'en',
  };
  return {
    default: instance,
  };
});

vi.mock('react-i18next', () => ({
  initReactI18next: { type: '3rdParty', name: 'reactI18next' },
}));

vi.mock('i18next-http-backend', () => ({
  default: class {
    static type = 'backend';
  },
}));

vi.mock('i18next-browser-languagedetector', () => ({
  default: class {
    static type = 'languageDetector';
  },
}));

vi.mock('../utils/translationHelper', () => ({
  getCurrentLanguage: () => currentDetectedLanguage,
}));

vi.mock('../utils/environmentLabel', () => ({
  withLocalSuffix: (label: string) => `${label} [local]`,
}));

// Mock locale JSON imports — zh-CN + en are statically imported (hot path),
// ja/ko/es are dynamically imported at language-switch time (R2D BUNDLE-2).
vi.mock('../locales/en/translation.json', () => ({
  default: { siteName: 'Anon Cafe' },
}));
vi.mock('../locales/zh-CN/translation.json', () => ({
  default: { siteName: '匿名咖啡' },
}));
vi.mock('../locales/ja/translation.json', () => ({ default: { siteName: 'サイト' } }));
vi.mock('../locales/ko/translation.json', () => ({ default: { siteName: '사이트' } }));
vi.mock('../locales/es/translation.json', () => ({ default: { siteName: 'Sitio' } }));

describe('i18n setup', () => {
  beforeEach(() => {
    vi.resetModules();
    initSpy.mockClear();
    useSpy.mockClear();
    onSpy.mockClear();
    addResourceBundleSpy.mockClear();
    tMock.mockClear();
    languageChangedHandler = null;
    currentDetectedLanguage = 'en';
  });

  afterEach(() => {
    // Clean up any DOM side effects
    document.title = '';
    document.documentElement.lang = '';
    const meta = document.querySelector('meta[name="description"]');
    if (meta) meta.remove();
  });

  it('initializes i18next with required options', async () => {
    const mod = await import('../i18n');
    expect(mod.default).toBeDefined();
    expect(initSpy).toHaveBeenCalledTimes(1);
    const opts = initSpy.mock.calls[0][0];
    expect(opts.lng).toBe('en');
    expect(opts.fallbackLng).toEqual(['zh-CN', 'en']);
    expect(opts.load).toBe('currentOnly');
    expect(opts.resources).toBeDefined();
    // R2D BUNDLE-2: only the hot-path locales (zh-CN + en) are statically
    // imported. ja/ko/es are dynamically imported on demand.
    expect(Object.keys(opts.resources).sort()).toEqual(['en', 'zh-CN'].sort());
    expect(opts.resources.ja).toBeUndefined();
    expect(opts.resources.ko).toBeUndefined();
    expect(opts.resources.es).toBeUndefined();
  });

  it('wires up http backend, language detector and initReactI18next via use()', async () => {
    await import('../i18n');
    // Three use() calls: backend, detector, initReactI18next
    expect(useSpy).toHaveBeenCalledTimes(3);
  });

  it('registers a languageChanged listener', async () => {
    await import('../i18n');
    expect(onSpy).toHaveBeenCalledWith('languageChanged', expect.any(Function));
    expect(languageChangedHandler).toBeInstanceOf(Function);
  });

  it('languageChanged handler updates document.lang, localStorage, title, and meta description', async () => {
    // Create a meta description element so the handler can update it
    const meta = document.createElement('meta');
    meta.setAttribute('name', 'description');
    meta.setAttribute('content', '');
    document.head.appendChild(meta);

    await import('../i18n');
    expect(languageChangedHandler).toBeTruthy();

    // Invoke the handler
    languageChangedHandler!('ja');

    expect(document.documentElement.lang).toBe('ja');
    expect(localStorage.getItem('language')).toBe('ja');
    expect(document.title).toBe('My Site [local]');
    expect(document.querySelector('meta[name="description"]')?.getAttribute('content')).toBe(
      'My Description'
    );

    meta.remove();
  });

  it('languageChanged handler runs without throwing when no meta description exists', async () => {
    // Make sure no meta description element is in the DOM
    document.querySelectorAll('meta[name="description"]').forEach((n) => n.remove());

    await import('../i18n');
    expect(() => languageChangedHandler!('ko')).not.toThrow();
    expect(document.documentElement.lang).toBe('ko');
  });

  it('interpolation.escapeValue is false', async () => {
    await import('../i18n');
    const opts = initSpy.mock.calls[0][0];
    expect(opts.interpolation.escapeValue).toBe(false);
  });

  it('react config disables Suspense and binds languageChanged', async () => {
    await import('../i18n');
    const opts = initSpy.mock.calls[0][0];
    expect(opts.react.useSuspense).toBe(false);
    expect(opts.react.bindI18n).toBe('languageChanged');
  });

  it('exports the i18n instance as default', async () => {
    const mod = await import('../i18n');
    expect(mod.default).toBeTruthy();
    expect(typeof mod.default.use).toBe('function');
    expect(typeof mod.default.init).toBe('function');
  });

  // -------------------------------------------------------------------------
  // R2D BUNDLE-2: ja/ko/es are lazy-loaded on demand, not bundled statically.
  // -------------------------------------------------------------------------
  describe('lazy locale loading', () => {
    it('does not register ja/ko/es resource bundles at init time', async () => {
      await import('../i18n');
      // addResourceBundle must NOT have been called for lazy locales before
      // the user switches to them — that would defeat the bundle-split.
      expect(addResourceBundleSpy).not.toHaveBeenCalled();
    });

    it('lazy-loads the target locale the first time the user switches to it', async () => {
      await import('../i18n');
      expect(languageChangedHandler).toBeTruthy();
      // Simulate a switch to Japanese.
      languageChangedHandler!('ja');
      // Allow the dynamic import() promise chain to settle.
      await new Promise((r) => setTimeout(r, 0));
      await new Promise((r) => setTimeout(r, 0));
      expect(addResourceBundleSpy).toHaveBeenCalledTimes(1);
      const [lng, ns, res] = addResourceBundleSpy.mock.calls[0];
      expect(lng).toBe('ja');
      expect(ns).toBe('translation');
      expect(res).toEqual({ siteName: 'サイト' });
    });

    it('does NOT re-load an already-loaded lazy locale on repeated switches', async () => {
      await import('../i18n');
      languageChangedHandler!('ko');
      await new Promise((r) => setTimeout(r, 0));
      await new Promise((r) => setTimeout(r, 0));
      expect(addResourceBundleSpy).toHaveBeenCalledTimes(1);

      // Switch to ko a second time — should NOT trigger another
      // addResourceBundle call (the loader short-circuits via loadedLazyLocales).
      languageChangedHandler!('ko');
      await new Promise((r) => setTimeout(r, 0));
      await new Promise((r) => setTimeout(r, 0));
      expect(addResourceBundleSpy).toHaveBeenCalledTimes(1);
    });

    it('switching to a statically-bundled locale (en/zh-CN) does NOT call addResourceBundle', async () => {
      await import('../i18n');
      languageChangedHandler!('en');
      await new Promise((r) => setTimeout(r, 0));
      languageChangedHandler!('zh-CN');
      await new Promise((r) => setTimeout(r, 0));
      expect(addResourceBundleSpy).not.toHaveBeenCalled();
    });

    it('auto-loads the detected lazy locale at startup', async () => {
      // Simulate a browser whose preferred language is Spanish so the
      // startup-bootstrap branch of loadLazyLocale runs.
      currentDetectedLanguage = 'es';
      await import('../i18n');
      // Dynamic import resolves on a microtask; flush.
      await new Promise((r) => setTimeout(r, 0));
      await new Promise((r) => setTimeout(r, 0));
      expect(addResourceBundleSpy).toHaveBeenCalled();
      const call = addResourceBundleSpy.mock.calls.find((c) => c[0] === 'es');
      expect(call).toBeTruthy();
      expect(call![2]).toEqual({ siteName: 'Sitio' });
    });
  });
});
