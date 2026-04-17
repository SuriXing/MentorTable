import React from 'react';
import { useTranslation } from 'react-i18next';
import Aurora from '../shared/Aurora';
import ThemePicker from '../shared/ThemePicker';
import ThemeModeToggle from '../shared/ThemeModeToggle';
import { useTheme } from '../../hooks/useTheme';
import '../../styles/Layout.css';

interface LayoutProps {
  children: React.ReactNode;
}

const Layout: React.FC<LayoutProps> = ({ children }) => {
  const { t } = useTranslation();
  const { theme, mode } = useTheme();
  // Aurora palette + intensity must track theme mode — otherwise light mode is
  // architecturally fake (CSS tokens flip but WebGL scene stays dark).
  const auroraStops = mode === 'light' ? theme.auroraLight : theme.aurora;
  const auroraAmplitude = mode === 'light' ? 0.6 : 1.0;

  return (
    <div className="layout">
      <Aurora colorStops={auroraStops} amplitude={auroraAmplitude} blend={0.5} />
      <main className="main-content">
        {children}
      </main>
      <ThemeModeToggle />
      <ThemePicker />
    </div>
  );
};

export default Layout;
