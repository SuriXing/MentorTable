import React from 'react';
import i18n from '../../i18n';

interface Props {
  children: React.ReactNode;
  fallback?: React.ReactNode;
}

interface State {
  hasError: boolean;
  error: Error | null;
}

/**
 * Top-level error boundary for render-time crashes.
 *
 * R2-FIX: "Try again" previously just flipped `hasError` back to false,
 * which re-rendered the same broken tree and re-triggered the boundary
 * in an infinite loop. Now it forces a full page reload so the app
 * re-boots with fresh state.
 *
 * R2-FIX: fallback copy is localized via i18next with English
 * defaultValues. i18n may not be initialized at first render in the
 * worst case, but defaultValue guarantees sane English fallback.
 */
export default class ErrorBoundary extends React.Component<Props, State> {
  state: State = { hasError: false, error: null };

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo): void {
    // eslint-disable-next-line no-console
    console.error('[ErrorBoundary] captured render error:', error, info);
  }

  private handleReset = (): void => {
    // Full reload: resetting state alone re-renders the same broken
    // subtree and loops the boundary. Reload clears the crash cleanly.
    if (typeof window !== 'undefined') {
      window.location.reload();
    } else {
      this.setState({ hasError: false, error: null });
    }
  };

  private tr(key: string, fallback: string): string {
    try {
      return String(i18n.t(key, { defaultValue: fallback }));
    } catch {
      return fallback;
    }
  }

  render(): React.ReactNode {
    if (this.state.hasError) {
      if (this.props.fallback) return this.props.fallback;
      return (
        <div
          role="alert"
          style={{
            padding: '2rem',
            maxWidth: 560,
            margin: '4rem auto',
            fontFamily: 'system-ui, sans-serif',
            lineHeight: 1.5
          }}
        >
          <h1 style={{ fontSize: '1.25rem', marginBottom: 12 }}>
            {this.tr('errorBoundary.title', 'Something went wrong.')}
          </h1>
          <p style={{ opacity: 0.8, marginBottom: 16 }}>
            {this.tr(
              'errorBoundary.message',
              'The page hit an unexpected error. Please reload; if it keeps happening, try disabling private browsing or clearing site data.'
            )}
          </p>
          {this.state.error?.message && (
            <pre
              style={{
                background: 'rgba(0,0,0,0.06)',
                padding: 12,
                borderRadius: 6,
                fontSize: '0.75rem',
                overflow: 'auto'
              }}
            >
              {this.state.error.message}
            </pre>
          )}
          <button
            type="button"
            onClick={this.handleReset}
            style={{
              marginTop: 16,
              padding: '8px 14px',
              borderRadius: 6,
              border: '1px solid currentColor',
              background: 'transparent',
              cursor: 'pointer'
            }}
          >
            {this.tr('errorBoundary.tryAgain', 'Try again')}
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
