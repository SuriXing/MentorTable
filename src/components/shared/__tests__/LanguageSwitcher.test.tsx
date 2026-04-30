import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import '@testing-library/jest-dom';

const changeLanguage = vi.fn().mockResolvedValue(undefined);
let mockLanguage = 'en';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    i18n: {
      get language() {
        return mockLanguage;
      },
      changeLanguage,
    },
    t: (key: string, opts?: { defaultValue?: string }) =>
      opts?.defaultValue ?? key,
  }),
}));

import LanguageSwitcher from '../LanguageSwitcher';

describe('LanguageSwitcher', () => {
  beforeEach(() => {
    changeLanguage.mockClear();
    mockLanguage = 'en';
    localStorage.clear();
  });

  afterEach(() => {
    cleanup();
  });

  it('renders the toggle button with aria-label and globe icon', () => {
    render(<LanguageSwitcher />);
    const btn = screen.getByRole('button', { name: 'Language' });
    expect(btn).toHaveAttribute('aria-haspopup', 'listbox');
    expect(btn).toHaveAttribute('aria-expanded', 'false');
    expect(btn).toHaveTextContent('🌐');
  });

  it('opens the listbox on click and lists all 5 languages', () => {
    render(<LanguageSwitcher />);
    fireEvent.click(screen.getByRole('button', { name: 'Language' }));
    const listbox = screen.getByRole('listbox', { name: 'Language' });
    expect(listbox).toBeInTheDocument();
    const opts = screen.getAllByRole('option');
    expect(opts).toHaveLength(5);
    // English is the active language → aria-selected=true on the en option
    const enOpt = opts.find((o) => o.textContent === 'en');
    expect(enOpt).toHaveAttribute('aria-selected', 'true');
  });

  it('clicking a language calls i18n.changeLanguage and persists to localStorage', () => {
    render(<LanguageSwitcher />);
    fireEvent.click(screen.getByRole('button', { name: 'Language' }));
    const ja = screen.getAllByRole('option').find((o) => o.textContent === 'ja');
    expect(ja).toBeTruthy();
    fireEvent.click(ja!);
    expect(changeLanguage).toHaveBeenCalledWith('ja');
    expect(localStorage.getItem('language')).toBe('ja');
    // Closes after selection
    expect(screen.queryByRole('listbox')).toBeNull();
  });

  it('closes the menu when clicking outside', () => {
    render(<LanguageSwitcher />);
    fireEvent.click(screen.getByRole('button', { name: 'Language' }));
    expect(screen.getByRole('listbox')).toBeInTheDocument();
    // mousedown outside the root closes
    fireEvent.mouseDown(document.body);
    expect(screen.queryByRole('listbox')).toBeNull();
  });

  it('does not close when clicking inside the root', () => {
    render(<LanguageSwitcher />);
    fireEvent.click(screen.getByRole('button', { name: 'Language' }));
    const listbox = screen.getByRole('listbox');
    fireEvent.mouseDown(listbox);
    expect(screen.getByRole('listbox')).toBeInTheDocument();
  });

  it('falls back to en when i18n.language is unrecognized', () => {
    mockLanguage = 'xx-YY';
    render(<LanguageSwitcher />);
    fireEvent.click(screen.getByRole('button', { name: 'Language' }));
    const enOpt = screen
      .getAllByRole('option')
      .find((o) => o.textContent === 'en');
    expect(enOpt).toHaveAttribute('aria-selected', 'true');
  });

  it('detects Chinese variant zh-cn (case-insensitive prefix match)', () => {
    mockLanguage = 'zh-cn';
    render(<LanguageSwitcher />);
    fireEvent.click(screen.getByRole('button', { name: 'Language' }));
    const zhOpt = screen
      .getAllByRole('option')
      .find((o) => o.textContent === 'zh-CN');
    expect(zhOpt).toHaveAttribute('aria-selected', 'true');
  });

  it('survives a localStorage write failure (Safari Private)', () => {
    const setSpy = vi
      .spyOn(Storage.prototype, 'setItem')
      .mockImplementation(() => {
        throw new Error('QuotaExceeded');
      });
    render(<LanguageSwitcher />);
    fireEvent.click(screen.getByRole('button', { name: 'Language' }));
    const ko = screen.getAllByRole('option').find((o) => o.textContent === 'ko');
    expect(() => fireEvent.click(ko!)).not.toThrow();
    expect(changeLanguage).toHaveBeenCalledWith('ko');
    setSpy.mockRestore();
  });

  it('handles missing i18n.language by treating it as en', () => {
    mockLanguage = '';
    render(<LanguageSwitcher />);
    fireEvent.click(screen.getByRole('button', { name: 'Language' }));
    const enOpt = screen
      .getAllByRole('option')
      .find((o) => o.textContent === 'en');
    expect(enOpt).toHaveAttribute('aria-selected', 'true');
  });

  it('toggles closed when the trigger button is clicked twice', () => {
    render(<LanguageSwitcher />);
    const btn = screen.getByRole('button', { name: 'Language' });
    fireEvent.click(btn);
    expect(screen.getByRole('listbox')).toBeInTheDocument();
    fireEvent.click(btn);
    expect(screen.queryByRole('listbox')).toBeNull();
  });
});
