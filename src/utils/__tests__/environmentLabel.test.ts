import { vi } from 'vitest';

describe('environmentLabel', () => {
  const originalWindow = globalThis.window;

  afterEach(() => {
    vi.restoreAllMocks();
    if (originalWindow) {
      globalThis.window = originalWindow;
    }
  });

  describe('isLocalRuntime', () => {
    it('returns true for localhost', async () => {
      vi.stubGlobal('window', { location: { hostname: 'localhost' } });
      vi.resetModules();
      const { isLocalRuntime } = await import('../environmentLabel');
      expect(isLocalRuntime()).toBe(true);
    });

    it('returns true for 127.0.0.1', async () => {
      vi.stubGlobal('window', { location: { hostname: '127.0.0.1' } });
      vi.resetModules();
      const { isLocalRuntime } = await import('../environmentLabel');
      expect(isLocalRuntime()).toBe(true);
    });

    it('returns true for 0.0.0.0', async () => {
      vi.stubGlobal('window', { location: { hostname: '0.0.0.0' } });
      vi.resetModules();
      const { isLocalRuntime } = await import('../environmentLabel');
      expect(isLocalRuntime()).toBe(true);
    });

    it('returns false for remote hostname', async () => {
      vi.stubGlobal('window', { location: { hostname: 'example.com' } });
      vi.resetModules();
      const { isLocalRuntime } = await import('../environmentLabel');
      expect(isLocalRuntime()).toBe(false);
    });

    it('returns false when window is undefined (SSR)', async () => {
      const savedWindow = globalThis.window;
      // @ts-ignore
      delete globalThis.window;
      vi.resetModules();
      const { isLocalRuntime } = await import('../environmentLabel');
      expect(isLocalRuntime()).toBe(false);
      globalThis.window = savedWindow;
    });
  });

  describe('withLocalSuffix', () => {
    it('adds " - local" suffix on localhost', async () => {
      vi.stubGlobal('window', { location: { hostname: 'localhost' } });
      vi.resetModules();
      const { withLocalSuffix } = await import('../environmentLabel');
      expect(withLocalSuffix('MentorTable')).toBe('MentorTable - local');
    });

    it('returns label unchanged on remote host', async () => {
      vi.stubGlobal('window', { location: { hostname: 'example.com' } });
      vi.resetModules();
      const { withLocalSuffix } = await import('../environmentLabel');
      expect(withLocalSuffix('MentorTable')).toBe('MentorTable');
    });
  });
});
