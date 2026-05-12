import React from 'react';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faChevronLeft } from '@fortawesome/free-solid-svg-icons';
import styles from '../pages/MentorTablePage.module.css';
import type { NoteThreadEntry } from '../../features/mentorTable/conversationTypes';
import type { MentorSimulationResult } from '../../features/mentorTable/mentorEngine';

interface ReplyThreadOverlayProps {
  reply: { mentorName: string; likelyResponse: string; oneActionStep: string };
  trapRef: React.RefObject<HTMLDivElement>;
  onClose: () => void;
  /** Locale-resolved display name for the mentor. */
  displayName: string;
  threadKey: string;
  notes: NoteThreadEntry[];
  /** Maps a reply meta snapshot to a source chip label (null = live, no chip). */
  sourceLabelFor?: (meta: MentorSimulationResult['meta'] | undefined) => string | null;
  noteDraft: string;
  onNoteDraftChange: (text: string) => void;
  noteOpen: boolean;
  onToggleNoteOpen: () => void;
  onSubmitNote: () => void;
  isRoundGenerating: boolean;
  labels: {
    backToTable: string;
    passNoteTo: string;
    replyTo: string;
    typing: string;
    send: string;
    you: string;
  };
  lang: 'zh' | 'en';
}

/**
 * F162 (P15): the live-session reply overlay with the inline note thread
 * (pass-a-note-to-this-mentor), extracted verbatim from MentorTablePage.
 * Note state and the submit flow stay in useMentorNotes / the page.
 */
export function ReplyThreadOverlay({
  reply,
  trapRef,
  onClose,
  displayName,
  threadKey,
  notes,
  sourceLabelFor,
  noteDraft,
  onNoteDraftChange,
  noteOpen,
  onToggleNoteOpen,
  onSubmitNote,
  isRoundGenerating,
  labels,
  lang,
}: ReplyThreadOverlayProps) {
  return (
    <div
      className={styles.replyExpandOverlay}
      role="dialog"
      aria-modal="true"
      aria-label={displayName}
      tabIndex={-1}
      ref={trapRef}
      onClick={onClose}
    >
      <button
        type="button"
        className={styles.expandBackTopLeft}
        onClick={(e) => {
          e.stopPropagation();
          onClose();
        }}
      >
        <FontAwesomeIcon icon={faChevronLeft} /> {labels.backToTable}
      </button>
      <article
        className={`${styles.replyExpandedCard} ${styles.replyExpandedSticky}`}
        onClick={(e) => e.stopPropagation()}
      >
        <header>{displayName}</header>
        <p>{reply.likelyResponse}</p>
        <footer>{lang === 'zh' ? '下一步：' : 'Next move: '} {reply.oneActionStep}</footer>
        <button
          type="button"
          className={styles.passNoteBtn}
          onClick={onToggleNoteOpen}
        >
          {labels.passNoteTo} {displayName}
        </button>
        {noteOpen && (
          <div className={styles.inlineNoteBox}>
            <textarea
              value={noteDraft}
              onChange={(e) => onNoteDraftChange(e.target.value)}
              placeholder={`${labels.replyTo} ${displayName}...`}
              rows={2}
            />
            <div className={styles.inlineNoteActions}>
              <button
                type="button"
                className={styles.ghostBtn}
                disabled={isRoundGenerating}
                onClick={onSubmitNote}
              >
                {isRoundGenerating ? labels.typing : labels.send}
              </button>
            </div>
          </div>
        )}
        {notes.map((note, idx) => (
          <div
            key={`${threadKey}-expanded-note-${idx}`}
            className={note.role === 'error' ? styles.noteThreadError : styles.noteThread}
          >
            {note.role === 'user'
              ? `${labels.you}: ${note.text}`
              : note.role === 'error'
                ? note.text
                : `${displayName}: ${note.text}`}
            {note.role === 'mentor' && note.source && sourceLabelFor?.(note.source) && (
              <span className={styles.sourceTagSmall}>{sourceLabelFor(note.source)}</span>
            )}
          </div>
        ))}
      </article>
    </div>
  );
}
