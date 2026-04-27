import { useState } from 'react';
import { MentorProfile } from '../../../features/mentorTable/mentorProfiles';
import { generateMentorAdvice, MentorConversationMessage } from '../../../features/mentorTable/mentorApi';

export interface NoteThreadEntry {
  role: 'user' | 'mentor';
  text: string;
}

export interface ConversationTurn {
  id: string;
  user: string;
  replies: Array<{ mentorName: string; text: string }>;
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
  generateFollowup: (mentorName: string, userText: string) => string;
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
    generateFollowup,
    reportGenerateError,
    appendConversationTurn,
    uniqueId,
    coordinateWithAll,
    isRoundGenerating,
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
    let mentorReply = generateFollowup(mentorName, text);
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
      }
    } catch (err) {
      // Bug-bash round 1: surface mentor API failures to the user instead of
      // swallowing them. Fallback text from generateFollowup is still used so
      // the thread has some response.
      // F157: full detail goes to console; the banner shows stable copy only.
      reportGenerateError(err);
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
    appendConversationTurn({
      // Bug #22: collision-safe id via uniqueId (crypto.randomUUID fallback).
      id: uniqueId(`turn-${threadKey}`),
      user: text,
      replies: [{ mentorName, text: mentorReply }]
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
