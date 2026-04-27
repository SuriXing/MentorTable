import { useState } from 'react';

interface UseImageChainOptions {
  /** Full fallback ladder for a mentor avatar (page-owned composition). */
  buildChain: (name: string, imageUrl?: string, candidateImageUrls?: string[]) => string[];
  /** LEAK-4: unmount-safe timer scheduler (page-owned pendingTimers set). */
  scheduleTimeout: (fn: () => void, ms: number) => number;
  /** Key normalization shared with the page (e.g. normalizeNameKey). */
  normalizeKey: (name: string) => string;
}

/**
 * F162 (P13): avatar fallback-ladder progress extracted from
 * MentorTablePage — which ladder entry renders now (imageSrcFor) and how
 * errors advance the ladder (markImageBroken, with the wikimedia 429
 * single-retry delay).
 */
export function useImageChain({ buildChain, scheduleTimeout, normalizeKey }: UseImageChainOptions): {
  imageSrcFor: (name: string, imageUrl?: string, candidateImageUrls?: string[]) => string;
  markImageBroken: (name: string, imageUrl?: string, candidateImageUrls?: string[]) => void;
  clearImageProgressForKey: (key: string) => void;
} {
  const [imageAttemptByKey, setImageAttemptByKey] = useState<Record<string, number>>({});
  const [imageRetryByKey, setImageRetryByKey] = useState<Record<string, number>>({});

  const imageSrcFor = (name: string, imageUrl?: string, candidateImageUrls?: string[]) => {
    const key = normalizeKey(name);
    const chain = buildChain(name, imageUrl, candidateImageUrls);
    const idx = Math.min(imageAttemptByKey[key] || 0, chain.length - 1);
    const src = chain[idx];
    // Append cache-buster on retry so the browser re-fetches instead of reusing cached 429
    const retry = imageRetryByKey[key] || 0;
    if (retry > 0 && src && !src.startsWith('data:')) {
      return `${src}${src.includes('?') ? '&' : '?'}_r=${retry}`;
    }
    return src;
  };

  const markImageBroken = (name: string, imageUrl?: string, candidateImageUrls?: string[]) => {
    const key = normalizeKey(name);
    const chain = buildChain(name, imageUrl, candidateImageUrls);
    const currentAttempt = imageAttemptByKey[key] || 0;
    const currentSrc = chain[Math.min(currentAttempt, chain.length - 1)];
    const retries = imageRetryByKey[key] || 0;

    // Wikimedia returns 429 under concurrent load — retry once after a delay.
    // LEAK-4: scheduleTimeout is unmount-safe.
    const isWikimedia = currentSrc?.includes('wikimedia.org') || currentSrc?.includes('wikipedia.org');
    if (isWikimedia && retries < 1) {
      scheduleTimeout(() => {
        setImageRetryByKey((prev) => ({ ...prev, [key]: (prev[key] || 0) + 1 }));
      }, 600 + currentAttempt * 400);
      return;
    }

    // Advance to next URL in chain
    setImageRetryByKey((prev) => ({ ...prev, [key]: 0 }));
    setImageAttemptByKey((prev) => {
      const current = prev[key] || 0;
      if (current >= chain.length - 1) return prev;
      return { ...prev, [key]: current + 1 };
    });
  };

  // Bug #21: clear stale imageAttempt/imageRetry counters for one key so a
  // re-added person starts at chain index 0 again.
  const clearImageProgressForKey = (key: string) => {
    setImageAttemptByKey((prev) => {
      if (!(key in prev)) return prev;
      const next = { ...prev };
      delete next[key];
      return next;
    });
    setImageRetryByKey((prev) => {
      if (!(key in prev)) return prev;
      const next = { ...prev };
      delete next[key];
      return next;
    });
  };

  return { imageSrcFor, markImageBroken, clearImageProgressForKey };
}
