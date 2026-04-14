/**
 * Regression tests for src/utils/ bug fixes.
 *
 * Covers:
 *  - Bug #17: browserDetection.ts — Android UA must report os='Android',
 *    not os='Linux' (Linux substring in Android UA).
 *  - Bug #19: iOS resize listener must not accumulate across repeat calls
 *    to initBrowserCompatibility (HMR, tests, route transitions).
 */
import { vi, describe, it, expect, afterEach, beforeEach } from 'vitest';
import { detectBrowser, initBrowserCompatibility } from '../browserDetection';

describe('bug-fixes: browserDetection', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  describe('Bug #17: Android detection must run before Linux', () => {
    it('classifies Samsung Android UA (which contains "Linux") as os="Android"', () => {
      const samsungUa =
        'Mozilla/5.0 (Linux; Android 13; SM-G991B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Mobile Safari/537.36';
      vi.stubGlobal('window', {
        navigator: { userAgent: samsungUa },
        MSStream: undefined,
      });

      const info = detectBrowser();
      // Before the fix this returned 'Linux' because the regex order tested
      // Linux first and the Android UA contains the substring "Linux".
      expect(info.os).toBe('Android');
      expect(info.isMobile).toBe(true);
    });

    it('classifies Pixel Android UA (with Linux substring) as os="Android"', () => {
      const pixelUa =
        'Mozilla/5.0 (Linux; Android 14; Pixel 8 Pro) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0 Mobile Safari/537.36';
      vi.stubGlobal('window', {
        navigator: { userAgent: pixelUa },
        MSStream: undefined,
      });

      expect(detectBrowser().os).toBe('Android');
    });

    it('still classifies desktop Linux (no Android token) as os="Linux"', () => {
      const desktopLinuxUa =
        'Mozilla/5.0 (X11; Linux x86_64; rv:121.0) Gecko/20100101 Firefox/121.0';
      vi.stubGlobal('window', {
        navigator: { userAgent: desktopLinuxUa },
        MSStream: undefined,
      });

      expect(detectBrowser().os).toBe('Linux');
    });
  });

  describe('Bug #19: iOS resize listener cleanup', () => {
    let addListenerSpy: ReturnType<typeof vi.fn>;
    let removeListenerSpy: ReturnType<typeof vi.fn>;
    let stubHtml: HTMLElement;

    beforeEach(() => {
      addListenerSpy = vi.fn();
      removeListenerSpy = vi.fn();
      stubHtml = {
        classList: { add: vi.fn(), remove: vi.fn() },
        style: { setProperty: vi.fn() },
      } as unknown as HTMLElement;

      const iosUa =
        'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';

      vi.stubGlobal('window', {
        navigator: { userAgent: iosUa },
        MSStream: undefined,
        innerHeight: 900,
        addEventListener: addListenerSpy,
        removeEventListener: removeListenerSpy,
      });

      vi.stubGlobal('document', {
        documentElement: stubHtml,
      });
    });

    it('does not double-add resize listeners when init is called twice', () => {
      initBrowserCompatibility();
      expect(addListenerSpy).toHaveBeenCalledTimes(1);

      // Simulate a second init (HMR, route transition, test remount).
      initBrowserCompatibility();

      // Old listener must have been removed before re-adding.
      expect(removeListenerSpy).toHaveBeenCalledTimes(1);
      expect(addListenerSpy).toHaveBeenCalledTimes(2);
      // Net listeners on window = 1 (not accumulating).
    });

    // R2A FIX-CRITIQUE-7: strengthen hollow count assertion with handler
    // identity + event name. A pure count check passes even if the removal
    // targets a different handler (or a different event). Assert that
    // removeEventListener was called with 'resize' AND with the exact
    // function reference previously passed to addEventListener.
    it('removeEventListener is called with "resize" and the same handler that was added', () => {
      initBrowserCompatibility();

      // Capture the handler added on the first init.
      const firstCall = addListenerSpy.mock.calls[0];
      expect(firstCall[0]).toBe('resize');
      const firstHandler = firstCall[1];
      expect(typeof firstHandler).toBe('function');

      // Second init must remove THAT exact handler.
      initBrowserCompatibility();

      // The removal must target 'resize' with the identical handler reference.
      expect(removeListenerSpy).toHaveBeenCalledTimes(1);
      const removeCall = removeListenerSpy.mock.calls[0];
      expect(removeCall[0]).toBe('resize');
      expect(removeCall[1]).toBe(firstHandler);

      // And the second init adds a (new) handler, still with the 'resize' event.
      const secondAdd = addListenerSpy.mock.calls[1];
      expect(secondAdd[0]).toBe('resize');
      expect(typeof secondAdd[1]).toBe('function');
    });
  });
});
