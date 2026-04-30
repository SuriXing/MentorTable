import React from 'react';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faChevronLeft } from '@fortawesome/free-solid-svg-icons';
import styles from '../pages/MentorTablePage.module.css';
import type { ExpandedSuggestionCard } from './SuggestionDeck';

interface ExpandedSuggestionOverlayProps {
  card: ExpandedSuggestionCard;
  trapRef: React.RefObject<HTMLDivElement>;
  onClose: () => void;
  labels: {
    backToTable: string;
    nextMove: string;
  };
  lang: 'zh' | 'en';
}

/**
 * F162 (P15): the tap-a-card overlay showing one mentor's full suggestion,
 * extracted verbatim from MentorTablePage (KB-4 focus trap stays wired via
 * the page-owned trapRef).
 */
export function ExpandedSuggestionOverlay({
  card,
  trapRef,
  onClose,
  labels,
  lang,
}: ExpandedSuggestionOverlayProps) {
  return (
    <div
      className={styles.replyExpandOverlay}
      role="dialog"
      aria-modal="true"
      aria-label={card.mentorName}
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
        <header>{card.mentorName}</header>
        <p>{card.likelyResponse}</p>
        <footer>{lang === 'zh' ? '下一步：' : 'Next move: '} {card.oneActionStep}</footer>
      </article>
    </div>
  );
}
