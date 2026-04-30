import React from 'react';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faBookOpen } from '@fortawesome/free-solid-svg-icons';
import styles from '../pages/MentorTablePage.module.css';

interface MemoryDrawerProps {
  open: boolean;
  onToggle: () => void;
  memories: Array<{
    id: string;
    title: string;
    createdAt: string;
    takeaways: string[];
  }>;
  saveNotice: string;
  labels: {
    memories: string;
    drawerTitle: string;
    drawerHint: string;
    empty: string;
  };
}

/**
 * F162 (P12): the floating memories button, save notice (SR-3), and the
 * memory drawer itself, extracted verbatim from MentorTablePage. State and
 * persistence stay in the page.
 */
export function MemoryDrawer({
  open,
  onToggle,
  memories,
  saveNotice,
  labels,
}: MemoryDrawerProps) {
  return (
    <>
      <button type="button" data-testid="mentor-memory-fab" className={styles.memoryFab} onClick={onToggle}>
        <FontAwesomeIcon icon={faBookOpen} /> {labels.memories} ({memories.length})
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

      {open && (
        <div data-testid="mentor-memory-drawer" className={styles.memoryDrawer}>
          <h3>{labels.drawerTitle}</h3>
          <p className={styles.memoryHint}>{labels.drawerHint}</p>
          {memories.length === 0 && <p className={styles.emptyMemory}>{labels.empty}</p>}
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
    </>
  );
}
