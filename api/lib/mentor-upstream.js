'use strict';

const { log } = require('../../lib/logger.js');
const { redactSensitive, recordLlmCall } = require('../../lib/security.js');
const {
  RESPONSE_SCHEMA,
  normalizeLanguage,
  normalizeProviderPayload,
  pickReplyForMentor,
  tryParseJson,
} = require('./mentor-contract.js');
const { buildSystemPrompt, buildUserPrompt } = require('./mentor-prompts.js');

// Upstream LLM dispatch: per-mentor fan-out and batch (F158) modes, JSON
// repair, and the shared chat-completions client.

// F167 (P23): per-instance LLM response cache. Key =
// sha256(model | mentor.id | language | problem | conversation history).
// Only successful, strictly-normalized replies are cached — a repair-path
// success is cacheable, a throw is not. Semantics: identical inputs replay
// the identical reply within the TTL, cutting cost and latency for
// accidental resubmits (double-click, strict-mode double render). Env:
// MENTOR_LLM_CACHE=0 disables; MENTOR_LLM_CACHE_TTL_SECONDS caps freshness
// (default 900).
const LLM_REPLY_CACHE = new Map();
const LLM_REPLY_CACHE_MAX = 200;
const LLM_REPLY_CACHE_TTL_MS_DEFAULT = 15 * 60 * 1000;

function llmCacheTtlMs() {
  const n = Number(process.env.MENTOR_LLM_CACHE_TTL_SECONDS);
  return Number.isFinite(n) && n >= 0 ? n * 1000 : LLM_REPLY_CACHE_TTL_MS_DEFAULT;
}

function llmCacheEnabled() {
  return process.env.MENTOR_LLM_CACHE !== '0';
}

function llmReplyCacheKey({ model, mentor, language, problem, compactedConversation }) {
  const crypto = require('crypto');
  const hash = crypto.createHash('sha256');
  hash.update(String(model || ''));
  hash.update('|');
  hash.update(String(mentor && mentor.id || ''));
  hash.update('|');
  hash.update(String(language || ''));
  hash.update('|');
  hash.update(String(problem || ''));
  hash.update('|');
  hash.update(JSON.stringify(compactedConversation || []));
  return hash.digest('hex');
}

function llmCacheGet(key) {
  if (!llmCacheEnabled()) return null;
  const entry = LLM_REPLY_CACHE.get(key);
  if (!entry) return null;
  if (Date.now() - entry.storedAt > llmCacheTtlMs()) {
    LLM_REPLY_CACHE.delete(key);
    return null;
  }
  // Refresh insertion recency (Map iteration order = LRU-ish eviction).
  LLM_REPLY_CACHE.delete(key);
  LLM_REPLY_CACHE.set(key, entry);
  return entry.value;
}

function llmCachePut(key, value) {
  if (!llmCacheEnabled()) return;
  if (LLM_REPLY_CACHE.size >= LLM_REPLY_CACHE_MAX) {
    const drop = Math.max(1, Math.floor(LLM_REPLY_CACHE_MAX / 10));
    let dropped = 0;
    for (const k of LLM_REPLY_CACHE.keys()) {
      if (dropped >= drop) break;
      LLM_REPLY_CACHE.delete(k);
      dropped += 1;
    }
  }
  LLM_REPLY_CACHE.set(key, { storedAt: Date.now(), value });
}

function _resetLlmReplyCache() {
  LLM_REPLY_CACHE.clear();
}

async function requestMentorReplyFromLLM({
  mentor,
  problem,
  language,
  compactedConversation,
  model,
  apiKey,
  chatCompletionsUrl,
  isDashscope,
  upstreamTimeoutMs
}) {
  const cacheKey = llmReplyCacheKey({ model, mentor, language, problem, compactedConversation });
  const cached = llmCacheGet(cacheKey);
  if (cached) {
    log('info', 'api_cache_hit', {
      handler: 'mentor-table',
      stage: 'upstream_cache_hit',
      mentorId: mentor.id,
      model,
    });
    return cached;
  }

  const payload = {
    model,
    temperature: 0.55,
    response_format: isDashscope
      ? { type: 'json_object' }
      : {
          type: 'json_schema',
          json_schema: {
            name: 'mentor_table_output',
            schema: RESPONSE_SCHEMA
          }
        },
    messages: [
      { role: 'system', content: buildSystemPrompt([mentor]) },
      { role: 'user', content: buildUserPrompt(problem, language, [mentor], compactedConversation) }
    ]
  };

  const startedAt = Date.now();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), upstreamTimeoutMs);
  let response;
  try {
    log('info', 'api_request', {
      handler: 'mentor-table',
      stage: 'upstream_start',
      mentorId: mentor.id,
      model,
    });
    // eslint-disable-next-line no-console
    console.log(`[mentor-api] upstream request start mentor=${mentor.id} model=${model}`);
    response = await callChatCompletions({
      url: chatCompletionsUrl,
      apiKey,
      payload,
      signal: controller.signal
    });

    if (!response.ok && response.status >= 400 && response.status < 500 && payload.response_format?.type === 'json_schema') {
      const fallbackPayload = {
        ...payload,
        response_format: { type: 'json_object' }
      };
      response = await callChatCompletions({
        url: chatCompletionsUrl,
        apiKey,
        payload: fallbackPayload,
        signal: controller.signal
      });
    }
  } finally {
    clearTimeout(timeout);
  }

  log('info', 'api_ok', {
    handler: 'mentor-table',
    stage: 'upstream_response',
    mentorId: mentor.id,
    status: response.status,
    latency_ms: Date.now() - startedAt,
  });
  // eslint-disable-next-line no-console
  console.log(
    `[mentor-api] upstream response mentor=${mentor.id} status=${response.status} elapsed=${Date.now() - startedAt}ms`
  );
  if (!response.ok) {
    // Log the full upstream body server-side for debugging, but do NOT embed
    // it in the thrown Error — upstream LLM error bodies can contain API key
    // prefixes, request IDs, and other sensitive infrastructure metadata.
    let errorText = '';
    try {
      errorText = await response.text();
    } catch {
      errorText = '<unreadable>';
    }
    // F58 (U8.1 R2): the parallel console.error duplicate that emitted the
    // upstream body at 500 chars unredacted has been removed. The single
    // structured log below pipes the 200-char preview through
    // `redactSensitive` so DashScope/OpenAI error bodies cannot leak
    // Authorization/sk-/LTAI prefixes echoed back from upstream.
    log('error', 'api_error', {
      handler: 'mentor-table',
      stage: 'upstream_non_ok',
      mentorId: mentor.id,
      status: response.status,
      bodyTruncated: redactSensitive(String(errorText).slice(0, 200)),
    });
    throw new Error(`Mentor API failed for ${mentor.id} with status ${response.status}`);
  }

  const data = await response.json();
  let content = extractAssistantContent(data);
  let parsed = tryParseJson(content);

  if (!parsed) {
    const repairPayload = {
      model,
      temperature: 0.2,
      response_format: { type: 'json_object' },
      messages: [
        {
          role: 'system',
          content:
            'Convert the given text into valid JSON only. No markdown. Use keys: schemaVersion, language, safety, mentorReplies, meta.'
        },
        {
          role: 'user',
          content:
            `Target mentor id: ${mentor.id}\n` +
            'Target schema keys: schemaVersion, language, safety, mentorReplies, meta\n' +
            `Raw output to repair:\n${String(content || '').slice(0, 6000)}`
        }
      ]
    };

    const repairController = new AbortController();
    const repairTimeout = setTimeout(() => repairController.abort(), Math.min(12000, upstreamTimeoutMs));
    try {
      const repairResponse = await callChatCompletions({
        url: chatCompletionsUrl,
        apiKey,
        payload: repairPayload,
        signal: repairController.signal
      });

      if (repairResponse.ok) {
        const repairedData = await repairResponse.json();
        content = extractAssistantContent(repairedData);
        parsed = tryParseJson(content);
      }
    } finally {
      clearTimeout(repairTimeout);
    }
  }

  // F159: strict parse only. The old regex salvage path (normalizeProviderPayloadLoose)
  // fabricated replies from arbitrary upstream text — including wrong-person
  // attribution when key names drifted. A batch that survives the repair call
  // but still cannot be strictly normalized degrades to the mentor's fallback
  // reply instead.
  const normalized = normalizeProviderPayload(parsed, { mentors: [mentor], language });
  if (!normalized) {
    const preview = String(content || '').slice(0, 180).replace(/\s+/g, ' ');
    throw new Error(`Model returned invalid JSON for ${mentor.id}. Preview: ${preview}`);
  }

  // normalizeProviderPayload guarantees mentorReplies.length > 0 when it returns
  // non-null, so pickReplyForMentor's fallback chain always finds a reply, and
  // normalizeSafety() always produces a safety object — no null guard needed.
  const reply = pickReplyForMentor(mentor, normalized);

  const result = { reply, safety: normalized.safety };
  llmCachePut(cacheKey, result);
  return result;
}

function extractAssistantContent(data) {
  const content = data?.choices?.[0]?.message?.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    const texts = content
      .map((part) => {
        if (typeof part === 'string') return part;
        if (part && typeof part.text === 'string') return part.text;
        return '';
      })
      .filter(Boolean);
    return texts.join('\n').trim();
  }
  if (content && typeof content === 'object') {
    return JSON.stringify(content);
  }
  return '';
}

// F158: batch generation — one upstream completion covers the whole table.
// MENTOR_BATCH_FANOUT=1 opts in; default remains the proven per-mentor
// fan-out. The RESPONSE_SCHEMA is already batch-shaped (mentorReplies
// array), so strict normalization is shared; only the request fan-out and
// per-mentor attribution change.
const MENTOR_BATCH_MAX_TIMEOUT_MS = 60000;

async function requestMentorBatchReplyFromLLM({
  mentors,
  problem,
  language,
  compactedConversation,
  model,
  apiKey,
  chatCompletionsUrl,
  isDashscope,
  upstreamTimeoutMs
}) {
  // One completion writing N replies takes longer than one reply. Scale the
  // per-mentor timeout linearly (each mentor contributes up to ~1 reply's
  // worth of tokens) and cap it so a 5-mentor table stays inside the
  // platform function budget.
  const batchTimeoutMs = Math.min(
    MENTOR_BATCH_MAX_TIMEOUT_MS,
    upstreamTimeoutMs + (mentors.length - 1) * Math.min(upstreamTimeoutMs, 12000)
  );

  const payload = {
    model,
    temperature: 0.55,
    response_format: isDashscope
      ? { type: 'json_object' }
      : {
          type: 'json_schema',
          json_schema: {
            name: 'mentor_table_output',
            schema: RESPONSE_SCHEMA
          }
        },
    messages: [
      { role: 'system', content: buildSystemPrompt(mentors) },
      { role: 'user', content: buildUserPrompt(problem, language, mentors, compactedConversation) }
    ]
  };

  const startedAt = Date.now();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), batchTimeoutMs);
  let response;
  try {
    log('info', 'api_request', {
      handler: 'mentor-table',
      stage: 'upstream_start',
      mentorId: 'batch',
      mentorCount: mentors.length,
      model,
    });
    // eslint-disable-next-line no-console
    console.log(
      `[mentor-api] upstream request start mode=batch mentors=${mentors.length} model=${model}`
    );
    response = await callChatCompletions({
      url: chatCompletionsUrl,
      apiKey,
      payload,
      signal: controller.signal
    });

    if (!response.ok && response.status >= 400 && response.status < 500 && payload.response_format?.type === 'json_schema') {
      const fallbackPayload = {
        ...payload,
        response_format: { type: 'json_object' }
      };
      response = await callChatCompletions({
        url: chatCompletionsUrl,
        apiKey,
        payload: fallbackPayload,
        signal: controller.signal
      });
    }
  } finally {
    clearTimeout(timeout);
  }

  log('info', 'api_ok', {
    handler: 'mentor-table',
    stage: 'upstream_response',
    mentorId: 'batch',
    mentorCount: mentors.length,
    status: response.status,
    latency_ms: Date.now() - startedAt,
  });
  // eslint-disable-next-line no-console
  console.log(
    `[mentor-api] upstream response mode=batch mentors=${mentors.length} status=${response.status} elapsed=${Date.now() - startedAt}ms`
  );
  if (!response.ok) {
    // Same rule as the per-mentor path: log the body server-side through
    // redactSensitive, never embed it in the thrown Error.
    let errorText = '';
    try {
      errorText = await response.text();
    } catch {
      errorText = '<unreadable>';
    }
    log('error', 'api_error', {
      handler: 'mentor-table',
      stage: 'upstream_non_ok',
      mentorId: 'batch',
      status: response.status,
      bodyTruncated: redactSensitive(String(errorText).slice(0, 200)),
    });
    throw new Error(`Mentor API failed in batch mode with status ${response.status}`);
  }

  const data = await response.json();
  let content = extractAssistantContent(data);
  let parsed = tryParseJson(content);

  if (!parsed) {
    // F158: repair counts as its own upstream call against the hourly budget.
    recordLlmCall(1);
    const repairPayload = {
      model,
      temperature: 0.2,
      response_format: { type: 'json_object' },
      messages: [
        {
          role: 'system',
          content:
            'Convert the given text into valid JSON only. No markdown. Use keys: schemaVersion, language, safety, mentorReplies, meta.'
        },
        {
          role: 'user',
          content:
            `Target mentor ids: ${mentors.map((m) => m.id).join(', ')}\n` +
            'Target schema keys: schemaVersion, language, safety, mentorReplies, meta. ' +
            'mentorReplies must contain one entry per target mentor.\n' +
            `Raw output to repair:\n${String(content || '').slice(0, 6000)}`
        }
      ]
    };

    const repairController = new AbortController();
    const repairTimeout = setTimeout(() => repairController.abort(), Math.min(12000, batchTimeoutMs));
    try {
      const repairResponse = await callChatCompletions({
        url: chatCompletionsUrl,
        apiKey,
        payload: repairPayload,
        signal: repairController.signal
      });

      if (repairResponse.ok) {
        const repairedData = await repairResponse.json();
        content = extractAssistantContent(repairedData);
        parsed = tryParseJson(content);
      }
    } finally {
      clearTimeout(repairTimeout);
    }
  }

  // F159: strict normalization only — same contract as the per-mentor path.
  // A batch that cannot be strictly normalized (after one repair call)
  // degrades to per-mentor fallbacks; no regex salvage, no fabricated
  // attribution.
  const normalized = normalizeProviderPayload(parsed, { mentors, language });
  if (!normalized || !Array.isArray(normalized.mentorReplies) || normalized.mentorReplies.length === 0) {
    const preview = String(content || '').slice(0, 180).replace(/\s+/g, ' ');
    throw new Error(`Model returned invalid JSON in batch mode. Preview: ${preview}`);
  }

  // Strict attribution: unlike pickReplyForMentor, NO replies[0] fallback —
  // a mentor missing from the batch response must degrade to its own
  // fallback reply, never inherit a neighbor's reply.
  const normalizeKey = (value) => String(value || '').trim().toLowerCase().replace(/\s+/g, '_');
  const safety = normalized.safety;
  return mentors.map((mentor) => {
    try {
      const mentorIdKey = normalizeKey(mentor.id);
      const mentorNameKey = normalizeKey(mentor.displayName);
      const reply =
        normalized.mentorReplies.find((item) => normalizeKey(item.mentorId) === mentorIdKey) ||
        normalized.mentorReplies.find((item) => normalizeKey(item.mentorName) === mentorNameKey);
      if (!reply) {
        throw new Error(`batch response missing mentor=${mentor.id}`);
      }
      return { mentor, ok: true, output: { reply, safety } };
    } catch (error) {
      return { mentor, ok: false, error };
    }
  });
}

async function callChatCompletions({ url, apiKey, payload, signal }) {
  return fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`
    },
    body: JSON.stringify(payload),
    signal
  });
}

function firstNonEmptyEnvValue(candidates) {
  for (const value of candidates) {
    if (typeof value !== 'string') continue;
    const trimmed = value.trim();
    if (trimmed) return trimmed;
  }
  return '';
}

module.exports = {
  callChatCompletions,
  extractAssistantContent,
  firstNonEmptyEnvValue,
  requestMentorReplyFromLLM,
  _resetLlmReplyCache,
  llmReplyCacheKey,
  requestMentorBatchReplyFromLLM,
};
