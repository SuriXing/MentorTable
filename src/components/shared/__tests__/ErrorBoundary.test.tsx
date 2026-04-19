import React from 'react';
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import '@testing-library/jest-dom';
import ErrorBoundary from '../ErrorBoundary';

// Throwing child for render-time crashes
const Boom: React.FC<{ msg?: string }> = ({ msg = 'kaboom' }) => {
  throw new Error(msg);
};

describe('ErrorBoundary', () => {
  let consoleError: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    cleanup();
    consoleError.mockRestore();
  });

  it('renders children when there is no error', () => {
    render(
      <ErrorBoundary>
        <div data-testid="ok">All good</div>
      </ErrorBoundary>
    );
    expect(screen.getByTestId('ok')).toHaveTextContent('All good');
  });

  it('catches render-time errors and shows the default fallback UI', () => {
    render(
      <ErrorBoundary>
        <Boom msg="render exploded" />
      </ErrorBoundary>
    );
    const alert = screen.getByRole('alert');
    expect(alert).toBeInTheDocument();
    // The error message is rendered in the <pre> regardless of locale
    expect(alert).toHaveTextContent(/render exploded/);
    // Try-again button is present (any locale)
    const buttons = screen.getAllByRole('button');
    expect(buttons.length).toBeGreaterThanOrEqual(1);
    // componentDidCatch logged
    expect(consoleError).toHaveBeenCalled();
  });

  it('renders the custom fallback prop when provided', () => {
    render(
      <ErrorBoundary fallback={<div data-testid="custom-fb">custom</div>}>
        <Boom />
      </ErrorBoundary>
    );
    expect(screen.getByTestId('custom-fb')).toBeInTheDocument();
    // Default alert should NOT render
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('reset button calls window.location.reload', () => {
    const reload = vi.fn();
    const orig = window.location;
    Object.defineProperty(window, 'location', {
      configurable: true,
      writable: true,
      value: { ...orig, reload },
    });
    try {
      render(
        <ErrorBoundary>
          <Boom />
        </ErrorBoundary>
      );
      // The button label is locale-dependent; there's only one button in the
      // fallback UI, so we grab it positionally.
      const btns = screen.getAllByRole('button');
      fireEvent.click(btns[btns.length - 1]);
      expect(reload).toHaveBeenCalledTimes(1);
    } finally {
      Object.defineProperty(window, 'location', {
        configurable: true,
        writable: true,
        value: orig,
      });
    }
  });

  it('does NOT catch errors thrown in event handlers (React limitation)', () => {
    const handler = vi.fn(() => {
      throw new Error('event-handler error');
    });
    const Click: React.FC = () => <button onClick={handler}>click me</button>;
    render(
      <ErrorBoundary>
        <Click />
      </ErrorBoundary>
    );
    // Suppress the jsdom unhandled error from React's invokeGuardedCallbackDev
    // re-dispatch — this is the documented React limitation we're proving.
    const onError = (e: ErrorEvent): void => {
      e.preventDefault();
    };
    window.addEventListener('error', onError);
    try {
      fireEvent.click(screen.getByRole('button', { name: /click me/i }));
    } finally {
      window.removeEventListener('error', onError);
    }
    expect(handler).toHaveBeenCalled();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('omits the <pre> when error has empty message', () => {
    const Empty: React.FC = () => {
      throw new Error('');
    };
    const { container } = render(
      <ErrorBoundary>
        <Empty />
      </ErrorBoundary>
    );
    expect(screen.getByRole('alert')).toBeInTheDocument();
    expect(container.querySelector('pre')).toBeNull();
  });
});
