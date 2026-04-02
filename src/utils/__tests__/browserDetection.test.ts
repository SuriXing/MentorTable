import { vi } from 'vitest';
import { detectBrowser, initBrowserCompatibility } from '../browserDetection';

// User agent strings for testing
const UA = {
  chrome: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36',
  safari: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.1 Safari/605.1.15',
  firefox: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:121.0) Gecko/20100101 Firefox/121.0',
  edge: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36 Edg/120.0',
  ie11: 'Mozilla/5.0 (Windows NT 10.0; Trident/7.0; rv:11.0) like Gecko',
  ieMsie: 'Mozilla/5.0 (compatible; MSIE 10.0; Windows NT 6.1)',
  androidChrome: 'Mozilla/5.0 (Linux; Android 13; SM-G991B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Mobile Safari/537.36',
  iphone: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
  ipad: 'Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
  linux: 'Mozilla/5.0 (X11; Linux x86_64; rv:121.0) Gecko/20100101 Firefox/121.0',
  unknown: 'SomeRandomBot/1.0',
};

function mockUserAgent(ua: string) {
  vi.stubGlobal('window', {
    navigator: { userAgent: ua },
    MSStream: undefined,
  });
}

describe('detectBrowser', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns defaults when window is undefined (SSR)', () => {
    const savedWindow = globalThis.window;
    // @ts-ignore
    delete globalThis.window;
    const info = detectBrowser();
    expect(info.browserName).toBe('Unknown');
    expect(info.browserVersion).toBe('Unknown');
    expect(info.isMobile).toBe(false);
    expect(info.isIOS).toBe(false);
    expect(info.os).toBe('Unknown');
    globalThis.window = savedWindow;
  });

  describe('Chrome', () => {
    it('detects Chrome on Windows', () => {
      mockUserAgent(UA.chrome);
      const info = detectBrowser();
      expect(info.isChrome).toBe(true);
      expect(info.browserName).toBe('Chrome');
      expect(info.browserVersion).toBe('120.0');
      expect(info.os).toBe('Windows');
      expect(info.isMobile).toBe(false);
    });
  });

  describe('Safari', () => {
    it('detects Safari on Mac', () => {
      mockUserAgent(UA.safari);
      const info = detectBrowser();
      expect(info.isSafari).toBe(true);
      expect(info.browserName).toBe('Safari');
      expect(info.browserVersion).toBe('17.1');
      expect(info.os).toBe('Mac');
    });
  });

  describe('Firefox', () => {
    it('detects Firefox on Windows', () => {
      mockUserAgent(UA.firefox);
      const info = detectBrowser();
      expect(info.isFirefox).toBe(true);
      expect(info.browserName).toBe('Firefox');
      expect(info.browserVersion).toBe('121.0');
      expect(info.os).toBe('Windows');
    });

    it('detects Firefox on Linux', () => {
      mockUserAgent(UA.linux);
      const info = detectBrowser();
      expect(info.isFirefox).toBe(true);
      expect(info.os).toBe('Linux');
    });
  });

  describe('Edge', () => {
    it('detects Edge', () => {
      mockUserAgent(UA.edge);
      const info = detectBrowser();
      expect(info.isEdge).toBe(true);
      expect(info.browserName).toBe('Edge');
      expect(info.browserVersion).toBe('120.0');
      expect(info.isChrome).toBe(false);
    });
  });

  describe('Internet Explorer', () => {
    it('detects IE11 via Trident/rv:', () => {
      mockUserAgent(UA.ie11);
      const info = detectBrowser();
      expect(info.isIE).toBe(true);
      expect(info.browserName).toBe('Internet Explorer');
      expect(info.browserVersion).toBe('11.0');
    });

    it('detects IE via MSIE token', () => {
      mockUserAgent(UA.ieMsie);
      const info = detectBrowser();
      expect(info.isIE).toBe(true);
      expect(info.browserName).toBe('Internet Explorer');
      expect(info.browserVersion).toBe('10.0');
    });

    it('returns Unknown version when IE version pattern missing', () => {
      mockUserAgent('Mozilla/5.0 (Trident/7.0)');
      const info = detectBrowser();
      expect(info.isIE).toBe(true);
      expect(info.browserVersion).toBe('Unknown');
    });
  });

  describe('Mobile', () => {
    it('detects Android mobile Chrome', () => {
      mockUserAgent(UA.androidChrome);
      const info = detectBrowser();
      expect(info.isMobile).toBe(true);
      expect(info.isChrome).toBe(true);
      // Note: Android UA contains "Linux" and the OS detection checks Linux before Android,
      // so Android devices get os='Linux'. This is a known quirk of the detection order.
      expect(info.os).toBe('Linux');
    });

    it('detects iPhone as mobile and iOS', () => {
      mockUserAgent(UA.iphone);
      const info = detectBrowser();
      expect(info.isMobile).toBe(true);
      expect(info.isIOS).toBe(true);
      expect(info.isSafari).toBe(true);
      expect(info.os).toBe('iOS');
    });

    it('detects iPad as mobile and iOS', () => {
      mockUserAgent(UA.ipad);
      const info = detectBrowser();
      expect(info.isMobile).toBe(true);
      expect(info.isIOS).toBe(true);
    });
  });

  describe('OS detection', () => {
    it('detects Android OS when UA has Android but not Linux', () => {
      mockUserAgent('Mozilla/5.0 (Android 13) AppleWebKit/537.36 Chrome/120.0');
      const info = detectBrowser();
      expect(info.os).toBe('Android');
    });
  });

  describe('Unknown browser', () => {
    it('returns Unknown for unrecognized user agent', () => {
      mockUserAgent(UA.unknown);
      const info = detectBrowser();
      expect(info.browserName).toBe('Unknown');
      expect(info.browserVersion).toBe('Unknown');
      expect(info.isChrome).toBe(false);
      expect(info.isSafari).toBe(false);
      expect(info.isFirefox).toBe(false);
      expect(info.isEdge).toBe(false);
      expect(info.isIE).toBe(false);
    });
  });

  describe('version extraction edge cases', () => {
    it('returns Unknown version when Chrome version pattern missing', () => {
      mockUserAgent('Mozilla/5.0 Chrome/ Safari/537.36');
      const info = detectBrowser();
      expect(info.isChrome).toBe(true);
      expect(info.browserVersion).toBe('Unknown');
    });

    it('returns Unknown version when Safari Version pattern missing', () => {
      mockUserAgent('Mozilla/5.0 AppleWebKit/605 Safari/605');
      const info = detectBrowser();
      expect(info.isSafari).toBe(true);
      expect(info.browserVersion).toBe('Unknown');
    });

    it('returns Unknown version when Firefox version pattern missing', () => {
      mockUserAgent('Mozilla/5.0 Firefox/');
      const info = detectBrowser();
      expect(info.isFirefox).toBe(true);
      expect(info.browserVersion).toBe('Unknown');
    });

    it('returns Unknown version when Edge version pattern missing', () => {
      mockUserAgent('Mozilla/5.0 Chrome/120 Edg/');
      const info = detectBrowser();
      expect(info.isEdge).toBe(true);
      expect(info.browserVersion).toBe('Unknown');
    });
  });
});

describe('initBrowserCompatibility', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    // Clean up any classes added to the real document
    if (typeof document !== 'undefined') {
      document.documentElement.classList.remove(
        'is-safari', 'is-firefox', 'is-ie', 'is-edge', 'is-chrome', 'is-mobile', 'is-ios'
      );
    }
  });

  it('does nothing when document is undefined (SSR)', () => {
    const savedDoc = globalThis.document;
    // @ts-ignore
    delete globalThis.document;
    // Should not throw
    expect(() => initBrowserCompatibility()).not.toThrow();
    globalThis.document = savedDoc;
  });

  it('adds is-chrome class for Chrome', () => {
    mockUserAgent(UA.chrome);
    initBrowserCompatibility();
    expect(document.documentElement.classList.contains('is-chrome')).toBe(true);
  });

  it('adds is-safari class for Safari', () => {
    mockUserAgent(UA.safari);
    initBrowserCompatibility();
    expect(document.documentElement.classList.contains('is-safari')).toBe(true);
  });

  it('adds is-firefox class for Firefox', () => {
    mockUserAgent(UA.firefox);
    initBrowserCompatibility();
    expect(document.documentElement.classList.contains('is-firefox')).toBe(true);
  });

  it('adds is-edge class for Edge', () => {
    mockUserAgent(UA.edge);
    initBrowserCompatibility();
    expect(document.documentElement.classList.contains('is-edge')).toBe(true);
  });

  it('adds is-ie class for IE', () => {
    mockUserAgent(UA.ie11);
    initBrowserCompatibility();
    expect(document.documentElement.classList.contains('is-ie')).toBe(true);
  });

  it('adds is-mobile class for mobile browsers', () => {
    mockUserAgent(UA.androidChrome);
    initBrowserCompatibility();
    expect(document.documentElement.classList.contains('is-mobile')).toBe(true);
  });

  it('adds is-ios class and sets --vh for iOS', () => {
    mockUserAgent(UA.iphone);
    const addEventListenerSpy = vi.fn();
    vi.stubGlobal('window', {
      navigator: { userAgent: UA.iphone },
      MSStream: undefined,
      innerHeight: 800,
      addEventListener: addEventListenerSpy,
    });

    initBrowserCompatibility();

    expect(document.documentElement.classList.contains('is-ios')).toBe(true);
    expect(document.documentElement.classList.contains('is-mobile')).toBe(true);
    // --vh should be set to innerHeight * 0.01
    expect(document.documentElement.style.getPropertyValue('--vh')).toBe('8px');
    // resize listener should be registered
    expect(addEventListenerSpy).toHaveBeenCalledWith('resize', expect.any(Function));
  });

  it('iOS resize handler updates --vh', () => {
    const listeners: Record<string, Function> = {};
    vi.stubGlobal('window', {
      navigator: { userAgent: UA.iphone },
      MSStream: undefined,
      innerHeight: 800,
      addEventListener: (event: string, fn: Function) => { listeners[event] = fn; },
    });

    initBrowserCompatibility();
    expect(document.documentElement.style.getPropertyValue('--vh')).toBe('8px');

    // Simulate resize
    (window as any).innerHeight = 600;
    listeners['resize']();
    expect(document.documentElement.style.getPropertyValue('--vh')).toBe('6px');
  });
});
