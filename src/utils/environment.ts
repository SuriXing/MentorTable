/**
 * Centralized environment variable access for Vite
 */

const env = import.meta.env;

// Environment information
export const NODE_ENV = env.MODE || 'development';
export const IS_PROD = env.PROD || NODE_ENV === 'production';
export const IS_DEV = env.DEV || NODE_ENV === 'development';

// Function to safely access any env variable with fallback
export function getEnv(key: string, fallback: string = ''): string {
  const fullKey = key.startsWith('VITE_') ? key : `VITE_${key}`;
  return env[fullKey] || fallback;
}
