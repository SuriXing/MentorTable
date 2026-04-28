import React from 'react';
import styles from '../pages/MentorTablePage.module.css';

export interface SuggestionDeckEntry {
  key: string;
  mentorIndex: number;
  displayName: string;
  likelyResponse: string;
  oneActionStep: string;
  status?: 'ready' | 'typing';
  replyId?: string;
}

export interface ExpandedSuggestionCard {
  mentorName: string;
  likelyResponse: string;
  oneActionStep: string;
}

export type DeckLang = 'zh' | 'en';

export function truncateWithEllipsis(text: string, maxChars: number): { text: string; isTruncated: boolean } {
  const compact = text.replace(/\s+/g, ' ').trim();
  if (compact.length <= maxChars) return { text: compact, isTruncated: false };
  return { text: `${compact.slice(0, maxChars).trimEnd()}...`, isTruncated: true };
}

export function simplifyLikelyResponse(text: string, lang: DeckLang): string {
  const compact = text.replace(/\s+/g, ' ').trim();
  // Callers only reach this when mentorReplies have been produced, and the
  // API schema requires likelyResponse to be a non-empty string, so the
  // empty-guard is dead and was removed.
  if (lang === 'zh') {
    return compact
      .replace(/^我(?:会|建议)?先(?:把这个)?拆成可执行步骤(?:先)?[:：]?\s*/u, '')
      .replace(/^我(?:会|建议)(?:先)?[:：]?\s*/u, '')
      .replace(/^可以先[:：]?\s*/u, '')
      .trim();
  }
  return compact
    .replace(/^i\s+(?:would|will|suggest|recommend)\s+break\s+this\s+into\s+executable\s+steps\s+first[:,]?\s*/iu, '')
    .replace(/^i\s+(?:would|will|suggest|recommend)\s+/iu, '')
    .replace(/^let'?s\s+/iu, '')
    .trim();
}

export function simplifyActionStep(text: string, lang: DeckLang): string {
  const compact = text.replace(/\s+/g, ' ').trim();
  if (!compact) return compact;
  if (lang === 'zh') {
    return compact.replace(/^下一步[:：]\s*/u, '').trim();
  }
  return compact.replace(/^next\s+step(?:\s*\(today\))?[:：]\s*/iu, '').trim();
}

interface SuggestionDeckProps {
  entries: SuggestionDeckEntry[];
  totalMentorSlots: number;
  lang: DeckLang;
  expandedReplyId: string;
  /** Page-owned table-geometry placement for a card. */
  placementFor: (mentorIndex: number, totalMentors: number) => React.CSSProperties;
  onSelectSuggestion: (card: ExpandedSuggestionCard) => void;
  onSelectReply: (replyId: string) => void;
  labels: {
    mentorTyping: string;
    clickToExpand: string;
  };
}

/**
 * F162 (P15): the floating suggestion deck over the round table, extracted
 * from MentorTablePage. Card previews, typing placeholders, and click
 * targets are presentation-only; deck entry derivation and expansion state
 * stay in the page.
 */
export function SuggestionDeck({
  entries,
  totalMentorSlots,
  lang,
  expandedReplyId,
  placementFor,
  onSelectSuggestion,
  onSelectReply,
  labels,
}: SuggestionDeckProps) {
  return (
    <div className={styles.suggestionDeck}>
      {entries.map((entry) => {
        const cardStyle = placementFor(entry.mentorIndex, totalMentorSlots);
        const actionPreview = truncateWithEllipsis(
          simplifyActionStep(entry.oneActionStep, lang),
          totalMentorSlots > 6 ? 24 : totalMentorSlots > 3 ? 32 : 44
        );
        const reasonPreview = truncateWithEllipsis(
          simplifyLikelyResponse(entry.likelyResponse, lang),
          totalMentorSlots > 6 ? 28 : totalMentorSlots > 3 ? 36 : 50
        );
        const hasTrimmed = reasonPreview.isTruncated || actionPreview.isTruncated;

        if (!entry.replyId) {
          if (entry.status === 'typing') {
            return (
              <article
                key={entry.key}
                className={`${styles.suggestionCard} ${styles.suggestionCardTyping}`}
                style={cardStyle}
              >
                <h3>{entry.displayName}</h3>
                <p className={styles.suggestionPrimary}>{labels.mentorTyping}</p>
              </article>
            );
          }

          return (
            <button
              type="button"
              key={entry.key}
              className={styles.suggestionCard}
              style={cardStyle}
              onClick={(e) => {
                e.stopPropagation();
                onSelectSuggestion({
                  mentorName: entry.displayName,
                  likelyResponse: entry.likelyResponse,
                  oneActionStep: entry.oneActionStep
                });
              }}
            >
              <h3>{entry.displayName}</h3>
              <p className={styles.suggestionPrimary}>{actionPreview.text}</p>
              <p className={styles.suggestionSecondary}>{reasonPreview.text}</p>
              {hasTrimmed && <span className={styles.replyExpandHint}>{labels.clickToExpand}</span>}
            </button>
          );
        }

        return (
          <article
            key={entry.key}
            className={`${styles.tableReplyCard} ${styles.mentorReplyPreview} ${expandedReplyId === entry.replyId ? styles.tableReplyCardActive : ''}`}
            style={cardStyle}
            onClick={(e) => {
              e.stopPropagation();
              onSelectReply(entry.replyId || '');
            }}
          >
            <header>{entry.displayName}</header>
            <p className={styles.suggestionPrimary}>{actionPreview.text}</p>
            <footer className={styles.suggestionSecondary}>{reasonPreview.text}</footer>
            {hasTrimmed && <span className={styles.replyExpandHint}>{labels.clickToExpand}</span>}
          </article>
        );
      })}
    </div>
  );
}
