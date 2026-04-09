/**
 * Browser Detection Utility
 * This utility provides functions to detect browser types and initialize
 * browser-specific compatibility features.
 */

export interface BrowserInfo {
  browserName: string;
  browserVersion: string;
  isMobile: boolean;
  isIOS: boolean;
  isSafari: boolean;
  isFirefox: boolean;
  isIE: boolean;
  isEdge: boolean;
  isChrome: boolean;
  os: string;
}

/**
 * Detects the current browser
 */
export function detectBrowser(): BrowserInfo {
  const info: BrowserInfo = {
    browserName: 'Unknown',
    browserVersion: 'Unknown',
    isMobile: false,
    isIOS: false,
    isSafari: false,
    isFirefox: false,
    isIE: false,
    isEdge: false,
    isChrome: false,
    os: 'Unknown',
  };

  if (typeof window === 'undefined') return info;
  
  const ua = window.navigator.userAgent;
  
  // Detect mobile and OS
  info.isMobile = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(ua);
  info.isIOS = /iPad|iPhone|iPod/.test(ua) && !(window as any).MSStream;
  
  // Bug #17: Android UA contains "Linux; Android 13..." so the Android check
  // must run BEFORE the Linux check — otherwise Android devices are mis-tagged
  // as Linux. Order: iOS → Android → Windows → Mac → Linux.
  if (info.isIOS) info.os = 'iOS';
  else if (/Android/.test(ua)) info.os = 'Android';
  else if (/Windows/.test(ua)) info.os = 'Windows';
  else if (/Macintosh|MacIntel/.test(ua)) info.os = 'Mac';
  else if (/Linux/.test(ua)) info.os = 'Linux';

  // Browser detection
  if (/Safari/.test(ua) && !/Chrome/.test(ua)) {
    info.isSafari = true;
    info.browserName = 'Safari';
    const match = ua.match(/Version\/(\d+(\.\d+)?)/);
    info.browserVersion = match ? match[1] : 'Unknown';
  } else if (/Chrome/.test(ua) && !/Edg/.test(ua)) {
    info.isChrome = true;
    info.browserName = 'Chrome';
    const match = ua.match(/Chrome\/(\d+(\.\d+)?)/);
    info.browserVersion = match ? match[1] : 'Unknown';
  } else if (/Edg/.test(ua)) {
    info.isEdge = true;
    info.browserName = 'Edge';
    const match = ua.match(/Edg\/(\d+(\.\d+)?)/);
    info.browserVersion = match ? match[1] : 'Unknown';
  } else if (/Firefox/.test(ua)) {
    info.isFirefox = true;
    info.browserName = 'Firefox';
    const match = ua.match(/Firefox\/(\d+(\.\d+)?)/);
    info.browserVersion = match ? match[1] : 'Unknown';
  } else if (/Trident|MSIE/.test(ua)) {
    info.isIE = true;
    info.browserName = 'Internet Explorer';
    const match = ua.match(/(MSIE |rv:)(\d+(\.\d+)?)/);
    info.browserVersion = match ? match[2] : 'Unknown';
  }

  return info;
}

/**
 * Initializes browser compatibility fixes
 */
export function initBrowserCompatibility(): void {
  if (typeof document === 'undefined') return;

  const info = detectBrowser();
  const html = document.documentElement;
  
  // Add browser classes for CSS targeting
  if (info.isSafari) html.classList.add('is-safari');
  if (info.isFirefox) html.classList.add('is-firefox');
  if (info.isIE) html.classList.add('is-ie');
  if (info.isEdge) html.classList.add('is-edge');
  if (info.isChrome) html.classList.add('is-chrome');
  if (info.isMobile) html.classList.add('is-mobile');
  if (info.isIOS) html.classList.add('is-ios');

  // Fix for iOS 100vh issue.
  // Bug #19: a resize listener is added but was never removed. If
  // initBrowserCompatibility is called more than once (HMR, tests, SPA
  // route transitions), listeners accumulate. We guard against double-add
  // by stashing the handler on a module-level flag-like property.
  if (info.isIOS) {
    const globalWin = window as unknown as { __mtVhHandler__?: () => void };
    if (globalWin.__mtVhHandler__) {
      window.removeEventListener('resize', globalWin.__mtVhHandler__);
    }
    const setVhVariable = () => {
      document.documentElement.style.setProperty('--vh', `${window.innerHeight * 0.01}px`);
    };
    setVhVariable();
    window.addEventListener('resize', setVhVariable);
    globalWin.__mtVhHandler__ = setVhVariable;
  }
}

export default {
  detectBrowser,
  initBrowserCompatibility
}; 