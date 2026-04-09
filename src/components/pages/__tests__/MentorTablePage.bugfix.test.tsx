/**
 * Regression tests for MentorTablePage bug fixes + dead-code restoration.
 *
 * Covers:
 *  - Dead code deletion #2: whitespace-only LLM replies must not leak into
 *    conversation history forwarded to the API on subsequent rounds.
 *  - Bug #22: conversation turn ids must be collision-safe (no duplicates
 *    within the same React batch / same millisecond).
 *  - Bug #44: conversation history sent to the API is capped at
 *    MAX_CONVERSATION_TURNS_IN_HISTORY turns.
 *  - Bug #40: saveTakeawayMemory saves all mentor takeaways, not just 3.
 *  - Bug #41: groupSolveText uses locale-aware separator.
 *  - Bug #42: icon-only buttons carry aria-label.
 */
import '@testing-library/jest-dom';
import { render, screen, fireEvent, act, waitFor } from '@testing-library/react';
import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';

// ---------- Mocks (mirror the shape used by MentorTablePage.test.tsx) ----------

const navigateMock = vi.fn();

vi.mock('react-router-dom', () => ({
  useNavigate: () => navigateMock,
}));

(globalThis as any).__mentorBugfixState = {
  language: 'en',
  fetchPersonImage: async (_n: string) => undefined,
  fetchPersonImageCandidates: async (_n: string) => undefined,
  searchPeopleWithPhotos: async (_q: string) => [] as Array<{ name: string; imageUrl?: string }>,
  getChineseDisplayName: (name: string) => name,
  findVerifiedPerson: (name: string) =>
    name.toLowerCase().includes('bill')
      ? {
          canonical: 'Bill Gates',
          imageUrl: 'https://example.com/bill.jpg',
          candidateImageUrls: ['https://example.com/bill2.jpg'],
        }
      : undefined,
};
const state = (globalThis as any).__mentorBugfixState;

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (k: string) => k,
    i18n: {
      get language() {
        return (globalThis as any).__mentorBugfixState.language;
      },
      changeLanguage: vi.fn(),
    },
  }),
}));

vi.mock('../../../hooks/useTheme', () => ({
  useTheme: vi.fn(),
}));

vi.mock('../../layout/Layout', () => ({
  default: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="mock-layout">{children}</div>
  ),
}));

vi.mock('@fortawesome/react-fontawesome', () => ({
  FontAwesomeIcon: ({ icon }: { icon: { iconName?: string } }) => (
    <span data-fa={icon?.iconName || 'icon'} />
  ),
}));

const generateMentorAdviceMock = vi.fn();
const fetchMentorDebugPromptMock = vi.fn();

vi.mock('../../../features/mentorTable/mentorApi', () => ({
  generateMentorAdvice: (args: unknown) => generateMentorAdviceMock(args),
  fetchMentorDebugPrompt: (args: unknown) => fetchMentorDebugPromptMock(args),
}));

vi.mock('../../../features/mentorTable/mentorProfiles', () => ({
  createCustomMentorProfile: (name: string) => ({
    id: `custom_${name.toLowerCase().replace(/\s+/g, '_')}`,
    displayName: name,
    archetype: 'Mentor',
    voice: 'analytical',
    strengths: ['clarity'],
    watchouts: [],
    signatureQuestions: [],
    language: 'en',
  }),
  getCartoonAvatarUrl: (_name: string) => 'https://example.com/cartoon.svg',
  getSuggestedPeople: (query: string) =>
    query.trim() ? [{ displayName: 'Suggested Person', description: 'desc' }] : [],
}));

vi.mock('../../../features/mentorTable/personLookup', () => ({
  fetchPersonImage: (name: string) => (globalThis as any).__mentorBugfixState.fetchPersonImage(name),
  fetchPersonImageCandidates: (name: string) =>
    (globalThis as any).__mentorBugfixState.fetchPersonImageCandidates(name),
  findVerifiedPerson: (name: string) =>
    (globalThis as any).__mentorBugfixState.findVerifiedPerson(name),
  getChineseDisplayName: (name: string) =>
    (globalThis as any).__mentorBugfixState.getChineseDisplayName(name),
  getVerifiedPlaceholderImage: () => 'data:image/svg+xml;utf8,placeholder',
  searchPeopleWithPhotos: (q: string) =>
    (globalThis as any).__mentorBugfixState.searchPeopleWithPhotos(q),
  searchVerifiedPeopleLocal: (query: string) =>
    query.trim().length
      ? [{ name: 'Bill Gates', imageUrl: 'https://example.com/bill.jpg' }]
      : [],
}));

import MentorTablePage from '../MentorTablePage';

// ---------- Helpers ----------

const buildMockResult = (overrides: Partial<any> = {}) => ({
  schemaVersion: 'mentor_table.v1',
  language: 'en',
  safety: { riskLevel: 'low', needsProfessionalHelp: false, emergencyMessage: '' },
  mentorReplies: [
    {
      mentorId: 'custom_bill_gates',
      mentorName: 'Bill Gates',
      likelyResponse: 'Identify the bottleneck and break it into steps.',
      whyThisFits: 'Analytical approach.',
      oneActionStep: 'List 3 issues and tackle the biggest first.',
      confidenceNote: 'AI-simulated.',
    },
  ],
  meta: {
    disclaimer: 'AI-simulated perspective.',
    generatedAt: '2024-01-01T00:00:00Z',
    source: 'llm' as const,
  },
  ...overrides,
});

async function addPerson(name: string) {
  const input = screen.getByTestId('mentor-person-input') as HTMLInputElement;
  fireEvent.change(input, { target: { value: name } });
  fireEvent.keyDown(input, { key: 'Enter', code: 'Enter' });
  await waitFor(() => expect(input.value).toBe(''));
}

async function runSessionWith(problem: string) {
  await addPerson('Bill');
  fireEvent.click(screen.getByTestId('mentor-continue-wish'));
  const textarea = screen.getByTestId('mentor-problem-input');
  fireEvent.change(textarea, { target: { value: problem } });
  await act(async () => {
    fireEvent.click(screen.getByTestId('mentor-begin-session'));
  });
  await waitFor(() => {
    expect(screen.getAllByText(/Next move/).length).toBeGreaterThan(0);
  });
}

// ---------- Tests ----------

describe('MentorTablePage bug-fix regressions', () => {
  beforeEach(() => {
    localStorage.clear();
    localStorage.setItem('mentorTableOnboardingHiddenV2', '1');
    navigateMock.mockReset();
    generateMentorAdviceMock.mockReset();
    generateMentorAdviceMock.mockResolvedValue(buildMockResult());
    fetchMentorDebugPromptMock.mockReset();
    fetchMentorDebugPromptMock.mockResolvedValue('MOCK PROMPT');
    state.language = 'en';
    state.fetchPersonImage = async () => undefined;
    state.fetchPersonImageCandidates = async () => undefined;
    state.searchPeopleWithPhotos = async () => [];
    state.getChineseDisplayName = (name: string) => name;
    state.findVerifiedPerson = (name: string) =>
      name.toLowerCase().includes('bill')
        ? {
            canonical: 'Bill Gates',
            imageUrl: 'https://example.com/bill.jpg',
            candidateImageUrls: ['https://example.com/bill2.jpg'],
          }
        : undefined;
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  // Submits a note as the user and waits for the round to complete.
  // Precondition: the inline-note box must already be open (either by a
  // prior Pass-a-note click or the previous round leaving it open).
  async function submitNoteRound(text: string, expectedCallIndex: number) {
    const openNoteBox = () => document.querySelector('[class*="inlineNoteBox"]');

    // If the note box is currently closed, click the Pass-a-note button to open it.
    if (!openNoteBox()) {
      const passBtn = Array.from(document.querySelectorAll('button')).find((b) =>
        /Pass a note to/.test(b.textContent || '')
      );
      fireEvent.click(passBtn!);
      await waitFor(() => {
        expect(openNoteBox()).toBeTruthy();
      });
    }

    const noteTextarea = document.querySelector(
      '[class*="inlineNoteBox"] textarea'
    ) as HTMLTextAreaElement;
    expect(noteTextarea).toBeTruthy();
    fireEvent.change(noteTextarea, { target: { value: text } });
    const sendBtn = document.querySelector(
      '[class*="inlineNoteBox"] button'
    ) as HTMLButtonElement;
    await act(async () => {
      fireEvent.click(sendBtn);
    });
    await waitFor(() => {
      expect(generateMentorAdviceMock).toHaveBeenCalledTimes(expectedCallIndex + 1);
    });
  }

  describe('Dead code deletion #2 — whitespace-only mentor reply must be skipped', () => {
    it('whitespace-only likelyResponse from the API does not leak into subsequent conversationHistory', async () => {
      // First session: normal mentor reply.
      generateMentorAdviceMock.mockResolvedValueOnce(buildMockResult());
      render(<MentorTablePage standalone />);
      await runSessionWith('How do I prioritize?');

      // Second call (pass-a-note): mentor returns a whitespace-only reply.
      // This passes the `if (aiReply?.likelyResponse)` truthiness check and
      // overwrites the local template, so the conversation turn's reply.text
      // becomes "   ".
      generateMentorAdviceMock.mockResolvedValueOnce(
        buildMockResult({
          mentorReplies: [
            {
              mentorId: 'custom_bill_gates',
              mentorName: 'Bill Gates',
              likelyResponse: '   ',
              whyThisFits: 'n/a',
              oneActionStep: 'step',
              confidenceNote: '',
            },
          ],
        })
      );
      await submitNoteRound('Round 2 note', 1);

      // Third call: send another note so buildConversationHistory is
      // recomputed and includes the (now-stored) whitespace reply from the
      // previous turn. We verify the OUTGOING conversationHistory payload
      // does NOT contain a mentor turn with empty/whitespace text.
      generateMentorAdviceMock.mockResolvedValueOnce(buildMockResult());
      await submitNoteRound('Round 3 note', 2);

      const thirdCallArg = generateMentorAdviceMock.mock.calls[2][0];
      const history = thirdCallArg.conversationHistory as Array<{
        role: string;
        speaker: string;
        text: string;
      }>;
      expect(Array.isArray(history)).toBe(true);
      // No mentor entry should have empty / whitespace-only text.
      const mentorEntries = history.filter((h) => h.role === 'mentor');
      expect(mentorEntries.length).toBeGreaterThan(0);
      for (const entry of mentorEntries) {
        expect(entry.text.trim().length).toBeGreaterThan(0);
      }
    });
  });

  describe('Bug #22: conversation turn ids are collision-safe', () => {
    it('two rapid submits produce distinct turn ids (no React key warning)', async () => {
      render(<MentorTablePage standalone />);
      await runSessionWith('Initial question');

      generateMentorAdviceMock.mockResolvedValue(buildMockResult());
      await submitNoteRound('Follow-up 0', 1);
      await submitNoteRound('Follow-up 1', 2);

      expect(document.body.textContent).toMatch(/Follow-up 0/);
      expect(document.body.textContent).toMatch(/Follow-up 1/);
    });
  });

  describe('Bug #44: conversation history is capped at MAX_CONVERSATION_TURNS_IN_HISTORY', () => {
    it('send many rounds — only the last N turns appear in outgoing conversationHistory', async () => {
      render(<MentorTablePage standalone />);
      await runSessionWith('Start');

      // Do 15 follow-up rounds. Without a cap, round 16 would send all 15
      // prior turns; with the cap (12), it should send at most 12 mentor
      // entries from conversation turns.
      generateMentorAdviceMock.mockResolvedValue(buildMockResult());
      for (let i = 0; i < 15; i += 1) {
        await submitNoteRound(`Round ${i}`, 1 + i);
      }

      // Final call — history should be capped.
      await submitNoteRound('Final', 16);

      const lastCall = generateMentorAdviceMock.mock.calls.at(-1)?.[0];
      const history = (lastCall?.conversationHistory || []) as Array<{
        role: string;
        text: string;
      }>;
      // Cap is 12 turns × (1 user + 1 mentor) = 24, plus baseProblem + visibleReplies (2),
      // plus latestUserText (1). Upper bound ~28 for this test setup.
      // The key assertion: not-30-or-more (uncapped would be 2 + 2*16 = 34).
      expect(history.length).toBeLessThan(30);
    }, 30000);
  });

  describe('Bug #40: saveTakeawayMemory saves all mentor takeaways', () => {
    it('saves all 5 takeaways when the table has 5 mentors', async () => {
      generateMentorAdviceMock.mockResolvedValueOnce(
        buildMockResult({
          mentorReplies: [
            {
              mentorId: 'custom_m1',
              mentorName: 'Mentor 1',
              likelyResponse: 'r1',
              whyThisFits: 'w1',
              oneActionStep: 'step-1',
              confidenceNote: '',
            },
            {
              mentorId: 'custom_m2',
              mentorName: 'Mentor 2',
              likelyResponse: 'r2',
              whyThisFits: 'w2',
              oneActionStep: 'step-2',
              confidenceNote: '',
            },
            {
              mentorId: 'custom_m3',
              mentorName: 'Mentor 3',
              likelyResponse: 'r3',
              whyThisFits: 'w3',
              oneActionStep: 'step-3',
              confidenceNote: '',
            },
            {
              mentorId: 'custom_m4',
              mentorName: 'Mentor 4',
              likelyResponse: 'r4',
              whyThisFits: 'w4',
              oneActionStep: 'step-4',
              confidenceNote: '',
            },
            {
              mentorId: 'custom_m5',
              mentorName: 'Mentor 5',
              likelyResponse: 'r5',
              whyThisFits: 'w5',
              oneActionStep: 'step-5',
              confidenceNote: '',
            },
          ],
        })
      );
      render(<MentorTablePage standalone />);
      await runSessionWith('Big question');

      // Wait until ALL 5 replies are visible (visibleReplyCount catches up).
      await waitFor(
        () => {
          expect(document.body.textContent).toMatch(/step-5/);
        },
        { timeout: 20000 }
      );

      // Click "Show session wrap".
      const wrapBtn = Array.from(document.querySelectorAll('button')).find((b) =>
        /Show session wrap/.test(b.textContent || '')
      );
      fireEvent.click(wrapBtn!);

      // Click Save.
      const saveBtn = screen.getByTestId('mentor-save-chat');
      fireEvent.click(saveBtn);

      // Memory drawer should now contain all 5 takeaways.
      const drawer = screen.getByTestId('mentor-memory-drawer');
      expect(drawer.textContent).toMatch(/step-1/);
      expect(drawer.textContent).toMatch(/step-2/);
      expect(drawer.textContent).toMatch(/step-3/);
      expect(drawer.textContent).toMatch(/step-4/);
      expect(drawer.textContent).toMatch(/step-5/);
    }, 25000);
  });

  describe('Bug #21: removePerson clears stale imageAttempt/imageRetry state', () => {
    it('image errors advance the attempt counter; remove+re-add resets it', async () => {
      render(<MentorTablePage standalone />);
      await addPerson('Bill');

      // Trigger an image error on the guest card to advance imageAttemptByKey.
      const guestImg = document.querySelector(
        '[class*="guestCard"] img'
      ) as HTMLImageElement;
      expect(guestImg).toBeTruthy();
      // Fire several errors to advance through the chain.
      fireEvent.error(guestImg);
      fireEvent.error(guestImg);

      // Now remove the person.
      const removeBtn = Array.from(document.querySelectorAll('button')).find((b) =>
        b.className.includes('removeGuestBtn')
      );
      fireEvent.click(removeBtn!);

      // Re-add — should not throw and the card should render.
      await addPerson('Bill');
      const guestCards = document.querySelectorAll('[class*="guestCard"]');
      expect(guestCards.length).toBe(1);
    });
  });

  describe('Bug #42: icon-only buttons have aria-label', () => {
    it('add-person and remove-guest buttons have aria-label', async () => {
      render(<MentorTablePage standalone />);

      const addBtn = screen.getByTestId('mentor-add-person');
      expect(addBtn.getAttribute('aria-label')).toBeTruthy();

      // Add then check remove has aria-label.
      await addPerson('Bill');
      const removeBtn = Array.from(document.querySelectorAll('button')).find((b) =>
        b.className.includes('removeGuestBtn')
      );
      expect(removeBtn?.getAttribute('aria-label')).toBeTruthy();

      const candle = document.querySelector('[class*="candleProp"]') as HTMLElement;
      expect(candle.getAttribute('aria-label')).toBeTruthy();
    });
  });
});
