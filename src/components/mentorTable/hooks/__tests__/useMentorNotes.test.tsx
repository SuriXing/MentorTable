import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useMentorNotes } from '../useMentorNotes';
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
  const appendConversationTurn = vi.fn();
  return {
    generationSeqRef,
    appendConversationTurn,
    options: {
      selectedMentors: [mentor],
      adviceLanguage: 'en' as const,
      threadKeyFor: (rawName: string) => rawName.trim().toLowerCase(),
      localizeName: (value: string) => value,
      resolveName: (value: string) => value,
      normalizeKey: (value: string) => value.trim().toLowerCase(),
      buildConversationHistory: () => [],
      formatNoteDeliveryFailure: (name: string) => `failed ${name}`,
      formatNoteNoResponse: (name: string) => `no ${name}`,
      reportGenerateError: vi.fn(),
      appendConversationTurn,
      uniqueId: (prefix: string) => `${prefix}-1`,
      coordinateWithAll: false,
      generationSeqRef,
      setIsRoundGenerating: vi.fn(),
    },
  };
}

describe('useMentorNotes race guard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('appends a delivered note to its thread', async () => {
    mockGenerate.mockResolvedValueOnce(okResult);
    const { options, appendConversationTurn } = makeOptions();
    const { result } = renderHook(() => useMentorNotes(options));
    act(() => {
      result.current.setNoteDrafts({ m1: 'hello' });
    });

    await act(async () => {
      await result.current.submitNoteToMentor('M1');
    });

    expect(result.current.noteReplies.m1).toHaveLength(2);
    expect(appendConversationTurn).toHaveBeenCalledTimes(1);
  });

  it('drops a late note after a reset', async () => {
    let settle!: (value: MentorSimulationResult) => void;
    const pending = new Promise<MentorSimulationResult>((resolve) => {
      settle = resolve;
    });
    mockGenerate.mockReturnValueOnce(pending);

    const { options, generationSeqRef, appendConversationTurn } = makeOptions();
    const { result } = renderHook(() => useMentorNotes(options));
    act(() => {
      result.current.setNoteDrafts({ m1: 'hello' });
    });

    act(() => {
      void result.current.submitNoteToMentor('M1');
    });
    generationSeqRef.current += 1;
    settle(okResult);
    await act(async () => {});

    expect(result.current.noteReplies).toEqual({});
    expect(appendConversationTurn).not.toHaveBeenCalled();
  });
});
