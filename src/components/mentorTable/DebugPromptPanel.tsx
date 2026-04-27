import React from 'react';
import styles from '../pages/MentorTablePage.module.css';

interface DebugPromptPanelProps {
  mentorDisplayName: string;
  loading: boolean;
  promptText: string;
  error: string;
  onClose: () => void;
  labels: {
    title: string;
    loading: string;
    loadFailed: string;
    close: string;
  };
}

/**
 * F162 (P12): the hover/click debug prompt panel (KB-5), extracted verbatim
 * from MentorTablePage. Fetching of the debug prompt stays in the page —
 * this is the presentation surface only.
 */
export function DebugPromptPanel({
  mentorDisplayName,
  loading,
  promptText,
  error,
  onClose,
  labels,
}: DebugPromptPanelProps) {
  return (
    <aside className={styles.debugPromptPanel}>
      <div className={styles.debugPromptHeader}>
        <strong>{labels.title}</strong>
        <span>{mentorDisplayName}</span>
      </div>
      <pre className={styles.debugPromptBody}>
        {loading ? labels.loading : promptText || error || labels.loadFailed}
      </pre>
      <button type="button" className={styles.debugPromptCloseBtn} onClick={onClose}>
        {labels.close}
      </button>
    </aside>
  );
}
