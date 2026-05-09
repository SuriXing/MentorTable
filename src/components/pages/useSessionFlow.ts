import { useEffect, useState } from 'react';
import { MentorProfile } from '../../features/mentorTable/mentorProfiles';
import { generateMentorAdvice, MentorConversationMessage } from '../../features/mentorTable/mentorApi';
import type { MentorSimulationResult } from '../../features/mentorTable/mentorEngine';
import type { ConversationTurn } from '../mentorTable/hooks/useMentorNotes';

export type RitualPhase = 'invite' | 'wish' | 'session';
export type SessionMode = 'idle' | 'booting' | 'live';

// Collision-safe id (Bug #22). Lives here so both the session orchestrators
// and the page (which forwards it to useMentorNotes) share one counter.
let __uniqueIdCounter = 0;
export function uniqueId(prefix = 'id'): string {
  const cryptoObj = ((globalThis as unknown) as { crypto?: { randomUUID?: () => string } }).crypto;
  if (cryptoObj?.randomUUID) return `${prefix}-${cryptoObj.randomUUID()}`;
  __uniqueIdCounter += 1;
  return `${prefix}-${Date.now()}-${__uniqueIdCounter}-${Math.random().toString(36).slice(2, 10)}`;
}

export interface UseSessionFlowOptions {
  selectedMentors: MentorProfile[];
  uiLanguage: 'zh-CN' | 'en';
  isZh: boolean;
  /** Rotation + reveal pause flag owned by the page's hover/focus wiring. */
  isConversationHovered: boolean;
  /** Tracked-timer bag + mount guard (LEAK-1/2/3/4 infra, page-owned). */
  scheduleTimeout: (fn: () => void, ms: number) => number;
  isMountedRef: React.MutableRefObject<boolean>;
  /** Rotation cursor — reset when a new session commits its result. */
  activeIndexRef: React.MutableRefObject<number>;
  /** Page-owned identity helpers (locale-aware, shared with note flows). */
  normalizeKey: (value: string) => string;
  buildConversationHistory: (latestUserText: string) => MentorConversationMessage[];
  /** F157/F162 follow-up: all session choreography the page owns. */
  beginSessionChoreography: () => void;
  scrollConversationToBottom: () => void;
}

export interface MentorReplyTurn {
  mentorName: string;
  text: string;
}

/**
 * The session state machine (P15's deferred second half): phase navigation,
 * boot/live mode, the problem input, the result commit, both async
 * orchestrators, and the reveal heartbeat. Pure orchestration — identity
 * helpers, notes, memories, and panel resets arrive via options.
 */
export function useSessionFlow(options: UseSessionFlowOptions) {
  const {
    selectedMentors,
    uiLanguage,
    isZh,
    isConversationHovered,
    scheduleTimeout,
    isMountedRef,
    activeIndexRef,
    normalizeKey,
    buildConversationHistory,
    beginSessionChoreography,
    scrollConversationToBottom,
  } = options;

  const [phase, setPhase] = useState<RitualPhase>('invite');
  const [sessionMode, setSessionMode] = useState<SessionMode>('idle');
  const [problem, setProblem] = useState('');
  const [isGenerating, setIsGenerating] = useState(false);
  const [result, setResult] = useState<MentorSimulationResult | null>(null);
  const [generateError, setGenerateError] = useState('');
  // Shared by reply-all + note submits (F162/P14: page previously owned it).
  const [isRoundGenerating, setIsRoundGenerating] = useState(false);
  const [conversationTurns, setConversationTurns] = useState<ConversationTurn[]>([]);
  const [replyAllDraft, setReplyAllDraft] = useState('');
  const [visibleReplyCount, setVisibleReplyCount] = useState(0);
  const [showSessionWrap, setShowSessionWrap] = useState(false);
  const [showGroupSolve, setShowGroupSolve] = useState(false);

  const generateMentorFollowup = (_mentorName: string, userText: string) => {
    const excerpt = userText.slice(0, 56).trim();
    if (uiLanguage === 'zh-CN') {
      return `收到你的补充（“${excerpt}${userText.length > 56 ? '...' : ''}”）。我会先给你一个最小可执行动作，你做完后我们再迭代下一步。`;
    }
    return `I got your follow-up (“${excerpt}${userText.length > 56 ? '...' : ''}”). I would start with one smallest executable step, then iterate with you from there.`;
  };

  const handleReplyAll = async () => {
    const text = replyAllDraft.trim();
    if (!text || isRoundGenerating || selectedMentors.length === 0) return;

    // USER-2 parity with handleGenerate: clamp by code points so a surrogate
    // pair is never split and the upstream payload stays bounded no matter
    // what the textarea accepted.
    const safeText = [...text].slice(0, 5000).join('');

    setIsRoundGenerating(true);
    try {
      const aiResult = await generateMentorAdvice({
        problem: safeText,
        language: uiLanguage,
        mentors: selectedMentors,
        conversationHistory: buildConversationHistory(safeText)
      });

      const replies: MentorReplyTurn[] = selectedMentors.map((mentor) => {
        const matched =
          aiResult.mentorReplies.find((reply) => normalizeKey(reply.mentorId) === normalizeKey(mentor.id)) ||
          aiResult.mentorReplies.find((reply) => normalizeKey(reply.mentorName) === normalizeKey(mentor.displayName));
        return {
          mentorName: mentor.displayName,
          text: matched?.likelyResponse || generateMentorFollowup(mentor.displayName, text)
        };
      });

      setConversationTurns((prev) => [
        ...prev,
        {
          // Bug #22: collision-safe id via uniqueId.
          id: uniqueId('turn-all'),
          user: safeText,
          replies
        }
      ]);
      setReplyAllDraft('');
      scrollConversationToBottom();
    } catch (err) {
      // Bug-bash round 1: previously this try/finally had no catch — a
      // malformed response from res.json() bubbled as SyntaxError and the
      // user's message was silently dropped. Surface via generateError.
      // F157: full detail goes to console; the banner shows stable copy only.
      console.error('[mentor-reply-all] request failed:', err);
      setGenerateError(err instanceof Error ? err.message : String(err));
    } finally {
      setIsRoundGenerating(false);
    }
  };

  const handleGenerate = async () => {
    // The mentor-begin-session button is `disabled` unless
    // problem.trim() && selectedMentors.length > 0, so this handler cannot
    // be invoked with empty inputs from the UI. Both defensive guards were
    // removed as unreachable.
    const language = uiLanguage;

    setGenerateError('');
    setIsGenerating(true);
    setPhase('session');
    setSessionMode('booting');
    setVisibleReplyCount(0);
    setShowSessionWrap(false);
    setShowGroupSolve(false);
    setConversationTurns([]);
    setReplyAllDraft('');
    beginSessionChoreography();

    // LEAK-1: tracked boot timer so an unmount mid-boot doesn't flip
    // sessionMode on a dead component.
    const bootTimer = scheduleTimeout(() => {
      setSessionMode('live');
    }, 2600);

    try {
      // USER-2: clamp by code-points (spread into an array) so we never
      // cut a 4-byte UTF-16 surrogate pair in half.
      const safeProblem = [...problem.trim()].slice(0, 5000).join('');
      const aiResult = await generateMentorAdvice({
        problem: safeProblem,
        language,
        mentors: selectedMentors,
        conversationHistory: buildConversationHistory(safeProblem)
      });
      // LEAK-1: only commit state if we're still mounted.
      if (!isMountedRef.current) return;
      setResult(aiResult);
      activeIndexRef.current = 0;
      setVisibleReplyCount(Math.min(1, aiResult.mentorReplies.length));
      window.clearTimeout(bootTimer);
      setIsGenerating(false);
      setSessionMode('live');
    } catch (err) {
      // ERR-2: surface the failure instead of silently leaving the user
      // with an empty conversation panel.
      // F157: full detail goes to console; the banner shows stable copy only.
      if (!isMountedRef.current) return;
      console.error('[mentor-generate] request failed:', err);
      window.clearTimeout(bootTimer);
      setIsGenerating(false);
      setGenerateError(err instanceof Error ? err.message : String(err));
      // Drop back to the wish phase so the Retry button is reachable.
      setPhase('wish');
      setSessionMode('idle');
    }
  };

  // Reveal heartbeat: one more reply becomes visible every 2.6s while the
  // session is live, until the whole table is out.
  useEffect(() => {
    if (sessionMode !== 'live' || !result?.mentorReplies?.length || isConversationHovered) return;
    const timer = window.setTimeout(() => {
      setVisibleReplyCount((count) => Math.min(count + 1, result.mentorReplies.length));
    }, 2600);
    return () => window.clearTimeout(timer);
  }, [sessionMode, result?.mentorReplies.length, visibleReplyCount, isConversationHovered]);

  // U7.1: phase-aware document.title. Single-route SPA → can't do per-route
  // <title> tags, but we can update the tab title as the user moves through
  // the lifecycle so it's obvious at a glance which phase they're in
  // (useful when multitasking across browser tabs).
  useEffect(() => {
    const base = '名人桌 — Mentor Table';
    const phaseLabel =
      phase === 'invite' ? (isZh ? '邀请' : 'Invite')
      : phase === 'wish' ? (isZh ? '提问' : 'Ask')
      : (isZh ? '答题中' : 'In session');
    document.title = `${phaseLabel} · ${base}`;
  }, [phase, isZh]);

  return {
    phase,
    setPhase,
    sessionMode,
    setSessionMode,
    problem,
    setProblem,
    result,
    setResult,
    isGenerating,
    generateError,
    setGenerateError,
    isRoundGenerating,
    setIsRoundGenerating,
    conversationTurns,
    setConversationTurns,
    replyAllDraft,
    setReplyAllDraft,
    visibleReplyCount,
    setVisibleReplyCount,
    showSessionWrap,
    setShowSessionWrap,
    showGroupSolve,
    setShowGroupSolve,
    generateFollowup: generateMentorFollowup,
    handleGenerate,
    handleReplyAll,
  };
}

export type SessionFlow = ReturnType<typeof useSessionFlow>;
