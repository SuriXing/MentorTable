import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import '@testing-library/jest-dom';

// Mock react-i18next to avoid Provider requirement
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
    i18n: { language: 'en' },
  }),
}));

// Mock Aurora (uses WebGL / ogl) and ThemePicker to isolate Layout
vi.mock('../../shared/Aurora', () => ({
  default: (props: any) => (
    <div data-testid="aurora" data-aurora={JSON.stringify(props.colorStops)} />
  ),
}));

vi.mock('../../shared/ThemePicker', () => ({
  default: () => <div data-testid="theme-picker" />,
}));

// Mock useTheme to return a predictable theme object
vi.mock('../../../hooks/useTheme', () => ({
  useTheme: () => ({
    theme: {
      id: 'blue',
      name: 'Blue',
      swatch: '#5B7BFA',
      aurora: ['#1a2a6c', '#5B7BFA', '#4A90FA'],
      primary: '#5B7BFA',
      primaryDark: '#4360D3',
      primaryLight: '#8A9FFC',
    },
    themeId: 'blue',
    setTheme: vi.fn(),
    mode: 'dark',
    setMode: vi.fn(),
  }),
}));

// Stub the CSS import
vi.mock('../../../styles/Layout.css', () => ({}));

import Layout from '../Layout';

describe('Layout', () => {
  it('renders children inside the main content', () => {
    render(
      <Layout>
        <span data-testid="child">hello child</span>
      </Layout>
    );
    expect(screen.getByTestId('child')).toBeInTheDocument();
    expect(screen.getByTestId('child')).toHaveTextContent('hello child');
  });

  it('renders Aurora background with theme color stops', () => {
    render(
      <Layout>
        <div />
      </Layout>
    );
    const aurora = screen.getByTestId('aurora');
    expect(aurora).toBeInTheDocument();
    expect(aurora.getAttribute('data-aurora')).toBe(
      JSON.stringify(['#1a2a6c', '#5B7BFA', '#4A90FA'])
    );
  });

  it('renders the ThemePicker', () => {
    render(
      <Layout>
        <div />
      </Layout>
    );
    expect(screen.getByTestId('theme-picker')).toBeInTheDocument();
  });

  it('wraps content in a layout container with class "layout"', () => {
    const { container } = render(
      <Layout>
        <div />
      </Layout>
    );
    const rootDiv = container.querySelector('.layout');
    expect(rootDiv).not.toBeNull();
    // main-content should be nested within
    const main = rootDiv!.querySelector('main.main-content');
    expect(main).not.toBeNull();
  });

  it('renders multiple children', () => {
    render(
      <Layout>
        <div data-testid="a">A</div>
        <div data-testid="b">B</div>
      </Layout>
    );
    expect(screen.getByTestId('a')).toBeInTheDocument();
    expect(screen.getByTestId('b')).toBeInTheDocument();
  });
});
