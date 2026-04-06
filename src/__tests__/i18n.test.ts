import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Store a reference to the mock methods so assertions can reach them
const initSpy = vi.fn();
const useSpy = vi.fn();
const onSpy = vi.fn();
const tMock = vi.fn((key: string, _fallback?: any) => {
  if (key === 'siteName') return 'My Site';
  if (key === 'siteDescription') return 'My Description';
  return key;
});

// Capture the handler registered for 'languageChanged' so tests can fire it
let languageChangedHandler: ((lng: string) => void) | null = null;

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
  getCurrentLanguage: () => 'en',
}));

vi.mock('../utils/environmentLabel', () => ({
  withLocalSuffix: (label: string) => `${label} [local]`,
}));

// Mock locale JSON imports
vi.mock('../locales/en/translation.json', () => ({
  default: { siteName: 'Anon Cafe' },
}));
vi.mock('../locales/zh-CN/translation.json', () => ({
  default: { siteName: '匿名咖啡' },
}));
vi.mock('../locales/ja/translation.json', () => ({ default: {} }));
vi.mock('../locales/ko/translation.json', () => ({ default: {} }));
vi.mock('../locales/es/translation.json', () => ({ default: {} }));

describe('i18n setup', () => {
  beforeEach(() => {
    vi.resetModules();
    initSpy.mockClear();
    useSpy.mockClear();
    onSpy.mockClear();
    tMock.mockClear();
    languageChangedHandler = null;
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
    expect(Object.keys(opts.resources).sort()).toEqual(
      ['en', 'es', 'ja', 'ko', 'zh-CN'].sort()
    );
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
});
