/**
 * T2 close-out: integration over the REAL client stack, mocked only at the
 * network boundary. The page suite mocks the mentorApi module wholesale —
 * fine for page behavior, but it means page -> hook -> api client -> response
 * mapping is never exercised end to end, and a param-shape change or mapping
 * regression could pass the whole suite. Here the real mentorApi runs against
 * a stubbed global fetch; personLookup keeps the suite's standard test seam
 * (pure image-chain code stays real, network lookups are state-hooked).
 */
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, act, cleanup } from '@testing-library/react';
import React from 'react';

(globalThis as any).__mentorTestState = {
  language: 'en',
  fetchPersonImage: async (_n: string) => undefined,
  fetchPersonImageCandidates: async (_n: string) => undefined,
  searchPeopleWithPhotos: async (_q: string) => [] as Array<{ name: string; imageUrl?: string }>,
  getChineseDisplayName: (name: string) => name,
  findVerifiedPerson: (name: string) =>
    name.toLowerCase().includes('bill')
      ? {
          canonical: 'Bill Gates',
          imageUrl: 'https://example.com/bill.jpg',
          candidateImageUrls: ['https://example.com/bill2.jpg'],
        }
      : undefined,
};
const mentorTestState = (globalThis as any).__mentorTestState;

vi.mock('react-i18next', async () => {
  const enResources = (await import('../../../locales/en/translation.json')).default;
  const zhResources = (await import('../../../locales/zh-CN/translation.json')).default;
  const RESOURCES: Record<string, Record<string, unknown>> = { en: enResources, 'zh-CN': zhResources };
  return {
    useTranslation: () => ({
      t: (k: string, opts?: { defaultValue?: string }) => {
        const lang = (globalThis as any).__mentorTestState.language as string;
        return String((RESOURCES[lang] ?? RESOURCES.en)[k] ?? opts?.defaultValue ?? k);
      },
      i18n: {
        get language() {
          return (globalThis as any).__mentorTestState.language;
        },
        changeLanguage: vi.fn(),
      },
    }),
  };
});
vi.mock('../../../hooks/useTheme', () => ({
  useTheme: () => ({ theme: 'blue' }),
}));
vi.mock('@fortawesome/react-fontawesome', () => ({
  FontAwesomeIcon: () => null,
}));
vi.mock('../../../features/mentorTable/personLookup', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    fetchPersonImage: (name: string) => (globalThis as any).__mentorTestState.fetchPersonImage(name),
    fetchPersonImageCandidates: (name: string) =>
      (globalThis as any).__mentorTestState.fetchPersonImageCandidates(name),
    findVerifiedPerson: (name: string) => (globalThis as any).__mentorTestState.findVerifiedPerson(name),
    getChineseDisplayName: (name: string) => (globalThis as any).__mentorTestState.getChineseDisplayName(name),
    getVerifiedPlaceholderImage: () => 'data:image/svg+xml;utf8,placeholder',
    searchPeopleWithPhotos: (q: string) => (globalThis as any).__mentorTestState.searchPeopleWithPhotos(q),
  };
});

// Import AFTER mocks
import MentorTablePage from '../MentorTablePage';

const MENTOR_TABLE_RESPONSE = {
  schemaVersion: 'mentor_table.v1',
  language: 'en',
  safety: { riskLevel: 'low', needsProfessionalHelp: false, emergencyMessage: '' },
  mentorReplies: [
    {
      mentorId: 'bill_gates',
      mentorName: 'Bill Gates',
      likelyResponse: 'I would map the system end to end.',
      whyThisFits: 'Systems thinking fits a motivation question.',
      oneActionStep: 'Write down one measurable outcome.',
      confidenceNote: 'AI-simulated.',
    },
  ],
  meta: { disclaimer: 'AI sim.', generatedAt: new Date().toISOString(), source: 'llm' },
};

const fetchCalls: { url: string; body?: unknown }[] = [];

function stubFetch() {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('/api/mentor-table')) {
        fetchCalls.push({ url, body: init?.body ? JSON.parse(String(init.body)) : undefined });
        return new Response(JSON.stringify(MENTOR_TABLE_RESPONSE), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return new Response(JSON.stringify({ results: [] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    })
  );
}

async function addBillGates() {
  const input = screen.getByTestId('mentor-person-input') as HTMLInputElement;
  fireEvent.change(input, { target: { value: 'Bill Gates' } });
  fireEvent.keyDown(input, { key: 'Enter', code: 'Enter' });
  await waitFor(() => expect(input.value).toBe(''));
}

describe('MentorTablePage integration (real mentorApi, fetch mocked)', () => {
  beforeEach(() => {
    fetchCalls.length = 0;
    mentorTestState.language = 'en';
    stubFetch();
    render(<MentorTablePage standalone />);
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it('drives a full session through the real api client and note flow', async () => {
    await addBillGates();
    fireEvent.click(screen.getByTestId('mentor-continue-wish'));
    fireEvent.change(screen.getByTestId('mentor-problem-input'), {
      target: { value: 'How do I stay motivated?' },
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId('mentor-begin-session'));
    });

    // The request passed through the real client: correct endpoint, the
    // problem text, and the mentor roster resolved by the page.
    await waitFor(() => expect(fetchCalls.length).toBe(1));
    const call = fetchCalls[0];
    expect(call.url).toContain('/api/mentor-table');
    expect(call.body).toMatchObject({ problem: 'How do I stay motivated?' });
    expect((call.body as { mentors: { id: string }[] }).mentors[0].id).toBe('bill_gates');

    // The response was mapped by the real client into the rendered table.
    await waitFor(
      () => {
        expect(screen.getAllByText(/map the system end to end/i).length).toBeGreaterThan(0);
      },
      { timeout: 15000 }
    );
    // Live-LLM response: the source chip renders and discloses the live
    // path (the chip always renders — the label is the honesty surface).
    await waitFor(() => {
      const chip = document.querySelector('[class*="sourceTag"]');
      expect(chip?.textContent).toContain('LLM API');
      expect(chip?.textContent).not.toContain('Local Fallback');
    });

    // Note flow through the real hook -> real client -> real conversation.
    fireEvent.click(document.querySelector('[class*="passNoteBtn"]')!);
    const noteBox = document.querySelector('[class*="inlineNoteBox"] textarea') as HTMLTextAreaElement;
    fireEvent.change(noteBox, { target: { value: 'One concrete step?' } });
    await act(async () => {
      fireEvent.click(document.querySelector('[class*="inlineNoteBox"] button')!);
    });
    await waitFor(() => expect(fetchCalls.length).toBe(2));
    const history = (fetchCalls[1].body as { conversationHistory?: unknown[] }).conversationHistory;
    expect(Array.isArray(history)).toBe(true);
    expect((history as unknown[]).length).toBeGreaterThan(0);
  });
});
