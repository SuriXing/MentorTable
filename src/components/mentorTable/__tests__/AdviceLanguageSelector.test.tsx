import '@testing-library/jest-dom';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { AdviceLanguageSelector } from '../AdviceLanguageSelector';

describe('AdviceLanguageSelector', () => {
  const labels = {
    legend: 'Mentor reply language',
    hint: 'Replies are available in every interface language.',
    english: 'English',
    chinese: '简体中文',
    japanese: '日本語',
    korean: '한국어',
    spanish: 'Español',
  };

  it('renders a named radio group and reports selection changes', () => {
    const onChange = vi.fn();
    render(
      <AdviceLanguageSelector
        value="en"
        onChange={onChange}
        labels={labels}
      />
    );

    expect(screen.getByRole('group', { name: labels.legend })).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: labels.english })).toBeChecked();
    expect(screen.getByText(labels.hint)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('radio', { name: labels.chinese }));
    expect(onChange).toHaveBeenCalledWith('zh-CN');
    fireEvent.click(screen.getByRole('radio', { name: labels.japanese }));
    expect(onChange).toHaveBeenCalledWith('ja');
    fireEvent.click(screen.getByRole('radio', { name: labels.korean }));
    expect(onChange).toHaveBeenCalledWith('ko');
    fireEvent.click(screen.getByRole('radio', { name: labels.spanish }));
    expect(onChange).toHaveBeenCalledWith('es');
  });
});
