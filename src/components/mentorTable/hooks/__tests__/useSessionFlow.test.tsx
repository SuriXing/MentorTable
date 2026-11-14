import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useSessionFlow } from '../useSessionFlow';
import type { MentorProfile } from '../../../../features/mentorTable/mentorProfiles';
import type { MentorSimulationResult } from '../../../../features/mentorTable/mentorEngine';

vi.mock('../../../../features/mentorTable/mentorApi', () => ({
  generateMentorAdvice: vi.fn(),
}));

import { generateMentorAdvice } from '../../../../features/mentorTable/mentorApi';

const mockGenerate = vi.mocked(generateMentorAdvice);

const mentor: MentorProfile = {
  id: 'custom_m1',
  displayName: 'M1',
  shortLabel: 'M1',
  speakingStyle: ['direct'],
  coreValues: ['clarity'],
  decisionPatterns: ['pick one step'],
  knownExperienceThemes: ['building'],
  likelyBlindSpots: ['emotion'],
  avoidClaims: [],
};

const okResult: MentorSimulationResult = {
  schemaVersion: 'mentor_table.v1',
  language: 'en',
  safety: { riskLevel: 'low', needsProfessionalHelp: false, emergencyMessage: '' },
  mentorReplies: [
    {
      mentorId: 'custom_m1',
      mentorName: 'M1',
      likelyResponse: 'A',
      whyThisFits: 'B',
      oneActionStep: 'C',
      confidenceNote: 'D',
    },
  ],
  meta: { disclaimer: 'd', generatedAt: 't', source: 'llm' },
};

function makeOptions() {
  const generationSeqRef = { current: 0 };
  return {
    generationSeqRef,
    options: {
      selectedMentors: [mentor],
      adviceLanguage: 'en' as const,
      isZh: false,
      isConversationHovered: false,
      scheduleTimeout: () => 0,
      isMountedRef: { current: true },
      activeIndexRef: { current: 0 },
      conversationPanelRef: { current: null },
      normalizeKey: (value: string) => value.trim().toLowerCase(),
      localizeName: (value: string) => value,
      resolveMentorName: (value: string) => value,
      youLabel: 'You',
      sessionStartRef: { current: null },
      generationSeqRef,
    },
  };
}

describe('useSessionFlow race guards', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('commits a finished generation to the session', async () => {
    mockGenerate.mockResolvedValueOnce(okResult);
    const { options } = makeOptions();
    const { result } = renderHook(() => useSessionFlow(options));

    act(() => {
      void result.current.handleGenerate();
    });
    await act(async () => {});

    expect(result.current.result).toEqual(okResult);
    expect(result.current.phase).toBe('session');
    expect(result.current.sessionMode).toBe('live');
  });

  it('drops a generation whose session was reset while it was in flight', async () => {
    let settle!: (value: MentorSimulationResult) => void;
    const pending = new Promise<MentorSimulationResult>((resolve) => {
      settle = resolve;
    });
    mockGenerate.mockReturnValueOnce(pending);

    const { options, generationSeqRef } = makeOptions();
    const { result } = renderHook(() => useSessionFlow(options));

    act(() => {
      void result.current.handleGenerate();
    });
    expect(result.current.sessionMode).toBe('booting');

    // The page bumps the counter on restart / edit / new table.
    generationSeqRef.current += 1;
    settle(okResult);
    await act(async () => {});

    expect(result.current.result).toBeNull();
    expect(result.current.sessionMode).not.toBe('live');
  });

  it('drops a late reply-all round after a reset', async () => {
    let settle!: (value: MentorSimulationResult) => void;
    const pending = new Promise<MentorSimulationResult>((resolve) => {
      settle = resolve;
    });
    mockGenerate.mockReturnValueOnce(pending);

    const { options, generationSeqRef } = makeOptions();
    const { result } = renderHook(() => useSessionFlow(options));
    act(() => {
      result.current.setReplyAllDraft('follow up');
    });

    act(() => {
      void result.current.handleReplyAll();
    });
    generationSeqRef.current += 1;
    settle(okResult);
    await act(async () => {});

    expect(result.current.conversationTurns).toHaveLength(0);
    expect(result.current.replyAllDraft).toBe('follow up');
  });
});
