/**
 * R3 C-3: extracted from MentorTablePage's rotation-tick useEffect closure
 * so the null-safety branch is directly unit-testable.
 *
 * The inline ref callback pattern in MentorTablePage's JSX
 *   `ref={(el) => { mentorNodeRefs.current[index] = el; }}`
 * creates a microsecond-scale window where slots can be null between render
 * commits. Any rotation tick that fires inside that window must NOT crash
 * with "Cannot read property classList of null". This helper is the guard.
 *
 * Lives in its OWN module file (rather than inside MentorTablePage.tsx) so
 * unit tests can import it without dragging the entire page component +
 * mentorApi + i18n + react-router-dom into the test environment.
 */
export function applyMentorSpeakerClass(
  nodes: ReadonlyArray<HTMLElement | null>,
  activeIdx: number,
  speakerClass: string
): void {
  for (let i = 0; i < nodes.length; i += 1) {
    const node = nodes[i];
    if (!node) continue;
    node.classList.toggle(speakerClass, i === activeIdx);
  }
}
