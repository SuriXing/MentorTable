/**
 * R3 I-4: unit tests for useFocusTrap.
 *
 * Covers:
 *   - no-op when active=false (no focus stolen, no listener)
 *   - auto-focus first focusable on open
 *   - Tab at last focusable wraps to first
 *   - Shift+Tab at first focusable wraps to last
 *   - Escape calls onClose
 *   - focus restored to return target on unmount
 *   - autoFocus / restoreFocus / closeOnEscape opt-outs
 *   - empty-dialog fallback: focus container itself
 */
import React, { useRef } from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, act, cleanup } from '@testing-library/react';
import { useFocusTrap } from '../useFocusTrap';

function Dialog({
  active,
  onClose,
  autoFocus,
  restoreFocus,
  closeOnEscape,
  empty,
}: {
  active: boolean;
  onClose?: () => void;
  autoFocus?: boolean;
  restoreFocus?: boolean;
  closeOnEscape?: boolean;
  empty?: boolean;
}) {
  const ref = useFocusTrap<HTMLDivElement>({
    active,
    onClose,
    autoFocus,
    restoreFocus,
    closeOnEscape,
  });
  if (!active) return null;
  return (
    <div ref={ref} role="dialog" aria-modal="true" data-testid="dialog">
      {!empty && (
        <>
          <button data-testid="first">First</button>
          <button data-testid="middle">Middle</button>
          <button data-testid="last">Last</button>
        </>
      )}
    </div>
  );
}

function Harness({
  open,
  onClose,
  autoFocus,
  restoreFocus,
  closeOnEscape,
  empty,
}: {
  open: boolean;
  onClose?: () => void;
  autoFocus?: boolean;
  restoreFocus?: boolean;
  closeOnEscape?: boolean;
  empty?: boolean;
}) {
  const openBtnRef = useRef<HTMLButtonElement>(null);
  return (
    <div>
      <button ref={openBtnRef} data-testid="opener">Open</button>
      <Dialog
        active={open}
        onClose={onClose}
        autoFocus={autoFocus}
        restoreFocus={restoreFocus}
        closeOnEscape={closeOnEscape}
        empty={empty}
      />
    </div>
  );
}

function dispatchKey(target: Element, key: string, opts: { shiftKey?: boolean } = {}) {
  target.dispatchEvent(
    new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...opts })
  );
}

describe('useFocusTrap', () => {
  beforeEach(() => {
    cleanup();
    document.body.innerHTML = '';
  });

  it('is a no-op when active=false', () => {
    const onClose = vi.fn();
    const before = document.createElement('button');
    before.textContent = 'before';
    document.body.appendChild(before);
    before.focus();
    expect(document.activeElement).toBe(before);

    render(<Harness open={false} onClose={onClose} />);
    // Focus should not have been moved.
    expect(document.activeElement).toBe(before);
    // Dialog not rendered.
    expect(document.querySelector('[data-testid="dialog"]')).toBeNull();
  });

  it('auto-focuses the first focusable on open', () => {
    const { getByTestId } = render(<Harness open={true} />);
    expect(document.activeElement).toBe(getByTestId('first'));
  });

  it('wraps Tab from last focusable back to first', () => {
    const { getByTestId } = render(<Harness open={true} />);
    const last = getByTestId('last');
    last.focus();
    expect(document.activeElement).toBe(last);
    dispatchKey(last, 'Tab');
    expect(document.activeElement).toBe(getByTestId('first'));
  });

  it('wraps Shift+Tab from first focusable back to last', () => {
    const { getByTestId } = render(<Harness open={true} />);
    const first = getByTestId('first');
    first.focus();
    dispatchKey(first, 'Tab', { shiftKey: true });
    expect(document.activeElement).toBe(getByTestId('last'));
  });

  it('Tab on a middle element does NOT wrap', () => {
    const { getByTestId } = render(<Harness open={true} />);
    const middle = getByTestId('middle');
    middle.focus();
    dispatchKey(middle, 'Tab');
    // Focus should NOT have jumped — browser would advance natively.
    expect(document.activeElement).toBe(middle);
  });

  it('Escape invokes onClose', () => {
    const onClose = vi.fn();
    const { getByTestId } = render(<Harness open={true} onClose={onClose} />);
    dispatchKey(getByTestId('dialog'), 'Escape');
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('Escape is ignored when closeOnEscape=false', () => {
    const onClose = vi.fn();
    const { getByTestId } = render(
      <Harness open={true} onClose={onClose} closeOnEscape={false} />
    );
    dispatchKey(getByTestId('dialog'), 'Escape');
    expect(onClose).not.toHaveBeenCalled();
  });

  it('restores focus to return target on unmount', () => {
    const opener = document.createElement('button');
    opener.textContent = 'opener';
    document.body.appendChild(opener);
    opener.focus();
    expect(document.activeElement).toBe(opener);

    const { rerender } = render(<Harness open={true} />);
    // Focus got stolen by the trap.
    expect(document.activeElement).not.toBe(opener);

    rerender(<Harness open={false} />);
    // rAF fires focus restore.
    return new Promise<void>((resolve) => {
      requestAnimationFrame(() => {
        expect(document.activeElement).toBe(opener);
        resolve();
      });
    });
  });

  it('does NOT restore focus when restoreFocus=false', () => {
    const opener = document.createElement('button');
    document.body.appendChild(opener);
    opener.focus();

    const { rerender, getByTestId } = render(
      <Harness open={true} restoreFocus={false} />
    );
    const first = getByTestId('first');
    expect(document.activeElement).toBe(first);
    rerender(<Harness open={false} restoreFocus={false} />);
    return new Promise<void>((resolve) => {
      requestAnimationFrame(() => {
        // Focus did NOT return to opener.
        expect(document.activeElement).not.toBe(opener);
        resolve();
      });
    });
  });

  it('does NOT auto-focus when autoFocus=false', () => {
    const before = document.createElement('button');
    document.body.appendChild(before);
    before.focus();
    render(<Harness open={true} autoFocus={false} />);
    // Focus did NOT move into the dialog.
    expect(document.activeElement).toBe(before);
  });

  it('empty dialog: focus falls back to container (and tabindex is set)', () => {
    const { getByTestId } = render(<Harness open={true} empty={true} />);
    const dialog = getByTestId('dialog');
    expect(dialog.getAttribute('tabindex')).toBe('-1');
    expect(document.activeElement).toBe(dialog);
  });

  it('empty dialog: Tab keeps focus on container instead of escaping', () => {
    const { getByTestId } = render(<Harness open={true} empty={true} />);
    const dialog = getByTestId('dialog');
    dispatchKey(dialog, 'Tab');
    expect(document.activeElement).toBe(dialog);
  });

  it('Tab ignored on non-Tab keys (covers `if event.key !== Tab return`)', () => {
    const { getByTestId } = render(<Harness open={true} />);
    const first = getByTestId('first');
    first.focus();
    dispatchKey(first, 'a');
    // No wrap, focus unchanged.
    expect(document.activeElement).toBe(first);
  });

  it('Tab wraps to first when focus is outside container (Tab branch)', () => {
    const { getByTestId } = render(<Harness open={true} />);
    // Move focus to a node outside the dialog, then fire Tab at the dialog.
    const outside = document.createElement('button');
    document.body.appendChild(outside);
    outside.focus();
    dispatchKey(getByTestId('dialog'), 'Tab');
    expect(document.activeElement).toBe(getByTestId('first'));
  });

  it('Shift+Tab wraps to last when focus is outside container', () => {
    const { getByTestId } = render(<Harness open={true} />);
    const outside = document.createElement('button');
    document.body.appendChild(outside);
    outside.focus();
    dispatchKey(getByTestId('dialog'), 'Tab', { shiftKey: true });
    expect(document.activeElement).toBe(getByTestId('last'));
  });

  it('Escape with no onClose provided is a safe no-op', () => {
    const { getByTestId } = render(<Harness open={true} />);
    expect(() => dispatchKey(getByTestId('dialog'), 'Escape')).not.toThrow();
  });

  it('filters out disabled, aria-hidden, and hidden focusables', () => {
    // Custom dialog that includes excluded elements between first and last.
    function NoisyDialog() {
      const ref = useFocusTrap<HTMLDivElement>({ active: true });
      return (
        <div ref={ref} data-testid="noisy">
          <button data-testid="a">A</button>
          <button disabled data-testid="disabled">Disabled</button>
          <button aria-hidden="true" data-testid="ariah">AriaHidden</button>
          <button hidden data-testid="hidden">Hidden</button>
          <button data-testid="b">B</button>
        </div>
      );
    }
    const { getByTestId } = render(<NoisyDialog />);
    // First focusable should be "a" (disabled/aria-hidden/hidden are skipped).
    expect(document.activeElement).toBe(getByTestId('a'));
    // Shift+Tab from "a" should wrap to "b" (the last non-filtered).
    dispatchKey(getByTestId('a'), 'Tab', { shiftKey: true });
    expect(document.activeElement).toBe(getByTestId('b'));
  });

  it('no-op when active flips to true but container ref is null (nothing rendered)', () => {
    // The hook runs the effect when active=true, but the dialog element
    // isn't attached — containerRef.current is null.
    function BareHook({ active }: { active: boolean }) {
      useFocusTrap<HTMLDivElement>({ active });
      return null; // Intentionally never attach the ref.
    }
    const before = document.createElement('button');
    document.body.appendChild(before);
    before.focus();
    // Should not throw, should not steal focus.
    expect(() => render(<BareHook active={true} />)).not.toThrow();
    expect(document.activeElement).toBe(before);
  });

  it('handles document.activeElement being a non-HTMLElement (e.g. null)', () => {
    // Covers the `instanceof HTMLElement ? ... : null` branch on line 87-88.
    // Spy on focus() of the first button; if the hook ran to the auto-focus
    // step without throwing on the null branch, we're good.
    const focusSpy = vi.fn();
    function SpyDialog() {
      const ref = useFocusTrap<HTMLDivElement>({ active: true });
      return (
        <div ref={ref}>
          <button
            ref={(el) => {
              if (el) el.focus = focusSpy;
            }}
            data-testid="spy-btn"
          >
            Spy
          </button>
        </div>
      );
    }
    // Stub document.activeElement to a non-HTMLElement so the instanceof
    // check on line 87 short-circuits to null for returnTarget.
    const origDesc = Object.getOwnPropertyDescriptor(Document.prototype, 'activeElement');
    Object.defineProperty(document, 'activeElement', {
      configurable: true,
      get: () => ({}), // plain object — NOT an HTMLElement
    });
    try {
      expect(() => render(<SpyDialog />)).not.toThrow();
      // focus() was still called on the first focusable — the null-branch
      // only affected returnTarget, not the auto-focus step.
      expect(focusSpy).toHaveBeenCalled();
    } finally {
      if (origDesc) {
        Object.defineProperty(Document.prototype, 'activeElement', origDesc);
      } else {
        delete (document as unknown as { activeElement?: unknown }).activeElement;
      }
    }
  });
});
