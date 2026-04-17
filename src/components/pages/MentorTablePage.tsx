import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
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
import { MentorProfile, createCustomMentorProfile, getCartoonAvatarUrl, getSuggestedPeople } from '../../features/mentorTable/mentorProfiles';
import { MentorSimulationResult } from '../../features/mentorTable/mentorEngine';
import { fetchMentorDebugPrompt, generateMentorAdvice, MentorConversationMessage } from '../../features/mentorTable/mentorApi';
import {
  PersonOption,
  fetchPersonImage,
  fetchPersonImageCandidates,
  findVerifiedPerson,
  getChineseDisplayName,
  getVerifiedPlaceholderImage,
  searchPeopleWithPhotos,
  searchVerifiedPeopleLocal
} from '../../features/mentorTable/personLookup';
import { applyMentorSpeakerClass } from './applyMentorSpeakerClass';
import styles from './MentorTablePage.module.css';

type RitualPhase = 'invite' | 'wish' | 'session';
type SessionMode = 'idle' | 'booting' | 'live';

interface MemoryCard {
  id: string;
  title: string;
  createdAt: string;
  takeaways: string[];
}

interface ConversationTurn {
  id: string;
  user: string;
  replies: Array<{ mentorName: string; text: string }>;
}

interface ExpandedSuggestionCard {
  mentorName: string;
  likelyResponse: string;
  oneActionStep: string;
}

interface SuggestionDeckEntry {
  key: string;
  mentorIndex: number;
  displayName: string;
  likelyResponse: string;
  oneActionStep: string;
  status?: 'ready' | 'typing';
  replyId?: string;
}

const MAX_PEOPLE = 10;
// Cap for conversation history forwarded to the mentor API on each round
// (bug #44). Prevents unbounded token growth across many reply rounds.
const MAX_CONVERSATION_TURNS_IN_HISTORY = 12;
const COORDINATE_PASS_NOTE_WITH_ALL = (import.meta.env.VITE_MENTOR_NOTE_COORDINATE_ALL ?? '1') !== '0';
const ONBOARDING_KEY = 'mentorTableOnboardingHiddenV2';
const DEFAULT_PLACEHOLDER_AVATAR = getVerifiedPlaceholderImage();

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
// React 18 StrictMode double-invokes or when auto-reply fires on the same
// tick as a user click. Use crypto.randomUUID when available, with a
// Date.now + random fallback for older browsers/test environments.
// globalThis is always defined in ES2020+ / Node 12+ (our Vite target is
// es2015 but node+modern browsers always have it), so no existence check.
let __uniqueIdCounter = 0;
function uniqueId(prefix = 'id'): string {
  const cryptoObj = ((globalThis as unknown) as { crypto?: { randomUUID?: () => string } }).crypto;
  if (cryptoObj?.randomUUID) return `${prefix}-${cryptoObj.randomUUID()}`;
  __uniqueIdCounter += 1;
  return `${prefix}-${Date.now()}-${__uniqueIdCounter}-${Math.random().toString(36).slice(2, 10)}`;
}

function getMentorCategory(name: string): 'tech' | 'sports' | 'artist' | 'leader' {
  const normalized = name.toLowerCase();
  if (normalized.includes('kobe')) return 'sports';
  if (normalized.includes('miyazaki') || normalized.includes('taylor') || normalized.includes('swift')) return 'artist';
  if (normalized.includes('bill') || normalized.includes('elon') || normalized.includes('jobs') || normalized.includes('lisa su') || normalized.includes('satya') || normalized.includes('nadella')) return 'tech';
  return 'leader';
}

const MentorTablePage: React.FC<{ standalone?: boolean }> = ({ standalone = false }) => {
  const navigate = useNavigate();
  const { i18n } = useTranslation();
  const isZh = i18n.language?.toLowerCase().startsWith('zh');
  // Apply stored theme (primary color + light/dark mode) on mount
  useTheme();
  const [phase, setPhase] = useState<RitualPhase>('invite');
  const [sessionMode, setSessionMode] = useState<SessionMode>('idle');
  const [problem, setProblem] = useState('');
  const [personQuery, setPersonQuery] = useState('');
  const [selectedPeople, setSelectedPeople] = useState<PersonOption[]>([]);
  const [isGenerating, setIsGenerating] = useState(false);
  const [isSearching, setIsSearching] = useState(false);
  const [suggestions, setSuggestions] = useState<PersonOption[]>([]);
  const [result, setResult] = useState<MentorSimulationResult | null>(null);
  // RERENDER-5: activeResultIndex lives in a ref below — removed from state.
  // This component only runs client-side (the app has no SSR), so `window`
  // and `localStorage` are always available.
  const [showOnboarding, setShowOnboarding] = useState<boolean>(
    () => localStorage.getItem(ONBOARDING_KEY) !== '1'
  );
  const [dontShowOnboardingAgain, setDontShowOnboardingAgain] = useState<boolean>(
    () => localStorage.getItem(ONBOARDING_KEY) === '1'
  );
  const [currentSlide, setCurrentSlide] = useState(0);
  const [flippedCards, setFlippedCards] = useState<Record<string, boolean>>({});
  const [lastSummonedName, setLastSummonedName] = useState<string>('');
  const [candleLevel, setCandleLevel] = useState(1);
  const [tableRipple, setTableRipple] = useState<{ x: number; y: number; key: string } | null>(null);
  const [openNoteFor, setOpenNoteFor] = useState<string>('');
  const [noteDrafts, setNoteDrafts] = useState<Record<string, string>>({});
  const [noteReplies, setNoteReplies] = useState<Record<string, Array<{ role: 'user' | 'mentor'; text: string }>>>({});
  const [memoryDrawerOpen, setMemoryDrawerOpen] = useState(false);
  const [memories, setMemories] = useState<MemoryCard[]>([]);
  const [visibleReplyCount, setVisibleReplyCount] = useState(0);
  const [isConversationHovered, setIsConversationHovered] = useState(false);
  const [showSessionWrap, setShowSessionWrap] = useState(false);
  const [showGroupSolve, setShowGroupSolve] = useState(false);
  const [replyAllDraft, setReplyAllDraft] = useState('');
  const [conversationTurns, setConversationTurns] = useState<ConversationTurn[]>([]);
  const [imageAttemptByKey, setImageAttemptByKey] = useState<Record<string, number>>({});
  const [imageRetryByKey, setImageRetryByKey] = useState<Record<string, number>>({});
  const [expandedReplyId, setExpandedReplyId] = useState('');
  const [expandedSuggestion, setExpandedSuggestion] = useState<ExpandedSuggestionCard | null>(null);
  const [isRoundGenerating, setIsRoundGenerating] = useState(false);
  const [hoveredDebugMentorId, setHoveredDebugMentorId] = useState('');
  const [openDebugMentorId, setOpenDebugMentorId] = useState('');
  const [debugPromptByMentorId, setDebugPromptByMentorId] = useState<Record<string, string>>({});
  const [debugPromptLoadingByMentorId, setDebugPromptLoadingByMentorId] = useState<Record<string, boolean>>({});
  const [debugPromptErrorByMentorId, setDebugPromptErrorByMentorId] = useState<Record<string, string>>({});
  const [saveNotice, setSaveNotice] = useState('');
  // ERR-2: surface a retry-able error banner when handleGenerate throws
  // (e.g. network failure) instead of silently dropping to an empty panel.
  const [generateError, setGenerateError] = useState('');
  const conversationPanelRef = useRef<HTMLDivElement | null>(null);
  // SR-4: focus the safety risk banner when it first appears.
  const riskBannerRef = useRef<HTMLDivElement | null>(null);
  const lastRiskSignatureRef = useRef<string>('');
  // LEAK-1: guard against setState after unmount. handleGenerate and
  // other async paths check this before state transitions.
  const isMountedRef = useRef(true);
  // LEAK-2/3/4: unified timer bag — every setTimeout gets tracked and
  // cleared on unmount so no fire-and-forget timers leak.
  const pendingTimersRef = useRef<Set<number>>(new Set());
  // RERENDER-5: rotation tick used to drive setState every 4.2s, forcing
  // the whole tree to re-render just to toggle a class. Now the tick
  // walks mentorNodeRefs and toggles the active class imperatively.
  const activeIndexRef = useRef(0);
  const mentorNodeRefs = useRef<Array<HTMLDivElement | null>>([]);
  // ARCH-3: coalesce rapid-fire addPerson calls for the same key so a
  // double-click on the add button doesn't cancel the prior hydration.
  const addPersonTimestampRef = useRef<Map<string, number>>(new Map());
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

  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
      // LEAK-2/3/4: fire-and-forget timers get swept here.
      for (const handle of pendingTimersRef.current) {
        window.clearTimeout(handle);
      }
      pendingTimersRef.current.clear();
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

  const selectedMentors = useMemo(
    () => selectedPeople.map((person) => createCustomMentorProfile(person.name)),
    [selectedPeople]
  );

  const ritualStep = phase === 'invite' ? 0 : phase === 'wish' ? 1 : 2;
  const localizedVibeTags = isZh ? vibeTagsZh : vibeTags;

  // RERENDER-3: stabilize the string bundle so it doesn't get rebuilt
  // on every render. Callers that capture `t` in closures / deps will
  // also stay stable across renders when language doesn't change.
  const t = useMemo(() => ({
    heroTitle: isZh ? '名人桌 · 召唤房间' : 'Celebrity Mentor Table · Summoning Room',
    heroSub: isZh ? '这不是普通页面，而是一个互动舞台。' : 'Not a page. A stage.',
    summonGuests: isZh ? '召唤人物' : 'Summon Guests',
    placeArtifact: isZh ? '放下你的问题卡' : 'Place Your Artifact',
    openCircle: isZh ? '开启圆桌' : 'Open Circle',
    edit: isZh ? '编辑' : 'Edit',
    shuffle: isZh ? '换座位' : 'Shuffle',
    restart: isZh ? '重新开始' : 'Restart',
    summoningRitual: isZh ? '召唤仪式' : 'Summoning Ritual',
    invitePlaceholder: isZh ? '输入对象（名人/MBTI/角色）' : 'Enter target (celebrity/MBTI/character)',
    flip: isZh ? '翻面' : 'flip',
    keepGoing: isZh ? '继续加油' : 'keep going',
    continueToWish: isZh ? '继续' : 'Continue',
    artifactPlaceholder: isZh ? '写下你现在最困扰的问题，圆桌会听见。' : 'Write what’s weighing on you. The table will listen.',
    beginSession: isZh ? '开启圆桌 ✨' : 'Open the Circle ✨',
    generating: isZh ? '正在召唤...' : 'Summoning...',
    sessionInProgress: isZh ? '会话进行中。' : 'Session in progress.',
    source: isZh ? '来源' : 'Source',
    llmApi: isZh ? 'LLM 接口' : 'LLM API',
    localFallback: isZh ? '本地回退' : 'Local Fallback',
    aiDisclaimer: isZh
      ? '这是基于公开信息的AI模拟视角，不代表真实人物的观点。'
      : 'This is an AI-simulated perspective inspired by public information, not a real statement from the person.',
    youFrontRow: isZh ? '你 · 第一视角' : 'You · Front row',
    concernHint: isZh ? '把你的问题放在桌面上。' : 'Place your concern artifact on the table.',
    tableListening: isZh ? '圆桌正在聆听。' : 'The table is listening.',
    clothPattern: isZh ? '桌布纹理浮现' : 'cloth pattern appears',
    ambientOn: isZh ? '环境粒子启动' : 'ambient particles activate',
    cardsGlow: isZh ? '人物卡开始发光' : 'guest cards glow',
    hoverPause: isZh ? '鼠标停留会暂停滚动，方便阅读。' : 'Hover to pause and read carefully.',
    you: isZh ? '你' : 'You',
    passNoteTo: isZh ? '给' : 'Pass a note to',
    replyTo: isZh ? '回复给' : 'Reply to',
    send: isZh ? '发送' : 'Send',
    typing: isZh ? '正在输入...' : 'typing...',
    typingNow: isZh ? '正在输入中' : 'Typing now',
    mentorTyping: isZh ? '输入中' : 'Typing',
    hideGroup: isZh ? '隐藏共同讨论' : 'Hide group solve',
    showGroup: isZh ? '共同讨论方案' : 'Group solve together',
    jointStrategy: isZh ? '全员讨论 · 联合方案' : 'All mentors · Joint strategy',
    replyToAllHeader: isZh ? '你 · 回复所有导师' : 'You · Reply to all mentors',
    replyAllPlaceholder: isZh ? '回复给所有人...' : 'Reply to all...',
    sendToAll: isZh ? '发送给所有人' : 'Send to all',
    showWrap: isZh ? '显示总结' : 'Show session wrap',
    sessionComplete: isZh ? '会话完成。' : 'Session complete.',
    tonightTakeaway: isZh ? '今晚总结' : 'Tonight’s takeaway',
    save: isZh ? '保存聊天' : 'Save Chat',
    newTable: isZh ? '开启新圆桌' : 'Start a new table',
    memories: isZh ? '记忆抽屉' : 'Memories',
    memoryDrawer: isZh ? '记忆抽屉' : 'Memory Drawer',
    savedInDrawer: isZh ? '已保存到右下角“记忆抽屉”。' : 'Saved to the Memories drawer in the bottom-right.',
    savedSuccess: isZh ? '聊天记录已成功保存。' : 'Conversation saved successfully.',
    noMemories: isZh ? '还没有保存内容。' : 'No saved memories yet.',
    chatWindow: isZh ? '聊天窗口' : 'Conversation',
    backToTable: isZh ? '返回上一页' : 'Back to previous view',
    clickToExpand: isZh ? '点开看完整建议' : 'Open full advice',
    debugPrompt: isZh ? 'Prompt 调试' : 'Prompt Debug',
    closeDebug: isZh ? '关闭' : 'Close',
    inspectPrompt: isZh ? '查看 Prompt' : 'Inspect Prompt',
    loading: isZh ? '加载中...' : 'Loading...',
    debugLoadFailed: isZh ? '加载失败' : 'Failed to load',
    back: isZh ? '上一步' : 'Back',
    next: isZh ? '下一步' : 'Next',
    getStarted: isZh ? '开始' : 'Get Started',
    dontShowAgain: isZh ? '下次不再显示' : "Don't show this again",
    keepShowing: isZh ? '下次继续显示' : 'Keep showing on startup',
    // ERR-2: retry-able error state for handleGenerate failures
    generateFailed: isZh ? '召唤失败，请重试。' : 'Could not reach the mentors. Please retry.',
    retry: isZh ? '重试' : 'Retry',
    // MC-3: jump past the reveal timer
    revealAll: isZh ? '立刻展示全部' : 'Reveal all now',
    // ERR-1: 0-mentor continue guard
    needAtLeastOne: isZh ? '至少选择一个人物才能继续。' : 'Please add at least one guest to continue.'
  }), [isZh]);

  const uiLanguage: 'zh-CN' | 'en' = isZh ? 'zh-CN' : 'en';

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

  const buildImageChain = (name: string, imageUrl?: string, candidateImageUrls?: string[]) => {
    const key = normalizeNameKey(name);
    const person = selectedPeople.find((p) => normalizeNameKey(p.name) === key);

    // Resolve the display name to canonical (e.g. "lisa" → "Lisa Su") and
    // collect any verified fallback image URLs for this person. Both share
    // the same findVerifiedPerson lookup, so the try/catch wraps them once.
    let resolvedName = name;
    let verifiedImages: string[] = [];
    try {
      const verified = findVerifiedPerson(name);
      if (verified) {
        resolvedName = verified.canonical;
        verifiedImages = [verified.imageUrl, ...(verified.candidateImageUrls ?? [])].filter(Boolean);
      }
    } catch { /* findVerifiedPerson may not be available */ }

    // Server-side proxy: fetches from Wikipedia, caches on disk, serves locally.
    // Works for ANY person/character — no CORS, no rate-limits for the client.
    const proxyUrl = `/api/mentor-image?name=${encodeURIComponent(resolvedName)}`;
    // Local dev fallback: the Vite dev server proxies /api/mentor-image, but
    // when running outside the dev server we hit the worker directly.
    const localFallback = `http://127.0.0.1:8787/api/mentor-image?name=${encodeURIComponent(resolvedName)}`;

    const external = Array.from(
      new Set(
        [
          imageUrl,
          person?.imageUrl,
          ...verifiedImages,
          ...(candidateImageUrls ?? []),
          ...(person?.candidateImageUrls ?? []),
        ].filter(Boolean)
      )
    ) as string[];

    // Chain: proxy (cached/fetched) → external URLs → cartoon → initials
    return [proxyUrl, localFallback, ...external, getCartoonAvatarUrl(name), createInitialAvatar(name)];
  };

  const imageSrcFor = (name: string, imageUrl?: string, candidateImageUrls?: string[]) => {
    const key = normalizeNameKey(name);
    const chain = buildImageChain(name, imageUrl, candidateImageUrls);
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
    const key = normalizeNameKey(name);
    const chain = buildImageChain(name, imageUrl, candidateImageUrls);
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

  const generateMentorFollowup = (_mentorName: string, userText: string) => {
    const excerpt = userText.slice(0, 56).trim();
    if (uiLanguage === 'zh-CN') {
      return `收到你的补充（“${excerpt}${userText.length > 56 ? '...' : ''}”）。我会先给你一个最小可执行动作，你做完后我们再迭代下一步。`;
    }
    return `I got your follow-up (“${excerpt}${userText.length > 56 ? '...' : ''}”). I would start with one smallest executable step, then iterate with you from there.`;
  };

  const mentorThreadKey = (rawName: string) => normalizeMentorKey(resolveMentorName(rawName));

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
      // otherwise be forwarded to the API as an empty mentor turn. See
      // .harness/nodes/deadcode-audit/eval.md (deletion #2).
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

  const submitNoteToMentor = async (rawName: string) => {
    const threadKey = mentorThreadKey(rawName);
    const mentorName = localizeName(resolveMentorName(rawName));
    const targetKey = normalizeMentorKey(rawName);
    const text = (noteDrafts[threadKey] || '').trim();
    if (!text) return;
    // The inline-note send button is disabled while isRoundGenerating, so a
    // re-entrant call is UI-unreachable. The belt-and-suspenders guard was
    // removed.

    setIsRoundGenerating(true);
    let mentorReply = generateMentorFollowup(mentorName, text);
    const targetMentor = selectedMentors.find((mentor) => {
      return normalizeMentorKey(mentor.displayName) === targetKey || normalizeMentorKey(mentor.id) === targetKey;
    });
    const coordinatedMentorSet =
      COORDINATE_PASS_NOTE_WITH_ALL && selectedMentors.length > 1
        ? selectedMentors
        : targetMentor
          ? [targetMentor]
          : selectedMentors.slice(0, 1);

    try {
      const aiResult = await generateMentorAdvice({
        problem: text,
        language: uiLanguage,
        mentors: coordinatedMentorSet,
        conversationHistory: buildConversationHistory(text)
      });

      const targetMentorIdKey = targetMentor ? normalizeMentorKey(targetMentor.id) : '';
      const targetMentorNameKey = targetMentor ? normalizeMentorKey(targetMentor.displayName) : targetKey;
      const aiReply =
        aiResult.mentorReplies.find((reply) => targetMentorIdKey && normalizeMentorKey(reply.mentorId) === targetMentorIdKey) ||
        aiResult.mentorReplies.find((reply) => normalizeMentorKey(reply.mentorName) === targetMentorNameKey) ||
        aiResult.mentorReplies.find((reply) => normalizeMentorKey(reply.mentorName) === targetKey) ||
        aiResult.mentorReplies[0];
      if (aiReply?.likelyResponse) {
        mentorReply = aiReply.likelyResponse;
      }
    } finally {
      setIsRoundGenerating(false);
    }

    setNoteReplies((prev) => ({
      ...prev,
      [threadKey]: [
        ...(prev[threadKey] || []),
        { role: 'user', text },
        { role: 'mentor', text: mentorReply }
      ]
    }));
    setConversationTurns((prev) => [
      ...prev,
      {
        // Bug #22: collision-safe id via uniqueId (crypto.randomUUID fallback).
        id: uniqueId(`turn-${threadKey}`),
        user: text,
        replies: [{ mentorName, text: mentorReply }]
      }
    ]);
    setNoteDrafts((prev) => ({ ...prev, [threadKey]: '' }));
    setOpenNoteFor(threadKey);
    scrollConversationToBottom();
  };

  const handleReplyAll = async () => {
    const text = replyAllDraft.trim();
    if (!text || isRoundGenerating || selectedMentors.length === 0) return;

    setIsRoundGenerating(true);
    try {
      const aiResult = await generateMentorAdvice({
        problem: text,
        language: uiLanguage,
        mentors: selectedMentors,
        conversationHistory: buildConversationHistory(text)
      });

      const replies = selectedMentors.map((mentor) => {
        const matched =
          aiResult.mentorReplies.find((reply) => normalizeMentorKey(reply.mentorId) === normalizeMentorKey(mentor.id)) ||
          aiResult.mentorReplies.find((reply) => normalizeMentorKey(reply.mentorName) === normalizeMentorKey(mentor.displayName));
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
          user: text,
          replies
        }
      ]);
      setReplyAllDraft('');
      scrollConversationToBottom();
    } finally {
      setIsRoundGenerating(false);
    }
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

  useEffect(() => {
    const query = personQuery.trim();
    if (!query) {
      setSuggestions([]);
      setIsSearching(false);
      return;
    }

    // ── Instant local results (sync, 0ms) ──
    // Try VERIFIED_PEOPLE search first, then fall back to MENTOR_PROFILES only
    let verifiedHits: PersonOption[] = [];
    try {
      verifiedHits = searchVerifiedPeopleLocal(query);
    } catch {
      // searchVerifiedPeopleLocal may not be available (module HMR / cache)
    }

    let profileHits: PersonOption[] = [];
    try {
      profileHits = getSuggestedPeople(query).map((p) => {
        let img: string | undefined;
        let candidates: string[] | undefined;
        try {
          const v = findVerifiedPerson(p.displayName);
          img = v?.imageUrl;
          candidates = v?.candidateImageUrls;
        } catch { /* findVerifiedPerson may not be available */ }
        return { name: p.displayName, imageUrl: img, candidateImageUrls: candidates } as PersonOption;
      });
    } catch { /* getSuggestedPeople fallback */ }

    const localUnique = new Map<string, PersonOption>();
    for (const p of [...verifiedHits, ...profileHits]) {
      const k = p.name.trim().toLowerCase();
      if (k && !localUnique.has(k)) localUnique.set(k, p);
    }
    const instantResults = Array.from(localUnique.values()).slice(0, 8);
    setSuggestions(instantResults);

    // If we already have local matches, don't show "Searching..." spinner
    const hasLocalHits = instantResults.length > 0;
    setIsSearching(!hasLocalHits);

    // ── Background remote search (async, debounced 120ms) ──
    // searchPeopleWithPhotos ALSO searches VERIFIED_PEOPLE + Wikipedia,
    // so even if local search failed, remote will fill in verified results.
    let alive = true;
    const timer = window.setTimeout(async () => {
      try {
        const remote = await searchPeopleWithPhotos(query);
        if (!alive) return;

        // Merge: verified local results first (most reliable), then remote
        const merged = new Map<string, PersonOption>();
        for (const p of [...verifiedHits, ...remote, ...instantResults]) {
          const k = p.name.trim().toLowerCase();
          if (k && !merged.has(k)) merged.set(k, p);
        }

        setSuggestions(Array.from(merged.values()).slice(0, 8));
      } catch {
        // Remote search failed — keep whatever local results we have
        if (!alive) return;
      } finally {
        if (alive) setIsSearching(false);
      }
    }, 120);

    return () => {
      alive = false;
      window.clearTimeout(timer);
    };
  }, [personQuery]);

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
    if (sessionMode !== 'live' || !result?.mentorReplies?.length || isConversationHovered) return;
    const timer = window.setTimeout(() => {
      setVisibleReplyCount((count) => Math.min(count + 1, result.mentorReplies.length));
    }, 2600);
    return () => window.clearTimeout(timer);
  }, [sessionMode, result?.mentorReplies.length, visibleReplyCount, isConversationHovered]);

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
    // e.g. "lisa" → "Lisa Su" with photo, "steve jobs" → "Steve Jobs" with photo
    let name = typeof person === 'string' ? trimmed : person.name;
    let initialImage = typeof person === 'string' ? undefined : person.imageUrl;
    let initialCandidates = typeof person === 'string' ? undefined : person.candidateImageUrls;

    if (typeof person === 'string') {
      try {
        const verified = findVerifiedPerson(trimmed);
        if (verified) {
          name = verified.canonical;
          initialImage = verified.imageUrl;
          initialCandidates = verified.candidateImageUrls;
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

    // Bug #21: clear stale imageAttempt/imageRetry counters for this key so
    // the re-added person starts at chain index 0 again.
    const normalizedKey = name.trim().toLowerCase().replace(/\s+/g, ' ');
    setImageAttemptByKey((prev) => {
      if (!(normalizedKey in prev)) return prev;
      const next = { ...prev };
      delete next[normalizedKey];
      return next;
    });
    setImageRetryByKey((prev) => {
      if (!(normalizedKey in prev)) return prev;
      const next = { ...prev };
      delete next[normalizedKey];
      return next;
    });

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
    const normalizedKey = name.trim().toLowerCase().replace(/\s+/g, ' ');
    setImageAttemptByKey((prev) => {
      if (!(normalizedKey in prev)) return prev;
      const next = { ...prev };
      delete next[normalizedKey];
      return next;
    });
    setImageRetryByKey((prev) => {
      if (!(normalizedKey in prev)) return prev;
      const next = { ...prev };
      delete next[normalizedKey];
      return next;
    });
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
    localStorage.setItem(ONBOARDING_KEY, dontShowOnboardingAgain ? '1' : '0');
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
    setOpenNoteFor('');
    setNoteDrafts({});
    setNoteReplies({});
    setExpandedReplyId('');
    setExpandedSuggestion(null);
    setOpenDebugMentorId('');
    setHoveredDebugMentorId('');
    setDebugPromptByMentorId({});
    setDebugPromptLoadingByMentorId({});
    setDebugPromptErrorByMentorId({});
    activeIndexRef.current = 0;

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
      if (!isMountedRef.current) return;
      window.clearTimeout(bootTimer);
      setIsGenerating(false);
      setGenerateError(err instanceof Error ? err.message : String(err));
      // Drop back to the wish phase so the Retry button is reachable.
      setPhase('wish');
      setSessionMode('idle');
    }
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

  const getReplyByMentorName = (name: string) =>
    replyByNormalizedName.get(name.trim().toLowerCase().replace(/\s+/g, '_'));

  const truncateWithEllipsis = (text: string, maxChars: number): { text: string; isTruncated: boolean } => {
    const compact = text.replace(/\s+/g, ' ').trim();
    if (compact.length <= maxChars) return { text: compact, isTruncated: false };
    return { text: `${compact.slice(0, maxChars).trimEnd()}...`, isTruncated: true };
  };

  const simplifyLikelyResponse = (text: string) => {
    const compact = text.replace(/\s+/g, ' ').trim();
    // Callers (suggestionDeckEntries) only reach this when mentorReplies
    // have been produced, and the API schema requires likelyResponse to be
    // a non-empty string, so the empty-guard is dead and was removed.
    if (isZh) {
      return compact
        .replace(/^我(?:会|建议)?先(?:把这个)?拆成可执行步骤(?:先)?[:：]?\s*/u, '')
        .replace(/^我(?:会|建议)(?:先)?[:：]?\s*/u, '')
        .replace(/^可以先[:：]?\s*/u, '')
        .trim();
    }
    return compact
      .replace(/^i\s+(?:would|will|suggest|recommend)\s+break\s+this\s+into\s+executable\s+steps\s+first[:,]?\s*/iu, '')
      .replace(/^i\s+(?:would|will|suggest|recommend)\s+/iu, '')
      .replace(/^let'?s\s+/iu, '')
      .trim();
  };

  const simplifyActionStep = (text: string) => {
    const compact = text.replace(/\s+/g, ' ').trim();
    if (!compact) return compact;
    if (isZh) {
      return compact.replace(/^下一步[:：]\s*/u, '').trim();
    }
    return compact.replace(/^next\s+step(?:\s*\(today\))?[:：]\s*/iu, '').trim();
  };

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
    [selectedMentors, selectedPeople, result, phase, sessionMode, visibleReplyCount, visibleReplies, sessionComplete, getReplyByMentorName, localizeName, t.mentorTyping]);

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
                // KB-7: the "Open Circle" pill is visually present but has
                // no click handler until the session phase is reached.
                // Disable it + aria-disabled so keyboard users skip it.
                const sessionPillDisabled = p.id === 'session' && phase !== 'session';
                return (
                  <button
                    type="button"
                    key={p.id}
                    disabled={sessionPillDisabled}
                    aria-disabled={sessionPillDisabled || undefined}
                    tabIndex={sessionPillDisabled ? -1 : 0}
                    onClick={() => {
                      if (p.id !== 'session') {
                        setPhase(p.id);
                        setResult(null);
                        setSessionMode('idle');
                        setExpandedReplyId('');
                        setExpandedSuggestion(null);
                        setOpenDebugMentorId('');
                        setHoveredDebugMentorId('');
                      }
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
                      aria-label={t.invitePlaceholder}
                      aria-labelledby="mentor-invite-heading"
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
                      aria-label={isZh ? '添加人物' : 'Add person'}
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
                                // SR-5: decorative avatar — the adjacent text
                                // already names the person.
                                alt=""
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
                        {isSearching && <div className={styles.searchingRow}>{isZh ? '搜索中...' : 'Searching...'}</div>}
                        {!isSearching && suggestions.length === 0 && (
                          <div className={styles.searchingRow}>{isZh ? '未找到结果，按回车添加自定义名人' : 'No results — press Enter to add as custom mentor'}</div>
                        )}
                      </div>
                    )}
                  </div>

                  <div className={styles.selectedPeopleGrid}>
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
                            alt={person.name}
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
                  <button
                    type="button"
                    data-testid="mentor-continue-wish"
                    className={styles.primaryCta}
                    disabled={selectedPeople.length === 0}
                    aria-describedby={selectedPeople.length === 0 ? 'mentor-continue-error' : undefined}
                    onClick={() => setPhase('wish')}
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
                      <div style={{ fontSize: '0.75rem', opacity: 0.7, marginTop: 4 }}>{generateError}</div>
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
                        pass-note silent fallback path. */}
                    <div
                      className={styles.sourceTag}
                      title={
                        result?.meta.source === 'llm'
                          ? (isZh ? '由 LLM 接口实时生成' : 'Generated live by the LLM API')
                          : (isZh
                              ? '后端不可用，已使用本地回退模板'
                              : 'Backend unavailable — using a local fallback template')
                      }
                    >
                      {t.source}: {result?.meta.source === 'llm' ? t.llmApi : t.localFallback}
                      {result?.meta.source !== 'llm' && (
                        <span style={{ marginLeft: 6, fontWeight: 700, color: '#9b6600' }}>
                          {isZh ? '(离线)' : '(offline)'}
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

                <div className={styles.suggestionDeck}>
                  {suggestionDeckEntries.map((entry) => {
                    const totalMentorSlots = Math.max(selectedMentors.length, 1);
                    const cardStyle = floatingCardPlacement(entry.mentorIndex, totalMentorSlots);
                    const actionPreview = truncateWithEllipsis(
                      simplifyActionStep(entry.oneActionStep),
                      totalMentorSlots > 6 ? 24 : totalMentorSlots > 3 ? 32 : 44
                    );
                    const reasonPreview = truncateWithEllipsis(
                      simplifyLikelyResponse(entry.likelyResponse),
                      totalMentorSlots > 6 ? 28 : totalMentorSlots > 3 ? 36 : 50
                    );
                    const hasTrimmed = reasonPreview.isTruncated || actionPreview.isTruncated;

                    if (!entry.replyId) {
                      if (entry.status === 'typing') {
                        return (
                          <article
                            key={entry.key}
                            className={`${styles.suggestionCard} ${styles.suggestionCardTyping}`}
                            style={cardStyle}
                          >
                            <h3>{entry.displayName}</h3>
                            <p className={styles.suggestionPrimary}>{t.mentorTyping}</p>
                          </article>
                        );
                      }

                      return (
                        <button
                          type="button"
                          key={entry.key}
                          className={styles.suggestionCard}
                          style={cardStyle}
                          onClick={(e) => {
                            e.stopPropagation();
                            setExpandedReplyId('');
                            setExpandedSuggestion({
                              mentorName: entry.displayName,
                              likelyResponse: entry.likelyResponse,
                              oneActionStep: entry.oneActionStep
                            });
                          }}
                        >
                          <h3>{entry.displayName}</h3>
                          <p className={styles.suggestionPrimary}>{actionPreview.text}</p>
                          <p className={styles.suggestionSecondary}>{reasonPreview.text}</p>
                          {hasTrimmed && <span className={styles.replyExpandHint}>{t.clickToExpand}</span>}
                        </button>
                      );
                    }

                    return (
                      <article
                        key={entry.key}
                        className={`${styles.tableReplyCard} ${styles.mentorReplyPreview} ${expandedReplyId === entry.replyId ? styles.tableReplyCardActive : ''}`}
                        style={cardStyle}
                        onClick={(e) => {
                          e.stopPropagation();
                          setExpandedSuggestion(null);
                          // narrowing doesn't survive the closure — rebind
                          setExpandedReplyId(entry.replyId || '');
                        }}
                      >
                        <header>{entry.displayName}</header>
                        <p className={styles.suggestionPrimary}>{actionPreview.text}</p>
                        <footer className={styles.suggestionSecondary}>{reasonPreview.text}</footer>
                        {hasTrimmed && <span className={styles.replyExpandHint}>{t.clickToExpand}</span>}
                      </article>
                    );
                  })}
                </div>

                {expandedSuggestion && (
                  // KB-4 + R3 I-4: proper dialog semantics + focus trap
                  // + focus return via useFocusTrap hook.
                  <div
                    className={styles.replyExpandOverlay}
                    role="dialog"
                    aria-modal="true"
                    aria-label={expandedSuggestion.mentorName}
                    tabIndex={-1}
                    ref={expandedSuggestionTrapRef}
                    onClick={() => setExpandedSuggestion(null)}
                  >
                    <button
                      type="button"
                      className={styles.expandBackTopLeft}
                      onClick={(e) => {
                        e.stopPropagation();
                        setExpandedSuggestion(null);
                      }}
                    >
                      <FontAwesomeIcon icon={faChevronLeft} /> {t.backToTable}
                    </button>
                    <article
                      className={`${styles.replyExpandedCard} ${styles.replyExpandedSticky}`}
                      onClick={(e) => e.stopPropagation()}
                    >
                      <header>{expandedSuggestion.mentorName}</header>
                      <p>{expandedSuggestion.likelyResponse}</p>
                      <footer>{isZh ? '下一步：' : 'Next move: '} {expandedSuggestion.oneActionStep}</footer>
                    </article>
                  </div>
                )}

                {phase === 'session' && sessionMode === 'live' && expandedReply && (
                  // KB-4 + R3 I-4: proper dialog semantics + focus trap
                  // + focus return via useFocusTrap hook. Escape handling
                  // and auto-focus are both done inside the hook.
                  <div
                    className={styles.replyExpandOverlay}
                    role="dialog"
                    aria-modal="true"
                    aria-label={localizeName(resolveMentorName(expandedReply.mentorName))}
                    tabIndex={-1}
                    ref={expandedReplyTrapRef}
                    onClick={() => {
                      setExpandedReplyId('');
                      setExpandedSuggestion(null);
                    }}
                  >
                    <button
                      type="button"
                      className={styles.expandBackTopLeft}
                      onClick={(e) => {
                        e.stopPropagation();
                        setExpandedReplyId('');
                        setExpandedSuggestion(null);
                      }}
                    >
                      <FontAwesomeIcon icon={faChevronLeft} /> {t.backToTable}
                    </button>
                    <article
                      className={`${styles.replyExpandedCard} ${styles.replyExpandedSticky}`}
                      onClick={(e) => e.stopPropagation()}
                    >
                      {(() => {
                        const mentorName = localizeName(resolveMentorName(expandedReply.mentorName));
                        const threadKey = mentorThreadKey(expandedReply.mentorName);
                        const notes = noteReplies[threadKey] || [];
                        return (
                          <>
                            <header>{mentorName}</header>
                            <p>{expandedReply.likelyResponse}</p>
                            <footer>{isZh ? '下一步：' : 'Next move: '} {expandedReply.oneActionStep}</footer>
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
                                    onClick={() => submitNoteToMentor(expandedReply.mentorName)}
                                  >
                                    {isRoundGenerating ? t.typing : t.send}
                                  </button>
                                </div>
                              </div>
                            )}
                            {notes.map((note, idx) => (
                              <div key={`${threadKey}-expanded-note-${idx}`} className={styles.noteThread}>
                                {note.role === 'user' ? `${t.you}: ${note.text}` : `${mentorName}: ${note.text}`}
                              </div>
                            ))}
                          </>
                        );
                      })()}
                    </article>
                  </div>
                )}

                {openDebugMentor && (
                  <aside className={styles.debugPromptPanel}>
                    <div className={styles.debugPromptHeader}>
                      <strong>{t.debugPrompt}</strong>
                      <span>{openDebugMentorDisplayName}</span>
                    </div>
                    <pre className={styles.debugPromptBody}>
                      {openDebugPromptLoading ? t.loading : openDebugPromptText || openDebugPromptError || t.debugLoadFailed}
                    </pre>
                    <button type="button" className={styles.debugPromptCloseBtn} onClick={() => setOpenDebugMentorId('')}>
                      {t.closeDebug}
                    </button>
                  </aside>
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

        <button type="button" data-testid="mentor-memory-fab" className={styles.memoryFab} onClick={() => setMemoryDrawerOpen((v) => !v)}>
          <FontAwesomeIcon icon={faBookOpen} /> {t.memories} ({memories.length})
        </button>

        {saveNotice && (
          // SR-3: polite status announcement (non-interrupting).
          <div
            data-testid="mentor-save-notice"
            className={styles.saveNotice}
            role="status"
            aria-live="polite"
          >
            {saveNotice}
          </div>
        )}

        {memoryDrawerOpen && (
          <div data-testid="mentor-memory-drawer" className={styles.memoryDrawer}>
            <h3>{t.memoryDrawer}</h3>
            <p className={styles.memoryHint}>{t.savedInDrawer}</p>
            {memories.length === 0 && <p className={styles.emptyMemory}>{t.noMemories}</p>}
            {memories.map((memory) => (
              <article key={memory.id} className={styles.memoryCard}>
                <header>{memory.title}</header>
                <small>{memory.createdAt}</small>
                <ul>
                  {/* Bug #40: show all saved takeaways in the memory drawer. */}
                  {memory.takeaways.map((item, idx) => (
                    <li key={`${memory.id}-${idx}`}>{item}</li>
                  ))}
                </ul>
              </article>
            ))}
          </div>
        )}

        {showOnboarding && (
          // KB-3 + R3 I-4: proper dialog semantics + focus trap + focus
          // return via useFocusTrap. Auto-focus and Escape are both
          // handled inside the hook.
          <div
            className={styles.onboardingOverlay}
            role="dialog"
            aria-modal="true"
            aria-labelledby="mentor-onboarding-title"
            ref={onboardingTrapRef}
          >
            <div className={styles.onboardingCard}>
              <h3 id="mentor-onboarding-title">{localizedOnboardingSlides[currentSlide].title}</h3>
              <p>{localizedOnboardingSlides[currentSlide].body}</p>
              {currentSlide === localizedOnboardingSlides.length - 1 && (
                <div className={styles.onboardingChoiceBoxes}>
                  <button
                    type="button"
                    className={`${styles.onboardingChoiceBox} ${dontShowOnboardingAgain ? styles.onboardingChoiceBoxActive : ''}`}
                    onClick={() => setDontShowOnboardingAgain(true)}
                  >
                    {t.dontShowAgain}
                  </button>
                  <button
                    type="button"
                    className={`${styles.onboardingChoiceBox} ${!dontShowOnboardingAgain ? styles.onboardingChoiceBoxActive : ''}`}
                    onClick={() => setDontShowOnboardingAgain(false)}
                  >
                    {t.keepShowing}
                  </button>
                </div>
              )}
              <div className={styles.slideDots}>
                {localizedOnboardingSlides.map((_, idx) => (
                  <span key={idx} className={`${styles.slideDot} ${currentSlide === idx ? styles.slideDotActive : ''}`} />
                ))}
              </div>
              <div className={styles.onboardingActions}>
                <button
                  type="button"
                  className={styles.onboardingBtnSecondary}
                  onClick={() => setCurrentSlide((s) => Math.max(0, s - 1))}
                  disabled={currentSlide === 0}
                >
                  {t.back}
                </button>
                {currentSlide < localizedOnboardingSlides.length - 1 ? (
                  <button
                    type="button"
                    className={styles.onboardingBtnPrimary}
                    onClick={() => setCurrentSlide((s) => Math.min(localizedOnboardingSlides.length - 1, s + 1))}
                  >
                    {t.next}
                  </button>
                ) : (
                  <button type="button" className={styles.onboardingBtnPrimary} onClick={finishOnboarding}>
                    {t.getStarted}
                  </button>
                )}
              </div>
            </div>
          </div>
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
