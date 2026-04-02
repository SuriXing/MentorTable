import { vi } from 'vitest';

/**
 * environment.ts captures `const env = import.meta.env` at module scope.
 * In vitest, import.meta.env is a mutable object, so we can set properties
 * on it before dynamically importing the module (after vi.resetModules()).
 */
describe('environment', () => {
  const savedMode = import.meta.env.MODE;
  const savedProd = import.meta.env.PROD;
  const savedDev = import.meta.env.DEV;

  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    // Restore original values
    import.meta.env.MODE = savedMode;
    import.meta.env.PROD = savedProd;
    import.meta.env.DEV = savedDev;
    delete (import.meta.env as any).VITE_API_URL;
  });

  describe('NODE_ENV', () => {
    it('uses env.MODE when available', async () => {
      import.meta.env.MODE = 'production';
      const { NODE_ENV } = await import('../environment');
      expect(NODE_ENV).toBe('production');
    });

    it('defaults to development when MODE is empty', async () => {
      import.meta.env.MODE = '';
      const { NODE_ENV } = await import('../environment');
      expect(NODE_ENV).toBe('development');
    });
  });

  describe('IS_PROD', () => {
    it('is truthy when env.PROD is true', async () => {
      import.meta.env.PROD = true as any;
      import.meta.env.MODE = 'production';
      const { IS_PROD } = await import('../environment');
      expect(IS_PROD).toBeTruthy();
    });

    it('is truthy when MODE is production even if PROD is falsy', async () => {
      (import.meta.env as any).PROD = '';
      import.meta.env.MODE = 'production';
      const { IS_PROD } = await import('../environment');
      // NODE_ENV will be 'production', so IS_PROD = false || true = true
      expect(IS_PROD).toBeTruthy();
    });

    it('is falsy when not production', async () => {
      // In Vite, env values are strings. Empty string is falsy.
      (import.meta.env as any).PROD = '';
      import.meta.env.MODE = 'development';
      const { IS_PROD } = await import('../environment');
      expect(IS_PROD).toBeFalsy();
    });
  });

  describe('IS_DEV', () => {
    it('is truthy when env.DEV is true', async () => {
      import.meta.env.DEV = true as any;
      import.meta.env.MODE = 'development';
      const { IS_DEV } = await import('../environment');
      expect(IS_DEV).toBeTruthy();
    });

    it('is truthy when MODE is development even if DEV is falsy', async () => {
      (import.meta.env as any).DEV = '';
      import.meta.env.MODE = 'development';
      const { IS_DEV } = await import('../environment');
      expect(IS_DEV).toBeTruthy();
    });

    it('is falsy when not development and DEV is falsy', async () => {
      (import.meta.env as any).DEV = '';
      import.meta.env.MODE = 'production';
      const { IS_DEV } = await import('../environment');
      expect(IS_DEV).toBeFalsy();
    });
  });

  describe('getEnv', () => {
    it('returns value for key with VITE_ prefix', async () => {
      (import.meta.env as any).VITE_API_URL = 'https://api.example.com';
      const { getEnv } = await import('../environment');
      expect(getEnv('VITE_API_URL')).toBe('https://api.example.com');
    });

    it('auto-adds VITE_ prefix when missing', async () => {
      (import.meta.env as any).VITE_API_URL = 'https://api.example.com';
      const { getEnv } = await import('../environment');
      expect(getEnv('API_URL')).toBe('https://api.example.com');
    });

    it('returns fallback when key is missing', async () => {
      const { getEnv } = await import('../environment');
      expect(getEnv('NONEXISTENT', 'default_val')).toBe('default_val');
    });

    it('returns empty string as default fallback', async () => {
      const { getEnv } = await import('../environment');
      expect(getEnv('NONEXISTENT')).toBe('');
    });
  });
});
