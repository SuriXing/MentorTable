import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { generateMentorAdvice, fetchMentorDebugPrompt } from '../mentorApi';
import type { MentorProfile } from '../mentorProfiles';

// We control fetch; restore after each test.
const originalFetch = globalThis.fetch;

const mentor: MentorProfile = {
  id: 'elon_musk',
  displayName: 'Elon Musk',
  speakingStyle: ['direct'],
  coreValues: ['innovation'],
  decisionPatterns: ['first-principles'],
  knownExperienceThemes: ['rockets'],
  likelyBlindSpots: [],
  avoidClaims: [],
} as unknown as MentorProfile;

function makeOk(body: unknown): Response {
  return {
    ok: true,
    status: 200,
    text: async () => JSON.stringify(body),
    json: async () => body,
  } as unknown as Response;
}

function makeErr(status: number, text = 'err'): Response {
  return {
    ok: false,
    status,
    text: async () => text,
    json: async () => ({ error: text }),
  } as unknown as Response;
}

const validResult = {
  schemaVersion: 'mentor_table.v1',
  language: 'en',
  safety: { riskLevel: 'none', needsProfessionalHelp: false, emergencyMessage: '' },
  mentorReplies: [
    {
      mentorId: 'elon_musk',
      mentorName: 'Elon Musk',
      likelyResponse: 'Take a small step.',
      whyThisFits: 'Direct.',
      oneActionStep: 'Write it down.',
      confidenceNote: 'AI sim.',
    },
  ],
  meta: { disclaimer: 'AI', generatedAt: new Date().toISOString() },
};

describe('generateMentorAdvice', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
    warnSpy.mockRestore();
    vi.useRealTimers();
  });

  it('returns LLM result on 2xx with source=llm', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(makeOk(validResult)) as unknown as typeof fetch;
    const out = await generateMentorAdvice({
      problem: 'p',
      language: 'en',
      mentors: [mentor],
    });
    expect(out.meta.source).toBe('llm');
    expect(out.mentorReplies).toHaveLength(1);
  });

  it('falls back to local simulation on 4xx', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(makeErr(400, 'bad request')) as unknown as typeof fetch;
    const out = await generateMentorAdvice({
      problem: 'help',
      language: 'en',
      mentors: [mentor],
    });
    expect(out.meta.source).toBe('fallback');
    expect(out.meta.debugMessage).toMatch(/status 400/);
    expect(warnSpy).toHaveBeenCalled();
  });

  it('falls back on 5xx', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(makeErr(500, 'oops')) as unknown as typeof fetch;
    const out = await generateMentorAdvice({
      problem: 'help',
      language: 'en',
      mentors: [mentor],
    });
    expect(out.meta.source).toBe('fallback');
    expect(out.meta.debugMessage).toMatch(/status 500/);
  });

  it('falls back on malformed JSON (invalid payload shape)', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(makeOk({ wrong: 'shape' })) as unknown as typeof fetch;
    const out = await generateMentorAdvice({
      problem: 'help',
      language: 'en',
      mentors: [mentor],
    });
    expect(out.meta.source).toBe('fallback');
    expect(out.meta.debugMessage).toMatch(/invalid payload/);
  });

  it('falls back when fetch throws (network error)', async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error('network down')) as unknown as typeof fetch;
    const out = await generateMentorAdvice({
      problem: 'help',
      language: 'en',
      mentors: [mentor],
    });
    expect(out.meta.source).toBe('fallback');
    expect(out.meta.debugMessage).toMatch(/network down/);
  });

  it('falls back with timeout message when fetch is aborted', async () => {
    vi.stubEnv('VITE_MENTOR_API_TIMEOUT_MS', '1');
    globalThis.fetch = vi.fn().mockImplementation(async (_url, opts: RequestInit) => {
      return await new Promise((_resolve, reject) => {
        const sig = opts.signal!;
        const onAbort = (): void => {
          const err = new Error('aborted');
          err.name = 'AbortError';
          reject(err);
        };
        if (sig.aborted) return onAbort();
        sig.addEventListener('abort', onAbort);
      });
    }) as unknown as typeof fetch;

    const out = await generateMentorAdvice({
      problem: 'help',
      language: 'en',
      mentors: [mentor],
    });
    expect(out.meta.source).toBe('fallback');
    expect(out.meta.debugMessage).toMatch(/timeout/i);
    vi.unstubAllEnvs();
  }, 15000);

  it('falls back when caught value is not an Error', async () => {
    globalThis.fetch = vi.fn().mockImplementation(() => {
      // eslint-disable-next-line no-throw-literal
      throw 'string error';
    }) as unknown as typeof fetch;
    const out = await generateMentorAdvice({
      problem: 'help',
      language: 'en',
      mentors: [mentor],
    });
    expect(out.meta.source).toBe('fallback');
    expect(out.meta.debugMessage).toBe('string error');
  });

  it('uses fallback timeout when env is non-numeric', async () => {
    vi.stubEnv('VITE_MENTOR_API_TIMEOUT_MS', '35s');
    globalThis.fetch = vi.fn().mockResolvedValue(makeOk(validResult)) as unknown as typeof fetch;
    const out = await generateMentorAdvice({
      problem: 'p',
      language: 'en',
      mentors: [mentor],
    });
    expect(out.meta.source).toBe('llm');
    vi.unstubAllEnvs();
  });

  it('respects VITE_MENTOR_API_URL custom endpoint', async () => {
    vi.stubEnv('VITE_MENTOR_API_URL', 'https://custom.example.com/mentor');
    let calledUrl = '';
    globalThis.fetch = vi.fn().mockImplementation(async (url: string) => {
      calledUrl = url;
      return makeOk(validResult);
    }) as unknown as typeof fetch;

    await generateMentorAdvice({
      problem: 'p',
      language: 'en',
      mentors: [mentor],
    });
    expect(calledUrl).toBe('https://custom.example.com/mentor');
    vi.unstubAllEnvs();
  });

  it('throws "All endpoints failed" when no endpoints exist (deduped to nothing)', async () => {
    vi.stubEnv('VITE_MENTOR_API_URL', '');
    globalThis.fetch = vi.fn().mockResolvedValue(makeErr(503, 'down')) as unknown as typeof fetch;
    const out = await generateMentorAdvice({
      problem: 'p',
      language: 'en',
      mentors: [mentor],
    });
    expect(out.meta.source).toBe('fallback');
    vi.unstubAllEnvs();
  });
});

describe('fetchMentorDebugPrompt', () => {
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('returns prompt string on 2xx', async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(makeOk({ prompt: 'hello prompt' })) as unknown as typeof fetch;
    const result = await fetchMentorDebugPrompt({
      mentor,
      language: 'en',
    });
    expect(result).toBe('hello prompt');
  });

  it('throws on 4xx', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(makeErr(400, 'bad')) as unknown as typeof fetch;
    await expect(
      fetchMentorDebugPrompt({ mentor, language: 'en' })
    ).rejects.toThrow(/status 400/);
  });

  it('throws on 5xx', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(makeErr(500, 'boom')) as unknown as typeof fetch;
    await expect(
      fetchMentorDebugPrompt({ mentor, language: 'en' })
    ).rejects.toThrow(/status 500/);
  });

  it('throws on malformed JSON (no prompt field)', async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(makeOk({ wrong: 'shape' })) as unknown as typeof fetch;
    await expect(
      fetchMentorDebugPrompt({ mentor, language: 'en' })
    ).rejects.toThrow(/invalid payload/);
  });

  it('throws on malformed JSON (non-string prompt)', async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(makeOk({ prompt: 42 })) as unknown as typeof fetch;
    await expect(
      fetchMentorDebugPrompt({ mentor, language: 'en' })
    ).rejects.toThrow(/invalid payload/);
  });

  it('throws on network error', async () => {
    globalThis.fetch = vi
      .fn()
      .mockRejectedValue(new Error('econnreset')) as unknown as typeof fetch;
    await expect(
      fetchMentorDebugPrompt({ mentor, language: 'en' })
    ).rejects.toThrow(/econnreset/);
  });

  it('throws timeout error when aborted', async () => {
    vi.stubEnv('VITE_MENTOR_API_TIMEOUT_MS', '1');
    globalThis.fetch = vi.fn().mockImplementation(async (_url, opts: RequestInit) => {
      return await new Promise((_resolve, reject) => {
        const sig = opts.signal!;
        const onAbort = (): void => {
          const err = new Error('aborted');
          err.name = 'AbortError';
          reject(err);
        };
        if (sig.aborted) return onAbort();
        sig.addEventListener('abort', onAbort);
      });
    }) as unknown as typeof fetch;

    await expect(
      fetchMentorDebugPrompt({ mentor, language: 'en' })
    ).rejects.toThrow(/timeout/i);
    vi.unstubAllEnvs();
  }, 15000);

  it('wraps non-Error throws into Error', async () => {
    globalThis.fetch = vi.fn().mockImplementation(() => {
      // eslint-disable-next-line no-throw-literal
      throw 'plain string';
    }) as unknown as typeof fetch;
    await expect(
      fetchMentorDebugPrompt({ mentor, language: 'en' })
    ).rejects.toThrow(/plain string/);
  });

  it('respects VITE_MENTOR_DEBUG_API_URL custom endpoint', async () => {
    vi.stubEnv('VITE_MENTOR_DEBUG_API_URL', 'https://debug.example.com/p');
    let calledUrl = '';
    globalThis.fetch = vi.fn().mockImplementation(async (url: string) => {
      calledUrl = url;
      return makeOk({ prompt: 'x' });
    }) as unknown as typeof fetch;

    const out = await fetchMentorDebugPrompt({ mentor, language: 'en' });
    expect(out).toBe('x');
    expect(calledUrl).toBe('https://debug.example.com/p');
    vi.unstubAllEnvs();
  });
});
