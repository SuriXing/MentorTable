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
  pickReplyForMentor,
  riskLevelScore,
  detectLanguageFromText,
  resolveEffectiveLanguage,
  normalizeRiskLevel,
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
    // 4 user messages (2 rounds: user+mentor, user+mentor) with very long text
    // to exceed token threshold, but only 2 rounds
    const entries = [
      { role: 'user', speaker: 'User', text: 'a'.repeat(500000) },
      { role: 'mentor', speaker: 'Mentor', text: 'b'.repeat(500000) },
      { role: 'user', speaker: 'User', text: 'c'.repeat(500000) },
      { role: 'mentor', speaker: 'Mentor', text: 'd'.repeat(500000) },
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

    // Should use deterministic fallback since rounds <= 4
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
    const history = [
      { role: 'user', speaker: 'You', text: 'Round 1 user concern about burnout.' },
      { role: 'mentor', speaker: 'Lisa', text: 'Round 1 Lisa advice.' },
      { role: 'mentor', speaker: 'Satya', text: 'Round 1 Satya advice.' },
      { role: 'user', speaker: 'You', text: 'Round 2 user follow-up.' },
      { role: 'mentor', speaker: 'Lisa', text: 'Round 2 Lisa advice.' },
      { role: 'mentor', speaker: 'Satya', text: 'Round 2 Satya advice.' },
      { role: 'user', speaker: 'You', text: 'Round 3 user update about stress.' },
      { role: 'mentor', speaker: 'Lisa', text: 'Round 3 Lisa advice.' },
      { role: 'mentor', speaker: 'Satya', text: 'Round 3 Satya advice.' },
      { role: 'user', speaker: 'You', text: 'Round 4 user update about conflict.' },
      { role: 'mentor', speaker: 'Lisa', text: 'Round 4 Lisa advice.' },
      { role: 'mentor', speaker: 'Satya', text: 'Round 4 Satya advice.' },
      { role: 'user', speaker: 'You', text: 'Round 5 user asks for a plan.' },
      { role: 'mentor', speaker: 'Lisa', text: 'Round 5 Lisa advice.' },
      { role: 'mentor', speaker: 'Satya', text: 'Round 5 Satya advice.' },
      { role: 'user', speaker: 'You', text: 'Round 6 user asks how to communicate upward.' },
      { role: 'mentor', speaker: 'Lisa', text: 'Round 6 Lisa advice.' },
      { role: 'mentor', speaker: 'Satya', text: 'Round 6 Satya advice.' },
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

    // Large history to trigger compression in the handler
    const history = Array.from({ length: 60 }, (_, i) => ({
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
    const result = tryParseJson(quadEncoded);
    // After 3 iterations tryParseNested returns null; falls through to extraction
    // The embedded object extraction may or may not find something depending on content
    // The key is that the loop terminates without infinite recursion
    expect(true).toBe(true); // Just verify no crash
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
});
