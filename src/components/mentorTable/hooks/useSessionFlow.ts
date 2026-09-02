import { useCallback, useEffect, useState } from 'react';
import { MentorProfile } from '../../../features/mentorTable/mentorProfiles';
import { generateMentorAdvice, MentorConversationMessage } from '../../../features/mentorTable/mentorApi';
import type { MentorSimulationResult } from '../../../features/mentorTable/mentorEngine';
import type { ConversationTurn } from '../../../features/mentorTable/conversationTypes';

export type RitualPhase = 'invite' | 'wish' | 'session';
export type SessionMode = 'idle' | 'booting' | 'live';

// Cap for conversation history forwarded to the mentor API on each round
// (bug #44). Prevents unbounded token growth across many reply rounds.
export const MAX_CONVERSATION_TURNS_IN_HISTORY = 12;

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
  /** Scroll target for conversation auto-scroll (page-owned DOM node). */
  conversationPanelRef: React.RefObject<HTMLDivElement | null>;
  /** Page-owned identity helpers (locale-aware, shared with note flows). */
  normalizeKey: (value: string) => string;
  localizeName: (raw: string) => string;
  resolveMentorName: (raw: string) => string;
  /** Localized "you" speaker label used in conversation history payloads. */
  youLabel: string;
  /**
   * Bridge to page-owned non-machine resets (notes, memories, panels,
   * rotation cursor). A ref, not a callback option: the choreography reads
   * useMentorNotes state, which depends on this hook's history builder —
   * a callback option would re-create the TDZ wrapper knot this options
   * rework removed. The page assigns the function; the hook calls it.
   */
  sessionStartRef: React.MutableRefObject<(() => void) | null>;
}

export interface MentorReplyTurn {
  mentorName: string;
  text: string;
  /** Snapshot of the API response meta this reply came from (badge honesty). */
  source?: MentorSimulationResult['meta'];
}

/**
 * The session state machine ('s deferred second half): phase navigation,
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
    conversationPanelRef,
    normalizeKey,
    localizeName,
    resolveMentorName,
    youLabel,
    sessionStartRef,
  } = options;

  const [phase, setPhase] = useState<RitualPhase>('invite');
  const [sessionMode, setSessionMode] = useState<SessionMode>('idle');
  const [problem, setProblem] = useState('');
  const [isGenerating, setIsGenerating] = useState(false);
  const [result, setResult] = useState<MentorSimulationResult | null>(null);
  const [generateError, setGenerateError] = useState('');
  // Shared by reply-all + note submits (/page previously owned it).
  const [isRoundGenerating, setIsRoundGenerating] = useState(false);
  const [conversationTurns, setConversationTurns] = useState<ConversationTurn[]>([]);
  const [replyAllDraft, setReplyAllDraft] = useState('');
  const [visibleReplyCount, setVisibleReplyCount] = useState(0);
  const [showSessionWrap, setShowSessionWrap] = useState(false);
  const [showGroupSolve, setShowGroupSolve] = useState(false);

  /**
   * Conversation history forwarded to the mentor API on each round. Built
   * here because every input is machine state (problem, committed result,
   * visible slice, stored turns) plus naming services — the page used to
   * rebuild this from hook state and hand it back through an options bag,
   * which is what forced the TDZ arrow wrappers.
   *
   * R3 C-4: latestUserText is REQUIRED. All three call sites
   * (handleGenerate / handleReplyAll / submitNoteToMentor) guard their
   * `text` before invoking and never pass undefined or empty. The budget
   * calc and the trailing append agree (no defensive guard contradiction).
   */
  const buildConversationHistory = (latestUserText: string): MentorConversationMessage[] => {
    const history: MentorConversationMessage[] = [];
    const baseProblem = problem.trim();
    if (baseProblem) {
      history.push({
        role: 'user',
        speaker: youLabel,
        text: baseProblem
      });
    }

    const visibleReplies = (result?.mentorReplies || []).slice(0, visibleReplyCount);
    for (const reply of visibleReplies) {
      const mentorName = localizeName(resolveMentorName(reply.mentorName));
      history.push({
        role: 'mentor',
        speaker: mentorName,
        text: `${reply.likelyResponse} ${reply.oneActionStep}`.trim()
      });
    }

    // Cap conversation turns client-side to avoid unbounded token growth
    // (bug #44) AND to stay under the server's HISTORY_MAX_ENTRIES=50 cap
    // (R2A ARCH-1: a 5-mentor × 12-turn session would send ~80 entries and
    // 413 on every submit). Each turn contributes (1 user + replies.length
    // mentor entries), so the cap must shrink as mentor count grows.
    const SERVER_HISTORY_CAP = 49; // keep 1 entry headroom below server's 50
    const baseSlots = 1 + visibleReplies.length + 1;
    // Worst-case per-turn size: 1 user + the largest replies array across all turns.
    let worstPerTurn = 2;
    for (const turn of conversationTurns) {
      const size = 1 + turn.replies.length;
      if (size > worstPerTurn) worstPerTurn = size;
    }
    const budget = Math.max(0, SERVER_HISTORY_CAP - baseSlots);
    const dynamicTurnCap = Math.max(1, Math.floor(budget / worstPerTurn));
    const effectiveTurnCap = Math.min(MAX_CONVERSATION_TURNS_IN_HISTORY, dynamicTurnCap);
    const recentTurns = conversationTurns.slice(-effectiveTurnCap);
    for (const turn of recentTurns) {
      if (turn.user?.trim()) {
        history.push({
          role: 'user',
          speaker: youLabel,
          text: turn.user.trim()
        });
      }
      // deadcode-audit deletion #2 (unsafe): skip whitespace-only mentor
      // replies — a remote LLM can return `likelyResponse: "   "` which
      // passes the truthiness check and would otherwise be forwarded to the
      // API as an empty mentor turn.
      for (const reply of turn.replies) {
        if (!reply?.text?.trim()) continue;
        history.push({
          role: 'mentor',
          speaker: localizeName(reply.mentorName),
          text: reply.text.trim()
        });
      }
    }

    // R3 C-4: append unconditionally — matches the budget calc above.
    history.push({
      role: 'user',
      speaker: youLabel,
      text: latestUserText.trim()
    });

    return history;
  };

  const scrollConversationToBottom = useCallback(() => {
    window.requestAnimationFrame(() => {
      // Ref may have been cleared between rAF schedule and callback —
      // e.g. phase changed back to invite mid-animation. Guard kept.
      const node = conversationPanelRef.current;
      if (!node) return;
      node.scrollTop = node.scrollHeight;
    });
  }, [conversationPanelRef]);

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
        // No reply for this mentor means an empty turn entry, which the UI
        // renders as an explicit "didn't respond" line. It used to fall back
        // to a fabricated first-person follow-up — a mentor who never spoke
        // got quoted words the model never produced.
        return {
          mentorName: mentor.displayName,
          text: matched?.likelyResponse || '',
          source: aiResult.meta
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
      // full detail goes to console; the banner shows stable copy only.
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
    sessionStartRef.current?.();

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
      // full detail goes to console; the banner shows stable copy only.
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

  // phase-aware document.title. Single-route SPA → can't do per-route
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
    handleGenerate,
    handleReplyAll,
    buildConversationHistory,
    scrollConversationToBottom,
  };
}

export type SessionFlow = ReturnType<typeof useSessionFlow>;
