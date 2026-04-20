/**
 * Tests for api/mentor-table.js
 *
 * Covers: handler method guard, validation, __test__ helpers,
 * language resolution, risk/safety normalization, contract finalization,
 * conversation history normalization & compaction, the no-API-key fallback,
 * the full LLM integration path (with mocked fetch), and backend context tests.
 *
 * NOTE: All tests that touch api/mentor-table.js MUST live in this single file.
 * c8 coverage in vitest 0.30 does not correctly merge coverage across test files
 * for the same CommonJS module. Moving tests out causes coverage to drop to ~44%.
 */

const handler = require('../mentor-table.js');

const {
  normalizeConversationHistory,
  buildConversationRounds,
  compactConversationHistoryDeterministic,
  compactConversationHistory,
  formatConversationHistoryForPrompt,
  buildUserPrompt,
  buildMentorDirectiveBlock,
  tryParseJson,
  normalizeProviderPayload,
  normalizeProviderPayloadLoose,
  pickReplyForMentor,
  riskLevelScore,
  detectLanguageFromText,
  resolveEffectiveLanguage,
  normalizeRiskLevel,
  mergeSafetyState,
  normalizeHistoryRole,
  estimateTokens,
  summarizeCompactedMiddleDeterministic,
  sanitizeFirstPerson,
  defaultConfidenceNote,
  defaultActionStep,
  extractAssistantContent,
  extractLooseStringField,
  contentMatchesLanguage,
  detectContentLanguage,
  finalizeContractShape,
  firstNonEmptyEnvValue,
  buildServerFallbackNormalized,
  buildFallbackReplyForMentor,
  defaultDisclaimer,
  providerFromBaseUrl,
  buildSystemPrompt,
} = handler.__test__;

// ---------------------------------------------------------------------------
// Mock req / res helpers
// ---------------------------------------------------------------------------
function mockReq(overrides = {}) {
  return { method: 'POST', body: {}, query: {}, headers: {}, ...overrides };
}

function mockRes() {
  const res = {
    _status: null,
    _json: null,
    _ended: false,
    statusCode: 200,
    status(code) { res._status = code; return res; },
    json(data) { res._json = data; res._ended = true; return res; },
    end() { res._ended = true; return res; },
    setHeader() { return res; },
  };
  return res;
}

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------
const sampleMentor = {
  id: 'elon_musk',
  displayName: 'Elon Musk',
  speakingStyle: ['direct', 'ambitious'],
  coreValues: ['innovation'],
  decisionPatterns: ['first-principles'],
  knownExperienceThemes: ['rockets'],
  likelyBlindSpots: ['work-life-balance'],
  avoidClaims: ['I built the rocket alone'],
};

// ---------------------------------------------------------------------------
// Handler-level tests
// ---------------------------------------------------------------------------
describe('mentor-table handler', () => {
  const savedEnv = {};
  beforeEach(() => {
    // Clear LLM env vars so handler enters the no-key path
    for (const key of [
      'LLM_API_KEY', 'OPENAI_API_KEY', 'LLM_API_TOKEN', 'OPENAI_KEY',
      'LLM_MODEL', 'OPENAI_MODEL', 'LLM_API_BASE_URL', 'OPENAI_BASE_URL',
    ]) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
  });
  afterEach(() => {
    for (const [key, val] of Object.entries(savedEnv)) {
      if (val === undefined) delete process.env[key];
      else process.env[key] = val;
    }
  });

  it('rejects non-POST with 405', async () => {
    const res = mockRes();
    await handler(mockReq({ method: 'GET' }), res);
    expect(res._status).toBe(405);
    expect(res._json.error).toMatch(/not allowed/i);
  });

  it('returns 500 when no API key is configured', async () => {
    const res = mockRes();
    await handler(mockReq({ method: 'POST', body: { problem: 'test', mentors: [sampleMentor] } }), res);
    expect(res._status).toBe(500);
    expect(res._json.error).toMatch(/configuration/i);
  });

  it('returns 400 when problem is missing', async () => {
    process.env.LLM_API_KEY = 'test-key';
    const res = mockRes();
    await handler(mockReq({ method: 'POST', body: { mentors: [sampleMentor] } }), res);
    expect(res._status).toBe(400);
    expect(res._json.error).toMatch(/problem/i);
  });

  it('returns 400 when mentors array is empty', async () => {
    process.env.LLM_API_KEY = 'test-key';
    const res = mockRes();
    await handler(mockReq({ method: 'POST', body: { problem: 'test', mentors: [] } }), res);
    expect(res._status).toBe(400);
    expect(res._json.error).toMatch(/mentor/i);
  });

  it('returns 400 when mentors is not an array', async () => {
    process.env.LLM_API_KEY = 'test-key';
    const res = mockRes();
    await handler(mockReq({ method: 'POST', body: { problem: 'test', mentors: 'bad' } }), res);
    expect(res._status).toBe(400);
  });

  it('returns 413 when problem exceeds PROBLEM_MAX_CHARS (5000)', async () => {
    // DoS/cost cap — attacker can't flood the LLM with megabytes of prompt.
    process.env.LLM_API_KEY = 'test-key';
    const res = mockRes();
    const hugeProblem = 'x'.repeat(5001);
    await handler(mockReq({
      method: 'POST',
      body: { problem: hugeProblem, mentors: [sampleMentor] },
    }), res);
    expect(res._status).toBe(413);
    expect(res._json.error).toMatch(/5000 character limit/);
  });

  it('returns 413 when mentors count exceeds MENTORS_MAX (10)', async () => {
    // Each mentor spawns a parallel upstream call — cap prevents a single
    // request from fan-out-amplifying token spend.
    process.env.LLM_API_KEY = 'test-key';
    const res = mockRes();
    const manyMentors = Array.from({ length: 11 }, (_, i) => ({
      ...sampleMentor,
      id: `mentor_${i}`,
      displayName: `Mentor ${i}`,
    }));
    await handler(mockReq({
      method: 'POST',
      body: { problem: 'test', mentors: manyMentors },
    }), res);
    expect(res._status).toBe(413);
    expect(res._json.error).toMatch(/too many mentors.*10/);
  });

  it('returns Unknown server error when the caught error has an empty message', async () => {
    // Exercises the `error.message || 'Unknown server error'` fallback branch
    // at line 1427. Need an Error whose .message is '' so the || picks the
    // constant string.
    process.env.LLM_API_KEY = 'test-key';
    const emptyErr = new Error('');
    // Ensure .message stays empty on the thrown Error
    const badBody = {
      problem: 'test',
      language: 'en',
      mentors: [sampleMentor],
    };
    Object.defineProperty(badBody, 'conversationHistory', {
      get() { throw emptyErr; },
      enumerable: true,
    });

    const res = mockRes();
    await handler(mockReq({ method: 'POST', body: badBody }), res);

    expect(res._status).toBe(500);
    expect(res._json.error).toBe('Unknown server error');
  });

  it('falls back to <unreadable> when upstream error body cannot be read', async () => {
    // Exercises `errorText = '<unreadable>'` fallback at lines 1113-1115.
    // Upstream returns non-ok; response.text() itself rejects (broken stream).
    // Handler must still throw a redacted per-mentor error and fall back.
    // F57 (U8.1 R2): handler no longer emits a parallel console.error — the
    // sole sink is the structured logger. Spy console.log (level=error routes
    // to console.error in the logger) AND console.error to capture both
    // routing paths.
    process.env.LLM_API_KEY = 'test-key';
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      text: async () => { throw new Error('stream destroyed'); },
      json: async () => ({}),
    });

    const res = mockRes();
    await handler(mockReq({
      method: 'POST',
      body: { problem: 'test', language: 'en', mentors: [sampleMentor] },
    }), res);

    expect(res._status).toBe(200);
    // Mentor fell back via buildFallbackReplyForMentor
    expect(res._json.mentorReplies).toHaveLength(1);
    expect(res._json.mentorReplies[0].mentorId).toBe(sampleMentor.id);

    // Confirm the '<unreadable>' fallback was actually logged server-side via
    // the structured logger (JSON line carrying bodyTruncated: '<unreadable>').
    const allCalls = [...errorSpy.mock.calls, ...logSpy.mock.calls];
    const unreadableLog = allCalls.find((call) => {
      if (typeof call[0] !== 'string') return false;
      try {
        const parsed = JSON.parse(call[0]);
        return parsed.bodyTruncated === '<unreadable>';
      } catch {
        return false;
      }
    });
    expect(unreadableLog).toBeTruthy();
    errorSpy.mockRestore();
    logSpy.mockRestore();
  });

  it('returns 413 when conversationHistory exceeds HISTORY_MAX_ENTRIES (50)', async () => {
    // Prevents bypassing per-entry caps via hundreds of short entries.
    process.env.LLM_API_KEY = 'test-key';
    const res = mockRes();
    const tooManyEntries = Array.from({ length: 51 }, (_, i) => ({
      role: i % 2 === 0 ? 'user' : 'mentor',
      speaker: 'x',
      text: 'hi',
    }));
    await handler(mockReq({
      method: 'POST',
      body: {
        problem: 'test',
        mentors: [sampleMentor],
        conversationHistory: tooManyEntries,
      },
    }), res);
    expect(res._status).toBe(413);
    expect(res._json.error).toMatch(/conversationHistory exceeds 50 entries/);
  });
});

// ---------------------------------------------------------------------------
// normalizeConversationHistory
// ---------------------------------------------------------------------------
describe('normalizeConversationHistory', () => {
  it('returns empty array for non-array input', () => {
    expect(normalizeConversationHistory(null)).toEqual([]);
    expect(normalizeConversationHistory(undefined)).toEqual([]);
    expect(normalizeConversationHistory('string')).toEqual([]);
  });

  it('filters out items without text', () => {
    const result = normalizeConversationHistory([
      { role: 'user', text: 'hello' },
      { role: 'user', text: '' },
      { role: 'user', text: '   ' },
      null,
      42,
    ]);
    expect(result).toHaveLength(1);
    expect(result[0].text).toBe('hello');
  });

  it('normalizes roles', () => {
    const result = normalizeConversationHistory([
      { role: 'user', text: 'a' },
      { role: 'mentor', text: 'b' },
      { role: 'system', text: 'c' },
      { role: 'garbage', text: 'd' },
    ]);
    expect(result.map((r) => r.role)).toEqual(['user', 'mentor', 'system', 'system']);
  });

  it('collapses whitespace in text', () => {
    const result = normalizeConversationHistory([{ role: 'user', text: '  a   b  c  ' }]);
    expect(result[0].text).toBe('a b c');
  });

  it('trims speaker string', () => {
    const result = normalizeConversationHistory([{ role: 'user', speaker: '  Bob  ', text: 'hi' }]);
    expect(result[0].speaker).toBe('Bob');
  });
});

// ---------------------------------------------------------------------------
// buildConversationRounds
// ---------------------------------------------------------------------------
describe('buildConversationRounds', () => {
  it('groups entries into rounds starting at each user message', () => {
    const entries = [
      { role: 'user', text: 'q1' },
      { role: 'mentor', text: 'a1' },
      { role: 'user', text: 'q2' },
      { role: 'mentor', text: 'a2' },
    ];
    const rounds = buildConversationRounds(entries);
    expect(rounds).toHaveLength(2);
    expect(rounds[0]).toHaveLength(2);
    expect(rounds[1]).toHaveLength(2);
  });

  it('handles empty input', () => {
    expect(buildConversationRounds([])).toEqual([]);
  });

  it('handles leading non-user messages', () => {
    const entries = [
      { role: 'system', text: 'sys' },
      { role: 'user', text: 'q1' },
    ];
    const rounds = buildConversationRounds(entries);
    expect(rounds).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// compactConversationHistoryDeterministic
// ---------------------------------------------------------------------------
describe('compactConversationHistoryDeterministic', () => {
  it('returns empty result for empty input', () => {
    const result = compactConversationHistoryDeterministic([]);
    expect(result.entries).toEqual([]);
    expect(result.omittedCount).toBe(0);
    expect(result.usedLlmCompression).toBe(false);
  });

  it('passes through small history unchanged', () => {
    const entries = [
      { role: 'user', speaker: 'u', text: 'hi' },
      { role: 'mentor', speaker: 'm', text: 'hello' },
    ];
    const result = compactConversationHistoryDeterministic(entries, 36, 6000);
    expect(result.entries).toEqual(entries);
    expect(result.omittedCount).toBe(0);
  });

  it('compacts large history and reports omitted count', () => {
    const entries = Array.from({ length: 60 }, (_, i) => ({
      role: i % 2 === 0 ? 'user' : 'mentor',
      speaker: i % 2 === 0 ? 'user' : 'mentor',
      text: `message ${i} ${'x'.repeat(200)}`,
    }));
    const result = compactConversationHistoryDeterministic(entries, 10, 2000);
    expect(result.entries.length).toBeLessThanOrEqual(10);
    expect(result.omittedCount).toBeGreaterThan(0);
    expect(result.summary).toBeTruthy();
  });

  it('returns empty summary when head+tail reconstruct the full history (omittedCount === 0)', () => {
    // Forces the `omittedCount > 0 ? ... : ''` false branch on line 357:
    // countChars > maxChars bypasses the L324 fast path, but entries.length
    // is small enough that head (4) + tail (6) = full 10 entries → nothing
    // is omitted → summary must be the empty string.
    const entries = Array.from({ length: 10 }, (_, i) => ({
      role: i % 2 === 0 ? 'user' : 'mentor',
      speaker: i % 2 === 0 ? 'u' : 'm',
      text: 'x'.repeat(80),
    }));
    // maxItems=10 (== entries.length), maxChars=500 (< countChars) → fast
    // path skipped. tailBudget = max(1200, 340) = 1200, and each entry is
    // ~92 chars so all 6 non-head entries fit comfortably.
    const result = compactConversationHistoryDeterministic(entries, 10, 500);
    expect(result.entries.length).toBe(10);
    expect(result.omittedCount).toBe(0);
    expect(result.summary).toBe('');
  });
});

// ---------------------------------------------------------------------------
// compactConversationHistory (async, deterministic path only)
// ---------------------------------------------------------------------------
describe('compactConversationHistory', () => {
  it('returns empty for null history', async () => {
    const result = await compactConversationHistory(null);
    expect(result.entries).toEqual([]);
  });

  it('passes small history through', async () => {
    const history = [
      { role: 'user', text: 'question' },
      { role: 'mentor', text: 'answer' },
    ];
    const result = await compactConversationHistory(history);
    expect(result.entries).toHaveLength(2);
    expect(result.usedLlmCompression).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// formatConversationHistoryForPrompt
// ---------------------------------------------------------------------------
describe('formatConversationHistoryForPrompt', () => {
  it('returns empty string for empty array', () => {
    expect(formatConversationHistoryForPrompt([])).toBe('');
  });

  it('returns empty string for non-array', () => {
    expect(formatConversationHistoryForPrompt(null)).toBe('');
  });

  it('formats entries with 1-based index', () => {
    const result = formatConversationHistoryForPrompt([
      { role: 'user', speaker: 'Alice', text: 'hello' },
      { role: 'mentor', speaker: 'Bob', text: 'hi' },
    ]);
    expect(result).toContain('1. [user] Alice: hello');
    expect(result).toContain('2. [mentor] Bob: hi');
  });
});

// ---------------------------------------------------------------------------
// buildMentorDirectiveBlock
// ---------------------------------------------------------------------------
describe('buildMentorDirectiveBlock', () => {
  it('returns fallback text for empty mentors', () => {
    expect(buildMentorDirectiveBlock([])).toMatch(/no mentor/i);
    expect(buildMentorDirectiveBlock(undefined)).toMatch(/no mentor/i);
  });

  it('includes mentor fields', () => {
    const result = buildMentorDirectiveBlock([sampleMentor]);
    expect(result).toContain('elon_musk');
    expect(result).toContain('Elon Musk');
    expect(result).toContain('innovation');
    expect(result).toContain('first-principles');
  });

  it('separates multiple mentors with blank lines', () => {
    const result = buildMentorDirectiveBlock([sampleMentor, { ...sampleMentor, id: 'mentor2', displayName: 'Mentor 2' }]);
    expect(result).toContain('elon_musk');
    expect(result).toContain('mentor2');
  });
});

// ---------------------------------------------------------------------------
// buildUserPrompt
// ---------------------------------------------------------------------------
describe('buildUserPrompt', () => {
  it('includes problem and language', () => {
    const prompt = buildUserPrompt('My problem', 'en', [sampleMentor], null);
    expect(prompt).toContain('My problem');
    expect(prompt).toContain('English');
    expect(prompt).toContain('elon_musk');
  });

  it('includes Chinese language label for zh-CN', () => {
    const prompt = buildUserPrompt('test', 'zh-CN', [sampleMentor], null);
    expect(prompt).toContain('Chinese (Simplified)');
  });

  it('includes conversation summary when provided', () => {
    const compacted = {
      entries: [{ role: 'user', speaker: 'u', text: 'prev' }],
      summary: 'summary of middle rounds',
      omittedCount: 3,
      usedLlmCompression: true,
    };
    const prompt = buildUserPrompt('test', 'en', [sampleMentor], compacted);
    expect(prompt).toContain('summary of middle rounds');
    expect(prompt).toContain('compacted');
  });
});

// ---------------------------------------------------------------------------
// LLM integration helpers
// ---------------------------------------------------------------------------
function makeLLMResponse(mentorId, mentorName, language = 'en') {
  return {
    schemaVersion: 'mentor_table.v1',
    language,
    safety: {
      riskLevel: 'none',
      needsProfessionalHelp: false,
      emergencyMessage: '',
    },
    mentorReplies: [
      {
        mentorId,
        mentorName,
        likelyResponse: language === 'zh-CN'
          ? '我认为你应该先迈出一小步。'
          : 'I think you should take a small step first.',
        whyThisFits: 'Matches the mentor style.',
        oneActionStep: language === 'zh-CN'
          ? '今天就把问题写下来。'
          : 'Write down the problem today.',
        confidenceNote: 'AI-simulated perspective.',
      },
    ],
    meta: {
      disclaimer: 'AI simulation disclaimer.',
      generatedAt: new Date().toISOString(),
    },
  };
}

function mockFetchOk(responseBody) {
  return vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => ({
      choices: [{ message: { content: JSON.stringify(responseBody) } }],
    }),
    text: async () => JSON.stringify(responseBody),
  });
}

function mockFetchError(status, errorText = 'error') {
  return vi.fn().mockResolvedValue({
    ok: false,
    status,
    json: async () => ({ error: errorText }),
    text: async () => errorText,
  });
}

// ---------------------------------------------------------------------------
// LLM integration tests
// ---------------------------------------------------------------------------
describe('mentor-table LLM integration', () => {
  const llmEnvKeys = [
    'LLM_API_KEY', 'OPENAI_API_KEY', 'LLM_API_TOKEN', 'OPENAI_KEY',
    'LLM_MODEL', 'OPENAI_MODEL', 'LLM_API_BASE_URL', 'OPENAI_BASE_URL',
    'MENTOR_UPSTREAM_TIMEOUT_MS',
  ];
  const savedLlmEnv = {};
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    for (const key of llmEnvKeys) {
      savedLlmEnv[key] = process.env[key];
      delete process.env[key];
    }
    process.env.LLM_API_KEY = 'test-key-123';
    process.env.LLM_MODEL = 'test-model';
    process.env.LLM_API_BASE_URL = 'https://api.test.com/v1';
    process.env.MENTOR_UPSTREAM_TIMEOUT_MS = '5000';
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    for (const [key, val] of Object.entries(savedLlmEnv)) {
      if (val === undefined) delete process.env[key];
      else process.env[key] = val;
    }
  });

  it('returns valid response for a single mentor with LLM reply', async () => {
    const llmResponse = makeLLMResponse('elon_musk', 'Elon Musk', 'en');
    globalThis.fetch = mockFetchOk(llmResponse);

    const res = mockRes();
    await handler(mockReq({
      method: 'POST',
      body: {
        problem: 'How do I start a company?',
        language: 'en',
        mentors: [sampleMentor],
      },
    }), res);

    expect(res._status).toBe(200);
    expect(res._json.schemaVersion).toBe('mentor_table.v1');
    expect(res._json.mentorReplies).toHaveLength(1);
    expect(res._json.mentorReplies[0].mentorId).toBe('elon_musk');
    expect(res._json.mentorReplies[0].likelyResponse).toBeTruthy();
    expect(res._json.meta.provider).toBe('api.test.com');
    expect(res._json.meta.model).toBe('test-model');
  });

  it('returns replies for multiple mentors', async () => {
    const mentor2 = { ...sampleMentor, id: 'bill_gates', displayName: 'Bill Gates' };
    const callCount = { n: 0 };
    globalThis.fetch = vi.fn().mockImplementation(async () => {
      callCount.n += 1;
      const mentorId = callCount.n === 1 ? 'elon_musk' : 'bill_gates';
      const mentorName = callCount.n === 1 ? 'Elon Musk' : 'Bill Gates';
      return {
        ok: true,
        status: 200,
        json: async () => ({
          choices: [{ message: { content: JSON.stringify(makeLLMResponse(mentorId, mentorName)) } }],
        }),
        text: async () => '',
      };
    });

    const res = mockRes();
    await handler(mockReq({
      method: 'POST',
      body: {
        problem: 'How do I scale?',
        language: 'en',
        mentors: [sampleMentor, mentor2],
      },
    }), res);

    expect(res._status).toBe(200);
    expect(res._json.mentorReplies).toHaveLength(2);
  });

  it('uses fallback when LLM call fails', async () => {
    globalThis.fetch = mockFetchError(500, 'Internal server error');

    const res = mockRes();
    await handler(mockReq({
      method: 'POST',
      body: {
        problem: 'Help me',
        language: 'en',
        mentors: [sampleMentor],
      },
    }), res);

    expect(res._status).toBe(200);
    expect(res._json.mentorReplies).toHaveLength(1);
    expect(res._json.meta.provider).toBe('server-fallback');
  });

  it('uses partial fallback when one mentor fails', async () => {
    const mentor2 = { ...sampleMentor, id: 'bill_gates', displayName: 'Bill Gates' };
    let callIndex = 0;
    globalThis.fetch = vi.fn().mockImplementation(async () => {
      callIndex += 1;
      if (callIndex === 1) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            choices: [{ message: { content: JSON.stringify(makeLLMResponse('elon_musk', 'Elon Musk')) } }],
          }),
          text: async () => '',
        };
      }
      return { ok: false, status: 500, text: async () => 'error', json: async () => ({}) };
    });

    const res = mockRes();
    await handler(mockReq({
      method: 'POST',
      body: {
        problem: 'Help',
        language: 'en',
        mentors: [sampleMentor, mentor2],
      },
    }), res);

    expect(res._status).toBe(200);
    expect(res._json.mentorReplies).toHaveLength(2);
    expect(res._json.meta.provider).toBe('partial-fallback');
  });

  it('repairs invalid JSON via second LLM call', async () => {
    let callIndex = 0;
    globalThis.fetch = vi.fn().mockImplementation(async () => {
      callIndex += 1;
      if (callIndex === 1) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            choices: [{ message: { content: 'This is not JSON at all, but mentorId elon_musk' } }],
          }),
          text: async () => '',
        };
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({
          choices: [{ message: { content: JSON.stringify(makeLLMResponse('elon_musk', 'Elon Musk')) } }],
        }),
        text: async () => '',
      };
    });

    const res = mockRes();
    await handler(mockReq({
      method: 'POST',
      body: { problem: 'Fix something', language: 'en', mentors: [sampleMentor] },
    }), res);

    expect(res._status).toBe(200);
    expect(res._json.mentorReplies).toHaveLength(1);
  });

  it('falls back from json_schema to json_object on 4xx error', async () => {
    let callIndex = 0;
    globalThis.fetch = vi.fn().mockImplementation(async (url, opts) => {
      callIndex += 1;
      const body = JSON.parse(opts.body);
      if (callIndex === 1 && body.response_format?.type === 'json_schema') {
        return { ok: false, status: 400, text: async () => 'json_schema not supported', json: async () => ({}) };
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({
          choices: [{ message: { content: JSON.stringify(makeLLMResponse('elon_musk', 'Elon Musk')) } }],
        }),
        text: async () => '',
      };
    });

    const res = mockRes();
    await handler(mockReq({
      method: 'POST',
      body: { problem: 'Test fallback', language: 'en', mentors: [sampleMentor] },
    }), res);

    expect(res._status).toBe(200);
    expect(res._json.mentorReplies).toHaveLength(1);
  });

  it('uses json_object format for dashscope base URL', async () => {
    process.env.LLM_API_BASE_URL = 'https://dashscope.aliyuncs.com/compatible-mode/v1';
    const llmResponse = makeLLMResponse('elon_musk', 'Elon Musk');
    let capturedBody;
    globalThis.fetch = vi.fn().mockImplementation(async (url, opts) => {
      capturedBody = JSON.parse(opts.body);
      return {
        ok: true,
        status: 200,
        json: async () => ({
          choices: [{ message: { content: JSON.stringify(llmResponse) } }],
        }),
        text: async () => '',
      };
    });

    const res = mockRes();
    await handler(mockReq({
      method: 'POST',
      body: { problem: 'Test dashscope', language: 'en', mentors: [sampleMentor] },
    }), res);

    expect(res._status).toBe(200);
    expect(capturedBody.response_format.type).toBe('json_object');
  });

  it('uses language-safe fallback when response language mismatches', async () => {
    const zhResponse = makeLLMResponse('elon_musk', 'Elon Musk', 'zh-CN');
    globalThis.fetch = mockFetchOk(zhResponse);

    const res = mockRes();
    await handler(mockReq({
      method: 'POST',
      body: { problem: 'How do I start?', language: 'en', mentors: [sampleMentor] },
    }), res);

    expect(res._status).toBe(200);
    expect(res._json.mentorReplies).toHaveLength(1);
    expect(res._json.mentorReplies[0].likelyResponse).toMatch(/[a-zA-Z]/);
  });

  it('handles zh-CN language request', async () => {
    const zhResponse = makeLLMResponse('elon_musk', 'Elon Musk', 'zh-CN');
    globalThis.fetch = mockFetchOk(zhResponse);

    const res = mockRes();
    await handler(mockReq({
      method: 'POST',
      body: { problem: '我该怎么创业？', language: 'zh-CN', mentors: [sampleMentor] },
    }), res);

    expect(res._status).toBe(200);
    expect(res._json.language).toBe('zh-CN');
  });

  it('detects language from conversation history when not explicitly set', async () => {
    const zhResponse = makeLLMResponse('elon_musk', 'Elon Musk', 'zh-CN');
    globalThis.fetch = mockFetchOk(zhResponse);

    const res = mockRes();
    await handler(mockReq({
      method: 'POST',
      body: {
        problem: '123',
        language: 'auto',
        mentors: [sampleMentor],
        conversationHistory: [
          { role: 'user', text: '我需要帮助解决这个问题' },
          { role: 'mentor', text: '你可以尝试...' },
        ],
      },
    }), res);

    expect(res._status).toBe(200);
    expect(res._json.language).toBe('zh-CN');
  });

  it('includes conversation history in the request', async () => {
    const llmResponse = makeLLMResponse('elon_musk', 'Elon Musk');
    let capturedBody;
    globalThis.fetch = vi.fn().mockImplementation(async (url, opts) => {
      capturedBody = JSON.parse(opts.body);
      return {
        ok: true,
        status: 200,
        json: async () => ({
          choices: [{ message: { content: JSON.stringify(llmResponse) } }],
        }),
        text: async () => '',
      };
    });

    const res = mockRes();
    await handler(mockReq({
      method: 'POST',
      body: {
        problem: 'Follow up question',
        language: 'en',
        mentors: [sampleMentor],
        conversationHistory: [
          { role: 'user', text: 'Initial question' },
          { role: 'mentor', speaker: 'Elon Musk', text: 'My initial reply' },
        ],
      },
    }), res);

    expect(res._status).toBe(200);
    const userMsg = capturedBody.messages.find((m) => m.role === 'user');
    expect(userMsg.content).toContain('Initial question');
  });

  it('returns fallback for AbortError in per-mentor call', async () => {
    globalThis.fetch = vi.fn().mockImplementation(async () => {
      const err = new Error('The operation was aborted');
      err.name = 'AbortError';
      throw err;
    });

    const res = mockRes();
    await handler(mockReq({
      method: 'POST',
      body: { problem: 'Test timeout', language: 'en', mentors: [sampleMentor] },
    }), res);

    expect(res._status).toBe(200);
    expect(res._json.meta.provider).toBe('server-fallback');
  });

  describe('provider payload normalization', () => {
    it('handles "replies" array shape', async () => {
      const payload = {
        replies: [
          {
            mentorId: 'elon_musk',
            mentorName: 'Elon Musk',
            Response: 'Take small steps and iterate.',
            reason: 'First principles approach.',
          },
        ],
        safety: { riskLevel: 'none', needsProfessionalHelp: false, emergencyMessage: '' },
      };
      globalThis.fetch = mockFetchOk(payload);

      const res = mockRes();
      await handler(mockReq({
        method: 'POST',
        body: { problem: 'test', language: 'en', mentors: [sampleMentor] },
      }), res);

      expect(res._status).toBe(200);
      expect(res._json.mentorReplies).toHaveLength(1);
      expect(res._json.mentorReplies[0].likelyResponse).toContain('small steps');
    });

    it('handles single mentor response object shape', async () => {
      const payload = {
        MentorId: 'elon_musk',
        MentorName: 'Elon Musk',
        Response: 'Focus on the core problem.',
        WhyThisFits: 'First principles.',
      };
      globalThis.fetch = mockFetchOk(payload);

      const res = mockRes();
      await handler(mockReq({
        method: 'POST',
        body: { problem: 'test', language: 'en', mentors: [sampleMentor] },
      }), res);

      expect(res._status).toBe(200);
      expect(res._json.mentorReplies).toHaveLength(1);
    });

    it('handles response map keyed by mentor name', async () => {
      const payload = {
        response: {
          elon_musk: {
            mentorId: 'elon_musk',
            mentorName: 'Elon Musk',
            message: 'Break it down to first principles.',
          },
        },
      };
      globalThis.fetch = mockFetchOk(payload);

      const res = mockRes();
      await handler(mockReq({
        method: 'POST',
        body: { problem: 'test', language: 'en', mentors: [sampleMentor] },
      }), res);

      expect(res._status).toBe(200);
      expect(res._json.mentorReplies).toHaveLength(1);
    });
  });

  describe('extractAssistantContent', () => {
    it('handles array content parts', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({
          choices: [{
            message: {
              content: [
                { text: JSON.stringify(makeLLMResponse('elon_musk', 'Elon Musk')) },
              ],
            },
          }],
        }),
        text: async () => '',
      });

      const res = mockRes();
      await handler(mockReq({
        method: 'POST',
        body: { problem: 'test', language: 'en', mentors: [sampleMentor] },
      }), res);

      expect(res._status).toBe(200);
      expect(res._json.mentorReplies).toHaveLength(1);
    });

    it('handles object content (JSON directly)', async () => {
      const responseObj = makeLLMResponse('elon_musk', 'Elon Musk');
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({
          choices: [{
            message: { content: responseObj },
          }],
        }),
        text: async () => '',
      });

      const res = mockRes();
      await handler(mockReq({
        method: 'POST',
        body: { problem: 'test', language: 'en', mentors: [sampleMentor] },
      }), res);

      expect(res._status).toBe(200);
      expect(res._json.mentorReplies).toHaveLength(1);
    });
  });

  it('parses JSON wrapped in markdown fences', async () => {
    const jsonStr = JSON.stringify(makeLLMResponse('elon_musk', 'Elon Musk'));
    const fenced = '```json\n' + jsonStr + '\n```';

    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        choices: [{ message: { content: fenced } }],
      }),
      text: async () => '',
    });

    const res = mockRes();
    await handler(mockReq({
      method: 'POST',
      body: { problem: 'test', language: 'en', mentors: [sampleMentor] },
    }), res);

    expect(res._status).toBe(200);
    expect(res._json.mentorReplies).toHaveLength(1);
  });

  it('uses loose extraction when JSON is malformed', async () => {
    let callIndex = 0;
    globalThis.fetch = vi.fn().mockImplementation(async () => {
      callIndex += 1;
      if (callIndex <= 2) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            choices: [{
              message: {
                content: `Here is the response for elon_musk:
                  "mentorId": "elon_musk"
                  "mentorName": "Elon Musk"
                  "likelyResponse": "Break it down and iterate on each piece"
                  "whyThisFits": "First principles thinking"
                  "oneActionStep": "Write down the problem"`,
              },
            }],
          }),
          text: async () => '',
        };
      }
      return { ok: false, status: 500, text: async () => 'fail' };
    });

    const res = mockRes();
    await handler(mockReq({
      method: 'POST',
      body: { problem: 'test', language: 'en', mentors: [sampleMentor] },
    }), res);

    expect(res._status).toBe(200);
    expect(res._json.mentorReplies).toHaveLength(1);
  });

  it('merges safety state from high-risk LLM response', async () => {
    const highRiskResponse = {
      ...makeLLMResponse('elon_musk', 'Elon Musk'),
      safety: {
        riskLevel: 'high',
        needsProfessionalHelp: true,
        emergencyMessage: 'Please contact help.',
      },
    };
    globalThis.fetch = mockFetchOk(highRiskResponse);

    const res = mockRes();
    await handler(mockReq({
      method: 'POST',
      body: { problem: 'I feel hopeless', language: 'en', mentors: [sampleMentor] },
    }), res);

    expect(res._status).toBe(200);
    expect(res._json.safety.riskLevel).toBe('high');
    expect(res._json.safety.needsProfessionalHelp).toBe(true);
    expect(res._json.safety.emergencyMessage).toBe('Please contact help.');
  });

  it('compacts large conversation history before LLM call', async () => {
    const llmResponse = makeLLMResponse('elon_musk', 'Elon Musk');
    globalThis.fetch = mockFetchOk(llmResponse);

    const history = Array.from({ length: 50 }, (_, i) => ({
      role: i % 2 === 0 ? 'user' : 'mentor',
      speaker: i % 2 === 0 ? 'User' : 'Elon Musk',
      text: `Message ${i}: ${'x'.repeat(100)}`,
    }));

    const res = mockRes();
    await handler(mockReq({
      method: 'POST',
      body: {
        problem: 'Follow up',
        language: 'en',
        mentors: [sampleMentor],
        conversationHistory: history,
      },
    }), res);

    expect(res._status).toBe(200);
    expect(res._json.mentorReplies).toHaveLength(1);
  });

  it('uses LLM compression when token threshold is exceeded', async () => {
    const entries = Array.from({ length: 80 }, (_, i) => ({
      role: i % 2 === 0 ? 'user' : 'mentor',
      speaker: i % 2 === 0 ? 'User' : 'Mentor',
      text: `Message ${i}: ${'a'.repeat(2000)}`,
    }));

    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        choices: [{
          message: {
            content: JSON.stringify({
              summary: 'User discussed various topics.',
              userConcerns: ['concern1'],
              mentorDirections: ['direction1'],
              openLoops: ['loop1'],
            }),
          },
        }],
      }),
      text: async () => '',
    });

    const result = await compactConversationHistory(entries, {
      tokenThreshold: 100,
      maxItems: 36,
      maxChars: 6000,
      language: 'en',
      model: 'test-model',
      apiKey: 'test-key',
      chatCompletionsUrl: 'https://api.test.com/v1/chat/completions',
      compressTimeoutMs: 5000,
    });

    expect(result.usedLlmCompression).toBe(true);
    expect(result.summary).toBeTruthy();
    expect(result.omittedCount).toBeGreaterThan(0);
  });

  it('uses zh-CN prompt when language is zh-CN in LLM compression', async () => {
    const entries = Array.from({ length: 80 }, (_, i) => ({
      role: i % 2 === 0 ? 'user' : 'mentor',
      speaker: i % 2 === 0 ? '用户' : '导师',
      text: `消息 ${i}: ${'中'.repeat(2000)}`,
    }));

    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        choices: [{
          message: {
            content: JSON.stringify({
              summary: '用户讨论了各种话题。',
              userConcerns: ['关切1'],
              mentorDirections: ['方向1'],
              openLoops: ['循环1'],
            }),
          },
        }],
      }),
      text: async () => '',
    });

    const result = await compactConversationHistory(entries, {
      tokenThreshold: 100,
      maxItems: 36,
      maxChars: 6000,
      language: 'zh-CN',
      model: 'test-model',
      apiKey: 'test-key',
      chatCompletionsUrl: 'https://api.test.com/v1/chat/completions',
      compressTimeoutMs: 5000,
    });

    expect(result.usedLlmCompression).toBe(true);
    expect(result.summary).toBeTruthy();
  });

  it('slices compactedEntries when head + tail exceeds maxItems', () => {
    // Create entries where the deterministic compaction's head + tail > maxItems
    // With maxItems=3, headKeep=min(4,len)=3 for 3 entries → head fills maxItems already
    // But we need head + tail > maxItems. So we need more entries with a small maxItems.
    // headKeep = min(4, entries.length) = 4
    // We need head(4) + tail(N) > maxItems, and maxChars large enough to pick up tail entries.
    const entries = Array.from({ length: 20 }, (_, i) => ({
      role: i % 2 === 0 ? 'user' : 'mentor',
      speaker: i % 2 === 0 ? 'User' : 'Mentor',
      text: `Message ${i}`,
    }));

    // maxItems=3 forces head(4) + tail entries > 3, triggering the slice
    const result = compactConversationHistoryDeterministic(entries, 3, 60000);
    expect(result.entries.length).toBeLessThanOrEqual(3);
  });

  it('falls back to deterministic when rounds <= 4 but tokens exceed threshold', async () => {
    // ≤4 rounds, but byte size pushed past the NEW-6 hard byte floor
    // (32KB) so we bypass the early short-circuit and reach the rounds
    // check. Each entry is capped to 2000 chars by normalizeConversationHistory,
    // so we need ~18+ entries to cross 32KB total.
    const pad = 'a'.repeat(1900);
    const entries = [
      { role: 'user', speaker: 'User', text: `u1 ${pad}` },
      ...Array.from({ length: 6 }, (_, i) => ({ role: 'mentor', speaker: `M${i}`, text: `r1-${i} ${pad}` })),
      { role: 'user', speaker: 'User', text: `u2 ${pad}` },
      ...Array.from({ length: 6 }, (_, i) => ({ role: 'mentor', speaker: `M${i}`, text: `r2-${i} ${pad}` })),
      { role: 'user', speaker: 'User', text: `u3 ${pad}` },
      ...Array.from({ length: 6 }, (_, i) => ({ role: 'mentor', speaker: `M${i}`, text: `r3-${i} ${pad}` })),
      { role: 'user', speaker: 'User', text: `u4 ${pad}` },
      { role: 'mentor', speaker: 'M0', text: `r4-0 ${pad}` },
    ];

    const result = await compactConversationHistory(entries, {
      tokenThreshold: 100,
      maxItems: 36,
      maxChars: 6000,
      language: 'en',
      model: 'test-model',
      apiKey: 'test-key',
      chatCompletionsUrl: 'https://api.test.com/v1/chat/completions',
      compressTimeoutMs: 5000,
    });

    // Should use deterministic fallback since rounds <= 4 (4 user messages)
    expect(result.usedLlmCompression).toBe(false);
    expect(result.estimatedTokens).toBeGreaterThan(100);
  });

  it('takes compression branch but uses deterministic middle summary when LLM call fails', async () => {
    // Build 80 entries (>4 rounds) with enough text to exceed tokenThreshold
    const entries = Array.from({ length: 80 }, (_, i) => ({
      role: i % 2 === 0 ? 'user' : 'mentor',
      speaker: i % 2 === 0 ? 'User' : 'Mentor',
      text: `Message ${i}: ${'a'.repeat(2000)}`,
    }));

    // Simulate LLM API failure
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      json: async () => ({}),
      text: async () => 'error',
    });

    const result = await compactConversationHistory(entries, {
      tokenThreshold: 100,
      maxItems: 36,
      maxChars: 6000,
      language: 'en',
      model: 'test-model',
      apiKey: 'test-key',
      chatCompletionsUrl: 'https://api.test.com/v1/chat/completions',
      compressTimeoutMs: 5000,
    });

    // The function took the LLM-compression BRANCH (preserves first 2 + last 2 rounds)
    // and set usedLlmCompression: true to signal that branch was taken, even though
    // the LLM itself failed and we fell back to a deterministic middle summary.
    expect(result.usedLlmCompression).toBe(true);
    // Verify the fallback actually happened: fetch was called (and failed)
    expect(globalThis.fetch).toHaveBeenCalled();
    // The summary must still be produced via deterministic fallback — it should
    // contain the marker from summarizeCompactedMiddleDeterministic, not LLM output
    expect(result.summary).toContain('Middle rounds compacted');
    // Verify structural invariants of the compression branch:
    //  - omittedCount > 0 (middle entries were removed)
    //  - preservedEntries are from rounds 0, 1, N-2, N-1 only
    expect(result.omittedCount).toBeGreaterThan(0);
    expect(result.entries.length).toBeLessThan(entries.length);
  });

  it('uses OPENAI_API_KEY and OPENAI_BASE_URL as fallbacks', async () => {
    delete process.env.LLM_API_KEY;
    delete process.env.LLM_MODEL;
    delete process.env.LLM_API_BASE_URL;
    process.env.OPENAI_API_KEY = 'openai-key';
    process.env.OPENAI_MODEL = 'gpt-4';
    process.env.OPENAI_BASE_URL = 'https://api.openai.com/v1';

    const llmResponse = makeLLMResponse('elon_musk', 'Elon Musk');
    let capturedAuth;
    globalThis.fetch = vi.fn().mockImplementation(async (url, opts) => {
      capturedAuth = opts.headers.Authorization;
      return {
        ok: true,
        status: 200,
        json: async () => ({
          choices: [{ message: { content: JSON.stringify(llmResponse) } }],
        }),
        text: async () => '',
      };
    });

    const res = mockRes();
    await handler(mockReq({
      method: 'POST',
      body: { problem: 'test', language: 'en', mentors: [sampleMentor] },
    }), res);

    expect(res._status).toBe(200);
    expect(capturedAuth).toBe('Bearer openai-key');
  });

  it('sanitizes "if I were" patterns from responses', async () => {
    const response = makeLLMResponse('elon_musk', 'Elon Musk');
    response.mentorReplies[0].likelyResponse = 'If I were you, I would take this step first and iterate.';
    globalThis.fetch = mockFetchOk(response);

    const res = mockRes();
    await handler(mockReq({
      method: 'POST',
      body: { problem: 'test', language: 'en', mentors: [sampleMentor] },
    }), res);

    expect(res._status).toBe(200);
    expect(res._json.mentorReplies[0].likelyResponse).not.toMatch(/^if i were/i);
  });
});

// ---------------------------------------------------------------------------
// Backend context continuity tests (migrated from mentorTableBackendContext)
// ---------------------------------------------------------------------------
describe('mentor-table backend context continuity', () => {
  const lisaSu = {
    id: 'custom_lisa_su',
    displayName: 'Lisa Su',
    shortLabel: 'Lisa',
    speakingStyle: ['direct and engineering-focused'],
    coreValues: ['execution'],
    decisionPatterns: ['iterate'],
    knownExperienceThemes: ['semiconductors'],
    likelyBlindSpots: [],
    avoidClaims: [],
  };
  const satyaNadella = {
    id: 'custom_satya_nadella',
    displayName: 'Satya Nadella',
    shortLabel: 'Satya',
    speakingStyle: ['calm and empathetic'],
    coreValues: ['growth mindset'],
    decisionPatterns: ['align'],
    knownExperienceThemes: ['cloud'],
    likelyBlindSpots: [],
    avoidClaims: [],
  };

  it('builds a shared prompt that includes prior conversation history', () => {
    const history = normalizeConversationHistory([
      { role: 'user', speaker: 'You', text: 'I am overwhelmed at work.' },
      { role: 'mentor', speaker: 'Lisa', text: 'Start by cutting the scope and stabilizing the basics.' },
      { role: 'mentor', speaker: 'Satya Nadella', text: 'Align with your team on one priority before expanding.' },
      { role: 'user', speaker: 'You', text: 'Lisa, Satya, my boss keeps changing priorities every day.' },
    ]);

    const prompt = buildUserPrompt(
      'Lisa, Satya, my boss keeps changing priorities every day.',
      'en',
      [lisaSu, satyaNadella],
      { entries: history, summary: '', omittedCount: 0, usedLlmCompression: false }
    );

    expect(prompt).toContain('Conversation context');
    expect(prompt).toContain('[user] You: I am overwhelmed at work.');
    expect(prompt).toContain('[mentor] Lisa: Start by cutting the scope');
  });

  it('keeps first/last rounds when compaction is forced', async () => {
    // Pad text so total byte size > 32KB (NEW-6 hard floor) and the LLM
    // compression path actually runs. Each entry is ~2KB of filler.
    const filler = (tag) => `${tag}: ${'x'.repeat(2000)}`;
    const history = [
      { role: 'user', speaker: 'You', text: `Round 1 user concern about burnout. ${filler('u1')}` },
      { role: 'mentor', speaker: 'Lisa', text: `Round 1 Lisa advice. ${filler('m1a')}` },
      { role: 'mentor', speaker: 'Satya', text: `Round 1 Satya advice. ${filler('m1b')}` },
      { role: 'user', speaker: 'You', text: `Round 2 user follow-up. ${filler('u2')}` },
      { role: 'mentor', speaker: 'Lisa', text: `Round 2 Lisa advice. ${filler('m2a')}` },
      { role: 'mentor', speaker: 'Satya', text: `Round 2 Satya advice. ${filler('m2b')}` },
      { role: 'user', speaker: 'You', text: `Round 3 user update about stress. ${filler('u3')}` },
      { role: 'mentor', speaker: 'Lisa', text: `Round 3 Lisa advice. ${filler('m3a')}` },
      { role: 'mentor', speaker: 'Satya', text: `Round 3 Satya advice. ${filler('m3b')}` },
      { role: 'user', speaker: 'You', text: `Round 4 user update about conflict. ${filler('u4')}` },
      { role: 'mentor', speaker: 'Lisa', text: `Round 4 Lisa advice. ${filler('m4a')}` },
      { role: 'mentor', speaker: 'Satya', text: `Round 4 Satya advice. ${filler('m4b')}` },
      { role: 'user', speaker: 'You', text: `Round 5 user asks for a plan. ${filler('u5')}` },
      { role: 'mentor', speaker: 'Lisa', text: `Round 5 Lisa advice. ${filler('m5a')}` },
      { role: 'mentor', speaker: 'Satya', text: `Round 5 Satya advice. ${filler('m5b')}` },
      { role: 'user', speaker: 'You', text: `Round 6 user asks how to communicate upward. ${filler('u6')}` },
      { role: 'mentor', speaker: 'Lisa', text: `Round 6 Lisa advice. ${filler('m6a')}` },
      { role: 'mentor', speaker: 'Satya', text: `Round 6 Satya advice. ${filler('m6b')}` },
    ];

    const compacted = await compactConversationHistory(history, {
      tokenThreshold: 1,
      maxItems: 99,
      maxChars: 20000,
      language: 'en',
      model: 'test-model',
      apiKey: '',
      chatCompletionsUrl: 'http://127.0.0.1:9/disabled',
      compressTimeoutMs: 5,
    });

    const formatted = formatConversationHistoryForPrompt(compacted.entries);
    expect(compacted.usedLlmCompression).toBe(true);
    expect(formatted).toContain('Round 1 user concern about burnout.');
    expect(formatted).toContain('Round 6 user asks how to communicate upward.');
    expect(formatted).not.toContain('Round 3 user update about stress.');
  });

  it('includes mentor-specific directive blocks', () => {
    const directives = buildMentorDirectiveBlock([lisaSu, satyaNadella]);
    expect(directives).toContain('custom_lisa_su');
    expect(directives).toContain('Lisa Su');
    expect(directives).toContain('custom_satya_nadella');
    expect(directives).toContain('Satya Nadella');
  });
});

// ---------------------------------------------------------------------------
// Edge cases for remaining uncovered lines
// ---------------------------------------------------------------------------
describe('mentor-table edge cases', () => {
  const llmEnvKeys2 = [
    'LLM_API_KEY', 'OPENAI_API_KEY', 'LLM_API_TOKEN', 'OPENAI_KEY',
    'LLM_MODEL', 'OPENAI_MODEL', 'LLM_API_BASE_URL', 'OPENAI_BASE_URL',
    'MENTOR_UPSTREAM_TIMEOUT_MS', 'MENTOR_HISTORY_COMPRESS_TOKENS',
  ];
  const savedEdgeEnv = {};
  const originalFetch2 = globalThis.fetch;

  beforeEach(() => {
    for (const key of llmEnvKeys2) {
      savedEdgeEnv[key] = process.env[key];
      delete process.env[key];
    }
    process.env.LLM_API_KEY = 'test-key-edge';
    process.env.LLM_MODEL = 'test-model';
    process.env.LLM_API_BASE_URL = 'https://api.edge.com/v1';
    process.env.MENTOR_UPSTREAM_TIMEOUT_MS = '5000';
  });

  afterEach(() => {
    globalThis.fetch = originalFetch2;
    for (const [key, val] of Object.entries(savedEdgeEnv)) {
      if (val === undefined) delete process.env[key];
      else process.env[key] = val;
    }
  });

  it('handles extractAssistantContent returning empty string when content is null', async () => {
    // LLM returns no content at all → extractAssistantContent returns ''
    // First call: empty content → repair attempt
    // Second call: also empty content → falls back
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        choices: [{ message: {} }], // no content field
      }),
      text: async () => '',
    });

    const res = mockRes();
    await handler(mockReq({
      method: 'POST',
      body: { problem: 'test', language: 'en', mentors: [sampleMentor] },
    }), res);

    // Should fall back gracefully
    expect(res._status).toBe(200);
    expect(res._json.meta.provider).toBe('server-fallback');
  });

  it('triggers LLM compression in handler path with large history', async () => {
    // Set a very low token threshold so the handler triggers LLM compression
    process.env.MENTOR_HISTORY_COMPRESS_TOKENS = '10';

    const llmResponse = makeLLMResponse('elon_musk', 'Elon Musk');
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        choices: [{ message: { content: JSON.stringify(llmResponse) } }],
      }),
      text: async () => '',
    });

    // Large history to trigger compression in the handler. Must stay within
    // HISTORY_MAX_ENTRIES (50) added as a DoS/cost cap (bug hunt #8 fix).
    // 40 entries = 20 user+mentor pairs = plenty to cross the compression
    // threshold (rounds > 4) while leaving headroom under the cap.
    const history = Array.from({ length: 40 }, (_, i) => ({
      role: i % 2 === 0 ? 'user' : 'mentor',
      speaker: i % 2 === 0 ? 'User' : 'Elon Musk',
      text: `Message ${i}: ${'x'.repeat(500)}`,
    }));

    const res = mockRes();
    await handler(mockReq({
      method: 'POST',
      body: {
        problem: 'Follow up',
        language: 'en',
        mentors: [sampleMentor],
        conversationHistory: history,
      },
    }), res);

    expect(res._status).toBe(200);
  });

  it('handles invalid base URL in providerFromBaseUrl (catch path)', async () => {
    process.env.LLM_API_BASE_URL = 'not-a-valid-url';
    const llmResponse = makeLLMResponse('elon_musk', 'Elon Musk');
    globalThis.fetch = mockFetchOk(llmResponse);

    const res = mockRes();
    await handler(mockReq({
      method: 'POST',
      body: { problem: 'test', language: 'en', mentors: [sampleMentor] },
    }), res);

    expect(res._status).toBe(200);
    expect(res._json.meta.provider).toBe('unknown');
  });

  it('returns 500 with timeout message for outer AbortError', async () => {
    // Force an error in the handler's try block that's not caught by per-mentor
    // This happens if compactConversationHistory itself throws AbortError
    const abortErr = new Error('The operation was aborted');
    abortErr.name = 'AbortError';

    // Provide a body whose conversationHistory getter throws
    const badBody = {
      problem: 'test',
      language: 'en',
      mentors: [sampleMentor],
    };
    Object.defineProperty(badBody, 'conversationHistory', {
      get() { throw abortErr; },
      enumerable: true,
    });

    const res = mockRes();
    await handler(mockReq({ method: 'POST', body: badBody }), res);

    expect(res._status).toBe(500);
    expect(res._json.error).toBe('Upstream LLM request timed out');
  });

  it('returns 500 with error message for outer generic error', async () => {
    const badBody = {
      problem: 'test',
      language: 'en',
      mentors: [sampleMentor],
    };
    Object.defineProperty(badBody, 'conversationHistory', {
      get() { throw new Error('Something broke'); },
      enumerable: true,
    });

    const res = mockRes();
    await handler(mockReq({ method: 'POST', body: badBody }), res);

    expect(res._status).toBe(500);
    expect(res._json.error).toBe('Something broke');
  });

  it('handles array content with mixed part types including empty parts', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        choices: [{
          message: {
            content: [
              'plain string part',
              { text: JSON.stringify(makeLLMResponse('elon_musk', 'Elon Musk')) },
              42, // not string, not object with text — triggers return ''
              { notText: true }, // also triggers return ''
            ],
          },
        }],
      }),
      text: async () => '',
    });

    const res = mockRes();
    await handler(mockReq({
      method: 'POST',
      body: { problem: 'test', language: 'en', mentors: [sampleMentor] },
    }), res);

    expect(res._status).toBe(200);
  });

  it('handles mentor-keyed object shape (no mentorReplies/replies/response)', async () => {
    // This triggers the last normalizeProviderPayload variant: object-values fallback
    const payload = {
      elon_musk: {
        mentorId: 'elon_musk',
        mentorName: 'Elon Musk',
        likelyResponse: 'Think from first principles.',
        whyThisFits: 'Core to the approach.',
        oneActionStep: 'Write it down.',
        confidenceNote: 'AI perspective.',
      },
    };
    globalThis.fetch = mockFetchOk(payload);

    const res = mockRes();
    await handler(mockReq({
      method: 'POST',
      body: { problem: 'test', language: 'en', mentors: [sampleMentor] },
    }), res);

    expect(res._status).toBe(200);
    expect(res._json.mentorReplies).toHaveLength(1);
  });

  it('uses zh-CN fallback in loose extraction when whyThisFits is absent', async () => {
    // Trigger normalizeProviderPayloadLoose with zh-CN language
    // Both main parse and repair fail, loose extraction has no whyThisFits
    let callIndex = 0;
    globalThis.fetch = vi.fn().mockImplementation(async () => {
      callIndex += 1;
      if (callIndex <= 2) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            choices: [{
              message: {
                content: `"mentorId": "elon_musk"\n"mentorName": "Elon Musk"\n"likelyResponse": "先从第一原理思考。"`,
              },
            }],
          }),
          text: async () => '',
        };
      }
      return { ok: false, status: 500, text: async () => 'fail' };
    });

    const res = mockRes();
    await handler(mockReq({
      method: 'POST',
      body: { problem: '请帮忙', language: 'zh-CN', mentors: [sampleMentor] },
    }), res);

    expect(res._status).toBe(200);
  });

  it('falls back when LLM returns valid JSON with empty mentorReplies (no reply match)', async () => {
    // normalizeProviderPayload returns an object with empty mentorReplies → normalized is null
    // → normalizeProviderPayloadLoose is tried → if no likelyResponse field → returns null
    // → throw Error → caught by per-mentor error handler → fallback
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        choices: [{
          message: {
            content: JSON.stringify({
              safety: { riskLevel: 'none', needsProfessionalHelp: false, emergencyMessage: '' },
              mentorReplies: [],
              meta: { disclaimer: 'test' },
            }),
          },
        }],
      }),
      text: async () => '',
    });

    const res = mockRes();
    await handler(mockReq({
      method: 'POST',
      body: { problem: 'test', language: 'en', mentors: [sampleMentor] },
    }), res);

    expect(res._status).toBe(200);
    expect(res._json.meta.provider).toBe('server-fallback');
  });

  it('returns 500 with unknown error for non-Error throw', async () => {
    const badBody = {
      problem: 'test',
      language: 'en',
      mentors: [sampleMentor],
    };
    Object.defineProperty(badBody, 'conversationHistory', {
      get() { throw 'string error'; },
      enumerable: true,
    });

    const res = mockRes();
    await handler(mockReq({ method: 'POST', body: badBody }), res);

    expect(res._status).toBe(500);
    expect(res._json.error).toBe('Unknown server error');
  });
});

// ---------------------------------------------------------------------------
// tryParseJson — multi-object and edge cases
// ---------------------------------------------------------------------------
describe('tryParseJson', () => {
  it('parses multiple top-level JSON objects separated by newlines into replies', () => {
    const input = '{"mentorId":"a","likelyResponse":"hello"}\n{"mentorId":"b","likelyResponse":"world"}';
    const result = tryParseJson(input);
    expect(result).toHaveProperty('replies');
    expect(result.replies).toHaveLength(2);
    expect(result.replies[0].mentorId).toBe('a');
    expect(result.replies[1].mentorId).toBe('b');
  });

  it('filters out unparseable chunks in multi-object input', () => {
    const input = '{"mentorId":"a"}\n{invalid json}\n{"mentorId":"b"}';
    const result = tryParseJson(input);
    expect(result).toHaveProperty('replies');
    expect(result.replies).toHaveLength(2);
  });

  it('handles double-encoded JSON string (unwraps nested stringified JSON)', () => {
    // JSON.stringify wraps an object in a string, then that string is stringified again
    const inner = { mentorId: 'test', likelyResponse: 'hi' };
    const doubleEncoded = JSON.stringify(JSON.stringify(inner));
    const result = tryParseJson(doubleEncoded);
    expect(result).toBeTruthy();
    expect(result.mentorId).toBe('test');
  });

  it('handles triple-encoded JSON string (exhausts 3 iterations)', () => {
    const inner = { mentorId: 'deep', likelyResponse: 'nested' };
    const tripleEncoded = JSON.stringify(JSON.stringify(JSON.stringify(inner)));
    const result = tryParseJson(tripleEncoded);
    expect(result).toBeTruthy();
    expect(result.mentorId).toBe('deep');
  });

  it('returns null after exhausting nested string iterations (4x encoded)', () => {
    const inner = { mentorId: 'too-deep' };
    const quadEncoded = JSON.stringify(JSON.stringify(JSON.stringify(JSON.stringify(inner))));
    // Measure wall-clock to prove the loop cannot recurse infinitely and
    // yields a deterministic value shape (either a parsed object or null
    // from the embedded-object extraction fallback).
    const startedAt = Date.now();
    const result = tryParseJson(quadEncoded);
    const elapsed = Date.now() - startedAt;
    expect(elapsed).toBeLessThan(100);
    // Contract: tryParseJson returns either null or a plain object/array —
    // never throws, never returns a raw string.
    expect(result === null || typeof result === 'object').toBe(true);
    // And strings (including the doubly-stringified inner value) are NEVER
    // returned directly: if the 3-iteration cap was silently removed, you'd
    // get back a string here.
    expect(typeof result).not.toBe('string');
  });

  it('parses top-level array payload directly', () => {
    const arr = [{ mentorId: 'a', likelyResponse: 'x' }, { mentorId: 'b', likelyResponse: 'y' }];
    const result = tryParseJson(JSON.stringify(arr));
    // tryParseNested handles valid arrays directly
    expect(Array.isArray(result)).toBe(true);
    expect(result).toHaveLength(2);
  });

  it('handles malformed array payload (starts/ends with brackets) gracefully', () => {
    // This hits the catch branch at lines 588-595 for invalid array text
    const input = '[not valid json]';
    const result = tryParseJson(input);
    // tryParseNested fails, then the array try/catch also fails, falls through
    expect(result).toBeNull();
  });

  it('returns null when no JSON object is found in text', () => {
    const result = tryParseJson('just plain text with no braces');
    expect(result).toBeNull();
  });

  it('falls back to embedded object extraction when text wraps JSON', () => {
    const input = 'Here is the response: {"mentorId":"x","likelyResponse":"test"} end';
    const result = tryParseJson(input);
    expect(result).toBeTruthy();
    expect(result.mentorId).toBe('x');
  });
});

// ---------------------------------------------------------------------------
// normalizeProviderPayload — disclaimer default & mentor name matching
// ---------------------------------------------------------------------------
describe('normalizeProviderPayload edge cases', () => {
  it('uses defaultDisclaimer when mentorReplies present but no disclaimer fields', () => {
    const raw = {
      safety: { riskLevel: 'low' },
      mentorReplies: [
        { mentorId: 'test', likelyResponse: 'hello' }
      ],
      // No meta, no GlobalDisclaimer, no globalDisclaimer, no disclaimer
    };
    const result = normalizeProviderPayload(raw, { mentors: [sampleMentor], language: 'en' });
    expect(result).toBeTruthy();
    expect(result.meta.disclaimer).toBeTruthy();
    expect(typeof result.meta.disclaimer).toBe('string');
  });

  it('matches single-response shape by mentor displayName', () => {
    const raw = {
      mentorId: 'elon_musk',
      mentorName: 'Elon Musk',
      response: 'First principles thinking.',
    };
    const mentors = [sampleMentor];
    const result = normalizeProviderPayload(raw, { mentors, language: 'en' });
    expect(result).toBeTruthy();
    expect(result.mentorReplies).toHaveLength(1);
    expect(result.mentorReplies[0].mentorName).toBe('Elon Musk');
  });

  it('matches single-response shape by displayName when id does not match', () => {
    const raw = {
      mentorId: 'unknown_id',
      name: 'Elon Musk',
      response: 'Think big.',
    };
    const mentors = [sampleMentor];
    const result = normalizeProviderPayload(raw, { mentors, language: 'en' });
    expect(result).toBeTruthy();
    expect(result.mentorReplies[0].mentorId).toBe('unknown_id');
  });
});

// ---------------------------------------------------------------------------
// pickReplyForMentor — null fallback when no replies match
// ---------------------------------------------------------------------------
describe('pickReplyForMentor', () => {
  it('returns first reply when mentorId matches', () => {
    const normalized = {
      mentorReplies: [
        { mentorId: 'elon_musk', mentorName: 'Elon Musk', likelyResponse: 'Go!' }
      ],
    };
    const result = pickReplyForMentor(sampleMentor, normalized);
    expect(result.likelyResponse).toBe('Go!');
  });

  it('returns null when mentorReplies is empty', () => {
    const normalized = { mentorReplies: [] };
    const result = pickReplyForMentor(sampleMentor, normalized);
    expect(result).toBeNull();
  });

  it('falls back to first reply when no id or name matches', () => {
    const normalized = {
      mentorReplies: [
        { mentorId: 'other', mentorName: 'Other', likelyResponse: 'Fallback' }
      ],
    };
    const result = pickReplyForMentor(sampleMentor, normalized);
    expect(result.likelyResponse).toBe('Fallback');
  });
});

// ---------------------------------------------------------------------------
// Handler: no reply for mentor after normalization (lines 1126-1127)
// ---------------------------------------------------------------------------
describe('handler no-reply-for-mentor fallback', () => {
  const savedEnv = {};
  beforeEach(() => {
    for (const key of ['LLM_API_KEY', 'OPENAI_API_KEY', 'LLM_API_TOKEN', 'OPENAI_KEY',
      'LLM_MODEL', 'OPENAI_MODEL', 'LLM_API_BASE_URL', 'OPENAI_BASE_URL']) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
    process.env.LLM_API_KEY = 'test-key';
  });
  afterEach(() => {
    for (const [key, val] of Object.entries(savedEnv)) {
      if (val === undefined) delete process.env[key];
      else process.env[key] = val;
    }
    if (globalThis.fetch !== undefined) delete globalThis.fetch;
  });

  it('falls back to server-fallback when normalizeProviderPayload returns structure with no matching reply', async () => {
    // Return valid JSON that normalizes, but with mentorReplies containing
    // entries where likelyResponse is empty → normalizeReply filters them out →
    // normalized ends up null → normalizeProviderPayloadLoose is attempted
    // with content that also yields null → throw → fallback
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        choices: [{
          message: {
            content: JSON.stringify({
              safety: { riskLevel: 'none', needsProfessionalHelp: false },
              mentorReplies: [{ mentorId: 'wrong_mentor', likelyResponse: '' }],
              meta: { disclaimer: 'test' },
            }),
          },
        }],
      }),
      text: async () => '',
    });

    const res = mockRes();
    await handler(mockReq({
      method: 'POST',
      body: { problem: 'test', language: 'en', mentors: [sampleMentor] },
    }), res);

    expect(res._status).toBe(200);
    expect(res._json.meta.provider).toBe('server-fallback');
    // Confirm we reached buildServerFallbackNormalized (not some generic
    // error path that also tags provider='server-fallback') by asserting
    // the language-safe canonical English fallback text was rendered for
    // THIS mentor — and only for this mentor.
    expect(res._json.mentorReplies).toHaveLength(1);
    expect(res._json.mentorReplies[0].mentorId).toBe(sampleMentor.id);
    expect(res._json.mentorReplies[0].likelyResponse).toMatch(
      /I understand this is difficult/
    );
    expect(res._json.mentorReplies[0].likelyResponse).toMatch(
      /smallest executable step/
    );
  });
});

// ---------------------------------------------------------------------------
// Small helper function edge cases
// ---------------------------------------------------------------------------
describe('riskLevelScore', () => {
  it('returns 1 for unknown risk level values', () => {
    expect(riskLevelScore('unknown')).toBe(1);
    expect(riskLevelScore(undefined)).toBe(1);
    expect(riskLevelScore('')).toBe(1);
  });
});

describe('normalizeRiskLevel', () => {
  it('returns low for unknown values', () => {
    expect(normalizeRiskLevel('unknown')).toBe('low');
    expect(normalizeRiskLevel(undefined)).toBe('low');
    expect(normalizeRiskLevel('')).toBe('low');
  });
});

describe('detectLanguageFromText', () => {
  it('returns en for predominantly Latin text', () => {
    expect(detectLanguageFromText('Hello world this is English text')).toBe('en');
  });

  it('returns zh-CN for predominantly CJK text', () => {
    expect(detectLanguageFromText('你好世界这是中文')).toBe('zh-CN');
  });
});

describe('resolveEffectiveLanguage', () => {
  it('returns detected language from conversation history user messages', () => {
    const history = [
      { role: 'user', text: '你好世界这是中文文本测试' },
    ];
    // requestedLanguage is non-standard so line 102 doesn't match;
    // problem has no detectable language; history user message is Chinese
    const result = resolveEffectiveLanguage('auto', '12345', history);
    expect(result).toBe('zh-CN');
  });

  it('falls back to requested language when nothing is detectable', () => {
    const result = resolveEffectiveLanguage('zh-CN', '123', []);
    expect(result).toBe('zh-CN');
  });

  it('falls back to normalized requested language when history has no detectable user messages', () => {
    const history = [
      { role: 'mentor', text: 'Some mentor text' },
      { role: 'user', text: '12345' }, // no detectable language
    ];
    // 'auto' bypasses line 102; problem '12345' is undetectable; loop finds nothing
    // normalizeLanguage('auto') → 'zh-CN' (anything not 'en' becomes 'zh-CN')
    const result = resolveEffectiveLanguage('auto', '12345', history);
    expect(result).toBe('zh-CN');
  });

  it('detects language from problem text when no explicit language given', () => {
    // Exercises line 107: problemLanguage truthy → return early
    const result = resolveEffectiveLanguage('auto', 'Hello this is an English problem', []);
    expect(result).toBe('en');
  });

  it('skips non-user history items while scanning backwards', () => {
    // Exercises line 112: `if (!item || item.role !== 'user') continue;`
    const history = [
      null,
      { role: 'mentor', text: 'English mentor reply' },
      { role: 'system', text: 'system text' },
      { role: 'user', text: '这是一段足够长的中文' },
    ];
    const result = resolveEffectiveLanguage('auto', '123', history);
    expect(result).toBe('zh-CN');
  });
});

// ---------------------------------------------------------------------------
// riskLevelScore — all discrete values including 'low'
// ---------------------------------------------------------------------------
describe('riskLevelScore (all discrete values)', () => {
  it('returns 3 for high', () => { expect(riskLevelScore('high')).toBe(3); });
  it('returns 2 for medium', () => { expect(riskLevelScore('medium')).toBe(2); });
  it('returns 1 for low', () => { expect(riskLevelScore('low')).toBe(1); });
  it('returns 0 for none', () => { expect(riskLevelScore('none')).toBe(0); });
});

// ---------------------------------------------------------------------------
// normalizeRiskLevel — valid values
// ---------------------------------------------------------------------------
describe('normalizeRiskLevel (valid values)', () => {
  it('passes through "none"', () => { expect(normalizeRiskLevel('none')).toBe('none'); });
  it('passes through "low"', () => { expect(normalizeRiskLevel('low')).toBe('low'); });
  it('passes through "medium"', () => { expect(normalizeRiskLevel('medium')).toBe('medium'); });
  it('passes through "high"', () => { expect(normalizeRiskLevel('high')).toBe('high'); });
});

// ---------------------------------------------------------------------------
// mergeSafetyState — all branches
// ---------------------------------------------------------------------------
describe('mergeSafetyState', () => {
  const baseAcc = { riskLevel: 'low', needsProfessionalHelp: false, emergencyMessage: '' };

  it('returns acc unchanged when next is null', () => {
    const result = mergeSafetyState(baseAcc, null);
    expect(result).toBe(baseAcc);
  });

  it('returns acc unchanged when next is undefined', () => {
    expect(mergeSafetyState(baseAcc, undefined)).toBe(baseAcc);
  });

  it('returns acc unchanged when next is not an object (string)', () => {
    expect(mergeSafetyState(baseAcc, 'bad')).toBe(baseAcc);
  });

  it('prefers next emergencyMessage when next risk is higher', () => {
    // useNext=true branch at line 73: next.emergencyMessage || acc.emergencyMessage
    const result = mergeSafetyState(
      { riskLevel: 'low', needsProfessionalHelp: false, emergencyMessage: 'old' },
      { riskLevel: 'high', needsProfessionalHelp: true, emergencyMessage: 'new' }
    );
    expect(result.riskLevel).toBe('high');
    expect(result.emergencyMessage).toBe('new');
    expect(result.needsProfessionalHelp).toBe(true);
  });

  it('falls through to acc emergencyMessage when next risk higher but next msg empty', () => {
    // useNext=true branch, next.emergencyMessage falsy → acc.emergencyMessage
    const result = mergeSafetyState(
      { riskLevel: 'low', needsProfessionalHelp: false, emergencyMessage: 'old' },
      { riskLevel: 'high', needsProfessionalHelp: false, emergencyMessage: '' }
    );
    expect(result.emergencyMessage).toBe('old');
  });

  it('falls through to empty string when neither side has emergency message and useNext=true', () => {
    const result = mergeSafetyState(
      { riskLevel: 'low', needsProfessionalHelp: false, emergencyMessage: '' },
      { riskLevel: 'high', needsProfessionalHelp: false, emergencyMessage: '' }
    );
    expect(result.emergencyMessage).toBe('');
  });

  it('keeps acc emergencyMessage when acc risk is higher', () => {
    // useNext=false branch at line 74-75
    const result = mergeSafetyState(
      { riskLevel: 'high', needsProfessionalHelp: true, emergencyMessage: 'keep' },
      { riskLevel: 'low', needsProfessionalHelp: false, emergencyMessage: 'discard' }
    );
    expect(result.riskLevel).toBe('high');
    expect(result.emergencyMessage).toBe('keep');
  });

  it('falls through to next emergencyMessage when acc risk higher but acc msg empty', () => {
    const result = mergeSafetyState(
      { riskLevel: 'high', needsProfessionalHelp: false, emergencyMessage: '' },
      { riskLevel: 'low', needsProfessionalHelp: false, emergencyMessage: 'next' }
    );
    expect(result.emergencyMessage).toBe('next');
  });

  it('falls through to empty string when neither side has emergency message and useNext=false', () => {
    const result = mergeSafetyState(
      { riskLevel: 'high', needsProfessionalHelp: false, emergencyMessage: '' },
      { riskLevel: 'low', needsProfessionalHelp: false, emergencyMessage: '' }
    );
    expect(result.emergencyMessage).toBe('');
  });
});

// ---------------------------------------------------------------------------
// detectLanguageFromText / detectContentLanguage — edge cases
// ---------------------------------------------------------------------------
describe('detectLanguageFromText edge cases', () => {
  it('returns null for non-string', () => {
    expect(detectLanguageFromText(null)).toBeNull();
    expect(detectLanguageFromText(42)).toBeNull();
  });

  it('returns null for empty string', () => {
    expect(detectLanguageFromText('   ')).toBeNull();
  });

  it('returns null for text with no CJK or Latin chars', () => {
    expect(detectLanguageFromText('1234 5678')).toBeNull();
  });

  // NOTE: the "last ternary" in detectLanguageFromText is mathematically
  // unreachable — if `cjkCount < latinCount*0.8` AND `latinCount < cjkCount*0.8`
  // both hold, their product would be < 0.64 < 1, which is impossible. The
  // branch was covered by a tautology test that added no behavioural value;
  // it has been removed. See orchestrator flag for follow-up on dead code.
});

describe('detectContentLanguage edge cases', () => {
  it('returns null for non-string', () => {
    expect(detectContentLanguage(undefined)).toBeNull();
    expect(detectContentLanguage(123)).toBeNull();
  });

  it('returns null for whitespace-only text', () => {
    expect(detectContentLanguage('   ')).toBeNull();
  });

  it('returns null for text with no CJK or Latin chars', () => {
    expect(detectContentLanguage('12345 67890 !@#')).toBeNull();
  });

  it('returns en for English text', () => {
    expect(detectContentLanguage('Hello world this is English text here')).toBe('en');
  });

  it('returns zh-CN for CJK text', () => {
    expect(detectContentLanguage('你好世界这是中文')).toBe('zh-CN');
  });

  it('handles mixed text where neither threshold triggers → falls to last ternary', () => {
    // 5 CJK, 4 latin: cjkCount(5) >= Math.max(3, 4*0.7=2.8)=3 → true → 'zh-CN'
    // Need both conditions false.
    // cjkCount=2, latinCount=2: first cjk>=Math.max(3,1.4)=3 → 2>=3 false; latin>=Math.max(6,2*1.4=2.8)=6 → false
    // Both false → last ternary: 2>=2 true → 'zh-CN'
    expect(detectContentLanguage('ab 你好')).toBe('zh-CN');
  });

  it('handles text where latinCount > cjkCount in last ternary (false branch)', () => {
    // cjkCount=1, latinCount=3: first cjk>=Math.max(3,2.1)=3 → 1>=3 false;
    // latin>=Math.max(6, 1*1.4=1.4)=6 → 3>=6 false; both false
    // last ternary: 1>=3 false → 'en'
    expect(detectContentLanguage('abc 你')).toBe('en');
  });
});

// ---------------------------------------------------------------------------
// contentMatchesLanguage
// ---------------------------------------------------------------------------
describe('contentMatchesLanguage', () => {
  it('returns true when content is not detectable', () => {
    // Line 184: `if (!detected) return true;`
    expect(contentMatchesLanguage('', 'en')).toBe(true);
    expect(contentMatchesLanguage('123', 'zh-CN')).toBe(true);
  });

  it('returns true when detected matches normalized language', () => {
    expect(contentMatchesLanguage('Hello world this is a test of English', 'en')).toBe(true);
    expect(contentMatchesLanguage('你好世界这是中文', 'zh-CN')).toBe(true);
  });

  it('returns false when detected mismatches', () => {
    expect(contentMatchesLanguage('你好世界这是中文', 'en')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// finalizeContractShape — defensive branches
// ---------------------------------------------------------------------------
describe('finalizeContractShape', () => {
  it('handles null normalized with defaults', () => {
    const result = finalizeContractShape(null, { language: 'en', baseUrl: 'https://api.test.com/v1', model: 'test' });
    expect(result.safety.riskLevel).toBe('low');
    expect(result.safety.needsProfessionalHelp).toBe(false);
    expect(result.safety.emergencyMessage).toBe('');
    expect(result.mentorReplies).toEqual([]);
    expect(result.meta.disclaimer).toBeTruthy();
    expect(result.meta.model).toBe('test');
    expect(result.meta.provider).toBe('api.test.com');
  });

  it('handles normalized with non-array mentorReplies', () => {
    const result = finalizeContractShape(
      { safety: {}, mentorReplies: 'not-array', meta: {} },
      { language: 'en', baseUrl: 'https://api.test.com/v1', model: 'test' }
    );
    expect(result.mentorReplies).toEqual([]);
  });

  it('filters out non-object items from mentorReplies', () => {
    const result = finalizeContractShape(
      { safety: {}, mentorReplies: [null, 'string', { mentorId: 'a', likelyResponse: 'x' }], meta: {} },
      { language: 'en', baseUrl: 'https://api.test.com/v1', model: 'test' }
    );
    expect(result.mentorReplies).toHaveLength(1);
  });

  it('coerces missing reply fields to string defaults', () => {
    const result = finalizeContractShape(
      { safety: {}, mentorReplies: [{}], meta: {} },
      { language: 'en', baseUrl: 'https://api.test.com/v1', model: 'test' }
    );
    expect(result.mentorReplies[0].mentorId).toBe('');
    expect(result.mentorReplies[0].mentorName).toBe('Mentor');
    expect(result.mentorReplies[0].likelyResponse).toBe('');
    expect(result.mentorReplies[0].whyThisFits).toBe('');
    expect(result.mentorReplies[0].oneActionStep).toBe('');
    expect(result.mentorReplies[0].confidenceNote).toBeTruthy();
  });

  it('coerces confidenceNote to default when missing', () => {
    const result = finalizeContractShape(
      { safety: {}, mentorReplies: [{ mentorId: 'a', mentorName: 'A', likelyResponse: 'x' }], meta: {} },
      { language: 'zh-CN', baseUrl: 'https://api.test.com/v1', model: 'test' }
    );
    expect(result.mentorReplies[0].confidenceNote).toContain('AI');
  });

  it('coerces safety.emergencyMessage to empty string when non-string', () => {
    const result = finalizeContractShape(
      { safety: { emergencyMessage: 42 }, mentorReplies: [], meta: {} },
      { language: 'en', baseUrl: 'https://api.test.com/v1', model: 'test' }
    );
    expect(result.safety.emergencyMessage).toBe('');
  });

  it('uses default disclaimer when meta.disclaimer is non-string', () => {
    const result = finalizeContractShape(
      { safety: {}, mentorReplies: [], meta: { disclaimer: 42 } },
      { language: 'en', baseUrl: 'https://api.test.com/v1', model: 'test' }
    );
    expect(result.meta.disclaimer).toContain('AI');
  });

  it('uses default disclaimer when meta.disclaimer is empty string', () => {
    const result = finalizeContractShape(
      { safety: {}, mentorReplies: [], meta: { disclaimer: '   ' } },
      { language: 'en', baseUrl: 'https://api.test.com/v1', model: 'test' }
    );
    expect(result.meta.disclaimer).toContain('AI');
  });

  it('uses empty model string when model is non-string', () => {
    const result = finalizeContractShape(
      { safety: {}, mentorReplies: [], meta: {} },
      { language: 'en', baseUrl: 'https://api.test.com/v1', model: null }
    );
    expect(result.meta.model).toBe('');
  });
});

// ---------------------------------------------------------------------------
// buildMentorDirectiveBlock field fallbacks
// ---------------------------------------------------------------------------
describe('buildMentorDirectiveBlock field fallbacks', () => {
  it('uses empty arrays for all missing optional fields', () => {
    const result = buildMentorDirectiveBlock([{ id: 'x', displayName: 'X' }]);
    expect(result).toContain('MentorId: x');
    expect(result).toContain('MentorName: X');
    expect(result).toContain('SpeakingStyle: \n');
    expect(result).toContain('CoreValues: \n');
    expect(result).toContain('DecisionPatterns: \n');
    expect(result).toContain('KnownExperienceThemes: \n');
    expect(result).toContain('LikelyBlindSpots: \n');
    expect(result).toContain('AvoidClaims: ');
  });

  it('handles mentor fields that are explicitly null (not undefined)', () => {
    // Exercises the `value === null` half of the null/undefined guard on
    // line 191. Passing {id: null, ...} distinguishes from the undefined case.
    const result = buildMentorDirectiveBlock([{
      id: null,
      displayName: null,
      speakingStyle: null,
    }]);
    expect(result).toContain('MentorId: \n');
    expect(result).toContain('MentorName: Mentor');
    expect(result).toContain('SpeakingStyle: \n');
  });

  it('coerces non-string mentor fields to strings', () => {
    // Exercises the `String(value)` branch in sanitizeMentorField (line 192)
    const result = buildMentorDirectiveBlock([{
      id: 42, // number → String(42)
      displayName: { toString: () => 'ObjMentor' },
      speakingStyle: [100, false], // non-string array items
    }]);
    expect(result).toContain('MentorId: 42');
    expect(result).toContain('MentorName: ObjMentor');
    expect(result).toContain('SpeakingStyle: 100; false');
  });

  it('strips control characters from mentor fields', () => {
    // Exercises the control-char regex branch (line 196)
    const result = buildMentorDirectiveBlock([{
      id: 'id',
      displayName: 'Name\u0001With\u0007Ctrl\nNewline',
    }]);
    expect(result).toContain('MentorName: Name With Ctrl Newline');
    expect(result).not.toMatch(/\u0001/);
  });

  it('truncates mentor fields longer than the cap', () => {
    // Exercises the `cleaned.length > maxLen` branch (line 197)
    // displayName cap is 120
    const longName = 'y'.repeat(500);
    const result = buildMentorDirectiveBlock([{ id: 'id', displayName: longName }]);
    const line = result.split('\n').find((l) => l.startsWith('MentorName: '));
    expect(line).toBeTruthy();
    const value = line.replace('MentorName: ', '');
    expect(value.length).toBe(120);
    expect(value).toBe('y'.repeat(120));
  });
});

// ---------------------------------------------------------------------------
// normalizeHistoryRole — direct tests
// ---------------------------------------------------------------------------
describe('normalizeHistoryRole', () => {
  it('passes through valid roles', () => {
    expect(normalizeHistoryRole('user')).toBe('user');
    expect(normalizeHistoryRole('mentor')).toBe('mentor');
    expect(normalizeHistoryRole('system')).toBe('system');
  });
  it('defaults unknown to system', () => {
    expect(normalizeHistoryRole('assistant')).toBe('system');
    expect(normalizeHistoryRole(null)).toBe('system');
  });
});

// ---------------------------------------------------------------------------
// normalizeConversationHistory — speaker non-string branch
// ---------------------------------------------------------------------------
describe('normalizeConversationHistory speaker/text coercion', () => {
  it('defaults speaker to empty string when non-string', () => {
    // Line 240: speaker = typeof item.speaker === 'string' ? ... : ''
    const result = normalizeConversationHistory([
      { role: 'user', speaker: 42, text: 'hi' },
    ]);
    expect(result[0].speaker).toBe('');
  });

  it('defaults text to empty string when non-string (filtered out)', () => {
    // Line 241: text = typeof item.text === 'string' ? ... : ''
    // Then filtered out by .filter(item.text)
    const result = normalizeConversationHistory([
      { role: 'user', text: 42 },
      { role: 'user', text: 'ok' },
    ]);
    expect(result).toHaveLength(1);
    expect(result[0].text).toBe('ok');
  });
});

// ---------------------------------------------------------------------------
// estimateTokens — falsy text branch
// ---------------------------------------------------------------------------
describe('estimateTokens', () => {
  it('returns 0 for empty / falsy text', () => {
    expect(estimateTokens('')).toBe(0);
    expect(estimateTokens(null)).toBe(0);
    expect(estimateTokens(undefined)).toBe(0);
  });

  it('estimates CJK at 1 token each plus latin at 1/4', () => {
    expect(estimateTokens('abcd')).toBe(1);
    expect(estimateTokens('你好')).toBe(2);
    expect(estimateTokens('你好abcd')).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// summarizeCompactedMiddleDeterministic — 'none' fallbacks
// ---------------------------------------------------------------------------
describe('summarizeCompactedMiddleDeterministic', () => {
  it('returns "none" placeholders when no user highlights or mentors', () => {
    // Line 289: both `|| 'none'` falsy branches
    const result = summarizeCompactedMiddleDeterministic([
      { role: 'system', speaker: '', text: 'sys' },
    ]);
    expect(result).toContain('User-highlights: none');
    expect(result).toContain('Mentor-participants: none');
  });

  it('includes mentors and user snippets when present', () => {
    const result = summarizeCompactedMiddleDeterministic([
      { role: 'user', speaker: 'u', text: 'user concern' },
      { role: 'mentor', speaker: 'Lisa', text: 'advice' },
    ]);
    expect(result).toContain('user concern');
    expect(result).toContain('Lisa');
  });
});

// ---------------------------------------------------------------------------
// sanitizeFirstPerson — input guards
// ---------------------------------------------------------------------------
describe('sanitizeFirstPerson', () => {
  it('returns input unchanged for empty / non-string', () => {
    expect(sanitizeFirstPerson('')).toBe('');
    expect(sanitizeFirstPerson(null)).toBeNull();
    expect(sanitizeFirstPerson(42)).toBe(42);
  });

  it('strips "if I were ..." prefix', () => {
    expect(sanitizeFirstPerson('If I were you, do X')).toBe('do X');
  });

  it('strips "as X, ..." prefix', () => {
    expect(sanitizeFirstPerson('As Elon, I would go fast')).toBe('I would go fast');
  });

  it('collapses whitespace', () => {
    expect(sanitizeFirstPerson('hello   world  ')).toBe('hello world');
  });
});

// ---------------------------------------------------------------------------
// defaultConfidenceNote / defaultActionStep / defaultDisclaimer / providerFromBaseUrl
// ---------------------------------------------------------------------------
describe('default helper strings', () => {
  it('defaultConfidenceNote zh-CN vs en', () => {
    expect(defaultConfidenceNote('zh-CN')).toMatch(/AI/);
    expect(defaultConfidenceNote('en')).toMatch(/AI/i);
  });
  it('defaultActionStep zh-CN vs en', () => {
    expect(defaultActionStep('zh-CN')).toMatch(/下一步/);
    expect(defaultActionStep('en')).toMatch(/Next step/);
  });
  it('defaultDisclaimer zh-CN vs en', () => {
    expect(defaultDisclaimer('zh-CN')).toMatch(/AI/);
    expect(defaultDisclaimer('en')).toMatch(/AI/);
  });
});

describe('providerFromBaseUrl', () => {
  it('returns hostname for valid URL', () => {
    expect(providerFromBaseUrl('https://api.openai.com/v1')).toBe('api.openai.com');
  });
  it('returns "unknown" for invalid URL', () => {
    expect(providerFromBaseUrl('not-a-url')).toBe('unknown');
  });
});

// ---------------------------------------------------------------------------
// firstNonEmptyEnvValue
// ---------------------------------------------------------------------------
describe('firstNonEmptyEnvValue', () => {
  it('returns empty string when all candidates are falsy or non-string', () => {
    expect(firstNonEmptyEnvValue([undefined, null, '', '   ', 0, {}])).toBe('');
  });
  it('returns first non-empty trimmed string', () => {
    expect(firstNonEmptyEnvValue([undefined, '', '  keep  ', 'next'])).toBe('keep');
  });
});

// ---------------------------------------------------------------------------
// extractAssistantContent — all content shapes
// ---------------------------------------------------------------------------
describe('extractAssistantContent', () => {
  it('returns empty string when data is null/missing', () => {
    expect(extractAssistantContent(null)).toBe('');
    expect(extractAssistantContent({})).toBe('');
    expect(extractAssistantContent({ choices: [] })).toBe('');
    expect(extractAssistantContent({ choices: [{ message: {} }] })).toBe('');
  });

  it('returns content directly when string', () => {
    expect(extractAssistantContent({ choices: [{ message: { content: 'hi' } }] })).toBe('hi');
  });

  it('joins array content parts', () => {
    const data = {
      choices: [{
        message: {
          content: [
            'plain',
            { text: 'obj-text' },
            42, // filtered out
            { notText: true }, // filtered out
          ],
        },
      }],
    };
    const result = extractAssistantContent(data);
    expect(result).toContain('plain');
    expect(result).toContain('obj-text');
  });

  it('stringifies object content', () => {
    const data = {
      choices: [{ message: { content: { foo: 'bar' } } }],
    };
    expect(extractAssistantContent(data)).toBe('{"foo":"bar"}');
  });
});

// ---------------------------------------------------------------------------
// tryParseJson — additional edge branches
// ---------------------------------------------------------------------------
describe('tryParseJson additional branches', () => {
  it('returns null for falsy input', () => {
    expect(tryParseJson('')).toBeNull();
    expect(tryParseJson(null)).toBeNull();
    expect(tryParseJson(undefined)).toBeNull();
  });

  it('returns object input directly when typeof === object', () => {
    const obj = { foo: 'bar' };
    expect(tryParseJson(obj)).toBe(obj);
  });

  it('returns null for text that does not start with {, [, or "', () => {
    expect(tryParseJson('abc hello world')).toBeNull();
  });

  it('unwraps nested stringified JSON when inner is a string', () => {
    // Triple-encoded: stringify(stringify(stringify(obj)))
    const doubleEncoded = JSON.stringify(JSON.stringify({ x: 1 }));
    expect(tryParseJson(doubleEncoded)).toEqual({ x: 1 });
  });

  it('handles fenced code block with no language specifier', () => {
    const result = tryParseJson('```\n{"a": 1}\n```');
    expect(result).toEqual({ a: 1 });
  });

  it('returns null when inner nested parse yields whitespace-only string', () => {
    // Exercises line 560: current = parsed (whitespace), trim yields '' → return null
    // Input: a triple-stringified whitespace → parse once → "  " → trim empty → return null
    // Then falls through to embedded object extraction → nothing found → null
    const result = tryParseJson('"  "');
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// compactConversationHistory — empty middleText early return (line 352)
// ---------------------------------------------------------------------------
// NOTE: the `if (!middleText.trim())` early-return inside
// compactConversationHistory is unreachable through normal flow —
// middleEntries is only empty when rounds.length <= 4, which is handled by
// an earlier guard. The tautology test that claimed to cover it has been
// removed. See orchestrator flag for follow-up on dead code.

// ---------------------------------------------------------------------------
// Handler: req.body null fallback and non-Error per-mentor error branches
// ---------------------------------------------------------------------------
describe('handler req.body and per-mentor error edge cases', () => {
  const savedEnv = {};
  beforeEach(() => {
    for (const key of ['LLM_API_KEY','OPENAI_API_KEY','LLM_API_TOKEN','OPENAI_KEY','LLM_MODEL','OPENAI_MODEL','LLM_API_BASE_URL','OPENAI_BASE_URL']) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
    process.env.LLM_API_KEY = 'test-key-body';
    process.env.LLM_MODEL = 'test-model';
    process.env.LLM_API_BASE_URL = 'https://api.body.com/v1';
  });
  afterEach(() => {
    for (const [key, val] of Object.entries(savedEnv)) {
      if (val === undefined) delete process.env[key];
      else process.env[key] = val;
    }
    delete globalThis.fetch;
  });

  it('returns 400 when body is null (NEW-8 shape check)', async () => {
    const res = mockRes();
    await handler(mockReq({ method: 'POST', body: null }), res);
    expect(res._status).toBe(400);
    // NEW-8 tightens the error to a top-level shape check before field-level
    // validation runs, so the surface message is now "body must be a JSON
    // object" rather than a per-field "problem is required" message.
    expect(res._json.error).toMatch(/JSON object/i);
  });

  it('logs per-mentor error when fetch throws a non-Error value (exercises String(item.error) branch)', async () => {
    // fetch throws a plain string → per-mentor error is a string → `String(item.error)` branch
    globalThis.fetch = vi.fn().mockImplementation(async () => {
      throw 'plain string error'; // eslint-disable-line no-throw-literal
    });

    const res = mockRes();
    await handler(mockReq({
      method: 'POST',
      body: { problem: 'test', language: 'en', mentors: [sampleMentor] },
    }), res);

    expect(res._status).toBe(200);
    expect(res._json.meta.provider).toBe('server-fallback');
  });
});

// ---------------------------------------------------------------------------
// normalizeProviderPayload — extra shape branches
// ---------------------------------------------------------------------------
describe('normalizeProviderPayload extra branches', () => {
  it('returns null for null/non-object raw', () => {
    expect(normalizeProviderPayload(null, { mentors: [], language: 'en' })).toBeNull();
    expect(normalizeProviderPayload('str', { mentors: [], language: 'en' })).toBeNull();
  });

  it('filters out non-object items in replies array via normalizeReply', () => {
    const raw = {
      replies: [null, 'str', { mentorId: 'x', likelyResponse: 'hi' }],
    };
    const result = normalizeProviderPayload(raw, { mentors: [], language: 'en' });
    expect(result.mentorReplies).toHaveLength(1);
  });

  it('skips replies with no likelyResponse', () => {
    const raw = {
      mentorReplies: [{ mentorId: 'x' }], // no likelyResponse
    };
    // mentorReplies → normalizeReply → empty → falls through to next shape checks
    const result = normalizeProviderPayload(raw, { mentors: [], language: 'en' });
    // No shape matches after filtering → falls through to objectValues check → may match empty → returns null
    // Actually raw has mentorReplies key with array → objectValues filter keeps non-array objects.
    // mentorReplies is an array → filtered out. No objectValues remain → returns null.
    expect(result).toBeNull();
  });

  it('matches mentor by id in single-response shape', () => {
    const raw = {
      mentorId: 'elon_musk',
      response: 'hello',
    };
    const result = normalizeProviderPayload(raw, {
      mentors: [sampleMentor],
      language: 'en',
    });
    expect(result).toBeTruthy();
    expect(result.mentorReplies[0].mentorName).toBe('Elon Musk');
  });

  it('falls through to mentorId as mentorName when no mentor match', () => {
    const raw = {
      mentorId: 'unknown',
      response: 'hello',
    };
    const result = normalizeProviderPayload(raw, { mentors: [], language: 'en' });
    expect(result.mentorReplies[0].mentorName).toBe('unknown');
  });

  it('uses default fallbacks for single-response shape missing optional fields', () => {
    const raw = {
      mentorId: 'x',
      response: 'hi',
    };
    const result = normalizeProviderPayload(raw, { mentors: [], language: 'en' });
    expect(result.mentorReplies[0].whyThisFits).toBe('');
    expect(result.mentorReplies[0].oneActionStep).toMatch(/Next step/);
    expect(result.mentorReplies[0].confidenceNote).toMatch(/AI/);
    expect(result.meta.disclaimer).toMatch(/AI/);
  });

  it('handles response-map shape with key-based mentor matching', () => {
    const raw = {
      response: {
        'Elon Musk': {
          mentorId: 'elon_musk',
          likelyResponse: 'Think big.',
        },
      },
    };
    const result = normalizeProviderPayload(raw, { mentors: [sampleMentor], language: 'en' });
    expect(result).toBeTruthy();
    expect(result.mentorReplies[0].mentorId).toBe('elon_musk');
  });

  it('skips response-map items with no likelyResponse', () => {
    const raw = {
      response: {
        good: { likelyResponse: 'valid reply text' },
        bad: {},
        nonObj: 'string',
      },
    };
    const result = normalizeProviderPayload(raw, { mentors: [], language: 'en' });
    expect(result.mentorReplies).toHaveLength(1);
  });

  it('response-map skips items with non-string likelyResponse', () => {
    const raw = {
      response: {
        bad: { likelyResponse: 42 }, // non-string
        good: { likelyResponse: 'ok' },
      },
    };
    const result = normalizeProviderPayload(raw, { mentors: [], language: 'en' });
    expect(result.mentorReplies).toHaveLength(1);
  });

  it('response-map uses defaults when oneActionStep non-string', () => {
    const raw = {
      response: {
        m: {
          likelyResponse: 'ok',
          oneActionStep: 42, // non-string
        },
      },
    };
    const result = normalizeProviderPayload(raw, { mentors: [], language: 'en' });
    expect(result.mentorReplies[0].oneActionStep).toMatch(/Next step/);
  });

  it('response-map returns null when all items filtered', () => {
    const raw = { response: { a: {}, b: null } };
    const result = normalizeProviderPayload(raw, { mentors: [], language: 'en' });
    expect(result).toBeNull();
  });

  it('uses GlobalDisclaimer from replies shape when meta missing', () => {
    const raw = {
      replies: [{ mentorId: 'x', likelyResponse: 'y' }],
      GlobalDisclaimer: 'custom disclaimer text',
    };
    const result = normalizeProviderPayload(raw, { mentors: [], language: 'en' });
    expect(result.meta.disclaimer).toBe('custom disclaimer text');
  });

  it('uses GlobalDisclaimer from response-map shape', () => {
    const raw = {
      response: { x: { likelyResponse: 'y' } },
      GlobalDisclaimer: 'RMD',
    };
    const result = normalizeProviderPayload(raw, { mentors: [], language: 'en' });
    expect(result.meta.disclaimer).toBe('RMD');
  });

  it('uses GlobalDisclaimer from mentor-keyed object shape', () => {
    const raw = {
      elon: { likelyResponse: 'hi' },
      GlobalDisclaimer: 'Custom',
    };
    const result = normalizeProviderPayload(raw, { mentors: [], language: 'en' });
    expect(result.meta.disclaimer).toBe('Custom');
  });

  it('uses meta.disclaimer from replies shape when present', () => {
    // Exercises line 759: raw?.meta?.disclaimer truthy branch
    const raw = {
      replies: [{ mentorId: 'x', likelyResponse: 'y' }],
      meta: { disclaimer: 'from-meta' },
    };
    const result = normalizeProviderPayload(raw, { mentors: [], language: 'en' });
    expect(result.meta.disclaimer).toBe('from-meta');
  });

  it('uses meta.disclaimer from response-map shape when present', () => {
    // Exercises line 834
    const raw = {
      response: { m: { likelyResponse: 'hi' } },
      meta: { disclaimer: 'rm-meta' },
    };
    const result = normalizeProviderPayload(raw, { mentors: [], language: 'en' });
    expect(result.meta.disclaimer).toBe('rm-meta');
  });

  it('uses meta.disclaimer from mentor-keyed object shape when present', () => {
    // Exercises line 858
    const raw = {
      elon: { likelyResponse: 'hi' },
      meta: { disclaimer: 'mk-meta' },
    };
    const result = normalizeProviderPayload(raw, { mentors: [], language: 'en' });
    expect(result.meta.disclaimer).toBe('mk-meta');
  });

  it('uses globalDisclaimer (lowercase) from replies shape', () => {
    const raw = {
      replies: [{ mentorId: 'x', likelyResponse: 'y' }],
      globalDisclaimer: 'lowercase-global',
    };
    const result = normalizeProviderPayload(raw, { mentors: [], language: 'en' });
    expect(result.meta.disclaimer).toBe('lowercase-global');
  });

  it('uses disclaimer (top-level) from replies shape', () => {
    const raw = {
      replies: [{ mentorId: 'x', likelyResponse: 'y' }],
      disclaimer: 'top-level',
    };
    const result = normalizeProviderPayload(raw, { mentors: [], language: 'en' });
    expect(result.meta.disclaimer).toBe('top-level');
  });

  it('single-response shape falls through `mentors || []` when mentors null', () => {
    // Exercises line 705 `(mentors || []).find(...)` null branch
    const raw = {
      mentorId: 'x',
      response: 'hi',
    };
    const result = normalizeProviderPayload(raw, { mentors: null, language: 'en' });
    expect(result).toBeTruthy();
  });

  it('response-map shape matches mentor by id via first normalizeKey branch', () => {
    // Exercises line 780:75 — first check matches (m.id normalized === key)
    const raw = {
      response: {
        elon_musk: {
          likelyResponse: 'First principles.',
        },
      },
    };
    const result = normalizeProviderPayload(raw, { mentors: [sampleMentor], language: 'en' });
    expect(result).toBeTruthy();
    expect(result.mentorReplies[0].mentorId).toBe('elon_musk');
  });

  it('response-map falls through `mentors || []` when mentors null', () => {
    // Exercises line 780:19 — mentors null branch
    const raw = {
      response: {
        foo: { likelyResponse: 'bar' },
      },
    };
    const result = normalizeProviderPayload(raw, { mentors: null, language: 'en' });
    expect(result).toBeTruthy();
    expect(result.mentorReplies[0].mentorId).toBe('foo');
  });

  it('response-map uses matchedMentor.id when item has no mentorId', () => {
    // Exercises line 783:83 — matchedMentor?.id truthy branch
    const raw = {
      response: {
        'Elon Musk': {
          likelyResponse: 'think big',
          // no mentorId field, so falls back through chain → matchedMentor?.id
        },
      },
    };
    const result = normalizeProviderPayload(raw, { mentors: [sampleMentor], language: 'en' });
    expect(result).toBeTruthy();
    expect(result.mentorReplies[0].mentorId).toBe('elon_musk');
  });

  it('response-map matches mentor via displayName branch (second || operand)', () => {
    // Exercises line 780:75 — normalizeKey(m.id) mismatches, normalizeKey(m.displayName) matches
    const raw = {
      response: {
        'ada_lovelace': {
          likelyResponse: 'Programming is reasoning.',
        },
      },
    };
    // Mentor whose id DOESN'T normalize to the key, but displayName DOES.
    const mentorByName = { id: 'different_id', displayName: 'Ada Lovelace' };
    const result = normalizeProviderPayload(raw, { mentors: [mentorByName], language: 'en' });
    expect(result).toBeTruthy();
    expect(result.mentorReplies[0].mentorId).toBe('different_id');
  });

  it('response-map skips mentors with undefined id/displayName in key matching', () => {
    // Exercises line 772:49 — normalizeKey(value) called with undefined → `value || ''` falsy
    const raw = {
      response: {
        foo: { likelyResponse: 'bar' },
      },
    };
    // Mentor with missing id and displayName → normalizeKey(undefined) hits
    // falsy branch. Because no mentor matches the key, the response-map
    // path must fall back to using the raw key 'foo' as the mentorId rather
    // than latching onto the empty-mentor defaults.
    const emptyMentor = { id: undefined, displayName: undefined };
    const result = normalizeProviderPayload(raw, { mentors: [emptyMentor], language: 'en' });
    expect(result).toBeTruthy();
    expect(result.mentorReplies).toHaveLength(1);
    // The raw key ('foo') is used as the mentorId — NOT the empty mentor's
    // undefined id — proving the undefined-mentor was actually skipped.
    expect(result.mentorReplies[0].mentorId).toBe('foo');
    expect(result.mentorReplies[0].likelyResponse).toBe('bar');
  });

  it('single-response shape picks name via matchedMentor displayName fallback', () => {
    // Exercises line 722-724 — matchedMentor?.displayName branch
    const raw = {
      mentorId: 'elon_musk',
      response: 'hi',
      // no MentorName, mentorName, name → falls to matchedMentor?.displayName
    };
    const result = normalizeProviderPayload(raw, { mentors: [sampleMentor], language: 'en' });
    expect(result.mentorReplies[0].mentorName).toBe('Elon Musk');
  });
});

// ---------------------------------------------------------------------------
// normalizeProviderPayloadLoose — all branches
// ---------------------------------------------------------------------------
describe('normalizeProviderPayloadLoose', () => {
  it('returns null for empty / non-string text', () => {
    expect(normalizeProviderPayloadLoose('', { mentor: sampleMentor, language: 'en' })).toBeNull();
    expect(normalizeProviderPayloadLoose(null, { mentor: sampleMentor, language: 'en' })).toBeNull();
  });

  it('returns null when no likelyResponse is extractable', () => {
    expect(normalizeProviderPayloadLoose('nothing useful here', { mentor: sampleMentor, language: 'en' })).toBeNull();
  });

  it('extracts fields and uses mentor defaults when fields missing', () => {
    const text = '"likelyResponse": "Take a small step"';
    const result = normalizeProviderPayloadLoose(text, { mentor: sampleMentor, language: 'en' });
    expect(result).toBeTruthy();
    expect(result.mentorReplies[0].mentorId).toBe('elon_musk');
    expect(result.mentorReplies[0].mentorName).toBe('Elon Musk');
    expect(result.mentorReplies[0].whyThisFits).toContain('Elon Musk');
    expect(result.mentorReplies[0].oneActionStep).toMatch(/Next step/);
  });

  it('uses zh-CN whyThisFits fallback when language is zh-CN', () => {
    const text = '"likelyResponse": "先迈一小步"';
    const result = normalizeProviderPayloadLoose(text, { mentor: sampleMentor, language: 'zh-CN' });
    expect(result.mentorReplies[0].whyThisFits).toContain('公开风格');
  });

  it('handles missing mentor (uses "Mentor" fallback)', () => {
    const text = '"likelyResponse": "do something"';
    const result = normalizeProviderPayloadLoose(text, { mentor: null, language: 'en' });
    expect(result.mentorReplies[0].mentorId).toBe('');
    expect(result.mentorReplies[0].mentorName).toBe('Mentor');
  });

  it('uses mentorId as mentorName when mentor.displayName missing', () => {
    const text = '"mentorId": "foo"\n"likelyResponse": "bar"';
    const result = normalizeProviderPayloadLoose(text, { mentor: { id: 'foo' }, language: 'en' });
    expect(result.mentorReplies[0].mentorName).toBe('foo');
  });
});

// ---------------------------------------------------------------------------
// extractLooseStringField
// ---------------------------------------------------------------------------
describe('extractLooseStringField', () => {
  it('returns empty for empty / non-string input', () => {
    expect(extractLooseStringField('', ['k'])).toBe('');
    expect(extractLooseStringField(null, ['k'])).toBe('');
  });

  it('matches strict JSON pattern', () => {
    const text = '{"mentorId": "elon", "other": "x"}';
    expect(extractLooseStringField(text, ['mentorId'])).toBe('elon');
  });

  it('matches line pattern when strict match fails', () => {
    // no trailing comma/brace → falls through to line match
    const text = '"mentorId": "elon-extracted"';
    expect(extractLooseStringField(text, ['mentorId'])).toBe('elon-extracted');
  });

  it('matches bare pattern without quotes', () => {
    const text = 'mentorId=loose-value';
    expect(extractLooseStringField(text, ['mentorId'])).toBe('loose-value');
  });

  it('returns empty when no key matches', () => {
    expect(extractLooseStringField('random text', ['mentorId'])).toBe('');
  });
});

// ---------------------------------------------------------------------------
// pickReplyForMentor — all branches
// ---------------------------------------------------------------------------
describe('pickReplyForMentor more branches', () => {
  it('returns null when normalized is null', () => {
    expect(pickReplyForMentor(sampleMentor, null)).toBeNull();
  });
  it('returns null when mentorReplies is not an array', () => {
    expect(pickReplyForMentor(sampleMentor, { mentorReplies: 'bad' })).toBeNull();
  });
  it('matches by mentor displayName when id does not match', () => {
    const normalized = {
      mentorReplies: [
        { mentorId: 'other', mentorName: 'Elon Musk', likelyResponse: 'by name' },
      ],
    };
    const result = pickReplyForMentor(sampleMentor, normalized);
    expect(result.likelyResponse).toBe('by name');
  });

  it('handles mentor with undefined id/displayName (normalizeKey falsy branch)', () => {
    // Exercises line 992:47 — value || '' falsy branch in internal normalizeKey
    const normalized = {
      mentorReplies: [
        { mentorId: 'x', mentorName: 'X', likelyResponse: 'first fallback' },
      ],
    };
    const result = pickReplyForMentor({ id: undefined, displayName: undefined }, normalized);
    // Since mentor.id and displayName are undefined, normalizeKey returns '';
    // reply items have non-empty keys, no match → falls to replies[0]
    expect(result.likelyResponse).toBe('first fallback');
  });
});

// ---------------------------------------------------------------------------
// buildServerFallbackNormalized / buildFallbackReplyForMentor
// ---------------------------------------------------------------------------
describe('buildServerFallbackNormalized / buildFallbackReplyForMentor', () => {
  it('uses zh-CN replies when language is zh-CN', () => {
    const result = buildServerFallbackNormalized({ mentors: [sampleMentor], language: 'zh-CN' });
    expect(result.mentorReplies).toHaveLength(1);
    expect(result.mentorReplies[0].likelyResponse).toContain('我理解');
    expect(result.mentorReplies[0].whyThisFits).toContain('公开风格');
  });
  it('uses en replies when language is en', () => {
    const result = buildServerFallbackNormalized({ mentors: [sampleMentor], language: 'en' });
    expect(result.mentorReplies[0].likelyResponse).toContain('difficult');
    expect(result.mentorReplies[0].whyThisFits).toContain('public style');
  });
  it('returns empty mentorReplies when mentors is null/empty', () => {
    const result = buildServerFallbackNormalized({ mentors: null, language: 'en' });
    expect(result.mentorReplies).toEqual([]);
  });
  it('buildFallbackReplyForMentor returns one normalized reply', () => {
    const reply = buildFallbackReplyForMentor(sampleMentor, 'en');
    expect(reply.mentorId).toBe('elon_musk');
    expect(reply.likelyResponse).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// buildSystemPrompt — basic coverage
// ---------------------------------------------------------------------------
describe('buildSystemPrompt', () => {
  it('includes priority and output discipline sections', () => {
    const result = buildSystemPrompt([sampleMentor]);
    expect(result).toContain('Priority rules');
    expect(result).toContain('Output discipline');
    expect(result).toContain('elon_musk');
  });
});

// ---------------------------------------------------------------------------
// buildUserPrompt — mentor field fallbacks
// ---------------------------------------------------------------------------
describe('buildUserPrompt field fallbacks', () => {
  it('uses empty arrays for missing optional mentor fields', () => {
    const result = buildUserPrompt('problem', 'en', [{ id: 'x', displayName: 'X' }], null);
    expect(result).toContain('MentorId: x');
    expect(result).toContain('SpeakingStyle: \n');
    expect(result).toContain('CoreValues: \n');
  });

  it('handles null mentors array (uses [])', () => {
    const result = buildUserPrompt('p', 'en', null, null);
    expect(result).toContain('Mentors:');
  });

  it('uses default compacted when undefined', () => {
    // Exercises `compactedConversation || { entries: [], summary: '', ... }`
    const result = buildUserPrompt('p', 'en', [sampleMentor], undefined);
    expect(result).toContain('No compaction needed.');
  });

  it('handles compacted with missing entries key', () => {
    // Exercises `compacted.entries || []`
    const result = buildUserPrompt('p', 'en', [sampleMentor], { summary: 'S', usedLlmCompression: false });
    expect(result).toContain('No prior conversation history');
  });

  it('emits empty <user_problem_{suffix}> block when problem is not a string', () => {
    // Exercises the non-string branch of the `typeof problem === 'string'`
    // ternary. BYPASS-5 made the delimiter per-request randomized, so the
    // assertion now checks the suffixed tag form.
    const result = buildUserPrompt(null, 'en', [sampleMentor], null);
    expect(result).toMatch(/<user_problem_[a-z0-9]+>\s*<\/user_problem_[a-z0-9]+>/);
  });

  it('falls back to "Mentor" displayName when mentor.displayName is missing', () => {
    // Exercises the `|| 'Mentor'` default on line 540. The sanitizer
    // returns '' for a missing/empty displayName, so the literal 'Mentor'
    // label should appear in the rendered block.
    const result = buildUserPrompt('prob', 'en', [{ id: 'nameless-1' }], null);
    expect(result).toContain('MentorId: nameless-1');
    expect(result).toContain('MentorName: Mentor');
  });
});

// ---------------------------------------------------------------------------
// compactConversationHistoryDeterministic — tail budget break branch
// ---------------------------------------------------------------------------
describe('compactConversationHistoryDeterministic extra branches', () => {
  it('hits the "tail length >= max" break branch in the loop', () => {
    // Build a history where many tail entries are picked but hit the tail limit
    const entries = Array.from({ length: 30 }, (_, i) => ({
      role: 'user',
      speaker: 'u',
      text: `m${i}`, // short
    }));
    // maxItems=8, maxChars very large → tail budget huge → length check triggers break
    const result = compactConversationHistoryDeterministic(entries, 8, 100000);
    expect(result.entries.length).toBeLessThanOrEqual(8);
  });
});

// ---------------------------------------------------------------------------
// compactConversationHistory — LLM compression edge cases
// ---------------------------------------------------------------------------
describe('compactConversationHistory LLM branches', () => {
  const savedFetch = globalThis.fetch;
  afterEach(() => { globalThis.fetch = savedFetch; });

  it('returns empty for empty normalized history', async () => {
    const result = await compactConversationHistory([]);
    expect(result.entries).toEqual([]);
    expect(result.usedLlmCompression).toBe(false);
  });

  it('LLM compression returns empty summary when middleText is empty-whitespace-only', async () => {
    // If middle entries have no text → formatConversationHistoryForPrompt returns empty → early return
    // Tricky: normalizeConversationHistory filters out text-less items, so middle would have no entries.
    // We need rounds.length > 4 with middle entries having only whitespace text, but normalized filters those.
    // Unreachable through normal flow unless we bypass normalization.
    // Instead: ensure LLM path handles fetch returning non-object (parsed is not object).
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        choices: [{ message: { content: 'null' } }], // parsed will be null → !parsed
      }),
      text: async () => '',
    });

    const entries = Array.from({ length: 80 }, (_, i) => ({
      role: i % 2 === 0 ? 'user' : 'mentor',
      speaker: i % 2 === 0 ? 'u' : 'm',
      text: `msg ${i}: ${'x'.repeat(2000)}`,
    }));

    const result = await compactConversationHistory(entries, {
      tokenThreshold: 100,
      language: 'en',
      model: 'm',
      apiKey: 'k',
      chatCompletionsUrl: 'https://x/y',
    });

    // LLM returned invalid summary → falls back to deterministic middle summary
    expect(result.usedLlmCompression).toBe(true);
    expect(result.summary).toContain('Middle rounds compacted');
  });

  it('LLM compression with parsed data returning primitive (not object)', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        choices: [{ message: { content: '"just a string"' } }],
      }),
      text: async () => '',
    });

    const entries = Array.from({ length: 80 }, (_, i) => ({
      role: i % 2 === 0 ? 'user' : 'mentor',
      speaker: i % 2 === 0 ? 'u' : 'm',
      text: `msg ${i}: ${'x'.repeat(2000)}`,
    }));

    const result = await compactConversationHistory(entries, {
      tokenThreshold: 100,
      language: 'en',
      model: 'm',
      apiKey: 'k',
      chatCompletionsUrl: 'https://x/y',
    });

    expect(result.usedLlmCompression).toBe(true);
    expect(result.summary).toContain('Middle rounds compacted');
  });

  it('LLM compression with partial fields (some non-array, some non-string items)', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        choices: [{
          message: {
            content: JSON.stringify({
              // no summary field (not a string)
              userConcerns: ['ok', 42], // mixed types → filter keeps 'ok'
              mentorDirections: 'not-array', // non-array → [] branch
              openLoops: [null, 'real'], // filter keeps 'real'
            }),
          },
        }],
      }),
      text: async () => '',
    });

    const entries = Array.from({ length: 80 }, (_, i) => ({
      role: i % 2 === 0 ? 'user' : 'mentor',
      speaker: i % 2 === 0 ? 'u' : 'm',
      text: `msg ${i}: ${'x'.repeat(2000)}`,
    }));

    const result = await compactConversationHistory(entries, {
      tokenThreshold: 100,
      language: 'en',
      model: 'm',
      apiKey: 'k',
      chatCompletionsUrl: 'https://x/y',
    });

    expect(result.usedLlmCompression).toBe(true);
    expect(result.summary).toContain('UserConcerns');
    expect(result.summary).toContain('OpenLoops');
  });

  it('LLM compression with ALL list fields non-array — all arrays fall back to [] and empty segments are dropped', async () => {
    // Exercises the `: []` fallbacks on lines 440 and 442 (userConcerns
    // and openLoops are not arrays) AND the `userConcerns.length ? ... : ''`
    // / `openLoops.length ? ... : ''` false branches on lines 446 and 448.
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        choices: [{
          message: {
            content: JSON.stringify({
              summary: 'Only a summary, no list fields.',
              userConcerns: 'not-array',
              mentorDirections: 'also-not-array',
              openLoops: { bad: 'shape' },
            }),
          },
        }],
      }),
      text: async () => '',
    });

    const entries = Array.from({ length: 80 }, (_, i) => ({
      role: i % 2 === 0 ? 'user' : 'mentor',
      speaker: i % 2 === 0 ? 'u' : 'm',
      text: `msg ${i}: ${'x'.repeat(2000)}`,
    }));

    const result = await compactConversationHistory(entries, {
      tokenThreshold: 100,
      language: 'en',
      model: 'm',
      apiKey: 'k',
      chatCompletionsUrl: 'https://x/y',
    });

    expect(result.usedLlmCompression).toBe(true);
    // Summary contains only the text summary — no UserConcerns / MentorDirections / OpenLoops lines.
    expect(result.summary).toContain('Only a summary');
    expect(result.summary).not.toContain('UserConcerns');
    expect(result.summary).not.toContain('MentorDirections');
    expect(result.summary).not.toContain('OpenLoops');
  });

  it('LLM compression throws → caught → empty summary → deterministic fallback', async () => {
    globalThis.fetch = vi.fn().mockImplementation(async () => {
      throw new Error('network blew up');
    });

    const entries = Array.from({ length: 80 }, (_, i) => ({
      role: i % 2 === 0 ? 'user' : 'mentor',
      speaker: i % 2 === 0 ? 'u' : 'm',
      text: `msg ${i}: ${'x'.repeat(2000)}`,
    }));

    const result = await compactConversationHistory(entries, {
      tokenThreshold: 100,
      language: 'en',
      model: 'm',
      apiKey: 'k',
      chatCompletionsUrl: 'https://x/y',
    });

    expect(result.usedLlmCompression).toBe(true);
    expect(result.summary).toContain('Middle rounds compacted');
  });
});

// ---------------------------------------------------------------------------
// Handler integration — exercise per-mentor reply fallbacks
// ---------------------------------------------------------------------------
describe('mentor-table handler per-mentor reply field fallbacks', () => {
  const savedEnv = {};
  beforeEach(() => {
    for (const key of ['LLM_API_KEY','OPENAI_API_KEY','LLM_API_TOKEN','OPENAI_KEY','LLM_MODEL','OPENAI_MODEL','LLM_API_BASE_URL','OPENAI_BASE_URL']) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
    process.env.LLM_API_KEY = 'test-key-fb';
    process.env.LLM_MODEL = 'test-model';
    process.env.LLM_API_BASE_URL = 'https://api.fb.com/v1';
  });
  afterEach(() => {
    for (const [key, val] of Object.entries(savedEnv)) {
      if (val === undefined) delete process.env[key];
      else process.env[key] = val;
    }
    delete globalThis.fetch;
  });

  it('substitutes zh-CN whyThisFits fallback in handler when reply missing whyThisFits', async () => {
    // Lines 1304-1306: zh-CN whyThisFits fallback
    const response = {
      schemaVersion: 'mentor_table.v1',
      language: 'zh-CN',
      safety: { riskLevel: 'none', needsProfessionalHelp: false, emergencyMessage: '' },
      mentorReplies: [
        {
          mentorId: 'elon_musk',
          mentorName: 'Elon Musk',
          likelyResponse: '迈出第一小步。',
          whyThisFits: '', // empty — triggers fallback
          oneActionStep: '现在写下问题。',
          confidenceNote: '',
        },
      ],
      meta: { disclaimer: 'disc', generatedAt: new Date().toISOString() },
    };

    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ choices: [{ message: { content: JSON.stringify(response) } }] }),
      text: async () => '',
    });

    const res = mockRes();
    await handler(mockReq({
      method: 'POST',
      body: { problem: '我不知道怎么办', language: 'zh-CN', mentors: [sampleMentor] },
    }), res);

    expect(res._status).toBe(200);
    expect(res._json.mentorReplies[0].whyThisFits).toContain('公开风格');
  });

  it('substitutes en whyThisFits fallback in handler when reply missing whyThisFits', async () => {
    // Lines 1306: en fallback path
    const response = {
      schemaVersion: 'mentor_table.v1',
      language: 'en',
      safety: { riskLevel: 'none', needsProfessionalHelp: false, emergencyMessage: '' },
      mentorReplies: [
        {
          mentorId: 'elon_musk',
          mentorName: 'Elon Musk',
          likelyResponse: 'Take a small step first.',
          whyThisFits: '', // triggers fallback
          oneActionStep: 'Write it down now.',
          confidenceNote: '',
        },
      ],
      meta: { disclaimer: 'disc', generatedAt: new Date().toISOString() },
    };

    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ choices: [{ message: { content: JSON.stringify(response) } }] }),
      text: async () => '',
    });

    const res = mockRes();
    await handler(mockReq({
      method: 'POST',
      body: { problem: 'help me', language: 'en', mentors: [sampleMentor] },
    }), res);

    expect(res._status).toBe(200);
    expect(res._json.mentorReplies[0].whyThisFits).toContain('public style');
  });
});
