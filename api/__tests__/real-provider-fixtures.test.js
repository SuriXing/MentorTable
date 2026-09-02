/**
 * Real-provider response fixtures, pinned through the full production path.
 *
 * These envelopes were captured live (2026-09-01) from each upstream with a
 * mentor-reply prompt: deepseek-v4-flash (openai protocol + reasoning_content),
 * qwen3-max (dashscope openai protocol), claude-opus-4-6 (anthropic native
 * content blocks, emitted inside a markdown fence). No secrets in fixtures —
 * they are model outputs only; fetch is mocked, nothing leaves CI.
 *
 * Why: the highest-value parse seam (real model shape -> strict JSON
 * contract) previously had no CI coverage — the live-LLM e2e is
 * operator-gated. These tests run the exact production handler against the
 * exact real-world response shapes on every push.
 */

const handler = require('../mentor-table.js');

const FIXTURES = [
  {
    file: './fixtures/deepseek-v4-flash.json',
    provider: 'deepseek',
    expectedMetaProvider: 'api.deepseek.com',
    expectedMetaModel: 'deepseek-v4-flash',
  },
  {
    file: './fixtures/qwen3-max.json',
    provider: 'dashscope',
    expectedMetaProvider: 'dashscope.aliyuncs.com',
    expectedMetaModel: 'qwen3-max',
  },
  {
    file: './fixtures/claude-opus-4-6.json',
    provider: 'claude',
    expectedMetaProvider: 'api.anthropic.com',
    // claude fixture is the shared-engine default list order
    expectedMetaModel: 'claude-sonnet-4-5',
  },
];

const sampleMentor = {
  id: 'elon_musk',
  displayName: 'Elon Musk',
  shortLabel: 'Elon',
  speakingStyle: ['blunt', 'first-principles'],
  coreValues: ['execution', 'physics'],
  decisionPatterns: ['delete requirements', 'iterate fast'],
  knownExperienceThemes: ['startups', 'engineering'],
  likelyBlindSpots: ['patience'],
};

function mockReq(overrides = {}) {
  return { method: 'POST', body: {}, headers: {}, ...overrides };
}

function mockRes() {
  const res = {
    _status: null,
    _json: null,
    status(code) { res._status = code; return res; },
    json(data) { res._json = data; return res; },
    setHeader() { return res; },
  };
  return res;
}

describe('real provider envelopes parse through the production path', () => {
  const savedEnv = {};
  const envKeys = [
    'DEEPSEEK_API_KEY', 'DASHSCOPE_API_KEY', 'ANTHROPIC_API_KEY_1',
    'LLM_PROVIDER', 'LLM_PROVIDER_CHAIN', 'MENTOR_LLM_CACHE',
  ];
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    for (const key of envKeys) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
    process.env.MENTOR_UPSTREAM_TIMEOUT_MS = '20000';
    process.env.MENTOR_LLM_CACHE = '0';
    if (handler.__test__ && handler.__test__._resetLlmReplyCache) handler.__test__._resetLlmReplyCache();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    for (const [key, val] of Object.entries(savedEnv)) {
      if (val === undefined) delete process.env[key];
      else process.env[key] = val;
    }
  });

  for (const fixture of FIXTURES) {
    it(`serves a real ${fixture.expectedMetaModel} reply from the captured envelope`, async () => {
      process.env.DEEPSEEK_API_KEY = 'test-key';
      process.env.DASHSCOPE_API_KEY = 'test-key';
      process.env.ANTHROPIC_API_KEY_1 = 'test-key';

      const envelope = require(fixture.file);
      let upstreamCalls = 0;
      globalThis.fetch = vi.fn().mockImplementation(async () => {
        upstreamCalls += 1;
        return {
          ok: true,
          status: 200,
          json: async () => envelope,
          text: async () => '',
        };
      });

      const res = mockRes();
      await handler(mockReq({
        method: 'POST',
        body: {
          problem: 'I keep losing focus on important work.',
          language: 'en',
          mentors: [sampleMentor],
          provider: fixture.provider,
        },
      }), res);

      expect(res._status).toBe(200);
      // Real output parses on the first upstream call — no repair burn.
      expect(upstreamCalls).toBe(1);
      const reply = res._json.mentorReplies[0];
      expect(reply.mentorId).toBe('elon_musk');
      expect(String(reply.likelyResponse || '')).not.toBe('');
      expect(res._json.safety).toBeDefined();
      expect(res._json.meta.provider).toBe(fixture.expectedMetaProvider);
      expect(res._json.meta.model).toBe(fixture.expectedMetaModel);
    });
  }
});
