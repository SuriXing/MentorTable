import React from 'react';

interface Props {
  children: React.ReactNode;
  fallback?: React.ReactNode;
}

interface State {
  hasError: boolean;
  error: Error | null;
}

/**
 * Bug-bash round 1: top-level error boundary so that render-time crashes
 * (e.g. Safari Private Browsing `SecurityError` on `localStorage.getItem`,
 * or any unexpected throw in the monster MentorTablePage render tree) do
 * not produce a silent white screen.
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
    this.setState({ hasError: false, error: null });
  };

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
          <h1 style={{ fontSize: '1.25rem', marginBottom: 12 }}>Something went wrong.</h1>
          <p style={{ opacity: 0.8, marginBottom: 16 }}>
            The page hit an unexpected error. Please reload; if it keeps happening, try disabling
            private browsing or clearing site data.
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
            Try again
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
