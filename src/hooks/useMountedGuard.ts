import { useEffect, useRef } from 'react';

/**
 * Mount guard for post-await state writes (LEAK-1). The lifecycle writes
 * used to live inside the page's timer-sweep cleanup effect, split across
 * files by comments; they belong to the guard itself. Read
 * `isMountedRef.current` after any await that must not touch dead state —
 * if it reads false, the component unmounted mid-flight.
 */
export function useMountedGuard() {
  const isMountedRef = useRef(true);

  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  return isMountedRef;
}
