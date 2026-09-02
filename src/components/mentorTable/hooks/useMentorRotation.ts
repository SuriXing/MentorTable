import { useEffect } from 'react';
import { applyMentorSpeakerClass } from '../../pages/applyMentorSpeakerClass';
import type { MentorSimulationResult } from '../../../features/mentorTable/mentorEngine';
import type { SessionMode } from './useSessionFlow';

interface UseMentorRotationOptions {
  result: MentorSimulationResult | null;
  sessionMode: SessionMode;
  /** Rotation + reveal pause flag owned by the page's hover/focus wiring. */
  isConversationHovered: boolean;
  mentorNodeRefs: React.MutableRefObject<(HTMLDivElement | null)[]>;
  activeIndexRef: React.MutableRefObject<number>;
  speakerClass: string;
}

/**
 * imperative mentor auto-rotation — walks mentorNodeRefs and
 * flips the speaker class directly, so the tick costs 0 React re-renders.
 * MC-2: the page's onFocus/onBlur mirror the hover pause so keyboard users
 * can pause auto-rotation the same way mouse users do.
 */
export function useMentorRotation({
  result,
  sessionMode,
  isConversationHovered,
  mentorNodeRefs,
  activeIndexRef,
  speakerClass,
}: UseMentorRotationOptions) {
  const total = result?.mentorReplies?.length ?? 0;

  useEffect(() => {
    if (sessionMode !== 'live' || total === 0 || isConversationHovered) return;
    const applyActiveClass = (idx: number) => {
      // R3 C-3: applyMentorSpeakerClass handles the null guard for the
      // inline-ref-callback null-write window.
      applyMentorSpeakerClass(mentorNodeRefs.current, idx, speakerClass);
    };
    applyActiveClass(activeIndexRef.current);
    const timer = window.setInterval(() => {
      activeIndexRef.current = (activeIndexRef.current + 1) % total;
      applyActiveClass(activeIndexRef.current);
    }, 4200);
    return () => window.clearInterval(timer);
  }, [total, sessionMode, isConversationHovered, mentorNodeRefs, activeIndexRef, speakerClass]);
}
