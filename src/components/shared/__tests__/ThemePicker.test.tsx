import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import '@testing-library/jest-dom';

// --- Mock useTheme -------------------------------------------------------
const setTheme = vi.fn();
const setMode = vi.fn();

let mockThemeId: string = 'blue';
let mockMode: string = 'dark';

vi.mock('../../../hooks/useTheme', async () => {
  // Provide real THEMES so the component can iterate them, but mock the hook.
  const THEMES = {
    blue: {
      id: 'blue',
      name: 'Blue',
      swatch: '#5B7BFA',
      primary: '#5B7BFA',
      primaryDark: '#4360D3',
      primaryLight: '#8A9FFC',
    },
    purple: {
      id: 'purple',
      name: 'Purple',
      swatch: '#9F6BFF',
      primary: '#9F6BFF',
      primaryDark: '#7C3AED',
      primaryLight: '#C4A6FF',
    },
    teal: {
      id: 'teal',
      name: 'Teal',
      swatch: '#2DD4BF',
      primary: '#2DD4BF',
      primaryDark: '#0D9488',
      primaryLight: '#5EEAD4',
    },
  };
  return {
    THEMES,
    useTheme: () => ({
      themeId: mockThemeId,
      setTheme,
      mode: mockMode,
      setMode,
      theme: (THEMES as any)[mockThemeId],
    }),
  };
});

const labels = vi.hoisted(() => ({
  'theme.light': 'Light',
  'theme.dark': 'Dark',
  'theme.themeColor': 'Theme color',
  'theme.changeTheme': 'Change theme',
  'theme.blue': 'Blue',
  'theme.purple': 'Purple',
  'theme.teal': 'Teal',
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: { defaultValue?: string }) =>
      (labels as Record<string, string>)[key] ?? options?.defaultValue ?? key,
    i18n: { language: 'en' },
  }),
}));

import ThemePicker from '../ThemePicker';

describe('ThemePicker', () => {
  beforeEach(() => {
    setTheme.mockReset();
    setMode.mockReset();
    mockThemeId = 'blue';
    mockMode = 'dark';
  });

  it('renders the toggle button initially and the panel is hidden', () => {
    render(<ThemePicker />);
    expect(screen.getByLabelText('Change theme')).toBeInTheDocument();
    // Panel content is not in the document when closed
    expect(screen.queryByText('Blue')).not.toBeInTheDocument();
    cleanup();
  });

  it('opens the panel when the toggle button is clicked', () => {
    render(<ThemePicker />);
    fireEvent.click(screen.getByLabelText('Change theme'));
    expect(screen.getByText('Blue')).toBeInTheDocument();
    expect(screen.getByText('Purple')).toBeInTheDocument();
    expect(screen.getByText('Teal')).toBeInTheDocument();
    cleanup();
  });

  it('renders light and dark mode buttons when panel is open', () => {
    render(<ThemePicker />);
    fireEvent.click(screen.getByLabelText('Change theme'));
    expect(screen.getByText(/Light/)).toBeInTheDocument();
    expect(screen.getByText(/Dark/)).toBeInTheDocument();
    cleanup();
  });

  it('calls setMode when light/dark buttons are clicked', () => {
    render(<ThemePicker />);
    fireEvent.click(screen.getByLabelText('Change theme'));
    fireEvent.click(screen.getByText(/Light/));
    expect(setMode).toHaveBeenCalledWith('light');
    fireEvent.click(screen.getByText(/Dark/));
    expect(setMode).toHaveBeenCalledWith('dark');
    cleanup();
  });

  it('calls setTheme and closes panel when a theme is selected', () => {
    render(<ThemePicker />);
    fireEvent.click(screen.getByLabelText('Change theme'));
    fireEvent.click(screen.getByText('Purple'));
    expect(setTheme).toHaveBeenCalledWith('purple');
    // After click, panel closes: the theme name is gone from DOM
    expect(screen.queryByText('Purple')).not.toBeInTheDocument();
    cleanup();
  });

  it('closes the panel on outside click', () => {
    render(<ThemePicker />);
    fireEvent.click(screen.getByLabelText('Change theme'));
    expect(screen.getByText('Blue')).toBeInTheDocument();

    // Simulate an outside mousedown on document.body
    fireEvent.mouseDown(document.body);

    expect(screen.queryByText('Blue')).not.toBeInTheDocument();
    cleanup();
  });

  it('does NOT close the panel on inside click (mousedown on a button)', () => {
    render(<ThemePicker />);
    fireEvent.click(screen.getByLabelText('Change theme'));
    // mousedown on a theme button – inside container
    fireEvent.mouseDown(screen.getByText('Blue'));
    // Panel still visible
    expect(screen.getByText('Blue')).toBeInTheDocument();
    cleanup();
  });

  it('highlights the current theme when open vs non-active themes', () => {
    mockThemeId = 'purple';
    render(<ThemePicker />);
    fireEvent.click(screen.getByLabelText('Change theme'));
    const purpleButton = screen.getByText('Purple').closest('button')!;
    const blueButton = screen.getByText('Blue').closest('button')!;

    // The active button and non-active buttons should have different
    // inline style strings (background + border branch differ).
    expect(purpleButton.getAttribute('style')).not.toEqual(
      blueButton.getAttribute('style')
    );
    // Non-active background is transparent
    expect(blueButton.style.background).toBe('transparent');
    cleanup();
  });

  it('applies hover background on non-active theme buttons and resets on mouse leave', () => {
    render(<ThemePicker />);
    fireEvent.click(screen.getByLabelText('Change theme'));
    const purpleButton = screen.getByText('Purple').closest('button')!;
    fireEvent.mouseEnter(purpleButton);
    expect(purpleButton.style.background).not.toBe('transparent');
    fireEvent.mouseLeave(purpleButton);
    expect(purpleButton.style.background).toBe('transparent');
    cleanup();
  });

  it('does not change background on mouse enter/leave for the active theme', () => {
    mockThemeId = 'blue';
    render(<ThemePicker />);
    fireEvent.click(screen.getByLabelText('Change theme'));
    const blueButton = screen.getByText('Blue').closest('button')!;
    const before = blueButton.style.background;
    fireEvent.mouseEnter(blueButton);
    // Handler early-returns for active button
    expect(blueButton.style.background).toBe(before);
    fireEvent.mouseLeave(blueButton);
    expect(blueButton.style.background).toBe(before);
    cleanup();
  });

  it('scales the toggle button on hover and resets on mouse leave', () => {
    render(<ThemePicker />);
    const toggle = screen.getByLabelText('Change theme') as HTMLButtonElement;
    fireEvent.mouseEnter(toggle);
    expect(toggle.style.transform).toBe('scale(1.08)');
    fireEvent.mouseLeave(toggle);
    expect(toggle.style.transform).toBe('scale(1)');
    cleanup();
  });

  it('renders localized theme names from the translation bundle', () => {
    labels['theme.blue'] = '深蓝';
    try {
      render(<ThemePicker />);
      fireEvent.click(screen.getByLabelText('Change theme'));
      expect(screen.getByText('深蓝')).toBeInTheDocument();
    } finally {
      labels['theme.blue'] = 'Blue';
    }
    cleanup();
  });

  it('toggles panel closed when clicking the toggle button twice', () => {
    render(<ThemePicker />);
    const toggle = screen.getByLabelText('Change theme');
    fireEvent.click(toggle);
    expect(screen.getByText('Blue')).toBeInTheDocument();
    fireEvent.click(toggle);
    expect(screen.queryByText('Blue')).not.toBeInTheDocument();
    cleanup();
  });

  it('renders in light mode variant when mode is light', () => {
    mockMode = 'light';
    render(<ThemePicker />);
    fireEvent.click(screen.getByLabelText('Change theme'));
    // Light mode branch was exercised; the theme label text remains visible
    expect(screen.getByText(/Theme color/)).toBeInTheDocument();
    cleanup();
  });

  it('applies light-mode hover background on non-active theme buttons (line 125 branch)', () => {
    mockMode = 'light';
    render(<ThemePicker />);
    fireEvent.click(screen.getByLabelText('Change theme'));
    // In light mode, current theme is blue (active) — purple is non-active.
    // Mouse-enter should set background to the LIGHT-mode rgba value.
    const purpleButton = screen.getByText('Purple').closest('button')!;
    fireEvent.mouseEnter(purpleButton);
    // Light mode uses rgba(0, 0, 0, 0.04), dark mode would use rgba(255, 255, 255, 0.05)
    expect(purpleButton.style.background).toContain('rgba(0, 0, 0');
    cleanup();
  });

  it('active mode button differs from inactive mode button style', () => {
    mockMode = 'dark';
    render(<ThemePicker />);
    fireEvent.click(screen.getByLabelText('Change theme'));
    const darkButton = screen.getByText(/Dark/).closest('button')!;
    const lightButton = screen.getByText(/Light/).closest('button')!;
    // Active (dark) vs inactive (light) should render different styles
    expect(darkButton.getAttribute('style')).not.toEqual(
      lightButton.getAttribute('style')
    );
    // Inactive button has transparent background
    expect(lightButton.style.background).toBe('transparent');
    cleanup();
  });
});
