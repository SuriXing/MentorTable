/**
 * Conversation shapes shared by the session-flow and note-thread hooks.
 * They used to live inside hook modules, which made the type graph lie
 * about ownership — the page and the overlay imported types "from a hook"
 * they don't own. Types live here; hooks own behavior.
 */

import type { MentorSimulationResult } from './mentorEngine';

export type AiMeta = MentorSimulationResult['meta'];

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
