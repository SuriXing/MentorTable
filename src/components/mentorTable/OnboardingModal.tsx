import React from 'react';
import styles from '../pages/MentorTablePage.module.css';

export interface OnboardingSlide {
  title: string;
  body: string;
}

interface OnboardingModalProps {
  slides: OnboardingSlide[];
  currentSlide: number;
  onSlideChange: (next: number) => void;
  dontShowAgain: boolean;
  onDontShowAgainChange: (next: boolean) => void;
  onFinish: () => void;
  trapRef: React.RefObject<HTMLDivElement>;
  labels: {
    skip: string;
    back: string;
    next: string;
    getStarted: string;
    dontShowAgain: string;
    keepShowing: string;
  };
}

/**
 * F162 (P12): the 3-slide onboarding tour, extracted verbatim from
 * MentorTablePage. The page keeps all state (slide index, dont-show flag,
 * persistence) — this component is the dialog surface only. Class names,
 * test hooks, and aria wiring are identical to the original inline block.
 */
export function OnboardingModal({
  slides,
  currentSlide,
  onSlideChange,
  dontShowAgain,
  onDontShowAgainChange,
  onFinish,
  trapRef,
  labels,
}: OnboardingModalProps) {
  if (slides.length === 0) return null;

  return (
    // KB-3 + R3 I-4: proper dialog semantics + focus trap + focus
    // return via useFocusTrap. Auto-focus and Escape are both
    // handled inside the hook.
    <div
      className={styles.onboardingOverlay}
      role="dialog"
      aria-modal="true"
      aria-labelledby="mentor-onboarding-title"
      ref={trapRef}
    >
      <div className={styles.onboardingCard}>
        {/* R2/F34: Skip button always visible — share-link visitors
            must be able to bypass the 3-slide tour to reach the form.
            R3/F50: label routed through the page's i18n bundle. */}
        <button
          type="button"
          className={styles.onboardingSkipBtn}
          onClick={onFinish}
          aria-label={labels.skip}
        >
          {labels.skip}
        </button>
        <h3 id="mentor-onboarding-title">{slides[currentSlide].title}</h3>
        <p>{slides[currentSlide].body}</p>
        {currentSlide === slides.length - 1 && (
          <div className={styles.onboardingChoiceBoxes}>
            <button
              type="button"
              className={`${styles.onboardingChoiceBox} ${dontShowAgain ? styles.onboardingChoiceBoxActive : ''}`}
              onClick={() => onDontShowAgainChange(true)}
            >
              {labels.dontShowAgain}
            </button>
            <button
              type="button"
              className={`${styles.onboardingChoiceBox} ${!dontShowAgain ? styles.onboardingChoiceBoxActive : ''}`}
              onClick={() => onDontShowAgainChange(false)}
            >
              {labels.keepShowing}
            </button>
          </div>
        )}
        <div className={styles.slideDots}>
          {slides.map((_, idx) => (
            <span key={idx} className={`${styles.slideDot} ${currentSlide === idx ? styles.slideDotActive : ''}`} />
          ))}
        </div>
        <div className={styles.onboardingActions}>
          <button
            type="button"
            className={styles.onboardingBtnSecondary}
            onClick={() => onSlideChange(Math.max(0, currentSlide - 1))}
            disabled={currentSlide === 0}
          >
            {labels.back}
          </button>
          {currentSlide < slides.length - 1 ? (
            <button
              type="button"
              className={styles.onboardingBtnPrimary}
              onClick={() => onSlideChange(Math.min(slides.length - 1, currentSlide + 1))}
            >
              {labels.next}
            </button>
          ) : (
            <button type="button" className={styles.onboardingBtnPrimary} onClick={onFinish}>
              {labels.getStarted}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
