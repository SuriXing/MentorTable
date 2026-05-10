import { useState } from 'react';
import { MentorProfile } from '../../../features/mentorTable/mentorProfiles';
import { generateMentorAdvice, MentorConversationMessage } from '../../../features/mentorTable/mentorApi';
import type { MentorSimulationResult } from '../../../features/mentorTable/mentorEngine';

type AiMeta = MentorSimulationResult['meta'];

export interface NoteThreadEntry {
  role: 'user' | 'mentor' | 'error';
  text: string;
  /** Meta snapshot of the response this entry came from (badge honesty). */
  source?: AiMeta;
}

export interface ConversationTurn {
  id: string;
  user: string;
  replies: Array<{ mentorName: string; text: string; source?: AiMeta }>;
}

interface UseMentorNotesOptions {
  selectedMentors: MentorProfile[];
  uiLanguage: 'zh-CN' | 'en';
  /** Page-owned identity helpers (locale-aware). */
  threadKeyFor: (rawName: string) => string;
  localizeName: (rawName: string) => string;
  resolveName: (rawName: string) => string;
  normalizeKey: (name: string) => string;
  /** Page-owned: full conversation history incl. table replies. */
  buildConversationHistory: (latestUserText: string) => MentorConversationMessage[];
  /** Locale copy for a note the API could not deliver (transport failure). */
  formatNoteDeliveryFailure: (mentorName: string) => string;
  /** Locale copy for a 200 response that carried no reply for the mentor. */
  formatNoteNoResponse: (mentorName: string) => string;
  reportGenerateError: (err: unknown) => void;
  appendConversationTurn: (turn: ConversationTurn) => void;
  uniqueId: (prefix: string) => string;
  coordinateWithAll: boolean;
  /** Shared with reply-all; owned by the page. */
  isRoundGenerating: boolean;
  setIsRoundGenerating: React.Dispatch<React.SetStateAction<boolean>>;
}

/**
 * F162 (P14): note-to-mentor threads extracted from MentorTablePage —
 * per-thread drafts, note history, the inline-note open state, and
 * submitNoteToMentor (which talks to the LLM with the whole table's
 * conversation history and appends the exchange as a conversation turn).
 * The reveal timers, table replies, and session phase stay in the page.
 */
export function useMentorNotes(options: UseMentorNotesOptions): {
  openNoteFor: string;
  setOpenNoteFor: React.Dispatch<React.SetStateAction<string>>;
  noteDrafts: Record<string, string>;
  setNoteDrafts: React.Dispatch<React.SetStateAction<Record<string, string>>>;
  noteReplies: Record<string, NoteThreadEntry[]>;
  submitNoteToMentor: (rawName: string) => Promise<void>;
  resetNotes: () => void;
} {
  const {
    selectedMentors,
    uiLanguage,
    threadKeyFor,
    localizeName,
    resolveName,
    normalizeKey,
    buildConversationHistory,
    formatNoteDeliveryFailure,
    formatNoteNoResponse,
    reportGenerateError,
    appendConversationTurn,
    uniqueId,
    coordinateWithAll,
    setIsRoundGenerating,
  } = options;

  const [openNoteFor, setOpenNoteFor] = useState<string>('');
  const [noteDrafts, setNoteDrafts] = useState<Record<string, string>>({});
  const [noteReplies, setNoteReplies] = useState<Record<string, NoteThreadEntry[]>>({});

  const submitNoteToMentor = async (rawName: string) => {
    const threadKey = threadKeyFor(rawName);
    const mentorName = localizeName(resolveName(rawName));
    const targetKey = normalizeKey(rawName);
    const text = (noteDrafts[threadKey] || '').trim();
    if (!text) return;
    // The inline-note send button is disabled while isRoundGenerating, so a
    // re-entrant call is UI-unreachable. The belt-and-suspenders guard was
    // removed.

    setIsRoundGenerating(true);
    let mentorReply: string | null = null;
    let delivered = false;
    let transportFailed = false;
    let replyMeta: AiMeta | undefined;
    const targetMentor = selectedMentors.find((mentor) => {
      return normalizeKey(mentor.displayName) === targetKey || normalizeKey(mentor.id) === targetKey;
    });
    const coordinatedMentorSet =
      coordinateWithAll && selectedMentors.length > 1
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

      const targetMentorIdKey = targetMentor ? normalizeKey(targetMentor.id) : '';
      const targetMentorNameKey = targetMentor ? normalizeKey(targetMentor.displayName) : targetKey;
      const aiReply =
        aiResult.mentorReplies.find((reply) => targetMentorIdKey && normalizeKey(reply.mentorId) === targetMentorIdKey) ||
        aiResult.mentorReplies.find((reply) => normalizeKey(reply.mentorName) === targetMentorNameKey) ||
        aiResult.mentorReplies.find((reply) => normalizeKey(reply.mentorName) === targetKey) ||
        aiResult.mentorReplies[0];
      if (aiReply?.likelyResponse) {
        mentorReply = aiReply.likelyResponse;
        replyMeta = aiResult.meta;
        delivered = true;
      }
    } catch (err) {
      transportFailed = true;
      // F157: full detail goes to console; the banner shows stable copy only.
      reportGenerateError(err);
    } finally {
      setIsRoundGenerating(false);
    }

    if (!delivered) {
      // A failed or empty response never becomes mentor speech. The thread
      // gets an explicit non-speech marker instead: delivery failure leaves
      // the draft in place so the note can be retried; a 200 without a
      // matching reply reads as "no response". Nothing is appended to the
      // table conversation either way — the table only records exchanges
      // that actually happened.
      const markerText = transportFailed
        ? formatNoteDeliveryFailure(mentorName)
        : formatNoteNoResponse(mentorName);
      setNoteReplies((prev) => ({
        ...prev,
        [threadKey]: [
          ...(prev[threadKey] || []),
          { role: 'user', text },
          { role: 'error', text: markerText }
        ]
      }));
      setOpenNoteFor(threadKey);
      return;
    }

    setNoteReplies((prev) => ({
      ...prev,
      [threadKey]: [
        ...(prev[threadKey] || []),
        { role: 'user', text },
        { role: 'mentor', text: mentorReply!, source: replyMeta }
      ]
    }));
    appendConversationTurn({
      // Bug #22: collision-safe id via uniqueId (crypto.randomUUID fallback).
      id: uniqueId(`turn-${threadKey}`),
      user: text,
      replies: [{ mentorName, text: mentorReply!, source: replyMeta }]
    });
    setNoteDrafts((prev) => ({ ...prev, [threadKey]: '' }));
    setOpenNoteFor(threadKey);
  };

  const resetNotes = () => {
    setOpenNoteFor('');
    setNoteDrafts({});
    setNoteReplies({});
  };

  return {
    openNoteFor,
    setOpenNoteFor,
    noteDrafts,
    setNoteDrafts,
    noteReplies,
    submitNoteToMentor,
    resetNotes,
  };
}
