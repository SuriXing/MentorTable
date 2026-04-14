/**
 * R3 C-3 regression test: applyMentorSpeakerClass null-slot guard.
 *
 * The rotation-tick body was extracted out of MentorTablePage's useEffect
 * closure into a module-level helper so the null-safety branch is directly
 * testable. Inline ref callbacks of the form
 *   `ref={(el) => { mentorNodeRefs.current[i] = el }}`
 * create a microsecond-scale window where slots can be null between render
 * commits. If the rotation tick fires inside that window without the guard,
 * the component crashes with "Cannot read property classList of null".
 *
 * This test exercises both branches:
 *   - false branch: node is non-null → classList.toggle is called
 *   - true branch (the C-3 fix):  node is null → continue, no crash
 */
// Imports the helper from its own module — does NOT touch MentorTablePage,
// mentorApi, i18n, or any of the other heavy app modules. Keeps this unit
// test fast and isolated.
import { describe, it, expect, vi } from 'vitest';
import { applyMentorSpeakerClass } from '../applyMentorSpeakerClass';

function makeMockNode() {
  const classes = new Set<string>();
  return {
    classList: {
      toggle: vi.fn((cls: string, on: boolean) => {
        if (on) classes.add(cls);
        else classes.delete(cls);
        return on;
      }),
      contains: (cls: string) => classes.has(cls),
    },
  } as unknown as HTMLElement & { classList: { toggle: ReturnType<typeof vi.fn>; contains: (c: string) => boolean } };
}

describe('applyMentorSpeakerClass', () => {
  it('toggles the speaker class on the active node and clears it on the others', () => {
    const a = makeMockNode();
    const b = makeMockNode();
    const c = makeMockNode();
    applyMentorSpeakerClass([a, b, c], 1, 'speaker');
    expect((a.classList.toggle as ReturnType<typeof vi.fn>).mock.calls).toEqual([['speaker', false]]);
    expect((b.classList.toggle as ReturnType<typeof vi.fn>).mock.calls).toEqual([['speaker', true]]);
    expect((c.classList.toggle as ReturnType<typeof vi.fn>).mock.calls).toEqual([['speaker', false]]);
    // Resulting state
    expect((a.classList as { contains: (c: string) => boolean }).contains('speaker')).toBe(false);
    expect((b.classList as { contains: (c: string) => boolean }).contains('speaker')).toBe(true);
    expect((c.classList as { contains: (c: string) => boolean }).contains('speaker')).toBe(false);
  });

  it('R3 C-3: skips null slots without throwing (rotation-tick race window)', () => {
    const a = makeMockNode();
    const c = makeMockNode();
    // Slot 1 is null — simulates the inline-ref-callback null-write window.
    expect(() => applyMentorSpeakerClass([a, null, c], 0, 'speaker')).not.toThrow();
    // Active idx=0 → a gets the class, c does not, null slot is silently skipped.
    expect((a.classList as { contains: (c: string) => boolean }).contains('speaker')).toBe(true);
    expect((c.classList as { contains: (c: string) => boolean }).contains('speaker')).toBe(false);
  });

  it('handles an entirely null slot array (no nodes bound yet) without throwing', () => {
    expect(() => applyMentorSpeakerClass([null, null, null], 0, 'speaker')).not.toThrow();
  });

  it('handles an empty slot array', () => {
    expect(() => applyMentorSpeakerClass([], 0, 'speaker')).not.toThrow();
  });

  it('an out-of-range activeIdx clears all slots (no node matches)', () => {
    const a = makeMockNode();
    const b = makeMockNode();
    applyMentorSpeakerClass([a, b], 99, 'speaker');
    expect((a.classList as { contains: (c: string) => boolean }).contains('speaker')).toBe(false);
    expect((b.classList as { contains: (c: string) => boolean }).contains('speaker')).toBe(false);
  });
});
