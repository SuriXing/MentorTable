import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useTheme, THEMES } from '../useTheme';

const STORAGE_KEY = 'anoncafe_theme';
const MODE_KEY = 'anoncafe_theme_mode';

describe('useTheme', () => {
  beforeEach(() => {
    localStorage.clear();
    // Clear data attribute between tests
    delete document.documentElement.dataset.themeMode;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('defaults to blue/dark when no stored values', () => {
    const { result } = renderHook(() => useTheme());
    expect(result.current.themeId).toBe('blue');
    expect(result.current.mode).toBe('dark');
    expect(result.current.theme).toEqual(THEMES.blue);
  });

  it('reads stored theme id from localStorage', () => {
    localStorage.setItem(STORAGE_KEY, 'purple');
    const { result } = renderHook(() => useTheme());
    expect(result.current.themeId).toBe('purple');
  });

  it('reads stored mode from localStorage', () => {
    localStorage.setItem(MODE_KEY, 'light');
    const { result } = renderHook(() => useTheme());
    expect(result.current.mode).toBe('light');
  });

  it('ignores unknown stored theme id', () => {
    localStorage.setItem(STORAGE_KEY, 'not-a-theme');
    const { result } = renderHook(() => useTheme());
    expect(result.current.themeId).toBe('blue');
  });

  it('ignores unknown stored mode', () => {
    localStorage.setItem(MODE_KEY, 'neon');
    const { result } = renderHook(() => useTheme());
    expect(result.current.mode).toBe('dark');
  });

  it('falls back to default when localStorage.getItem throws on theme', () => {
    const origGet = Storage.prototype.getItem;
    Storage.prototype.getItem = vi.fn((key: string) => {
      if (key === STORAGE_KEY) throw new Error('blocked');
      return null;
    });
    try {
      const { result } = renderHook(() => useTheme());
      expect(result.current.themeId).toBe('blue');
    } finally {
      Storage.prototype.getItem = origGet;
    }
  });

  it('falls back to default when localStorage.getItem throws on mode', () => {
    const origGet = Storage.prototype.getItem;
    Storage.prototype.getItem = vi.fn((key: string) => {
      if (key === MODE_KEY) throw new Error('blocked');
      return null;
    });
    try {
      const { result } = renderHook(() => useTheme());
      expect(result.current.mode).toBe('dark');
    } finally {
      Storage.prototype.getItem = origGet;
    }
  });

  it('setTheme updates theme and persists to localStorage', () => {
    const { result } = renderHook(() => useTheme());
    act(() => {
      result.current.setTheme('teal');
    });
    expect(result.current.themeId).toBe('teal');
    expect(result.current.theme).toEqual(THEMES.teal);
    expect(localStorage.getItem(STORAGE_KEY)).toBe('teal');
  });

  it('setMode updates mode and persists to localStorage', () => {
    const { result } = renderHook(() => useTheme());
    act(() => {
      result.current.setMode('light');
    });
    expect(result.current.mode).toBe('light');
    expect(localStorage.getItem(MODE_KEY)).toBe('light');
    expect(document.documentElement.dataset.themeMode).toBe('light');
  });

  it('applies CSS variables to document root on mount', () => {
    renderHook(() => useTheme());
    const root = document.documentElement;
    expect(root.style.getPropertyValue('--primary')).toBe(THEMES.blue.primary);
    expect(root.style.getPropertyValue('--primary-color')).toBe(THEMES.blue.primary);
    expect(root.dataset.themeMode).toBe('dark');
  });

  it('dispatches themeChange CustomEvent on change', () => {
    const listener = vi.fn();
    window.addEventListener('themeChange', listener as EventListener);
    const { result } = renderHook(() => useTheme());
    act(() => {
      result.current.setTheme('sunset');
    });
    expect(listener).toHaveBeenCalled();
    // The last call should carry sunset in the detail.
    const lastCallEvent = (listener.mock.calls.at(-1)?.[0]) as CustomEvent;
    expect(lastCallEvent.detail).toEqual({ themeId: 'sunset', mode: 'dark' });
    window.removeEventListener('themeChange', listener as EventListener);
  });

  it('swallows errors from localStorage.setItem', () => {
    const origSet = Storage.prototype.setItem;
    Storage.prototype.setItem = vi.fn(() => {
      throw new Error('quota');
    });
    try {
      // Should not throw
      expect(() => renderHook(() => useTheme())).not.toThrow();
    } finally {
      Storage.prototype.setItem = origSet;
    }
  });

  it('listens for external themeChange events and updates state', () => {
    const { result } = renderHook(() => useTheme());
    act(() => {
      window.dispatchEvent(
        new CustomEvent('themeChange', { detail: { themeId: 'forest', mode: 'light' } })
      );
    });
    expect(result.current.themeId).toBe('forest');
    expect(result.current.mode).toBe('light');
  });

  it('ignores external themeChange events with same themeId (no state thrash)', () => {
    const { result } = renderHook(() => useTheme());
    const originalThemeId = result.current.themeId;
    act(() => {
      window.dispatchEvent(
        new CustomEvent('themeChange', { detail: { themeId: originalThemeId } })
      );
    });
    expect(result.current.themeId).toBe(originalThemeId);
  });

  it('ignores external themeChange events with invalid themeId', () => {
    const { result } = renderHook(() => useTheme());
    act(() => {
      window.dispatchEvent(
        new CustomEvent('themeChange', { detail: { themeId: 'bogus' as any } })
      );
    });
    expect(result.current.themeId).toBe('blue');
  });

  it('ignores external themeChange events with invalid mode', () => {
    const { result } = renderHook(() => useTheme());
    act(() => {
      window.dispatchEvent(
        new CustomEvent('themeChange', { detail: { mode: 'sepia' as any } })
      );
    });
    expect(result.current.mode).toBe('dark');
  });

  it('handles themeChange event with no detail gracefully', () => {
    const { result } = renderHook(() => useTheme());
    act(() => {
      // Use a plain Event (no detail), exercising the `custom.detail || {}` branch
      window.dispatchEvent(new Event('themeChange'));
    });
    expect(result.current.themeId).toBe('blue');
    expect(result.current.mode).toBe('dark');
  });

  it('cleans up themeChange listener on unmount', () => {
    const removeSpy = vi.spyOn(window, 'removeEventListener');
    const { unmount } = renderHook(() => useTheme());
    unmount();
    expect(removeSpy).toHaveBeenCalledWith('themeChange', expect.any(Function));
  });
});
