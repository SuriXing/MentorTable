// TODO: 73 more isZh ternaries to migrate, see .bugbash/mt-ux.md
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import {
  faUser,
  faLightbulb,
  faCircleInfo,
  faUsers,
  faTriangleExclamation,
  faPlus,
  faXmark,
  faMagnifyingGlass,
  faShuffle,
  faRotate,
  faChevronLeft,
  faBell,
  faBookOpen,
  faBug
} from '@fortawesome/free-solid-svg-icons';
// BUNDLE-1: Layout + Aurora + OGL were deleted (dead code under the
// `standalone` render path). Theme controls are mounted directly in main.tsx.
import { useTheme } from '../../hooks/useTheme';
import { useFocusTrap } from '../../hooks/useFocusTrap';
import { MentorProfile, createCustomMentorProfile } from '../../features/mentorTable/mentorProfiles';
import { fetchMentorDebugPrompt, MentorConversationMessage } from '../../features/mentorTable/mentorApi';
import {
  PersonOption,
  buildMentorImageChain,
  fetchPersonImage,
  fetchPersonImageCandidates,
  findVerifiedPerson,
  getChineseDisplayName
} from '../../features/mentorTable/personLookup';
import { applyMentorSpeakerClass } from './applyMentorSpeakerClass';
import styles from './MentorTablePage.module.css';
import { OnboardingModal } from '../mentorTable/OnboardingModal';
import { MemoryDrawer } from '../mentorTable/MemoryDrawer';
import { DebugPromptPanel } from '../mentorTable/DebugPromptPanel';
import { SuggestionDeck, type ExpandedSuggestionCard, type SuggestionDeckEntry } from '../mentorTable/SuggestionDeck';
import { ExpandedSuggestionOverlay } from '../mentorTable/ExpandedSuggestionOverlay';
import { ReplyThreadOverlay } from '../mentorTable/ReplyThreadOverlay';
import { usePersonSearch } from '../mentorTable/hooks/usePersonSearch';
import { useImageChain } from '../mentorTable/hooks/useImageChain';
import { useMentorNotes } from '../mentorTable/hooks/useMentorNotes';
import { MemoryCard, clearMemories, loadMemories, saveMemories } from '../../lib/memoryStore';
import { useSessionFlow, uniqueId } from './useSessionFlow';
import type { RitualPhase } from './useSessionFlow';
import mentorsContract from '../../../shared/mentors-contract.json';

// F174: the ceiling is owned by shared/mentors-contract.json, the same file
// the API requires — parity is structural, not a regex over this file.
const MAX_PEOPLE = mentorsContract.mentorsMax;
// Cap for conversation history forwarded to the mentor API on each round
// (bug #44). Prevents unbounded token growth across many reply rounds.
const MAX_CONVERSATION_TURNS_IN_HISTORY = 12;
const COORDINATE_PASS_NOTE_WITH_ALL = (import.meta.env.VITE_MENTOR_NOTE_COORDINATE_ALL ?? '1') !== '0';
const ONBOARDING_KEY = 'mentorTableOnboardingHiddenV2';

const onboardingSlides = [
  {
    title: '欢迎来到名人桌',
    body: '把你的问题抛给一桌名人、角色或性格类型——每个人都会从自己的视角给你建议。就像同时和爱因斯坦、哆啦A梦、还有你最喜欢的游戏角色聊天一样。'
  },
  {
    title: '怎么用？',
    body: '1. 搜索并添加你想咨询的对象（名人、MBTI类型、动漫/游戏/电影角色都可以）\n2. 写下你的问题\n3. 点击开始，等待每位对象的回复\n\n你还可以单独追问某个人，或同时问所有人。'
  },
  {
    title: '准备好了吗？',
    body: '有用的回复可以保存到右下角的记忆抽屉，方便以后查看。选择下次是否还显示这个说明，然后开始吧！'
  }
];

const vibeTags = ['Builder', 'Storyteller', 'Competitor', 'Strategist', 'Dreamer', 'Rebel'];
const vibeTagsZh = ['构建者', '讲述者', '行动派', '战略派', '梦想家', '突破者'];


// Bug #22: Date.now() alone can collide within the same millisecond when
function getMentorCategory(name: string): 'tech' | 'sports' | 'artist' | 'leader' {
  const normalized = name.toLowerCase();
  if (normalized.includes('kobe')) return 'sports';
  if (normalized.includes('miyazaki') || normalized.includes('taylor') || normalized.includes('swift')) return 'artist';
  if (normalized.includes('bill') || normalized.includes('elon') || normalized.includes('jobs') || normalized.includes('lisa su') || normalized.includes('satya') || normalized.includes('nadella')) return 'tech';
  return 'leader';
}

const MentorTablePage: React.FC<{ standalone?: boolean }> = ({ standalone = false }) => {
  const { i18n, t: tI18n } = useTranslation();
  const isZh = i18n.language?.toLowerCase().startsWith('zh');
  // Apply stored theme (primary color + light/dark mode) on mount
  useTheme();
  const [personQuery, setPersonQuery] = useState('');
  // F162 (P13): search suggestions + spinner state live in usePersonSearch.
  const { suggestions, isSearching } = usePersonSearch(personQuery);
  const [selectedPeople, setSelectedPeople] = useState<PersonOption[]>([]);
  const uiLanguage: 'zh-CN' | 'en' = isZh ? 'zh-CN' : 'en';
  const selectedMentors = useMemo(
    () => selectedPeople.map((person) => createCustomMentorProfile(person.name)),
    [selectedPeople]
  );
  const [isConversationHovered, setIsConversationHovered] = useState(false);
  const isMountedRef = useRef(true);
  // LEAK-2/3/4: unified timer bag — every setTimeout gets tracked and
  // cleared on unmount so no fire-and-forget timers leak.
  const pendingTimersRef = useRef<Set<number>>(new Set());
  // RERENDER-5: rotation tick used to drive setState every 4.2s, forcing
  // the whole tree to re-render just to toggle a class. Now the tick
  // walks mentorNodeRefs and toggles the active class imperatively.
  const activeIndexRef = useRef(0);
  // LEAK-1: provide a safe replacement for setTimeout that records
  // handles and is auto-cleared on unmount. The unmount effect calls
  // clearTimeout on every pending handle *before* React finishes tearing
  // down, so a post-unmount `isMountedRef.current === false` check inside
  // the callback is unreachable — if we're still running, we're mounted.
  const scheduleTimeout = useCallback((fn: () => void, ms: number): number => {
    const handle = window.setTimeout(() => {
      pendingTimersRef.current.delete(handle);
      fn();
    }, ms);
    pendingTimersRef.current.add(handle);
    return handle;
  }, []);

  // P15 second half: the session state machine (phase/mode/problem/result/
  // orchestrators/reveal heartbeat) lives in useSessionFlow now. Identity
  // helpers, notes, memories, and panel choreography stay page-side and
  // arrive as options; the destructure keeps every original name so the
  // JSX and downstream hooks are untouched.
  const {
    phase, setPhase, sessionMode, setSessionMode, problem, setProblem, result, setResult,
    isGenerating, generateError, setGenerateError, isRoundGenerating, setIsRoundGenerating,
    conversationTurns, setConversationTurns, replyAllDraft, setReplyAllDraft,
    visibleReplyCount, setVisibleReplyCount, showSessionWrap, setShowSessionWrap,
    showGroupSolve, setShowGroupSolve, generateFollowup, handleGenerate, handleReplyAll,
  } = useSessionFlow({
    selectedMentors,
    uiLanguage,
    isZh,
    isConversationHovered,
    scheduleTimeout,
    isMountedRef,
    activeIndexRef,
    normalizeKey: (value) => normalizeMentorKey(value),
    buildConversationHistory: (text) => buildConversationHistory(text),
    beginSessionChoreography: () => beginSessionChoreography(),
    scrollConversationToBottom: () => scrollConversationToBottom(),
  });
  // RERENDER-5: activeResultIndex lives in a ref below — removed from state.
  // This component only runs client-side (the app has no SSR), so `window`
  // and `localStorage` are always available.
  const [showOnboarding, setShowOnboarding] = useState<boolean>(
    // Bug-bash round 1: Safari Private Browsing throws SecurityError on
    // localStorage access. Fall back to showing onboarding on failure.
    () => {
      try {
        return localStorage.getItem(ONBOARDING_KEY) !== '1';
      } catch {
        return true;
      }
    }
  );
  const [dontShowOnboardingAgain, setDontShowOnboardingAgain] = useState<boolean>(
    () => {
      try {
        return localStorage.getItem(ONBOARDING_KEY) === '1';
      } catch {
        return false;
      }
    }
  );
  const [currentSlide, setCurrentSlide] = useState(0);
  const [flippedCards, setFlippedCards] = useState<Record<string, boolean>>({});
  const [lastSummonedName, setLastSummonedName] = useState<string>('');
  const [candleLevel, setCandleLevel] = useState(1);
  const [tableRipple, setTableRipple] = useState<{ x: number; y: number; key: string } | null>(null);
  const [memoryDrawerOpen, setMemoryDrawerOpen] = useState(false);
  // F163 (P16): memories survive refreshes — loaded once from localStorage
  // (with schema migration) and persisted best-effort on every change.
  const [memories, setMemories] = useState<MemoryCard[]>(() => loadMemories());
  useEffect(() => {
    saveMemories(memories);
  }, [memories]);
  const [expandedReplyId, setExpandedReplyId] = useState('');
  // R3/F44: inviteTouched was dead — the CTA is `disabled` (F38) so
  // onClick never fires to set it, and the error hint stayed hidden. Render
  // the hint unconditionally while selectedPeople.length === 0 so the user
  // understands *why* the button is disabled.
  const [expandedSuggestion, setExpandedSuggestion] = useState<ExpandedSuggestionCard | null>(null);
  const [hoveredDebugMentorId, setHoveredDebugMentorId] = useState('');
  const [openDebugMentorId, setOpenDebugMentorId] = useState('');
  const [debugPromptByMentorId, setDebugPromptByMentorId] = useState<Record<string, string>>({});
  const [debugPromptLoadingByMentorId, setDebugPromptLoadingByMentorId] = useState<Record<string, boolean>>({});
  const [debugPromptErrorByMentorId, setDebugPromptErrorByMentorId] = useState<Record<string, string>>({});
  const [saveNotice, setSaveNotice] = useState('');
  // ERR-2: surface a retry-able error banner when handleGenerate throws
  // (e.g. network failure) instead of silently dropping to an empty panel.
  const conversationPanelRef = useRef<HTMLDivElement | null>(null);
  // SR-4: focus the safety risk banner when it first appears.
  const riskBannerRef = useRef<HTMLDivElement | null>(null);
  const lastRiskSignatureRef = useRef<string>('');
  // LEAK-1: guard against setState after unmount. handleGenerate and
  // other async paths check this before state transitions.
  const mentorNodeRefs = useRef<Array<HTMLDivElement | null>>([]);
  // ARCH-3: coalesce rapid-fire addPerson calls for the same key so a
  // double-click on the add button doesn't cancel the prior hydration.
  const addPersonTimestampRef = useRef<Map<string, number>>(new Map());

  useEffect(() => {
    isMountedRef.current = true;
    // Capture the ref's Set into effect scope so the cleanup closes over the
    // same Set we're tracking into. The Set's identity never changes at
    // runtime — we only ever mutate its contents — so this is safe and
    // satisfies the ref-in-cleanup lint rule.
    const timers = pendingTimersRef.current;
    return () => {
      isMountedRef.current = false;
      // LEAK-2/3/4: fire-and-forget timers get swept here.
      for (const handle of timers) {
        window.clearTimeout(handle);
      }
      timers.clear();
    };
  }, []);

  // R3 I-4: proper focus-trap + focus-return for the 3 modal dialogs.
  // Each hook is called unconditionally (React rules-of-hooks) and the
  // `active` flag tells it when the dialog is currently mounted. When
  // `active` is false, the hook is a no-op: no focus stolen, no listeners.
  //
  // The ref returned by each hook is attached to the corresponding dialog
  // element in the JSX below. See src/hooks/useFocusTrap.ts for the
  // full contract.
  const onboardingTrapRef = useFocusTrap<HTMLDivElement>({
    active: showOnboarding,
    onClose: () => finishOnboarding(),
  });
  const expandedSuggestionTrapRef = useFocusTrap<HTMLDivElement>({
    active: Boolean(expandedSuggestion),
    onClose: () => setExpandedSuggestion(null),
  });
  // Note: use expandedReplyId (plain state) rather than the derived
  // `expandedReply` const, because that const is declared further down
  // in the function body — reading it here would hit a TDZ error.
  const expandedReplyTrapRef = useFocusTrap<HTMLDivElement>({
    active: expandedReplyId !== '',
    onClose: () => {
      setExpandedReplyId('');
      setExpandedSuggestion(null);
    },
  });

  // Bug #20: per-person hydration sequence — an addPerson call records its
  // sequence number; when the async image fetch resolves, we only apply the
  // result if that sequence is still the latest for the normalized key.
  // This prevents a stale hydration from an earlier add/remove cycle from
  // overwriting fresh data when the user quickly removes and re-adds a
  // person.
  const personHydrationSeqRef = useRef<Map<string, number>>(new Map());

  const ritualStep = phase === 'invite' ? 0 : phase === 'wish' ? 1 : 2;
  const localizedVibeTags = isZh ? vibeTagsZh : vibeTags;

  // RERENDER-3: stabilize the string bundle so it doesn't get rebuilt
  // on every render. Callers that capture `t` in closures / deps will
  // also stay stable across renders when language doesn't change.
  const t = useMemo(() => ({
    heroTitle: tI18n('mt.heroTitle'),
    heroSub: tI18n('mt.heroSub'),
    // Bug-bash round 1: migrate 10 most user-visible ternaries to t() with
    // new namespaced keys. Falls back to the isZh branch if the key isn't
    // defined in the active locale yet.
    summonGuests: tI18n('mt.summonGuests'),
    placeArtifact: tI18n('mt.placeArtifact'),
    openCircle: tI18n('mt.openCircle'),
    edit: tI18n('mt.edit'),
    shuffle: tI18n('mt.shuffle'),
    restart: tI18n('mt.restart'),
    summoningRitual: tI18n('mt.summoningRitual'),
    invitePlaceholder: tI18n('mt.invitePlaceholder'),
    flip: tI18n('mt.flip'),
    keepGoing: tI18n('mt.keepGoing'),
    continueToWish: tI18n('mt.continueToWish'),
    artifactPlaceholder: tI18n('mt.artifactPlaceholder'),
    beginSession: tI18n('mt.beginSession'),
    generating: tI18n('mt.generating'),
    sessionInProgress: tI18n('mt.sessionInProgress'),
    source: tI18n('mt.source'),
    llmApi: tI18n('mt.llmApi'),
    localFallback: tI18n('mt.localFallback'),
    aiDisclaimer: tI18n('mt.aiDisclaimer'),
    youFrontRow: tI18n('mt.youFrontRow'),
    concernHint: tI18n('mt.concernHint'),
    tableListening: tI18n('mt.tableListening'),
    clothPattern: tI18n('mt.clothPattern'),
    ambientOn: tI18n('mt.ambientOn'),
    cardsGlow: tI18n('mt.cardsGlow'),
    hoverPause: tI18n('mt.hoverPause'),
    you: tI18n('mt.you'),
    passNoteTo: tI18n('mt.passNoteTo'),
    replyTo: tI18n('mt.replyTo'),
    send: tI18n('mt.send'),
    typing: tI18n('mt.typing'),
    typingNow: tI18n('mt.typingNow'),
    mentorTyping: tI18n('mt.mentorTyping'),
    hideGroup: tI18n('mt.hideGroup'),
    showGroup: tI18n('mt.showGroup'),
    jointStrategy: tI18n('mt.jointStrategy'),
    replyToAllHeader: tI18n('mt.replyToAllHeader'),
    replyAllPlaceholder: tI18n('mt.replyAllPlaceholder'),
    sendToAll: tI18n('mt.sendToAll'),
    showWrap: tI18n('mt.showWrap'),
    sessionComplete: tI18n('mt.sessionComplete'),
    tonightTakeaway: tI18n('mt.tonightTakeaway'),
    save: tI18n('mt.save'),
    newTable: tI18n('mt.newTable'),
    memories: tI18n('mt.memories'),
    memoryDrawer: tI18n('mt.memoryDrawer'),
    savedInDrawer: tI18n('mt.savedInDrawer'),
    savedSuccess: tI18n('mt.savedSuccess'),
    noMemories: tI18n('mt.noMemories'),
    chatWindow: tI18n('mt.chatWindow'),
    backToTable: tI18n('mt.backToTable'),
    clickToExpand: tI18n('mt.clickToExpand'),
    debugPrompt: tI18n('mt.debugPrompt'),
    closeDebug: tI18n('mt.closeDebug'),
    inspectPrompt: tI18n('mt.inspectPrompt'),
    loading: tI18n('mt.loading'),
    debugLoadFailed: tI18n('mt.debugLoadFailed'),
    back: tI18n('mt.back'),
    next: tI18n('mt.next'),
    getStarted: tI18n('mt.getStarted'),
    dontShowAgain: tI18n('mt.dontShowAgain'),
    keepShowing: tI18n('mt.keepShowing'),
    // R3/F50: i18n-wire the onboarding Skip label (was hardcoded bilingual).
    skipOnboarding: tI18n('mt.skipOnboarding'),
    // ERR-2: retry-able error state for handleGenerate failures
    generateFailed: tI18n('mt.generateFailed'),
    // F157: the banner stays human-readable; raw upstream text goes to the
    // console only — endpoint URLs / status bodies were leaking into the UI.
    generateFailedHint: tI18n('mt.generateFailedHint'),
    // F160/F161: provider honesty — the server can answer 200 with fully
    // canned replies (meta.provider 'server-fallback') or a mix ('partial-
    // fallback'); the badge must not present those as live LLM output.
    cannedReplies: tI18n('mt.cannedReplies'),
    cannedRepliesTitle: isZh
      ? 'LLM 服务本次不可用，展示的是本地预设回复模板'
      : 'The LLM was unavailable for this request — replies below are local preset templates',
    partialFallback: tI18n('mt.partialFallback'),
    partialFallbackTitle: isZh
      ? '部分嘉宾的回复由本地预设模板补充（LLM 未返回）'
      : 'Some guests\' replies were filled in from local preset templates (the LLM did not return them)',
    retry: tI18n('mt.retry'),
    // MC-3: jump past the reveal timer
    revealAll: tI18n('mt.revealAll'),
    // ERR-1: 0-mentor continue guard
    needAtLeastOne: tI18n('mt.needAtLeastOne'),
    // R2/F39: empty-state copy via t map (was inline isZh ternaries — works
    // but breaks DRY with the rest of the bilingual surface).
    emptyIntroTitle: tI18n('mt.emptyIntroTitle'),
    emptyIntroHint: isZh ? '在上方搜索框输入名字，按回车即可入席。' : 'Type a name above and press Enter to seat them.'
  }), [isZh, tI18n]);

  const normalizeNameKey = useCallback(
    (name: string) => name.trim().toLowerCase().replace(/\s+/g, ' '),
    []
  );

  // RERENDER-1 / ALGO-1: memoize caller-side wrappers on top of the
  // (still O(n)) findVerifiedPerson lookup. Keyed on selectedPeople so
  // they're stable inside other useMemo/useCallback deps.
  const resolveDisplayName = useCallback((name: string): string => {
    try {
      const verified = findVerifiedPerson(name);
      if (verified) return verified.canonical;
    } catch { /* findVerifiedPerson may not be available */ }
    return name;
    // findVerifiedPerson is imported once at module scope so its identity
    // never changes — no dep needed. selectedPeople included so callers
    // can safely pass it through deps.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedPeople]);

  const localizeName = useCallback((name: string) => {
    const canonical = resolveDisplayName(name);
    if (!isZh) return canonical;
    return getChineseDisplayName(canonical);
  }, [isZh, resolveDisplayName]);

  const createInitialAvatar = (name: string) => {
    const canonical = resolveDisplayName(name);
    // canonical has already passed through trim()/filter() guards upstream,
    // so the split chunks are always non-empty — no `|| '?'` fallback needed.
    const text = canonical
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((s) => s[0].toUpperCase())
      .join('');
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="96" height="96"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0%" stop-color="#eff5ff"/><stop offset="100%" stop-color="#d6e5ff"/></linearGradient></defs><rect width="96" height="96" fill="url(#g)"/><circle cx="48" cy="48" r="44" fill="#ffffff" opacity="0.72"/><text x="50%" y="53%" text-anchor="middle" dominant-baseline="middle" font-family="Arial,sans-serif" font-size="34" font-weight="700" fill="#2b4f90">${text}</text></svg>`;
    return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
  };

  // Callers always pass a truthy src — the `!src` guard has been removed.
  const isLikelyFallbackAvatar = (src: string) =>
    src.startsWith('data:image/svg+xml') || src.includes('ui-avatars.com/api');

  // F162 (P13): ladder progress lives in useImageChain; the page composes
  // the chain itself (it owns selectedPeople + locale-aware initials).
  const { imageSrcFor, markImageBroken, clearImageProgressForKey } = useImageChain({
    buildChain: (name, imageUrl, candidateImageUrls) => {
      const person = selectedPeople.find((p) => normalizeNameKey(p.name) === normalizeNameKey(name));

      // F154: the ladder itself lives in personLookup.buildMentorImageChain —
      // production is proxy → initials (CSP blocks every external host), dev
      // keeps the full ladder. This wrapper only merges component state
      // (selectedPeople images) into the external candidates.
      return buildMentorImageChain({
        name,
        externalCandidates: [
          imageUrl,
          person?.imageUrl,
          ...(candidateImageUrls ?? []),
          ...(person?.candidateImageUrls ?? []),
        ].filter(Boolean) as string[],
        initialsAvatar: createInitialAvatar(name),
        isDev: import.meta.env.DEV,
      });
    },
    scheduleTimeout,
    normalizeKey: normalizeNameKey,
  });

  const mentorThreadKey = (rawName: string) => normalizeMentorKey(resolveMentorName(rawName));

  const normalizeMentorKey = (value: string) => value.trim().toLowerCase().replace(/\s+/g, '_');

  const resolveMentorName = (rawName: string): string => {
    const key = normalizeMentorKey(rawName);
    const fromSelectedPeople = selectedPeople.find((p) => normalizeMentorKey(p.name) === key);
    if (fromSelectedPeople) return fromSelectedPeople.name;
    // selectedMentors is built 1:1 from selectedPeople (createCustomMentorProfile
    // uses person.name as displayName), so if fromSelectedPeople missed, a
    // mentor-displayName lookup would miss for the same key. Mentor.id is only
    // ever derived internally — no caller here passes a raw id, so the
    // fallback lookup on selectedMentors was unreachable and was removed.
    return rawName;
  };


  // R3 C-4: latestUserText is REQUIRED, not optional. All three call sites
  // (handleGenerate / handleReplyAll / submitNoteToMentor) guard their
  // `text` before invoking and never pass undefined or empty. Making it
  // required at the type level means the budget calc and the trailing
  // append agree (no defensive guard contradiction). If a future caller
  // wants to skip latestUserText, they should call a new variant — don't
  // re-introduce the optional + if-guard pattern that R3 flagged.
  const buildConversationHistory = (latestUserText: string): MentorConversationMessage[] => {
    const history: MentorConversationMessage[] = [];
    const baseProblem = problem.trim();
    if (baseProblem) {
      history.push({
        role: 'user',
        speaker: t.you,
        text: baseProblem
      });
    }

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
    //
    // Formula: remaining budget after baseProblem (1) + visibleReplies.length
    // + latestUserText (1, if present). Divide by worst-case per-turn
    // entry count to get max turns we can fit.
    const SERVER_HISTORY_CAP = 49; // keep 1 entry headroom below server's 50
    // R3 C-4: latestUserText is always present (the parameter is required;
    // see the comment on the function signature). The budget includes its
    // slot unconditionally — this matches the unconditional append at
    // line ~520. Both halves agree.
    const baseSlots = 1 + visibleReplies.length + 1;
    // Worst-case per-turn size: 1 user + the largest replies array across all turns.
    // `turn.replies` is always an array per ConversationTurn type.
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
          speaker: t.you,
          text: turn.user.trim()
        });
      }
      // deadcode-audit deletion #2 (unsafe): restored skip guard for
      // whitespace-only mentor replies. The original justification claimed
      // writers always set trimmed strings, but a remote LLM can return
      // `likelyResponse: "   "` which passes the truthiness check and would
      // otherwise be forwarded to the API as an empty mentor turn.
      for (const reply of turn.replies) {
        if (!reply?.text?.trim()) continue;
        history.push({
          role: 'mentor',
          speaker: localizeName(reply.mentorName),
          text: reply.text.trim()
        });
      }
    }

    // R3 C-4: latestUserText is required and non-empty (see signature).
    // Append unconditionally — matches the budget calc above. The
    // previous `if (latestUserText?.trim())` guard contradicted the
    // unconditional budget addend and was flagged by Round 3 as the
    // "two halves disagree" maintenance hazard.
    history.push({
      role: 'user',
      speaker: t.you,
      text: latestUserText.trim()
    });

    return history;
  };

  // F162 (P14): note threads + submit flow live in useMentorNotes; the page
  // keeps the shared isRoundGenerating flag (reply-all also drives it) and
  // the conversation-history builder.
  const {
    openNoteFor,
    setOpenNoteFor,
    noteDrafts,
    setNoteDrafts,
    noteReplies,
    submitNoteToMentor,
    resetNotes,
  } = useMentorNotes({
    selectedMentors,
    uiLanguage,
    threadKeyFor: mentorThreadKey,
    localizeName,
    resolveName: resolveMentorName,
    normalizeKey: normalizeMentorKey,
    buildConversationHistory,
    generateFollowup,
    reportGenerateError: (err) => {
      // F157: full detail to console; banner shows stable copy only.
      console.error('[mentor-note] request failed:', err);
      setGenerateError(err instanceof Error ? err.message : String(err));
    },
    appendConversationTurn: (turn) => setConversationTurns((prev) => [...prev, turn]),
    uniqueId,
    coordinateWithAll: COORDINATE_PASS_NOTE_WITH_ALL,
    isRoundGenerating,
    setIsRoundGenerating,
  });


  // P15: everything handleGenerate used to reset that is NOT machine state
  // — notes, memories, reply/debug panels, rotation cursor. The session
  // orchestrator calls this at session start; the page owns the targets.
  const beginSessionChoreography = () => {
    resetNotes();
    setMemories([]);
    clearMemories();
    setExpandedReplyId('');
    setExpandedSuggestion(null);
    setOpenDebugMentorId('');
    setHoveredDebugMentorId('');
    setDebugPromptByMentorId({});
    setDebugPromptLoadingByMentorId({});
    setDebugPromptErrorByMentorId({});
    activeIndexRef.current = 0;
  };

  const scrollConversationToBottom = () => {
    window.requestAnimationFrame(() => {
      // Ref may have been cleared between rAF schedule and callback —
      // e.g. phase changed back to invite mid-animation. Guard kept.
      const node = conversationPanelRef.current;
      if (!node) return;
      node.scrollTop = node.scrollHeight;
    });
  };

  // RERENDER-5: imperative rotation — walks mentorNodeRefs and flips
  // the speaker class directly, so the tick costs 0 React re-renders.
  // MC-2: onFocus/onBlur mirror the hover pause so keyboard users can
  // pause auto-rotation the same way mouse users do.
  useEffect(() => {
    const total = result?.mentorReplies?.length ?? 0;
    if (sessionMode !== 'live' || total === 0 || isConversationHovered) return;
    const applyActiveClass = (idx: number) => {
      // R3 C-3: applyMentorSpeakerClass (module-level) handles the null
      // guard for the inline-ref-callback null-write window. Extracted
      // out of the closure so it's directly unit-testable with a nulled
      // slot — see src/components/pages/__tests__ rotation tests.
      applyMentorSpeakerClass(mentorNodeRefs.current, idx, styles.mentorNodeSpeaker);
    };
    applyActiveClass(activeIndexRef.current);
    const timer = window.setInterval(() => {
      activeIndexRef.current = (activeIndexRef.current + 1) % total;
      applyActiveClass(activeIndexRef.current);
    }, 4200);
    return () => window.clearInterval(timer);
  }, [result?.mentorReplies.length, sessionMode, isConversationHovered]);

  useEffect(() => {
    if (phase !== 'session' || sessionMode !== 'live') return;
    scrollConversationToBottom();
  }, [phase, sessionMode, visibleReplyCount, noteReplies, conversationTurns, showGroupSolve, showSessionWrap]);

  // SR-4: focus the risk banner on first appearance so screen-reader
  // users land on the safety message immediately. Uses a stable string
  // signature (level + text) to detect transitions rather than re-focus
  // every render.
  useEffect(() => {
    if (!result) return;
    const sig = `${result.safety.riskLevel}|${result.safety.emergencyMessage ?? ''}`;
    if (result.safety.riskLevel === 'high' && sig !== lastRiskSignatureRef.current) {
      lastRiskSignatureRef.current = sig;
      // Rely on the ref having been attached by React before the effect runs.
      riskBannerRef.current?.focus();
    } else if (result.safety.riskLevel !== 'high') {
      lastRiskSignatureRef.current = '';
    }
  }, [result]);

  // Note: an earlier defensive effect cleaned up `expandedReplyId` when the
  // expanded reply was no longer in the visible set. Every path that clears
  // `result` or `visibleReplyCount` also explicitly clears `expandedReplyId`
  // in the same batch (handleGenerate, restart, newTable, phase pills, edit,
  // chatBackBtn), so the cleanup branch was unreachable and was removed.

  const findImage = (rawName: string): string => {
    const resolvedName = resolveMentorName(rawName);
    const key = normalizeMentorKey(rawName);
    const match = selectedPeople.find(
      (p) =>
        normalizeMentorKey(p.name) === key ||
        normalizeMentorKey(p.name) === normalizeMentorKey(resolvedName) ||
        normalizeMentorKey(localizeName(p.name)) === key ||
        normalizeMentorKey(localizeName(p.name)) === normalizeMentorKey(resolvedName)
    );
    return imageSrcFor(resolvedName, match?.imageUrl, match?.candidateImageUrls);
  };

  const addPerson = async (person: PersonOption | string) => {
    const rawName = typeof person === 'string' ? person : person.name;
    const trimmed = rawName.trim();
    if (!trimmed) return;

    // ARCH-3: coalesce rapid double-clicks while a hydration for the
    // same key is still in-flight, so the second invocation doesn't
    // cancel the first one via a hydration-seq bump. We record the
    // start time and only bail if < 200ms has elapsed AND the prior
    // call hasn't yet recorded a completion timestamp (negative).
    const coalesceKey = trimmed.toLowerCase();
    const now = Date.now();
    const lastStart = addPersonTimestampRef.current.get(coalesceKey) ?? 0;
    if (lastStart > 0 && now - lastStart < 200) {
      // Still clear the search input so a keyboard user who hammered
      // Enter twice doesn't end up stuck with their query mid-air.
      setPersonQuery('');
      return;
    }
    addPersonTimestampRef.current.set(coalesceKey, now);

    // ── Resolve raw text to canonical name + image ──
    // R2-FIX: Autocomplete was silently overwriting typed input on Enter
    // (e.g. "Bob" → "海绵宝宝"). Only promote to a verified canonical name
    // if the typed text is an exact (case-insensitive) match for one of
    // the canonical forms or known aliases. Otherwise honor the user's
    // raw input and treat it as a custom mentor.
    let name = typeof person === 'string' ? trimmed : person.name;
    let initialImage = typeof person === 'string' ? undefined : person.imageUrl;
    let initialCandidates = typeof person === 'string' ? undefined : person.candidateImageUrls;

    if (typeof person === 'string') {
      try {
        const verified = findVerifiedPerson(trimmed);
        if (verified) {
          // R2-FIX: only accept the canonical swap when the typed text
          // matches the canonical name exactly (case-insensitive). For
          // fuzzy/alias hits (e.g. "Bob" → "海绵宝宝"), keep the user's
          // typed text so we never silently replace their input.
          if (trimmed.toLowerCase() === verified.canonical.toLowerCase()) {
            name = verified.canonical;
            initialImage = verified.imageUrl;
            initialCandidates = verified.candidateImageUrls;
          }
        }
      } catch { /* findVerifiedPerson may not be available due to module cache */ }
    }

    setSelectedPeople((prev) => {
      if (prev.some((p) => p.name.toLowerCase() === name.toLowerCase())) return prev;
      if (prev.length >= MAX_PEOPLE) return prev;
      return [...prev, { name, imageUrl: initialImage, candidateImageUrls: initialCandidates }];
    });

    // Bug #20: bump the hydration sequence so any in-flight fetches from a
    // previous add/remove cycle will be ignored once they resolve.
    const hydrationKey = name.toLowerCase();
    const hydrationSeq = (personHydrationSeqRef.current.get(hydrationKey) || 0) + 1;
    personHydrationSeqRef.current.set(hydrationKey, hydrationSeq);

    // Bug #21: clear stale image-progress for this key so the re-added
    // person starts at chain index 0 again.
    clearImageProgressForKey(name.trim().toLowerCase().replace(/\s+/g, ' '));

    setLastSummonedName(name);
    // LEAK-2: tracked timer so it's cleaned up if the component unmounts.
    scheduleTimeout(() => setLastSummonedName(''), 1800);
    setPersonQuery('');

    const shouldHydrateProfile = !initialImage || !initialCandidates?.length || isLikelyFallbackAvatar(initialImage);
    if (shouldHydrateProfile) {
      try {
        const [fetchedImage, fetchedCandidates] = await Promise.all([fetchPersonImage(name), fetchPersonImageCandidates(name)]);
        // LEAK-1: bail out if the component unmounted while we were awaiting.
        if (!isMountedRef.current) return;
        // Bug #20: only apply if our hydration sequence is still the latest
        // for this person. A newer addPerson or removePerson call would have
        // bumped the seq. `.get()!` is safe — we set it unconditionally two
        // lines above, and either set or removePerson's bump keeps it defined.
        const latestSeq = personHydrationSeqRef.current.get(hydrationKey)!;
        if (latestSeq !== hydrationSeq) return;
        if (fetchedImage || fetchedCandidates) {
          setSelectedPeople((prev) =>
            prev.map((p) =>
              p.name.toLowerCase() === name.toLowerCase()
                ? { ...p, imageUrl: fetchedImage || p.imageUrl, candidateImageUrls: fetchedCandidates || p.candidateImageUrls }
                : p
            )
          );
        }
      } catch { /* remote image fetch failed — keep initial/fallback */ }
    }
    // Mark this key as "hydration complete" so a legitimate re-add
    // (e.g. after a remove) isn't blocked by the 200ms coalesce window.
    addPersonTimestampRef.current.set(coalesceKey, -1);
  };

  const removePerson = (name: string) => {
    setSelectedPeople((prev) => prev.filter((p) => p.name !== name));
    // Bug #21: clear per-person image attempt/retry counters so that when
    // the user re-adds the same person, image loading restarts from chain
    // index 0 instead of the previously advanced state.
    clearImageProgressForKey(name.trim().toLowerCase().replace(/\s+/g, ' '));
    // Bug #20: invalidate any in-flight hydration for this person. The key
    // is always set — removePerson is only reachable via the X button on a
    // guest card, which only renders for persons already added via addPerson
    // (which sets the ref unconditionally before awaiting). `.get()!` is safe.
    const hydrationKey = name.toLowerCase();
    const current = personHydrationSeqRef.current.get(hydrationKey)!;
    personHydrationSeqRef.current.set(hydrationKey, current + 1);
  };

  const shuffleSeating = () => {
    setSelectedPeople((prev) => {
      const next = [...prev];
      for (let i = next.length - 1; i > 0; i -= 1) {
        const j = Math.floor(Math.random() * (i + 1));
        [next[i], next[j]] = [next[j], next[i]];
      }
      return next;
    });
  };

  const finishOnboarding = () => {
    setShowOnboarding(false);
    // R3/F48: always persist ONBOARDING_KEY='1' on dismiss UNLESS the user
    // explicitly toggled "keep showing" on slide 3 (`dontShowOnboardingAgain`
    // is initialized from the stored key — so `false` means either
    // never-set or the user actively asked to keep seeing the tour).
    // A Skip-tapper never reaches slide 3, so default-persist dismissal.
    // The explicit "keep showing" case is when the user is on slide 3 AND
    // toggled it off — we honor that by writing '0'. Dead
    // 'onboardingDismissed' write removed (no reader).
    const persistValue =
      currentSlide === localizedOnboardingSlides.length - 1 && !dontShowOnboardingAgain
        ? '0'
        : '1';
    try {
      localStorage.setItem(ONBOARDING_KEY, persistValue);
    } catch { /* Safari Private — state only persists for this session */ }
  };

  const seatPoint = (index: number, total: number) => {
    if (total <= 1) return { x: 50, y: 34 };
    const angleStart = 200;
    const angleEnd = 340;
    const angle = angleStart + ((angleEnd - angleStart) * index) / Math.max(total - 1, 1);
    const rad = (angle * Math.PI) / 180;
    const rX = total > 6 ? 42 : 38;
    const rY = total > 6 ? 13 : 11;
    const x = 50 + rX * Math.cos(rad);
    const y = 48 + rY * Math.sin(rad);
    return { x, y };
  };

  const seatStyle = (index: number, total: number) => {
    const { x, y } = seatPoint(index, total);
    return { left: `${x}%`, top: `${y}%` };
  };

  const clampNumber = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));

  // ALGO-2: precompute a normalized-name → reply map so per-mentor
  // lookups during render go from O(n) scan to O(1). Rebuilt only when
  // the replies array identity changes.
  const replyByNormalizedName = useMemo(() => {
    const map = new Map<string, NonNullable<typeof result>['mentorReplies'][number]>();
    if (!result?.mentorReplies) return map;
    for (const reply of result.mentorReplies) {
      map.set(reply.mentorName.trim().toLowerCase().replace(/\s+/g, '_'), reply);
    }
    return map;
    // normalizeMentorKey is a pure inline function so we inline its body
    // here to avoid making the dep array depend on its identity.
  }, [result?.mentorReplies]);

  const getReplyByMentorName = useCallback(
    (name: string) => replyByNormalizedName.get(name.trim().toLowerCase().replace(/\s+/g, '_')),
    [replyByNormalizedName]
  );

  const floatingCardPlacement = (mentorIndex: number, totalMentors: number): React.CSSProperties => {
    const safeTotal = Math.max(totalMentors, 1);
    const safeIndex = Math.min(Math.max(mentorIndex, 0), safeTotal - 1);
    const lanePoints = Array.from({ length: safeTotal }, (_, idx) => seatPoint(idx, safeTotal));
    // lanePoints has exactly safeTotal entries and safeIndex is clamped to
    // [0, safeTotal-1], so lanePoints[safeIndex] is always defined. The
    // previous `|| { x: 50, y: 34 }` fallback was dead and was removed.
    const lane = lanePoints[safeIndex];
    const prevLane = safeIndex > 0 ? lanePoints[safeIndex - 1] : null;
    const nextLane = safeIndex < safeTotal - 1 ? lanePoints[safeIndex + 1] : null;
    const leftGap = prevLane ? Math.abs(lane.x - prevLane.x) : Number.POSITIVE_INFINITY;
    const rightGap = nextLane ? Math.abs(nextLane.x - lane.x) : Number.POSITIVE_INFINITY;
    const nearestGap = Math.min(leftGap, rightGap);
    const widthPercent = Number.isFinite(nearestGap) ? clampNumber(nearestGap * 0.82, 8.5, 22) : 22;
    const widthCapPx = safeTotal <= 2 ? 250 : safeTotal <= 4 ? 210 : safeTotal <= 6 ? 170 : safeTotal <= 8 ? 150 : 130;
    const safeInset = widthPercent / 2 + 1.25;
    const left = clampNumber(lane.x, safeInset, 100 - safeInset);
    // Keep notes above the mentor name plate zone.
    const top = clampNumber(lane.y - 26.5, 10, 16.5);

    return {
      ['--mentor-card-left' as string]: `${left}%`,
      ['--mentor-card-top' as string]: `${top}%`,
      ['--mentor-card-rotate' as string]: '0deg',
      ['--mentor-card-width' as string]: `${widthPercent}%`,
      ['--mentor-card-max' as string]: `${widthCapPx}px`
    };
  };

  // RERENDER-5: activeReply/activeReplyName removed — the speaker class
  // is now toggled imperatively inside the rotation effect and does not
  // need to flow through the render loop.
  const visibleReplies = (result?.mentorReplies || []).slice(0, visibleReplyCount);
  const pendingMentorReplies = (result?.mentorReplies || []).slice(visibleReplyCount);

  const sessionComplete = Boolean(
    result?.mentorReplies?.length && visibleReplyCount >= result.mentorReplies.length && sessionMode === 'live'
  );
  const expandedReply = visibleReplies.find((reply) => reply.mentorId === expandedReplyId) || null;

   
  // reads only `selectedPeople` (already a dep); localizeName is memoized and
  // firing on its identity change would be spurious. Deps intentionally minimal.
  const groupSolveText = useMemo(() => {
    if (!result?.mentorReplies?.length) return '';
    // Bug #41: i18n-safe separator. Bug #40 (indicator for extras): include
    // all replies instead of silently dropping mentors 5..N. Chinese users
    // get a fullwidth separator, English users a regular ASCII separator.
    const separator = isZh ? ' ｜ ' : ' | ';
    const lines = result.mentorReplies.map((reply) => {
      const name = localizeName(resolveMentorName(reply.mentorName));
      return `${name}: ${reply.oneActionStep}`;
    });
    return lines.join(separator);
  // resolveMentorName reads only `selectedPeople` (already a dep); localizeName
  // is memoized via useCallback. Adding them would re-fire spuriously.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [result?.mentorReplies, selectedPeople, isZh]);

  const openDebugMentor = selectedMentors.find((mentor) => mentor.id === openDebugMentorId) || null;
  const openDebugMentorDisplayName = openDebugMentor ? localizeName(openDebugMentor.displayName) : '';
  const openDebugPromptText = openDebugMentor ? debugPromptByMentorId[openDebugMentor.id] || '' : '';
  const openDebugPromptLoading = openDebugMentor ? Boolean(debugPromptLoadingByMentorId[openDebugMentor.id]) : false;
  const openDebugPromptError = openDebugMentor ? debugPromptErrorByMentorId[openDebugMentor.id] || '' : '';

  useEffect(() => {
    if (!openDebugMentorId && !hoveredDebugMentorId) return;
    const validMentorIds = new Set<string>(selectedMentors.map((mentor) => mentor.id));
    if (openDebugMentorId && !validMentorIds.has(openDebugMentorId)) {
      setOpenDebugMentorId('');
    }
    if (hoveredDebugMentorId && !validMentorIds.has(hoveredDebugMentorId)) {
      setHoveredDebugMentorId('');
    }
  }, [openDebugMentorId, hoveredDebugMentorId, selectedMentors]);

  // EFFECT-1: use refs for the "already-loaded / already-loading"
  // snapshots so the effect doesn't need to re-run every time we flip
  // those maps. Previously omitting them from deps left the effect with
  // a stale closure; including them caused extra re-runs.
  const debugPromptByMentorIdRef = useRef(debugPromptByMentorId);
  const debugPromptLoadingByMentorIdRef = useRef(debugPromptLoadingByMentorId);
  debugPromptByMentorIdRef.current = debugPromptByMentorId;
  debugPromptLoadingByMentorIdRef.current = debugPromptLoadingByMentorId;

  useEffect(() => {
    if (!openDebugMentorId) return;
    const mentor = selectedMentors.find((item) => item.id === openDebugMentorId);
    if (!mentor) return;
    // EFFECT-1: read the latest snapshots off the refs instead of the
    // captured closure, so the effect avoids stale reads without needing
    // both maps in its deps (which would cause extra re-runs).
    if (debugPromptByMentorIdRef.current[mentor.id]) return;
    if (debugPromptLoadingByMentorIdRef.current[mentor.id]) return;

    let cancelled = false;
    setDebugPromptLoadingByMentorId((prev) => ({ ...prev, [mentor.id]: true }));
    setDebugPromptErrorByMentorId((prev) => ({ ...prev, [mentor.id]: '' }));

    fetchMentorDebugPrompt({
      mentor,
      language: uiLanguage
    })
      .then((prompt) => {
        if (cancelled) return;
        setDebugPromptByMentorId((prev) => ({ ...prev, [mentor.id]: prompt }));
      })
      .catch((error) => {
        if (cancelled) return;
        const message = error instanceof Error ? error.message : String(error);
        setDebugPromptErrorByMentorId((prev) => ({ ...prev, [mentor.id]: message }));
      })
      .finally(() => {
        if (cancelled) return;
        setDebugPromptLoadingByMentorId((prev) => ({ ...prev, [mentor.id]: false }));
      });

    return () => {
      cancelled = true;
    };
  }, [openDebugMentorId, selectedMentors, uiLanguage]);

  const saveTakeawayMemory = () => {
    // Save button only renders under `sessionComplete && showSessionWrap`,
    // which requires result.mentorReplies.length > 0.
    // Bug #40: save all mentor takeaways instead of silently capping at 3.
    // USER-1: aggregate takeaways from both the initial mentorReplies
    // AND any follow-up conversationTurns. Previously only round-1 data
    // was saved, so follow-up advice was silently lost on save.
    const takeaways: string[] = [];
    for (const reply of result!.mentorReplies) {
      if (reply.oneActionStep) takeaways.push(reply.oneActionStep);
    }
    for (const turn of conversationTurns) {
      if (turn.user) takeaways.push(`${t.you}: ${turn.user}`);
      for (const reply of turn.replies) {
        if (reply.text) takeaways.push(`${localizeName(reply.mentorName)}: ${reply.text}`);
      }
    }
    const memory: MemoryCard = {
      // Bug #22: collision-safe id via uniqueId.
      id: uniqueId('memory'),
      title: isZh ? '今晚总结' : 'Tonight\'s takeaway',
      createdAt: new Date().toLocaleString(),
      takeaways
    };
    setMemories((prev) => [memory, ...prev]);
    setSaveNotice(`${t.savedSuccess} ${t.savedInDrawer}`);
    // LEAK-3: tracked timer so an unmount mid-notice doesn't setState on a dead component.
    scheduleTimeout(() => setSaveNotice(''), 2600);
    setMemoryDrawerOpen(true);
  };

  const phaseTitles: Array<{ id: RitualPhase; label: string }> = [
    { id: 'invite', label: t.summonGuests },
    { id: 'wish', label: t.placeArtifact },
    { id: 'session', label: t.openCircle }
  ];

  const localizedOnboardingSlides = isZh
    ? onboardingSlides
    : [
        {
          title: 'Welcome to Mentor Table',
          body: 'Throw your question at a table of famous people, fictional characters, or personality types — each one gives you advice from their own perspective. It\'s like chatting with Einstein, Doraemon, and your favorite game character all at once.'
        },
        {
          title: 'How does it work?',
          body: '1. Search and add who you want advice from (celebrities, MBTI types, cartoon/game/movie characters — all work)\n2. Describe your problem\n3. Hit start and wait for each one to reply\n\nYou can also follow up with one person, or ask everyone at once.'
        },
        {
          title: 'Ready?',
          body: 'Save useful replies to the memory drawer (bottom-right) for later. Choose whether to show this guide next time, then jump in!'
        }
      ];

  // RERENDER-2: memoize the deck entries so we don't rebuild the full
  // SuggestionDeckEntry array on every render. Keyed on the inputs the
  // map depends on.
  const suggestionDeckEntries: SuggestionDeckEntry[] = useMemo(() => selectedMentors
    .map<SuggestionDeckEntry | null>((mentor, index) => {
      // selectedMentors mirrors selectedPeople 1:1 via useMemo, so
      // selectedPeople[index] is always defined here. The `|| mentor.displayName`
      // fallback was unreachable and was removed.
      const person = selectedPeople[index];
      const displayName = localizeName(person.name);
      const reply = getReplyByMentorName(displayName) || getReplyByMentorName(mentor.displayName);
      const visibleReply = reply ? visibleReplies.find((item) => item.mentorId === reply.mentorId) : undefined;

      if (phase !== 'session' && reply) {
        return {
          key: `suggestion-${mentor.id}-${index}`,
          mentorIndex: index,
          displayName,
          likelyResponse: reply.likelyResponse,
          oneActionStep: reply.oneActionStep,
          status: 'ready'
        };
      }

      if (phase === 'session' && sessionMode === 'live' && visibleReply) {
        return {
          key: `preview-${mentor.id}-${index}`,
          mentorIndex: index,
          displayName,
          likelyResponse: visibleReply.likelyResponse,
          oneActionStep: visibleReply.oneActionStep,
          status: 'ready',
          replyId: visibleReply.mentorId
        };
      }

      if (phase === 'session' && sessionMode === 'live' && reply && !sessionComplete) {
        return {
          key: `typing-${mentor.id}-${index}`,
          mentorIndex: index,
          displayName,
          likelyResponse: t.mentorTyping,
          oneActionStep: '',
          status: 'typing'
        };
      }

      return null;
    })
    .filter((item): item is SuggestionDeckEntry => item !== null),
    [selectedMentors, selectedPeople, phase, sessionMode, visibleReplies, sessionComplete, getReplyByMentorName, localizeName, t.mentorTyping]);

  const content = (
      // SR-1: explicit main landmark so screen-reader users can jump
      // directly to the page's primary content.
      <section role="main" aria-label={t.heroTitle} className={styles.roomPage}>
        <div className={`${styles.roomScene} ${sessionMode === 'booting' ? styles.ritualBooting : ''}`}>
          <div className={styles.backLayer} />
          <div className={styles.midLayer} />
          <div className={styles.lightSource} />
          <div className={styles.vignette} />

          <div className={styles.heroBar}>
            <h1>{t.heroTitle}</h1>
            <p>{t.heroSub}</p>
          </div>

          <div className={styles.topBar}>
            <div className={styles.phaseTrack}>
              {phaseTitles.map((p, idx) => {
                // R2-FIX: pill #3 ("Open Circle") was previously always
                // disabled unless phase==='session', making the core flow
                // unreachable through the phase track. Now it is only
                // disabled when the form prerequisites aren't met (need
                // at least one guest + a problem). Clicking it advances
                // the phase or kicks off generation.
                const canBeginSession =
                  selectedPeople.length > 0 && problem.trim().length > 0;
                const sessionPillDisabled =
                  p.id === 'session' && phase !== 'session' && !canBeginSession;
                return (
                  <button
                    type="button"
                    key={p.id}
                    disabled={sessionPillDisabled || (p.id === 'session' && isGenerating)}
                    aria-disabled={sessionPillDisabled || undefined}
                    tabIndex={sessionPillDisabled ? -1 : 0}
                    onClick={() => {
                      if (p.id === 'session') {
                        if (phase !== 'session' && canBeginSession && !isGenerating) {
                          handleGenerate();
                        }
                        return;
                      }
                      setPhase(p.id);
                      setResult(null);
                      setSessionMode('idle');
                      setExpandedReplyId('');
                      setExpandedSuggestion(null);
                      setOpenDebugMentorId('');
                      setHoveredDebugMentorId('');
                    }}
                    className={`${styles.phasePill} ${idx <= ritualStep ? styles.phasePillDone : ''}`}
                  >
                    {idx + 1}. {p.label}
                  </button>
                );
              })}
            </div>
            <div className={styles.topBarActions}>
              <div className={styles.guestCount}>{isZh ? '人物数' : 'Guests'}: {selectedPeople.length}</div>
              <button
                type="button"
                className={styles.ghostBtn}
                onClick={() => {
                  setPhase('invite');
                  setExpandedReplyId('');
                  setExpandedSuggestion(null);
                  setOpenDebugMentorId('');
                  setHoveredDebugMentorId('');
                }}
              >
                {t.edit}
              </button>
              <button type="button" className={styles.ghostBtn} onClick={shuffleSeating}><FontAwesomeIcon icon={faShuffle} /> {t.shuffle}</button>
              <button
                type="button"
                className={styles.ghostBtn}
                onClick={() => {
                  setResult(null);
                  setPhase('invite');
                  setSessionMode('idle');
                  setVisibleReplyCount(0);
                  setShowSessionWrap(false);
                  setShowGroupSolve(false);
                  setConversationTurns([]);
                  setReplyAllDraft('');
                  setExpandedReplyId('');
                  setExpandedSuggestion(null);
                  setOpenDebugMentorId('');
                  setHoveredDebugMentorId('');
                }}
              >
                <FontAwesomeIcon icon={faRotate} /> {t.restart}
              </button>
            </div>
          </div>

          <div className={styles.workspace}>
            <aside className={styles.panel}>
              {phase === 'invite' && (
                <div className={styles.block}>
                  <h2 id="mentor-invite-heading"><FontAwesomeIcon icon={faUsers} /> {t.summoningRitual}</h2>
                  <div className={styles.searchBox}>
                    <FontAwesomeIcon icon={faMagnifyingGlass} className={styles.searchIcon} />
                    <input
                      data-testid="mentor-person-input"
                      value={personQuery}
                      onChange={(e) => setPersonQuery(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') {
                          e.preventDefault();
                          addPerson(personQuery);
                        }
                      }}
                      placeholder={t.invitePlaceholder}
                      className={styles.personInput}
                      // SR-8: explicit label so SR users hear a name, not "edit".
                      // Bug-bash round 1: drop aria-labelledby (pointed at
                      // "Summoning Ritual" heading — misleading for a text
                      // input) and keep only aria-label.
                      aria-label={t.invitePlaceholder}
                      // KB-6: combobox semantics for the search → menu pair.
                      role="combobox"
                      aria-expanded={Boolean(personQuery.trim() && suggestions.length > 0)}
                      aria-controls="mentor-suggestion-menu"
                      aria-autocomplete="list"
                    />
                    <button
                      type="button"
                      data-testid="mentor-add-person"
                      className={styles.addBtn}
                      aria-label={String(tI18n('mt.addPerson'))}
                      onClick={() => addPerson(personQuery)}
                    >
                      <FontAwesomeIcon icon={faPlus} />
                    </button>
                    {personQuery.trim() && (
                      // KB-6: listbox paired with the combobox input above.
                      <div
                        id="mentor-suggestion-menu"
                        className={styles.suggestionMenu}
                        role="listbox"
                        aria-label={t.invitePlaceholder}
                      >
                        {suggestions.map((s) => {
                          const desc = isZh ? (s.descriptionZh || s.description) : s.description;
                          return (
                            <button
                              type="button"
                              key={s.name}
                              className={styles.suggestionItem}
                              onClick={() => addPerson(s)}
                              role="option"
                              aria-selected={false}
                            >
                              <img
                                src={imageSrcFor(s.name, s.imageUrl, s.candidateImageUrls)}
                                loading="lazy"
                                decoding="async"
                                // SR-5: decorative avatar — the adjacent text
                                // already names the person.
                                alt=""
                                width={40}
                                height={40}
                                className={styles.suggestionAvatar}
                                referrerPolicy="no-referrer"
                                onError={() => markImageBroken(s.name, s.imageUrl, s.candidateImageUrls)}
                              />
                              <div className={styles.suggestionText}>
                                <span className={styles.suggestionName}>{localizeName(s.name)}</span>
                                {desc && <span className={styles.suggestionDesc}>{desc}</span>}
                              </div>
                            </button>
                          );
                        })}
                        {isSearching && <div className={styles.searchingRow}>{tI18n('mt.searching')}</div>}
                        {!isSearching && suggestions.length === 0 && (
                          <div className={styles.searchingRow}>{tI18n('mt.noResults')}</div>
                        )}
                      </div>
                    )}
                  </div>

                  <div className={styles.selectedPeopleGrid}>
                    {selectedPeople.length === 0 && (
                      // U7.1: empty state — illustration + bilingual copy + CTA hint.
                      // Renders only when the user has not added any guests yet.
                      // The Add button above is the actual CTA target; this block
                      // makes the empty surface intentional rather than blank.
                      <div
                        data-testid="mentor-empty-intro"
                        className={styles.emptyIntro}
                        aria-live="polite"
                      >
                        <svg
                          aria-hidden="true"
                          width="120"
                          height="80"
                          viewBox="0 0 120 80"
                          fill="none"
                          className={styles.emptyIntroIllustration}
                        >
                          <ellipse cx="60" cy="62" rx="46" ry="6" fill="currentColor" opacity="0.18" />
                          <ellipse cx="60" cy="58" rx="46" ry="6" fill="currentColor" opacity="0.55" />
                          <circle cx="22" cy="38" r="10" fill="currentColor" opacity="0.45" />
                          <circle cx="46" cy="30" r="11" fill="currentColor" opacity="0.7" />
                          <circle cx="74" cy="30" r="11" fill="currentColor" opacity="0.85" />
                          <circle cx="98" cy="38" r="10" fill="currentColor" opacity="0.55" />
                        </svg>
                        <p className={styles.emptyIntroTitle}>
                          {t.emptyIntroTitle}
                        </p>
                        <p className={styles.emptyIntroHint}>
                          {t.emptyIntroHint}
                        </p>
                      </div>
                    )}
                    {selectedPeople.map((person, idx) => {
                      const category = getMentorCategory(person.name);
                      const flipped = Boolean(flippedCards[person.name]);
                      const summoned = lastSummonedName.toLowerCase() === person.name.toLowerCase();
                      return (
                        <div
                          key={person.name}
                          className={`${styles.guestCard} ${summoned ? styles.guestCardSummon : ''}`}
                          style={{ animationDelay: `${idx * 70}ms` }}
                        >
                          <div className={`${styles.summonRing} ${styles[`summon${category[0].toUpperCase()}${category.slice(1)}`]}`} />
                          <img
                            src={imageSrcFor(person.name, person.imageUrl, person.candidateImageUrls)}
                            loading="lazy"
                            decoding="async"
                            alt={person.name}
                            width={96}
                            height={96}
                            className={styles.guestAvatar}
                            referrerPolicy="no-referrer"
                            onError={() => markImageBroken(person.name, person.imageUrl, person.candidateImageUrls)}
                          />
                          <div className={styles.guestMeta}>
                            <strong>{localizeName(person.name)}</strong>
                            <span>
                              {flipped
                                ? `${localizedVibeTags[idx % localizedVibeTags.length]} · “${t.keepGoing}”`
                                : localizedVibeTags[idx % localizedVibeTags.length]}
                            </span>
                          </div>
                          <button
                            type="button"
                            className={styles.flipMiniBtn}
                            aria-label={isZh ? `翻转卡片 ${localizeName(person.name)}` : `Flip ${localizeName(person.name)} card`}
                            onClick={() => setFlippedCards((prev) => ({ ...prev, [person.name]: !prev[person.name] }))}
                          >
                            {t.flip}
                          </button>
                          <button
                            type="button"
                            className={styles.removeGuestBtn}
                            aria-label={isZh ? `移除 ${localizeName(person.name)}` : `Remove ${localizeName(person.name)}`}
                            onClick={() => removePerson(person.name)}
                          >
                            <FontAwesomeIcon icon={faXmark} />
                          </button>
                        </div>
                      );
                    })}
                  </div>

                  {/* ERR-1: block the continue button when no mentors picked.
                      Inline error announces it to AT users. */}
                  {/* R3/F44+F45: `disabled` silences onClick (R2/F38), so the
                      error hint is rendered unconditionally while the guest
                      list is empty — it tells the user *why* the CTA is
                      disabled. Inline opacity removed; the CSS
                      `:disabled { opacity: 0.72 }` rule (CC-5, WCAG 3:1) wins. */}
                  <button
                    type="button"
                    data-testid="mentor-continue-wish"
                    className={styles.primaryCta}
                    disabled={selectedPeople.length === 0}
                    aria-disabled={selectedPeople.length === 0}
                    aria-describedby={selectedPeople.length === 0 ? 'mentor-continue-error' : undefined}
                    onClick={() => {
                      if (selectedPeople.length === 0) return;
                      setPhase('wish');
                    }}
                  >
                    {t.continueToWish}
                  </button>
                  {selectedPeople.length === 0 && (
                    <p
                      id="mentor-continue-error"
                      role="alert"
                      style={{ color: '#9b2121', fontSize: '0.85rem', margin: '6px 0 0' }}
                    >
                      {t.needAtLeastOne}
                    </p>
                  )}
                </div>
              )}

              {phase === 'wish' && (
                <div className={styles.block}>
                  <h2 id="mentor-wish-heading"><FontAwesomeIcon icon={faBookOpen} /> {t.placeArtifact}</h2>
                  <div className={styles.artifactInput}>
                    <textarea
                      data-testid="mentor-problem-input"
                      className={styles.problemInput}
                      value={problem}
                      onChange={(e) => setProblem(e.target.value)}
                      placeholder={t.artifactPlaceholder}
                      rows={7}
                      // SR-9: heading points the label at the textarea.
                      aria-labelledby="mentor-wish-heading"
                      aria-label={t.placeArtifact}
                    />
                  </div>
                  {/* ERR-2: retry banner surfaces network failures from
                      handleGenerate instead of silently dropping to an
                      empty panel. */}
                  {generateError && (
                    <div
                      role="alert"
                      aria-live="assertive"
                      data-testid="mentor-generate-error"
                      style={{
                        background: '#fff3f3',
                        border: '1px solid #ffc1c1',
                        color: '#9b2121',
                        borderRadius: 10,
                        padding: '10px 12px',
                        marginTop: 8,
                        fontSize: '0.9rem',
                      }}
                    >
                      <div>{t.generateFailed}</div>
                      {/* F157: the raw upstream text (endpoint URL, status
                          body) used to render here. It stays in state for
                          debugging and goes to console.error, but the UI
                          shows stable localized copy only. */}
                      <div style={{ fontSize: '0.75rem', opacity: 0.7, marginTop: 4 }}>{t.generateFailedHint}</div>
                      <button
                        type="button"
                        data-testid="mentor-generate-retry"
                        onClick={() => { setGenerateError(''); handleGenerate(); }}
                        style={{
                          marginTop: 8,
                          border: '1px solid #9b2121',
                          background: '#fff',
                          color: '#9b2121',
                          borderRadius: 8,
                          padding: '6px 12px',
                          fontWeight: 700,
                          minHeight: 36,
                          cursor: 'pointer',
                        }}
                      >
                        {t.retry}
                      </button>
                    </div>
                  )}
                  <button
                    type="button"
                    data-testid="mentor-begin-session"
                    className={styles.primaryCta}
                    disabled={isGenerating || !problem.trim() || selectedMentors.length === 0}
                    onClick={handleGenerate}
                  >
                    <FontAwesomeIcon icon={faLightbulb} /> {t.beginSession}
                  </button>
                </div>
              )}

              {phase === 'session' && (
                <div className={styles.sessionSidebarStack}>
                  <div className={styles.disclaimer}>
                    <div className={styles.disclaimerLine}><FontAwesomeIcon icon={faCircleInfo} /> {t.aiDisclaimer}</div>
                    {/* ERR-3: hover explainer so users understand why the
                        source is labelled "Local Fallback" (offline / API
                        unreachable). ERR-4: visible badge surfacing the
                        pass-note silent fallback path.
                        F160/F161: meta.provider honesty — a 200 response can
                        still carry server-fallback (fully canned) or
                        partial-fallback replies; the badge surfaces both. */}
                    <div
                      className={styles.sourceTag}
                      title={
                        result?.meta.source !== 'llm'
                          ? (isZh
                              ? '后端不可用，已使用本地回退模板'
                              : 'Backend unavailable — using a local fallback template')
                          : result?.meta.provider === 'server-fallback'
                            ? t.cannedRepliesTitle
                            : result?.meta.provider === 'partial-fallback'
                              ? t.partialFallbackTitle
                              : (isZh ? '由 LLM 接口实时生成' : 'Generated live by the LLM API')
                      }
                    >
                      {t.source}: {
                        result?.meta.source !== 'llm'
                          ? t.localFallback
                          : result?.meta.provider === 'server-fallback'
                            ? t.cannedReplies
                            : result?.meta.provider === 'partial-fallback'
                              ? t.partialFallback
                              : t.llmApi
                      }
                      {result?.meta.source !== 'llm' && (
                        <span style={{ marginLeft: 6, fontWeight: 700, color: '#9b6600' }}>
                          {isZh ? '(离线)' : '(offline)'}
                        </span>
                      )}
                      {result?.meta.source === 'llm' && result?.meta.provider === 'server-fallback' && (
                        <span style={{ marginLeft: 6, fontWeight: 700, color: '#9b6600' }}>
                          {isZh ? '(未走 LLM)' : '(no LLM)'}
                        </span>
                      )}
                      {result?.meta.source === 'llm' && result?.meta.provider === 'partial-fallback' && (
                        <span style={{ marginLeft: 6, fontWeight: 700, color: '#9b6600' }}>
                          {isZh ? '(部分回退)' : '(partial)'}
                        </span>
                      )}
                    </div>
                  </div>

                  <div className={styles.sessionChatHeader}>
                    <span>{t.chatWindow}</span>
                    {expandedReply && (
                      <button
                        type="button"
                        className={styles.chatBackBtn}
                        onClick={() => {
                          setExpandedReplyId('');
                          setExpandedSuggestion(null);
                        }}
                      >
                        <FontAwesomeIcon icon={faChevronLeft} /> {t.backToTable}
                      </button>
                    )}
                  </div>

                  <div
                    ref={conversationPanelRef}
                    data-testid="mentor-conversation-panel"
                    className={styles.conversationPanel}
                    // SR-2: polite live region so screen readers announce
                    // new mentor replies without interrupting.
                    aria-live="polite"
                    aria-atomic={false}
                    aria-label={t.chatWindow}
                    // MC-2: focus events mirror hover so keyboard users can
                    // pause auto-rotation the same way mouse users do.
                    onMouseEnter={() => setIsConversationHovered(true)}
                    onMouseLeave={() => setIsConversationHovered(false)}
                    onFocus={() => setIsConversationHovered(true)}
                    onBlur={() => setIsConversationHovered(false)}
                    tabIndex={0}
                  >
                    <div className={styles.conversationHint}>
                      {t.hoverPause}
                      {/* MC-3: skip the reveal timer. */}
                      {result?.mentorReplies?.length && visibleReplyCount < result.mentorReplies.length ? (
                        <>
                          {' '}
                          <button
                            type="button"
                            data-testid="mentor-reveal-all"
                            onClick={() => setVisibleReplyCount(result.mentorReplies.length)}
                            style={{
                              marginLeft: 8,
                              border: '1px solid rgba(255,255,255,0.6)',
                              background: 'rgba(255,255,255,0.12)',
                              color: '#ffffff',
                              borderRadius: 8,
                              padding: '4px 8px',
                              fontSize: '0.78rem',
                              fontWeight: 700,
                              cursor: 'pointer',
                            }}
                          >
                            {t.revealAll}
                          </button>
                        </>
                      ) : null}
                    </div>

                    {sessionMode !== 'live' && (
                      <div className={styles.conversationRowLeft}>
                        <div className={styles.turnGroup}>
                          <div className={styles.conversationRowRight}>
                            <article className={`${styles.conversationBubble} ${styles.conversationRightBubble}`}>
                              <header>{t.you}</header>
                              {/* phase==='session' is only reachable through handleGenerate, which requires problem.trim(). The `|| '...'` fallback was unreachable. */}
                              <p>{problem.trim()}</p>
                            </article>
                          </div>
                          {selectedMentors.map((mentor) => (
                            <div key={`booting-${mentor.id}`} className={styles.conversationRowLeft}>
                              <article data-testid={`mentor-typing-${mentor.id}`} className={`${styles.conversationBubble} ${styles.conversationLoading}`}>
                                <header>{localizeName(mentor.displayName)}</header>
                                <p>{t.mentorTyping}</p>
                              </article>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}

                    {sessionMode === 'live' && (
                      <>
                        <div className={styles.conversationRowRight}>
                          <article className={`${styles.conversationBubble} ${styles.conversationRightBubble}`}>
                            <header>{t.you}</header>
                            {/* problem.trim() is guaranteed non-empty during session — handleGenerate requires it. The `|| '...'` fallback was unreachable. */}
                            <p>{problem.trim()}</p>
                          </article>
                        </div>

                        {visibleReplies.map((reply) => {
                          const mentorName = localizeName(resolveMentorName(reply.mentorName));
                          const threadKey = mentorThreadKey(reply.mentorName);
                          return (
                            <div key={`${mentorName}-${reply.mentorId}`} className={styles.conversationRowLeft}>
                              <article className={`${styles.conversationBubble} ${styles.conversationLeftBubble} `}>
                                <header>{mentorName}</header>
                                <p>{reply.likelyResponse}</p>
                                <footer>{isZh ? '下一步：' : 'Next move: '} {reply.oneActionStep}</footer>
                                <button
                                  type="button"
                                  className={styles.passNoteBtn}
                                  onClick={() => setOpenNoteFor((prev) => (prev === threadKey ? '' : threadKey))}
                                >
                                  {t.passNoteTo} {mentorName}
                                </button>
                                {openNoteFor === threadKey && (
                                  <div className={styles.inlineNoteBox}>
                                    <textarea
                                      value={noteDrafts[threadKey] || ''}
                                      onChange={(e) =>
                                        setNoteDrafts((prev) => ({ ...prev, [threadKey]: e.target.value }))
                                      }
                                      placeholder={`${t.replyTo} ${mentorName}...`}
                                      rows={2}
                                    />
                                    <div className={styles.inlineNoteActions}>
                                      <button
                                        type="button"
                                        className={styles.ghostBtn}
                                        disabled={isRoundGenerating}
                                        onClick={() => submitNoteToMentor(reply.mentorName)}
                                      >
                                        {isRoundGenerating ? t.typing : t.send}
                                      </button>
                                    </div>
                                  </div>
                                )}
                              </article>
                            </div>
                          );
                        })}

                        {!sessionComplete && pendingMentorReplies.map((reply, idx) => {
                          const mentorName = localizeName(resolveMentorName(reply.mentorName));
                          return (
                            <div key={`pending-${reply.mentorId || reply.mentorName}-${idx}`} className={styles.conversationRowLeft}>
                              <article data-testid={`mentor-pending-${reply.mentorId || idx}`} className={`${styles.conversationBubble} ${styles.conversationLoading}`}>
                                <header>{mentorName}</header>
                                <p>{t.mentorTyping}</p>
                              </article>
                            </div>
                          );
                        })}

                        {isRoundGenerating && (
                          <div className={styles.turnGroup}>
                            {selectedMentors.map((mentor) => (
                              <div key={`round-loading-${mentor.id}`} className={styles.conversationRowLeft}>
                                <article data-testid={`mentor-round-typing-${mentor.id}`} className={`${styles.conversationBubble} ${styles.conversationLoading}`}>
                                  <header>{localizeName(mentor.displayName)}</header>
                                  <p>{t.mentorTyping}</p>
                                </article>
                              </div>
                            ))}
                          </div>
                        )}

                        {conversationTurns.map((turn) => (
                          <div key={turn.id} className={styles.turnGroup}>
                            <div className={styles.conversationRowRight}>
                              <article className={`${styles.conversationBubble} ${styles.conversationRightBubble}`}>
                                <header>{t.you}</header>
                                <p>{turn.user}</p>
                              </article>
                            </div>
                            {turn.replies.map((reply, idx) => (
                              <div key={`${turn.id}-${reply.mentorName}-${idx}`} className={styles.conversationRowLeft}>
                                <article className={`${styles.conversationBubble} ${styles.conversationLeftBubble} `}>
                                  <header>{localizeName(reply.mentorName)}</header>
                                  <p>{reply.text}</p>
                                </article>
                              </div>
                            ))}
                          </div>
                        ))}

                        {sessionComplete && (
                          <div className={styles.groupActions}>
                            <button
                              type="button"
                              className={styles.secondaryCta}
                              onClick={() => setShowGroupSolve((v) => !v)}
                            >
                              {showGroupSolve ? t.hideGroup : t.showGroup}
                            </button>
                          </div>
                        )}

                        {sessionComplete && showGroupSolve && (
                          <div className={styles.conversationRowLeft}>
                            <article className={`${styles.conversationBubble} ${styles.groupSolveCard}`}>
                              <header>{t.jointStrategy}</header>
                              <p>{groupSolveText}</p>
                            </article>
                          </div>
                        )}

                        {sessionComplete && !showSessionWrap && (
                          <div className={styles.conversationRowRight}>
                            <button type="button" className={styles.secondaryCta} onClick={() => setShowSessionWrap(true)}>
                              {t.showWrap}
                            </button>
                          </div>
                        )}

                        {sessionComplete && (
                          <div className={styles.conversationRowRight}>
                            <article className={`${styles.conversationBubble} ${styles.conversationRightBubble} ${styles.replyAllDockCard}`}>
                              <header>{t.replyToAllHeader}</header>
                              <textarea
                                value={replyAllDraft}
                                onChange={(e) => setReplyAllDraft(e.target.value)}
                                placeholder={t.replyAllPlaceholder}
                                rows={4}
                              />
                              <div className={styles.inlineNoteActions}>
                                <button
                                  type="button"
                                  className={styles.ghostBtn}
                                  disabled={isRoundGenerating}
                                  onClick={handleReplyAll}
                                >
                                  {isRoundGenerating ? t.typing : t.sendToAll}
                                </button>
                              </div>
                            </article>
                          </div>
                        )}
                      </>
                    )}
                  </div>

                  {sessionComplete && showSessionWrap && result && (
                    <div className={styles.sessionWrap}>
                      <h3>{t.sessionComplete}</h3>
                      <p>{t.tonightTakeaway}</p>
                      <ul>
                        {/* sessionComplete already guarantees result && result.mentorReplies.length; the || [] fallback was dead and was removed. */}
                        {/* Bug #40: show all mentor takeaways instead of dropping mentors 4..N silently. */}
                        {result.mentorReplies.map((reply) => (
                          <li key={reply.mentorName}>{reply.oneActionStep}</li>
                        ))}
                      </ul>
                      <div className={styles.wrapActions}>
                        <button type="button" data-testid="mentor-save-chat" className={styles.secondaryCta} onClick={() => saveTakeawayMemory()}>{t.save}</button>
                        <button
                          type="button"
                          className={styles.secondaryCta}
                          onClick={() => {
                            setResult(null);
                            setPhase('invite');
                            setSessionMode('idle');
                            setConversationTurns([]);
                            setReplyAllDraft('');
                            setExpandedReplyId('');
                            setExpandedSuggestion(null);
                            setOpenDebugMentorId('');
                            setHoveredDebugMentorId('');
                          }}
                        >
                          {t.newTable}
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              )}
            </aside>

            <div className={`${styles.stage} ${sessionMode === 'live' ? styles.stageLive : ''}`}>
              <div
                className={styles.tableArena}
                onClick={(e) => {
                  const target = e.currentTarget.getBoundingClientRect();
                  const x = e.clientX - target.left;
                  const y = e.clientY - target.top;
                  setTableRipple({ x, y, key: `${Date.now()}` });
                }}
              >
                {tableRipple && (
                  <span
                    key={tableRipple.key}
                    className={styles.tableRipple}
                    style={{ left: tableRipple.x, top: tableRipple.y }}
                  />
                )}

                <div className={styles.tableTop}>
                  <div className={styles.tableRunner} />
                  <div className={styles.tableInner} />
                  <button
                    type="button"
                    className={styles.candleProp}
                    aria-label={isZh ? '调整蜡烛亮度' : 'Adjust candle brightness'}
                    style={{ ['--flame-scale' as string]: `${0.8 + candleLevel * 0.26}` }}
                    onClick={(e) => {
                      e.stopPropagation();
                      setCandleLevel((v) => (v % 3) + 1);
                    }}
                  >
                    <span className={styles.candleBody} />
                    <span className={styles.candleFlame} />
                  </button>
                </div>

                <div className={styles.tableLegs}>
                  <div className={`${styles.leg} ${styles.leg1}`} />
                  <div className={`${styles.leg} ${styles.leg2}`} />
                  <div className={`${styles.leg} ${styles.leg3}`} />
                  <div className={`${styles.leg} ${styles.leg4}`} />
                </div>

                <div className={styles.userSeat}>
                  <div className={styles.userAvatar}><FontAwesomeIcon icon={faUser} /></div>
                  <div className={styles.userLabel}>{t.youFrontRow}</div>
                  <p className={styles.userPrompt}>{problem.trim() || t.concernHint}</p>
                </div>

                {selectedMentors.map((mentor: MentorProfile, index: number) => {
                  // selectedPeople[index] is always defined: selectedMentors
                  // is derived 1:1 from selectedPeople. `|| mentor.displayName`
                  // fallback was unreachable and was removed.
                  const person = selectedPeople[index];
                  const displayName = localizeName(person.name);
                  const mentorReply = getReplyByMentorName(displayName) || getReplyByMentorName(mentor.displayName);
                  const mentorWaitingForReply = Boolean(
                    phase === 'session' &&
                    sessionMode === 'live' &&
                    !sessionComplete &&
                    mentorReply &&
                    !visibleReplies.some((reply) => reply.mentorId === mentorReply.mentorId)
                  );
                  // RERENDER-5: speaker highlight is toggled imperatively
                  // by the rotation effect; the render loop no longer wires
                  // up an isSpeaker boolean at all.
                  const flipped = Boolean(flippedCards[displayName]);
                  const marker = '✎';
                  const categoryClass = styles[`entrance${getMentorCategory(displayName)[0].toUpperCase()}${getMentorCategory(displayName).slice(1)}`];

                  return (
                    <div
                      key={`${displayName}-${mentor.id}`}
                      ref={(el) => { mentorNodeRefs.current[index] = el; }}
                      className={`${styles.mentorNode} ${categoryClass}`}
                      style={seatStyle(index, selectedMentors.length)}
                    >
                      {mentorWaitingForReply && (
                        <div className={styles.mentorTypingBadge}>{t.mentorTyping}</div>
                      )}
                      <button
                        type="button"
                        className={styles.namePlate}
                        onClick={() => setFlippedCards((prev) => ({ ...prev, [displayName]: !prev[displayName] }))}
                      >
                        {flipped ? `${displayName} · ${localizedVibeTags[index % localizedVibeTags.length]}` : displayName}
                      </button>
                      <div
                        className={styles.mentorAvatarWrap}
                        // KB-5: mirror hover state on focus so keyboard users
                        // can also reveal the debug icon.
                        onMouseEnter={() => setHoveredDebugMentorId(mentor.id)}
                        onMouseLeave={() => setHoveredDebugMentorId((prev) => (prev === mentor.id ? '' : prev))}
                        onFocus={() => setHoveredDebugMentorId(mentor.id)}
                        onBlur={() => setHoveredDebugMentorId((prev) => (prev === mentor.id ? '' : prev))}
                      >
                        {/* SR-6: mentor avatar was wrapped in a <button>
                            with no onClick, which announced a useless
                            button to SR users. Replaced with a plain div. */}
                        <div className={styles.mentorAvatar}>
                          <img
                            src={findImage(displayName)}
                            alt={displayName}
                            loading="lazy"
                            decoding="async"
                            width={64}
                            height={64}
                            referrerPolicy="no-referrer"
                            onError={() => markImageBroken(resolveMentorName(displayName), selectedPeople[index]?.imageUrl, selectedPeople[index]?.candidateImageUrls)}
                          />
                        </div>
                        {(hoveredDebugMentorId === mentor.id || openDebugMentorId === mentor.id) && (
                          <button
                            type="button"
                            className={styles.debugIconBtn}
                            title={t.inspectPrompt}
                            aria-label={t.inspectPrompt}
                            onClick={(e) => {
                              e.stopPropagation();
                              setOpenDebugMentorId((prev) => (prev === mentor.id ? '' : mentor.id));
                            }}
                          >
                            <FontAwesomeIcon icon={faBug} />
                          </button>
                        )}
                      </div>
                      <div className={styles.seatProp}>{marker}</div>
                    </div>
                  );
                })}

                <SuggestionDeck
                  entries={suggestionDeckEntries}
                  totalMentorSlots={Math.max(selectedMentors.length, 1)}
                  lang={isZh ? 'zh' : 'en'}
                  expandedReplyId={expandedReplyId}
                  placementFor={floatingCardPlacement}
                  onSelectSuggestion={(card) => {
                    setExpandedReplyId('');
                    setExpandedSuggestion(card);
                  }}
                  onSelectReply={(replyId) => {
                    setExpandedSuggestion(null);
                    setExpandedReplyId(replyId);
                  }}
                  labels={{ mentorTyping: t.mentorTyping, clickToExpand: t.clickToExpand }}
                />

                {expandedSuggestion && (
                  <ExpandedSuggestionOverlay
                    card={expandedSuggestion}
                    trapRef={expandedSuggestionTrapRef}
                    onClose={() => setExpandedSuggestion(null)}
                    labels={{ backToTable: t.backToTable, nextMove: '' }}
                    lang={isZh ? 'zh' : 'en'}
                  />
                )}

                {phase === 'session' && sessionMode === 'live' && expandedReply && (
                  <ReplyThreadOverlay
                    reply={expandedReply}
                    trapRef={expandedReplyTrapRef}
                    onClose={() => {
                      setExpandedReplyId('');
                      setExpandedSuggestion(null);
                    }}
                    displayName={localizeName(resolveMentorName(expandedReply.mentorName))}
                    threadKey={mentorThreadKey(expandedReply.mentorName)}
                    notes={noteReplies[mentorThreadKey(expandedReply.mentorName)] || []}
                    noteDraft={noteDrafts[mentorThreadKey(expandedReply.mentorName)] || ''}
                    onNoteDraftChange={(text) =>
                      setNoteDrafts((prev) => ({ ...prev, [mentorThreadKey(expandedReply.mentorName)]: text }))
                    }
                    noteOpen={openNoteFor === mentorThreadKey(expandedReply.mentorName)}
                    onToggleNoteOpen={() =>
                      setOpenNoteFor((prev) => (prev === mentorThreadKey(expandedReply.mentorName) ? '' : mentorThreadKey(expandedReply.mentorName)))
                    }
                    onSubmitNote={() => submitNoteToMentor(expandedReply.mentorName)}
                    isRoundGenerating={isRoundGenerating}
                    labels={{
                      backToTable: t.backToTable,
                      passNoteTo: t.passNoteTo,
                      replyTo: t.replyTo,
                      typing: t.typing,
                      send: t.send,
                      you: t.you,
                    }}
                    lang={isZh ? 'zh' : 'en'}
                  />
                )}

                {openDebugMentor && (
                  <DebugPromptPanel
                    mentorDisplayName={openDebugMentorDisplayName}
                    loading={openDebugPromptLoading}
                    promptText={openDebugPromptText}
                    error={openDebugPromptError}
                    onClose={() => setOpenDebugMentorId('')}
                    labels={{
                      title: t.debugPrompt,
                      loading: t.loading,
                      loadFailed: t.debugLoadFailed,
                      close: t.closeDebug,
                    }}
                  />
                )}
              </div>

              {phase === 'session' && (
                <div className={styles.sessionLayer}>
                  {sessionMode === 'booting' && (
                    <div className={styles.bootSequence}>
                      <div className={styles.sessionBell}><FontAwesomeIcon icon={faBell} /></div>
                      <div className={styles.bootLine}>{t.tableListening}</div>
                      <div className={styles.bootSteps}>
                        <span>{t.clothPattern}</span>
                        <span>{t.ambientOn}</span>
                        <span>{t.cardsGlow}</span>
                      </div>
                    </div>
                  )}

                  {sessionMode === 'live' && (
                    <div className={styles.stageLiveHint}>{t.tableListening}</div>
                  )}
                </div>
              )}

              {result?.safety.riskLevel === 'high' && (
                // SR-4: safety-critical — assertive alert so screen readers
                // interrupt whatever else they were reading. tabIndex + ref
                // so focus can be moved programmatically on first appearance.
                <div
                  ref={riskBannerRef}
                  className={styles.riskBanner}
                  role="alert"
                  aria-live="assertive"
                  tabIndex={-1}
                  data-testid="mentor-risk-banner"
                >
                  <FontAwesomeIcon icon={faTriangleExclamation} />
                  <span>{result.safety.emergencyMessage}</span>
                </div>
              )}
            </div>
          </div>
        </div>

        <MemoryDrawer
          open={memoryDrawerOpen}
          onToggle={() => setMemoryDrawerOpen((v) => !v)}
          memories={memories}
          saveNotice={saveNotice}
          labels={{
            memories: t.memories,
            drawerTitle: t.memoryDrawer,
            drawerHint: t.savedInDrawer,
            empty: t.noMemories,
          }}
        />

        {showOnboarding && (
          <OnboardingModal
            slides={localizedOnboardingSlides}
            currentSlide={currentSlide}
            onSlideChange={setCurrentSlide}
            dontShowAgain={dontShowOnboardingAgain}
            onDontShowAgainChange={setDontShowOnboardingAgain}
            onFinish={finishOnboarding}
            trapRef={onboardingTrapRef}
            labels={{
              skip: t.skipOnboarding,
              back: t.back,
              next: t.next,
              getStarted: t.getStarted,
              dontShowAgain: t.dontShowAgain,
              keepShowing: t.keepShowing,
            }}
          />
        )}
      </section>
  );

  // Layout wrapper was removed (Aurora/OGL deleted — dead code in the
  // `standalone` render path). Both branches now render the same content;
  // the `standalone` prop is kept for API compatibility with callers/tests
  // but no longer changes behavior.
  void standalone;
  return content;
};

export default MentorTablePage;
