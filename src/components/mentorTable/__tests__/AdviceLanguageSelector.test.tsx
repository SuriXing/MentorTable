import '@testing-library/jest-dom';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { AdviceLanguageSelector } from '../AdviceLanguageSelector';

describe('AdviceLanguageSelector', () => {
  const labels = {
    legend: 'Mentor reply language',
    hint: 'Replies are currently available in English and Simplified Chinese.',
    english: 'English',
    chinese: 'Simplified Chinese',
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
  });
});
