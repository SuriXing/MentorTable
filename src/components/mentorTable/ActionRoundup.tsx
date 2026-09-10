import React from 'react';
import styles from '../pages/MentorTablePage.module.css';

export interface ActionRoundupEntry {
  key: string;
  mentorName: string;
  actionStep: string;
}

interface ActionRoundupProps {
  id: string;
  heading: string;
  entries: ActionRoundupEntry[];
}

export function ActionRoundup({ id, heading, entries }: ActionRoundupProps) {
  const headingId = `${id}-heading`;

  return (
    <article
      id={id}
      className={`${styles.conversationBubble} ${styles.actionRoundupCard}`}
      aria-labelledby={headingId}
    >
      <header id={headingId}>{heading}</header>
      <ul className={styles.actionRoundupList} aria-labelledby={headingId}>
        {entries.map((entry) => (
          <li key={entry.key} className={styles.actionRoundupItem}>
            <span className={styles.actionRoundupMentor}>{entry.mentorName}</span>
            <p className={styles.actionRoundupStep}>{entry.actionStep}</p>
          </li>
        ))}
      </ul>
    </article>
  );
}
