/**
 * P21 / F173 — automated a11y scan (axe-core) across the page's renderable
 * phases in jsdom.
 *
 * SCOPE LIMIT (important): jsdom has no real layout engine, so axe cannot
 * evaluate color-contrast or anything requiring geometry. This file covers
 * the rule families that DO work headless: ARIA usage, form labels, roles,
 * duplicate ids, landmark structure, button/link naming. The full matrix
 * (5 themes x 2 modes x 2 languages, contrast included) lives in
 * e2e/a11y-matrix.spec.ts and needs a real browser — run it with
 * `npx playwright install chromium && npx playwright test` on a machine
 * with network access.
 *
 * axe-core is currently a transitive dependency of @axe-core/playwright;
 * if that ever stops hoisting it, add axe-core to devDependencies.
 */
import '@testing-library/jest-dom';
import { render, waitFor } from '@testing-library/react';
import { vi, describe, it, expect, beforeEach } from 'vitest';
import axeSource from 'axe-core/axe.min.js?raw';
// axe-core's CJS entry exposes only version/source — eval the browser
// bundle once to get the real axe runtime object.
const axe = new Function(`${axeSource}; return axe;`)();

(globalThis as any).__mentorTestState = {
  language: 'en',
  fetchPersonImage: async () => undefined,
  fetchPersonImageCandidates: async () => undefined,
  searchPeopleWithPhotos: async () => [],
  getChineseDisplayName: (name: string) => name,
  findVerifiedPerson: () => undefined,
};

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (k: string, opts?: { defaultValue?: string }) =>
      String(
        ((globalThis as any).__resources?.en ?? {})[k] ?? opts?.defaultValue ?? k
      ),
    i18n: { language: 'en', changeLanguage: vi.fn() },
  }),
}));

vi.mock('@fortawesome/react-fontawesome', () => ({
  FontAwesomeIcon: ({ icon }: { icon: { iconName?: string } }) => (
    <span data-fa={icon?.iconName || 'icon'} />
  ),
}));

const generateMentorAdviceMock = vi.fn();

vi.mock('../../../features/mentorTable/mentorApi', () => ({
  generateMentorAdvice: (args: unknown) => generateMentorAdviceMock(args),
  fetchMentorDebugPrompt: vi.fn(),
}));

vi.mock('../../../features/mentorTable/mentorProfiles', () => ({
  createCustomMentorProfile: (name: string) => ({
    id: `custom_${name.toLowerCase().replace(/\s+/g, '_')}`,
    displayName: name,
    archetype: 'Mentor',
    voice: 'analytical',
    strengths: ['clarity'],
    watchouts: [],
    signatureQuestions: [],
    language: 'en',
  }),
  getCartoonAvatarUrl: () => 'https://example.com/cartoon.svg',
  getSuggestedPeople: () => [],
}));

vi.mock('../../../features/mentorTable/personLookup', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    fetchPersonImage: async () => undefined,
    fetchPersonImageCandidates: async () => undefined,
    findVerifiedPerson: () => undefined,
    getChineseDisplayName: (name: string) => name,
    getVerifiedPlaceholderImage: () => 'data:image/svg+xml;utf8,placeholder',
    searchPeopleWithPhotos: async () => [],
    searchVerifiedPeopleLocal: () => [],
  };
});

vi.mock('../../../hooks/useTheme', () => ({
  useTheme: vi.fn().mockReturnValue({
    themeId: 'blue',
    mode: 'light',
    setThemeId: vi.fn(),
    setMode: vi.fn(),
  }),
}));

import MentorTablePage from '../MentorTablePage';
import enResources from '../../../locales/en/translation.json';
(globalThis as any).__resources = { en: enResources };

async function scanAxe(container: HTMLElement) {
  const results = await axe.run(container, {
    rules: {
      // jsdom cannot compute color — the contrast family is a real-browser job.
      'color-contrast': { enabled: false },
    },
  });
  const violations = results.violations.filter((v: { id: string }) => !['color-contrast'].includes(v.id));
  return violations;
}

describe('axe-core a11y scan (P21/F173, jsdom rule families)', () => {
  beforeEach(() => {
    generateMentorAdviceMock.mockReset();
    localStorage.clear();
    localStorage.setItem('mentorTableOnboardingHiddenV2', '1');
  });

  it('invite phase: no violations', async () => {
    const { container } = render(<MentorTablePage standalone />);
    await waitFor(() => {
      expect(container.querySelector('[data-testid="mentor-person-input"]')).toBeTruthy();
    });
    const violations = await scanAxe(container);
    expect(
      violations.map((v: { id: string; impact?: string; nodes: unknown[] }) => ({ id: v.id, impact: v.impact, nodes: v.nodes.length }))
    ).toEqual([]);
  });

  it('onboarding modal open: no violations', async () => {
    localStorage.removeItem('mentorTableOnboardingHiddenV2');
    const { container } = render(<MentorTablePage standalone />);
    const violations = await scanAxe(container);
    expect(
      violations.map((v: { id: string; impact?: string; nodes: unknown[] }) => ({ id: v.id, impact: v.impact, nodes: v.nodes.length }))
    ).toEqual([]);
  });
});
