import React from 'react';
import type { AdviceLanguage } from '../../features/mentorTable/adviceLanguage';
import styles from '../pages/MentorTablePage.module.css';

interface AdviceLanguageSelectorProps {
  value: AdviceLanguage;
  onChange: (language: AdviceLanguage) => void;
  labels: {
    legend: string;
    hint: string;
    english: string;
    chinese: string;
  };
}

export function AdviceLanguageSelector({
  value,
  onChange,
  labels,
}: AdviceLanguageSelectorProps) {
  const hintId = 'mentor-advice-language-hint';
  const options: Array<{ value: AdviceLanguage; label: string }> = [
    { value: 'en', label: labels.english },
    { value: 'zh-CN', label: labels.chinese },
  ];

  return (
    <fieldset className={styles.adviceLanguageFieldset} aria-describedby={hintId}>
      <legend>{labels.legend}</legend>
      <div className={styles.adviceLanguageOptions}>
        {options.map((option) => (
          <label
            key={option.value}
            className={`${styles.adviceLanguageOption} ${value === option.value ? styles.adviceLanguageOptionActive : ''}`}
          >
            <input
              type="radio"
              name="mentor-advice-language"
              value={option.value}
              checked={value === option.value}
              onChange={() => onChange(option.value)}
            />
            <span>{option.label}</span>
          </label>
        ))}
      </div>
      <p id={hintId} className={styles.adviceLanguageHint}>{labels.hint}</p>
    </fieldset>
  );
}
