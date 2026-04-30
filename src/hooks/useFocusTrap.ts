import { useEffect, useRef } from 'react';

/**
 * Focus trap + focus return hook for modal dialogs.
 *
 * R3 I-4: before this, MentorTablePage's three overlays had `role="dialog"`
 * and `aria-modal="true"` but no focus management. Tab walked straight out
 * of the dialog into the dimmed-but-tabbable background — a lie to
 * assistive tech. WCAG 2.1.2 ("No Keyboard Trap" inverse) + 2.4.3
 * ("Focus Order") fail.
 *
 * This hook implements the full contract:
 *   1. On open: save the currently-focused element ("return target"),
 *      then focus the first focusable element inside the dialog.
 *   2. While open: Tab at the last focusable wraps to the first,
 *      Shift+Tab at the first wraps to the last. Focus cannot escape.
 *   3. Escape invokes the caller's onClose.
 *   4. On close / unmount: restore focus to the return target.
 *
 * Attach the returned ref to the dialog element. Pass `active: false` when
 * the dialog is closed — the hook is a no-op in that state.
 *
 * No external dependency — pure Node/DOM + React refs.
 */

// Query that matches every interactive element we want inside the tab cycle.
// Matches the WAI-ARIA "tabbable" list used by libraries like tabbable.js.
const FOCUSABLE_SELECTOR = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
  'details > summary:first-of-type',
  'audio[controls]',
  'video[controls]',
  '[contenteditable]:not([contenteditable="false"])',
].join(',');

function getFocusable(root: HTMLElement): HTMLElement[] {
  const all = Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR));
  // Filter out explicitly-hidden / inert elements. We deliberately do NOT
  // probe offsetParent or getBoundingClientRect here: those are both stubbed
  // in jsdom (offsetParent always null, rects always 0) and would strip every
  // focusable in the test environment. The CSS selector above already
  // handles `disabled` on form controls via `:not([disabled])`, so we only
  // need to filter the two state signals that the selector doesn't cover.
  return all.filter((el) => {
    if (el.getAttribute('aria-hidden') === 'true') return false;
    if (el.hasAttribute('hidden')) return false;
    return true;
  });
}

export interface UseFocusTrapOptions {
  active: boolean;
  onClose?: () => void;
  /** If true, Escape key calls onClose. Default: true. */
  closeOnEscape?: boolean;
  /** If true, focus the first focusable on open. Default: true. */
  autoFocus?: boolean;
  /** If true, restore focus to the previously-focused element on close. Default: true. */
  restoreFocus?: boolean;
}

export function useFocusTrap<T extends HTMLElement = HTMLElement>(
  options: UseFocusTrapOptions
) {
  const {
    active,
    onClose,
    closeOnEscape = true,
    autoFocus = true,
    restoreFocus = true,
  } = options;
  const containerRef = useRef<T | null>(null);

  useEffect(() => {
    if (!active) return;
    const container = containerRef.current;
    if (!container) return;

    // 1. Remember where focus was BEFORE we trapped it, so we can restore.
    const returnTarget =
      (document.activeElement instanceof HTMLElement ? document.activeElement : null);

    // 2. Focus the first focusable element inside the dialog.
    if (autoFocus) {
      const focusables = getFocusable(container);
      const first = focusables[0];
      if (first) {
        first.focus();
      } else {
        // No focusables — focus the container itself so screen readers
        // land on the dialog rather than the background page.
        if (!container.hasAttribute('tabindex')) {
          container.setAttribute('tabindex', '-1');
        }
        container.focus();
      }
    }

    // 3. Trap Tab / Shift+Tab at the container boundary.
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && closeOnEscape && onClose) {
        event.stopPropagation();
        onClose();
        return;
      }
      if (event.key !== 'Tab') return;

      const focusables = getFocusable(container);
      if (focusables.length === 0) {
        // No tabbable — keep focus on the container.
        event.preventDefault();
        container.focus();
        return;
      }
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      const activeEl = document.activeElement as HTMLElement | null;

      if (event.shiftKey) {
        // Shift+Tab: if at first (or focus is outside the dialog), wrap to last.
        if (activeEl === first || !container.contains(activeEl)) {
          event.preventDefault();
          last.focus();
        }
      } else {
        // Tab: if at last (or focus is outside), wrap to first.
        if (activeEl === last || !container.contains(activeEl)) {
          event.preventDefault();
          first.focus();
        }
      }
    };

    container.addEventListener('keydown', handleKeyDown);

    // 4. Cleanup: remove listener, restore focus to the return target.
    return () => {
      container.removeEventListener('keydown', handleKeyDown);
      if (restoreFocus && returnTarget && document.contains(returnTarget)) {
        // Use requestAnimationFrame so the restore happens after React
        // has finished removing the dialog from the DOM.
        window.requestAnimationFrame(() => {
          if (returnTarget && document.contains(returnTarget)) {
            returnTarget.focus();
          }
        });
      }
    };
  }, [active, onClose, closeOnEscape, autoFocus, restoreFocus]);

  return containerRef;
}
