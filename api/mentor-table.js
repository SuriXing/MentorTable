const {
  applyApiSecurity,
  enforceLlmBreaker,
  recordLlmCall,
  redactSensitive,
  sanitizeMentorField,
  sanitizeMentorFieldArray,
} = require('../lib/security.js');
const { log, truncateErrorMessage } = require('../lib/logger.js');
const {
  riskLevelScore,
  mergeSafetyState,
  defaultDisclaimer,
  detectLanguageFromText,
  resolveEffectiveLanguage,
  normalizeRiskLevel,
  providerFromBaseUrl,
  finalizeContractShape,
  detectContentLanguage,
  contentMatchesLanguage,
  tryParseJson,
  extractTopLevelJsonObjects,
  sanitizeFirstPerson,
  defaultConfidenceNote,
  defaultActionStep,
  normalizeProviderPayload,
  buildServerFallbackNormalized,
  pickReplyForMentor,
  buildFallbackReplyForMentor,
} = require('./lib/mentor-contract.js');
const {
  formatConversationHistoryForPrompt,
  buildMentorDirectiveBlock,
  buildSystemPrompt,
  buildUserPrompt,
} = require('./lib/mentor-prompts.js');
const {
  normalizeHistoryRole,
  normalizeConversationHistory,
  estimateTokens,
  buildConversationRounds,
  summarizeCompactedMiddleDeterministic,
  compactConversationHistoryDeterministic,
  compactConversationHistory,
} = require('./lib/mentor-history.js');
const { getProvider, isKnownProvider, providerErrorHint } = require('./lib/llm-providers.js');
const {
  extractAssistantContent,
  firstNonEmptyEnvValue,
  requestMentorReplyFromLLM,
  requestMentorBatchReplyFromLLM,
  _resetLlmReplyCache,
} = require('./lib/mentor-upstream.js');

// F174: single source for the mentor-count ceiling. The number itself lives
// in shared/mentors-contract.json, imported by the client (MAX_PEOPLE) and
// required here — the contract-parity test pins it against the schema's
// maxItems.
const MENTORS_MAX = require('../shared/mentors-contract.json').mentorsMax;

// F175: upstream budget default. The timeout-chain test pins the order
// upstream (25s) < client (28s) < platform function ceiling (30s).
const DEFAULT_UPSTREAM_TIMEOUT_MS = 25000;

// Named request-flow steps. The handler was one 300-line try block; each
// step below owns one phase and the handler at the bottom is orchestration
// only. All steps run inside the handler's try/catch — a throw anywhere
// still surfaces through the same structured 500 path.

// providerName comes from the request body (client/agent choice) or the
// LLM_PROVIDER env default; both must name an entry in the provider
// registry. With no provider named, the legacy single-provider env config
// applies unchanged (LLM_API_BASE_URL/LLM_MODEL + key aliases).
// Anthropic-native endpoints hang off the base root, not /v1: accept a bare
// host, a host with /v1, or a full /v1/messages URL from the relay config.
const anthropicMessagesUrl = (baseUrl) => {
  const trimmed = baseUrl.replace(/\/+$/, '');
  if (trimmed.endsWith('/v1/messages')) return trimmed;
  if (trimmed.endsWith('/v1')) return `${trimmed}/messages`;
  return `${trimmed}/v1/messages`;
};

const resolveUpstreamConfig = (providerName) => {
  if (providerName && isKnownProvider(providerName)) {
    const entry = getProvider(providerName);
    // Strict per-provider key: only the env vars this entry names — a
    // missing key must fail loudly (500 diagnostics name the var), not
    // silently bill some other provider's key against this endpoint.
    const apiKey = (entry.apiKeyEnvs || []).map((n) => process.env[n]).find(Boolean) || null;
    const baseUrl = entry.baseUrl;
    const protocol = entry.protocol || 'openai';
    return {
      provider: providerName,
      apiKey,
      apiKeyEnv: (entry.apiKeyEnvs || [])[0] || null,
      protocol,
      model: entry.model,
      baseUrl,
      upstreamTimeoutMs: Number(process.env.MENTOR_UPSTREAM_TIMEOUT_MS || DEFAULT_UPSTREAM_TIMEOUT_MS),
      chatCompletionsUrl:
        protocol === 'anthropic'
          ? anthropicMessagesUrl(baseUrl)
          : `${baseUrl.replace(/\/+$/, '')}/chat/completions`,
      isDashscope: /dashscope\.aliyuncs\.com/i.test(baseUrl)
    };
  }
  const baseUrl = process.env.LLM_API_BASE_URL || process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1';
  return {
    provider: null,
    protocol: 'openai',
    apiKey: firstNonEmptyEnvValue([
      process.env.LLM_API_KEY,
      process.env.OPENAI_API_KEY,
      process.env.LLM_API_TOKEN,
      process.env.OPENAI_KEY
    ]),
    apiKeyEnv: null,
    model: process.env.LLM_MODEL || process.env.OPENAI_MODEL || 'qwen-max',
    baseUrl,
    upstreamTimeoutMs: Number(process.env.MENTOR_UPSTREAM_TIMEOUT_MS || DEFAULT_UPSTREAM_TIMEOUT_MS),
    chatCompletionsUrl: `${baseUrl.replace(/\/+$/, '')}/chat/completions`,
    isDashscope: /dashscope\.aliyuncs\.com/i.test(baseUrl)
  };
};

const logMissingKeyDiagnostics = (cfg) => {
  console.error('[mentor-table] API key missing. Diagnostics:', {
    vercelEnv: process.env.VERCEL_ENV || null,
    provider: cfg && cfg.provider ? cfg.provider : null,
    expectedKeyEnv: cfg && cfg.apiKeyEnv ? cfg.apiKeyEnv : 'LLM_API_KEY (or legacy aliases)',
    hasLLMApiKey: Boolean(firstNonEmptyEnvValue([process.env.LLM_API_KEY])),
    hasOpenAiApiKey: Boolean(firstNonEmptyEnvValue([process.env.OPENAI_API_KEY])),
    hasLlmApiToken: Boolean(firstNonEmptyEnvValue([process.env.LLM_API_TOKEN])),
    hasOpenAiKey: Boolean(firstNonEmptyEnvValue([process.env.OPENAI_KEY])),
    hasLLMModel: Boolean(firstNonEmptyEnvValue([process.env.LLM_MODEL, process.env.OPENAI_MODEL])),
    hasLLMBaseUrl: Boolean(firstNonEmptyEnvValue([process.env.LLM_API_BASE_URL, process.env.OPENAI_BASE_URL]))
  });
};

// Validates and unwraps the request. Responds 4xx itself and returns null
// when invalid; every client-error check happens here so misuses surface as
// 4xx even in environments without a key configured (the 500 key check runs
// only after this step passed).
const parseAndValidateRequest = (req, res) => {
  // NEW-8: ensure req.body is a plain object. If express or the Vercel
  // runtime handed us a string / array / buffer (e.g. content-type was
  // text/plain), destructuring below would silently yield undefined for
  // every field and return unhelpful 400 errors. Fail fast with a clear
  // shape error instead.
  if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) {
    res.status(400).json({ error: 'request body must be a JSON object' });
    return null;
  }
  const { problem, language, mentors, conversationHistory, provider } = req.body;

  if (provider != null && !isKnownProvider(provider)) {
    res.status(400).json({ error: `unknown provider '${String(provider)}' (${providerErrorHint()})` });
    return null;
  }

  if (typeof problem !== 'string' || !problem.trim()) {
    res.status(400).json({ error: 'problem is required' });
    return null;
  }

  // Hard cap the problem text to bound upstream token spend.
  const PROBLEM_MAX_CHARS = 5000;
  if (problem.length > PROBLEM_MAX_CHARS) {
    res.status(413).json({ error: `problem exceeds ${PROBLEM_MAX_CHARS} character limit` });
    return null;
  }

  if (!Array.isArray(mentors) || mentors.length === 0) {
    res.status(400).json({ error: 'at least one mentor is required' });
    return null;
  }

  // Cap mentor count — each mentor spawns a parallel upstream LLM call.
  if (mentors.length > MENTORS_MAX) {
    res.status(413).json({ error: `too many mentors (max ${MENTORS_MAX})` });
    return null;
  }

  // Cap conversation history length so a caller can't bypass per-entry caps
  // by sending hundreds of short entries.
  const HISTORY_MAX_ENTRIES = 50;
  if (Array.isArray(conversationHistory) && conversationHistory.length > HISTORY_MAX_ENTRIES) {
    res.status(413).json({ error: `conversationHistory exceeds ${HISTORY_MAX_ENTRIES} entries` });
    return null;
  }

  return { problem, language, mentors, conversationHistory, provider: provider || null };
};

const compactRequestHistory = async (conversationHistory, effectiveLanguage, cfg) => {
  const historyMaxItems = Number(process.env.MENTOR_HISTORY_MAX_ITEMS || 36);
  const historyMaxChars = Number(process.env.MENTOR_HISTORY_MAX_CHARS || 6000);
  const historyCompressTokenThreshold = Number(process.env.MENTOR_HISTORY_COMPRESS_TOKENS || 100000);
  const historyCompressTimeoutMs = Number(process.env.MENTOR_HISTORY_COMPRESS_TIMEOUT_MS || 12000);
  const compactedConversation = await compactConversationHistory(conversationHistory, {
    maxItems: historyMaxItems,
    maxChars: historyMaxChars,
    tokenThreshold: historyCompressTokenThreshold,
    compressTimeoutMs: historyCompressTimeoutMs,
    language: effectiveLanguage,
    model: cfg.model,
    apiKey: cfg.apiKey,
    chatCompletionsUrl: cfg.chatCompletionsUrl
  });
  if (compactedConversation.usedLlmCompression) {
    console.log(
      `[mentor-api] history compressed via llm estimatedTokens=${compactedConversation.estimatedTokens} preservedEntries=${compactedConversation.entries.length} omittedEntries=${compactedConversation.omittedCount}`
    );
  }
  return compactedConversation;
};

// F158: two dispatch modes produce the same perMentor item shape
// ({ mentor, ok, output?, error? }), so aggregation stays shared. Batch
// (MENTOR_BATCH_FANOUT=1) spends ONE upstream call for the whole table
// instead of one per mentor — 5x cost and latency-shape reduction — and
// degrades per-mentor on any missing/mismatched batch entry. Default
// remains the proven per-mentor fan-out until the flag is enabled in a
// staged rollout.
const dispatchMentorGeneration = async ({ mentors, problem, effectiveLanguage, compactedConversation, cfg }) => {
  const batchMode = process.env.MENTOR_BATCH_FANOUT === '1';
  if (batchMode) {
    try {
      // F19: the batch call counts as ONE upstream LLM call against the
      // hourly budget (the repair call inside the batch helper counts
      // separately when it fires).
      recordLlmCall(1);
      const perMentor = await requestMentorBatchReplyFromLLM({
        mentors,
        problem,
        language: effectiveLanguage,
        compactedConversation,
        model: cfg.model,
        apiKey: cfg.apiKey,
        chatCompletionsUrl: cfg.chatCompletionsUrl,
        isDashscope: cfg.isDashscope,
        protocol: cfg.protocol,
        upstreamTimeoutMs: cfg.upstreamTimeoutMs
      });
      return perMentor;
    } catch (error) {
      // Whole-batch failure: every mentor takes its own fallback reply and
      // the response still completes with 200 + meta.provider honesty.
      console.warn(
        `[mentor-api] batch generation failed; falling back per-mentor: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
      return mentors.map((mentor) => ({ mentor, ok: false, error }));
    }
  }
  return Promise.all(
    mentors.map(async (mentor) => {
      try {
        // F19: count this fan-out against the per-instance hourly LLM
        // budget. Recorded just before dispatch so even if upstream
        // errors out the call counts (it still consumed quota / time).
        recordLlmCall(1);
        const output = await requestMentorReplyFromLLM({
          mentor,
          problem,
          language: effectiveLanguage,
          compactedConversation,
          model: cfg.model,
          apiKey: cfg.apiKey,
          chatCompletionsUrl: cfg.chatCompletionsUrl,
          isDashscope: cfg.isDashscope,
        protocol: cfg.protocol,
          upstreamTimeoutMs: cfg.upstreamTimeoutMs
        });
        return { mentor, ok: true, output };
      } catch (error) {
        return { mentor, ok: false, error };
      }
    })
  );
};

const aggregatePerMentorResults = (perMentor, effectiveLanguage) => {
  const failedMentors = [];
  const normalized = {
    safety: {
      riskLevel: 'low',
      needsProfessionalHelp: false,
      emergencyMessage: ''
    },
    mentorReplies: [],
    meta: { disclaimer: defaultDisclaimer(effectiveLanguage) }
  };

  for (const item of perMentor) {
    const mentor = item.mentor;
    if (item.ok && item.output) {
      normalized.safety = mergeSafetyState(normalized.safety, item.output.safety);
      const reply = item.output.reply;
      // reply is guaranteed populated: normalizeProviderPayload filters out
      // entries without likelyResponse and defaults the other fields; a
      // strict-parse failure degraded this mentor to a fallback reply above.
      const likelyResponse = sanitizeFirstPerson(String(reply.likelyResponse));
      const oneActionStep = sanitizeFirstPerson(String(reply.oneActionStep));
      const wrongLanguage =
        !contentMatchesLanguage(likelyResponse, effectiveLanguage) ||
        !contentMatchesLanguage(oneActionStep, effectiveLanguage);
      if (wrongLanguage) {
        failedMentors.push(mentor.id);
        console.warn(`[mentor-api] language mismatch for mentor=${mentor.id}; using language-safe fallback`);
        const fallbackReply = buildFallbackReplyForMentor(mentor, effectiveLanguage);
        normalized.mentorReplies.push({
          mentorId: mentor.id,
          mentorName: mentor.displayName,
          likelyResponse: sanitizeFirstPerson(fallbackReply.likelyResponse),
          whyThisFits: fallbackReply.whyThisFits,
          oneActionStep: sanitizeFirstPerson(fallbackReply.oneActionStep),
          confidenceNote: fallbackReply.confidenceNote
        });
        continue;
      }
      normalized.mentorReplies.push({
        mentorId: mentor.id,
        mentorName: mentor.displayName,
        likelyResponse,
        whyThisFits:
          String(reply.whyThisFits) ||
          (effectiveLanguage === 'zh-CN'
            ? `这条建议基于${mentor.displayName}公开风格生成。`
            : `This guidance is generated from ${mentor.displayName}'s public style.`),
        oneActionStep,
        confidenceNote: String(reply.confidenceNote)
      });
    } else {
      failedMentors.push(mentor.id);
      console.warn(
        `[mentor-api] per-mentor generation failed mentor=${mentor.id}: ${
          item.error instanceof Error ? item.error.message : String(item.error)
        }`
      );
      const fallbackReply = buildFallbackReplyForMentor(mentor, effectiveLanguage);
      normalized.mentorReplies.push({
        mentorId: mentor.id,
        mentorName: mentor.displayName,
        likelyResponse: sanitizeFirstPerson(fallbackReply.likelyResponse),
        whyThisFits: fallbackReply.whyThisFits,
        oneActionStep: sanitizeFirstPerson(fallbackReply.oneActionStep),
        confidenceNote: fallbackReply.confidenceNote
      });
    }
  }

  return { normalized, failedMentors };
};

const mentorTableHandler = async (req, res) => {
  const requestStartedAt = Date.now(); // F170: request_complete latency
  // Apply shared security middleware (CORS + OPTIONS + body cap + rate limit).
  // The body cap is 256kb here — conversation history can legitimately be
  // large on multi-round sessions. Rate limit is stricter than mentor-image
  // because each request fans out to 10 upstream LLM calls.
  if (!(await applyApiSecurity(req, res, {
    maxBodyBytes: '256kb',
    rateLimit: {
      capacity: 20,
      refillPerSecond: 0.3,
      kvLimit: Number(process.env.MENTOR_TABLE_KV_LIMIT || 30), kvWindowSeconds: 60, bucketName: 'table',
    },
  }))) return;

  // F19: global LLM cost ceiling. Per-IP rate limit above is best-effort and
  // does not bound autoscale cost. The breaker + LLM_DISABLED kill switch
  // give the operator a real ceiling and a sub-minute mitigation path.
  if (!enforceLlmBreaker(req, res)) return;

  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  try {
    const input = parseAndValidateRequest(req, res);
    if (!input) return;

    // Provider precedence: request body > LLM_PROVIDER env default > legacy
    // env config. An unknown LLM_PROVIDER env value is an operator typo —
    // warn loudly but keep serving on the legacy config rather than going
    // down; a body-level unknown provider is a client error (400 in the
    // parse step above).
    const envProvider = process.env.LLM_PROVIDER;
    if (envProvider && !isKnownProvider(envProvider)) {
      console.warn(`[mentor-table] ignoring unknown LLM_PROVIDER '${envProvider}' (${providerErrorHint()}); using legacy env config`);
    }
    const cfg = resolveUpstreamConfig(input.provider || (isKnownProvider(envProvider) ? envProvider : null));

    // Misuse of the API always returns 4xx (validation above); only
    // LLM-requiring paths require server config.
    if (!cfg.apiKey) {
      logMissingKeyDiagnostics(cfg);
      res.status(500).json({ error: 'Server configuration error' });
      return;
    }

    const { problem, language, mentors, conversationHistory } = input;
    const effectiveLanguage = resolveEffectiveLanguage(language, problem, conversationHistory);
    const compactedConversation = await compactRequestHistory(conversationHistory, effectiveLanguage, cfg);
    const perMentor = await dispatchMentorGeneration({
      mentors,
      problem,
      effectiveLanguage,
      compactedConversation,
      cfg
    });
    const { normalized, failedMentors } = aggregatePerMentorResults(perMentor, effectiveLanguage);

    const finalized = finalizeContractShape(normalized, {
      language: effectiveLanguage,
      baseUrl: cfg.baseUrl,
      model: cfg.model
    });

    if (failedMentors.length === mentors.length) {
      finalized.meta.provider = 'server-fallback';
    } else if (failedMentors.length > 0) {
      finalized.meta.provider = 'partial-fallback';
    }

    // F170 (P26): one grep-able summary per successful request — outcome,
    // fan-out mode, cost proxies (mentor count, failures), latency.
    log('info', 'request_complete', {
      handler: 'mentor-table',
      outcome: 'ok',
      mode: process.env.MENTOR_BATCH_FANOUT === '1' ? 'batch' : 'fanout',
      mentorCount: mentors.length,
      failedCount: failedMentors.length,
      provider: finalized.meta.provider,
      latencyMs: Date.now() - requestStartedAt,
    });

    res.status(200).json(finalized);
  } catch (error) {
    // Log the full error server-side for debugging.
    log('error', 'api_error', {
      handler: 'mentor-table',
      errorName: error instanceof Error ? error.name : typeof error,
      errorMessageTruncated: truncateErrorMessage(error, 200),
    });
    // F57 (U8.1 R2): the parallel `console.error('[mentor-api] error:', error)`
    // duplicate that emitted the raw Error (with multi-line stack trace and
    // /var/task/ paths) has been removed. The structured log above is the
    // sole record — message is truncated to 200 chars and runs through
    // `truncateErrorMessage` so no stack reaches Vercel Logs.
    // Never pass through non-Error throws to the client — they may contain
    // arbitrary caller-controlled text and bypass the structured error surface.
    // Only Error instances with vetted messages are relayed, and even those
    // are redacted for key/token patterns before being returned.
    let message = 'Unknown server error';
    if (error instanceof Error) {
      if (error.name === 'AbortError') {
        message = 'Upstream LLM request timed out';
      } else {
        message = redactSensitive(error.message || 'Unknown server error');
      }
    }
    res.status(500).json({ error: message });
  }
};

// redactSensitive now lives in lib/security.js and is imported at the top of
// this file. See BYPASS-1 / FIX-CRITIQUE-4 — the old pattern over-redacted
// legitimate UUIDs/hashes via a 32+ char catch-all AND missed most real
// secret formats. The shared helper enumerates specific well-known formats.

mentorTableHandler.__test__ = {
  normalizeConversationHistory,
  buildConversationRounds,
  compactConversationHistoryDeterministic,
  compactConversationHistory,
  formatConversationHistoryForPrompt,
  buildUserPrompt,
  buildMentorDirectiveBlock,
  requestMentorBatchReplyFromLLM,
  sanitizeMentorField,
  sanitizeMentorFieldArray,
  redactSensitive,
  extractTopLevelJsonObjects,
  tryParseJson,
  normalizeProviderPayload,
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
  contentMatchesLanguage,
  detectContentLanguage,
  finalizeContractShape,
  firstNonEmptyEnvValue,
  buildServerFallbackNormalized,
  buildFallbackReplyForMentor,
  defaultDisclaimer,
  providerFromBaseUrl,
  buildSystemPrompt,
  _resetLlmReplyCache,
  MENTORS_MAX,
  DEFAULT_UPSTREAM_TIMEOUT_MS,
};

module.exports = mentorTableHandler;
