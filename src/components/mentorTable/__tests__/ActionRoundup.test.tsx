import '@testing-library/jest-dom';
import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ActionRoundup } from '../ActionRoundup';

describe('ActionRoundup', () => {
  it('renders every mentor action as a named semantic list item', () => {
    const entries = Array.from({ length: 10 }, (_, index) => ({
      key: `mentor-${index}`,
      mentorName: `Mentor ${index + 1}`,
      actionStep: `Action ${index + 1}`,
    }));

    render(
      <ActionRoundup
        id="mentor-action-roundup"
        heading="Mentor action roundup"
        entries={entries}
      />
    );

    const article = screen.getByRole('article', { name: 'Mentor action roundup' });
    const list = within(article).getByRole('list', { name: 'Mentor action roundup' });
    const items = within(list).getAllByRole('listitem');

    expect(items).toHaveLength(10);
    entries.forEach((entry, index) => {
      expect(items[index]).toHaveTextContent(entry.mentorName);
      expect(items[index]).toHaveTextContent(entry.actionStep);
    });
  });
});
