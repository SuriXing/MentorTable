import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import '@testing-library/jest-dom';

const setMode = vi.fn();
let mockMode: 'dark' | 'light' = 'dark';

vi.mock('../../../hooks/useTheme', () => ({
  useTheme: () => ({ mode: mockMode, setMode }),
}));

import ThemeModeToggle from '../ThemeModeToggle';

describe('ThemeModeToggle', () => {
  beforeEach(() => {
    setMode.mockClear();
    mockMode = 'dark';
  });
  afterEach(() => {
    cleanup();
  });

  it('renders sun icon and "Switch to light mode" label when mode is dark', () => {
    mockMode = 'dark';
    render(<ThemeModeToggle />);
    const btn = screen.getByRole('button', { name: 'Switch to light mode' });
    expect(btn).toHaveAttribute('title', 'Switch to light mode');
    expect(btn).toHaveTextContent('☀️');
  });

  it('renders moon icon and "Switch to dark mode" label when mode is light', () => {
    mockMode = 'light';
    render(<ThemeModeToggle />);
    const btn = screen.getByRole('button', { name: 'Switch to dark mode' });
    expect(btn).toHaveTextContent('🌙');
  });

  it('clicking calls setMode("light") when current mode is dark', () => {
    mockMode = 'dark';
    render(<ThemeModeToggle />);
    fireEvent.click(screen.getByRole('button', { name: 'Switch to light mode' }));
    expect(setMode).toHaveBeenCalledWith('light');
  });

  it('clicking calls setMode("dark") when current mode is light', () => {
    mockMode = 'light';
    render(<ThemeModeToggle />);
    fireEvent.click(screen.getByRole('button', { name: 'Switch to dark mode' }));
    expect(setMode).toHaveBeenCalledWith('dark');
  });

  it('hover handlers scale and reset the button', () => {
    mockMode = 'dark';
    render(<ThemeModeToggle />);
    const btn = screen.getByRole('button') as HTMLButtonElement;
    fireEvent.mouseEnter(btn);
    expect(btn.style.transform).toBe('scale(1.08)');
    fireEvent.mouseLeave(btn);
    expect(btn.style.transform).toBe('scale(1)');
  });

  it('uses light-mode background colors when mode is light', () => {
    mockMode = 'light';
    render(<ThemeModeToggle />);
    const btn = screen.getByRole('button') as HTMLButtonElement;
    // Light mode → white-ish background
    expect(btn.style.background).toContain('255, 255, 255');
  });

  it('uses dark-mode background colors when mode is dark', () => {
    mockMode = 'dark';
    render(<ThemeModeToggle />);
    const btn = screen.getByRole('button') as HTMLButtonElement;
    expect(btn.style.background).toContain('18, 20, 34');
  });
});
