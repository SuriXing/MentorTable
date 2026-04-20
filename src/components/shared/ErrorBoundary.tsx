import React from 'react';
import i18n from '../../i18n';

interface Props {
  children: React.ReactNode;
  fallback?: React.ReactNode;
}

interface State {
  hasError: boolean;
  error: Error | null;
  copied: boolean;
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
  state: State = { hasError: false, error: null, copied: false };
  private copyResetTimer: ReturnType<typeof setTimeout> | null = null;

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error, copied: false };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo): void {
    // eslint-disable-next-line no-console
    console.error('[ErrorBoundary] captured render error:', error, info);
    // U8.1: report to Vercel Analytics as a custom event. Guarded so SSR /
    // tests without window.va are no-ops. We intentionally truncate
    // message and component stack — full stacks can leak file paths and
    // user-authored strings, and Vercel Analytics caps event payload size.
    if (typeof window !== 'undefined') {
      try {
        const w = window as unknown as {
          va?: { track?: (event: string, props: Record<string, unknown>) => void };
        };
        w.va?.track?.('client_error', {
          name: error?.name || 'Error',
          message_first_200_chars: (error?.message || '').slice(0, 200),
          component_stack_first_500: (info?.componentStack || '').slice(0, 500),
        });
      } catch {
        /* never let analytics reporting crash the boundary */
      }
    }
  }

  componentWillUnmount(): void {
    if (this.copyResetTimer) {
      clearTimeout(this.copyResetTimer);
      this.copyResetTimer = null;
    }
  }

  private handleReset = (): void => {
    // Full reload: resetting state alone re-renders the same broken
    // subtree and loops the boundary. Reload clears the crash cleanly.
    if (typeof window !== 'undefined') {
      window.location.reload();
    } else {
      this.setState({ hasError: false, error: null, copied: false });
    }
  };

  // R2/F35: copy diagnostics to clipboard instead of mailto:?subject= with
  // no recipient (was a fake feedback channel). KISS — no operational
  // dependency on a real inbox. Falls back to a hidden textarea + execCommand
  // for non-secure contexts where navigator.clipboard is undefined.
  // R3/F46: surface an inline "Copied ✓ / 已复制" success state so the copy
  // isn't silent. Auto-clears after ~2s.
  private flashCopied = (): void => {
    this.setState({ copied: true });
    if (this.copyResetTimer) clearTimeout(this.copyResetTimer);
    this.copyResetTimer = setTimeout(() => {
      this.setState({ copied: false });
      this.copyResetTimer = null;
    }, 2000);
  };

  private handleCopyDiagnostics = (): void => {
    const errMsg = this.state.error?.message || '';
    const stack = this.state.error?.stack || '';
    const ua = typeof navigator !== 'undefined' ? navigator.userAgent : 'n/a';
    const payload = `[名人桌 / Mentor Table] Crash report\nTime: ${new Date().toISOString()}\nUA: ${ua}\nError: ${errMsg}\nStack:\n${stack}`;
    const nav = typeof navigator !== 'undefined' ? navigator : undefined;
    if (nav?.clipboard?.writeText) {
      nav.clipboard.writeText(payload).then(
        () => this.flashCopied(),
        () => {
          this.fallbackCopy(payload);
          this.flashCopied();
        }
      );
      return;
    }
    this.fallbackCopy(payload);
    this.flashCopied();
  };

  private fallbackCopy(text: string): void {
    if (typeof document === 'undefined') return;
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    try {
      document.execCommand('copy');
    } catch {
      /* user can still see the textarea contents in DevTools */
    }
    document.body.removeChild(ta);
  }

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
      const errMsg = this.state.error?.message || '';
      // U7.1: positional ordering matters — ErrorBoundary.test.tsx clicks the
      // LAST button to assert handleReset fires. Keep "Try again" last.
      return (
        <div
          role="alert"
          style={{
            padding: '2rem',
            maxWidth: 560,
            margin: '4rem auto',
            fontFamily: 'system-ui, sans-serif',
            lineHeight: 1.5,
            color: 'var(--text-primary, #1f2937)',
            background: 'var(--bg-surface-solid, transparent)',
            borderRadius: 16,
            textAlign: 'center'
          }}
        >
          {/* Sad-face SVG illustration — inline, themable via currentColor */}
          <svg
            aria-hidden="true"
            width="96"
            height="96"
            viewBox="0 0 96 96"
            fill="none"
            style={{ margin: '0 auto 16px', display: 'block', color: 'var(--primary-color, #5B7BFA)' }}
          >
            <circle cx="48" cy="48" r="42" stroke="currentColor" strokeWidth="3" opacity="0.35" />
            <circle cx="34" cy="42" r="4" fill="currentColor" />
            <circle cx="62" cy="42" r="4" fill="currentColor" />
            <path d="M30 66 Q48 52 66 66" stroke="currentColor" strokeWidth="3" strokeLinecap="round" fill="none" />
          </svg>
          <h1 style={{ fontSize: '1.35rem', marginBottom: 12 }}>
            {this.tr('errorBoundary.title', 'Something went wrong / 出错了')}
          </h1>
          <p style={{ opacity: 0.8, marginBottom: 16 }}>
            {this.tr(
              'errorBoundary.message',
              'The page hit an unexpected error. Please reload; if it keeps happening, try disabling private browsing or clearing site data.'
            )}
          </p>
          {errMsg && (
            <pre
              style={{
                background: 'rgba(0,0,0,0.06)',
                padding: 12,
                borderRadius: 6,
                fontSize: '0.75rem',
                overflow: 'auto',
                textAlign: 'left'
              }}
            >
              {errMsg}
            </pre>
          )}
          <div style={{ display: 'flex', gap: 12, justifyContent: 'center', marginTop: 16, flexWrap: 'wrap' }}>
            <button
              type="button"
              onClick={this.handleCopyDiagnostics}
              aria-live="polite"
              style={{
                padding: '8px 14px',
                borderRadius: 6,
                border: '1px solid color-mix(in srgb, currentColor 30%, transparent)',
                background: this.state.copied ? 'color-mix(in srgb, currentColor 8%, transparent)' : 'transparent',
                color: 'inherit',
                cursor: 'pointer',
                fontSize: '0.9rem'
              }}
            >
              {this.state.copied
                ? this.tr('errorBoundary.copied', '已复制 / Copied ✓')
                : this.tr('errorBoundary.copyDiagnostics', 'Copy diagnostics / 复制错误信息')}
            </button>
            <button
              type="button"
              onClick={this.handleReset}
              style={{
                padding: '8px 14px',
                borderRadius: 6,
                border: '1px solid currentColor',
                background: 'var(--primary-color, #5B7BFA)',
                color: 'var(--text-on-primary, #fff)',
                cursor: 'pointer',
                fontWeight: 600
              }}
            >
              {this.tr('errorBoundary.tryAgain', 'Try again / 重试')}
            </button>
          </div>
          {/* R3/F46: tell users where to paste. Static bilingual hint —
              tech-debt placeholder until a real issue-tracker handle exists. */}
          <p style={{ opacity: 0.65, fontSize: '0.75rem', marginTop: 12 }}>
            {this.tr(
              'errorBoundary.pasteHint',
              '可粘贴到小红书反馈帖 / Paste into your issue report'
            )}
          </p>
        </div>
      );
    }
    return this.props.children;
  }
}
