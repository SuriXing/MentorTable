import React from 'react';
import { useTheme } from '../../hooks/useTheme';

/**
 * Standalone sun/moon toggle that lives NEXT TO the ThemePicker 🎨 button.
 * The in-popover Light/Dark switch is kept for redundancy; this surfaces
 * the most common action (flipping mode) as a one-tap target so users
 * don't have to discover it inside the theme popover.
 */
const ThemeModeToggle: React.FC = () => {
  const { mode, setMode } = useTheme();
  const nextMode = mode === 'dark' ? 'light' : 'dark';
  const icon = mode === 'dark' ? '☀️' : '🌙';
  const label =
    mode === 'dark' ? 'Switch to light mode' : 'Switch to dark mode';

  return (
    <button
      onClick={() => setMode(nextMode)}
      style={{
        position: 'fixed',
        right: 80,
        bottom: 20,
        width: 44,
        height: 44,
        borderRadius: '50%',
        background:
          mode === 'light'
            ? 'rgba(255, 255, 255, 0.96)'
            : 'rgba(18, 20, 34, 0.92)',
        backdropFilter: 'blur(16px)',
        WebkitBackdropFilter: 'blur(16px)',
        border: `1px solid ${
          mode === 'light'
            ? 'rgba(0, 0, 0, 0.08)'
            : 'rgba(91, 123, 250, 0.4)'
        }`,
        cursor: 'pointer',
        boxShadow: '0 4px 20px rgba(0, 0, 0, 0.25), 0 2px 8px rgba(0, 0, 0, 0.2)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        fontSize: 20,
        transition: 'transform 0.2s ease',
        zIndex: 9999,
      }}
      onMouseEnter={(e) => {
        e.currentTarget.style.transform = 'scale(1.08)';
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.transform = 'scale(1)';
      }}
      title={label}
      aria-label={label}
    >
      <span role="img" aria-hidden>
        {icon}
      </span>
    </button>
  );
};

export default ThemeModeToggle;
