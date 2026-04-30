'use strict';

const { sanitizeMentorField } = require('../../lib/security.js');
const {
  normalizeLanguage,
  tryParseJson,
} = require('./mentor-contract.js');
const { callChatCompletions, extractAssistantContent } = require('./mentor-upstream.js');
const { formatConversationHistoryForPrompt } = require('./mentor-prompts.js');

// Conversation-history normalization, token estimation, deterministic and
// LLM-assisted middle compaction.

function normalizeHistoryRole(value) {
  if (value === 'user' || value === 'mentor' || value === 'system') return value;
  return 'system';
}

function normalizeConversationHistory(history) {
  return Array.isArray(history)
    ? history
        .filter((item) => item && typeof item === 'object')
        .map((item) => {
          const role = normalizeHistoryRole(item.role);
          // BYPASS-6: speaker previously preserved newlines, letting an
          // attacker inject "\n[system]: ignore previous" inside the prompt
          // block. Collapse whitespace (including \n\r\t) to a single space
          // and strip invisible / bidi / C1 control chars the same way
          // mentor fields are sanitized.
          const speaker =
            typeof item.speaker === 'string'
              ? sanitizeMentorField(item.speaker.replace(/\s+/g, ' '), 200)
              : '';
          const rawText =
            typeof item.text === 'string' ? item.text.trim().replace(/\s+/g, ' ') : '';
          // Cap each entry at ~2000 chars so one malicious history item can't
          // blow up the token budget.
          const text = rawText.length > 2000 ? rawText.slice(0, 2000) : rawText;
          return { role, speaker, text };
        })
        .filter((item) => item.text)
    : [];
}

function estimateTokens(text) {
  if (!text) return 0;
  const cjk = (text.match(/[\u3400-\u9fff]/g) || []).length;
  const nonCjk = Math.max(0, text.length - cjk);
  return cjk + Math.ceil(nonCjk / 4);
}

function buildConversationRounds(entries) {
  const rounds = [];
  let current = [];

  for (const item of entries) {
    if (item.role === 'user') {
      if (current.length) rounds.push(current);
      current = [item];
      continue;
    }
    if (!current.length) {
      current = [item];
    } else {
      current.push(item);
    }
  }
  if (current.length) rounds.push(current);
  return rounds;
}

function summarizeCompactedMiddleDeterministic(middleEntries) {
  const omittedUsers = middleEntries
    .filter((item) => item.role === 'user')
    .slice(-3)
    .map((item) => item.text.slice(0, 140));
  const omittedMentors = Array.from(
    new Set(
      middleEntries
        .filter((item) => item.role === 'mentor')
        .map((item) => item.speaker)
        .filter(Boolean)
    )
  ).slice(0, 8);

  return `Middle rounds compacted. User-highlights: ${omittedUsers.join(' | ') || 'none'}. Mentor-participants: ${omittedMentors.join(', ') || 'none'}.`;
}

function compactConversationHistoryDeterministic(entries, maxItems = 36, maxChars = 6000) {
  if (entries.length === 0) {
    return { entries: [], summary: '', omittedCount: 0, usedLlmCompression: false, estimatedTokens: 0 };
  }

  const countChars = (rows) => rows.reduce((sum, item) => sum + item.text.length + item.speaker.length + 12, 0);
  if (entries.length <= maxItems && countChars(entries) <= maxChars) {
    return {
      entries,
      summary: '',
      omittedCount: 0,
      usedLlmCompression: false,
      estimatedTokens: estimateTokens(formatConversationHistoryForPrompt(entries))
    };
  }

  const headKeep = Math.min(4, entries.length);
  const head = entries.slice(0, headKeep);

  const tailBudget = Math.max(1200, Math.floor(maxChars * 0.68));
  const tail = [];
  let tailChars = 0;
  for (let i = entries.length - 1; i >= headKeep; i -= 1) {
    const item = entries[i];
    const itemChars = item.text.length + item.speaker.length + 12;
    if (tail.length >= Math.max(6, maxItems - headKeep)) break;
    if (tailChars + itemChars > tailBudget) break;
    tail.push(item);
    tailChars += itemChars;
  }
  tail.reverse();

  let compactedEntries = [...head, ...tail];
  if (compactedEntries.length > maxItems) {
    compactedEntries = compactedEntries.slice(compactedEntries.length - maxItems);
  }

  const omittedCount = Math.max(0, entries.length - compactedEntries.length);
  const omittedMiddle = entries.slice(headKeep, entries.length - tail.length);
  const summary = omittedCount > 0 ? summarizeCompactedMiddleDeterministic(omittedMiddle) : '';

  return {
    entries: compactedEntries,
    summary,
    omittedCount,
    usedLlmCompression: false,
    estimatedTokens: estimateTokens(formatConversationHistoryForPrompt(entries))
  };
}

async function summarizeCompactedMiddleWithLLM({
  middleEntries,
  language,
  model,
  apiKey,
  chatCompletionsUrl,
  compressTimeoutMs
}) {
  const lang = normalizeLanguage(language);
  // middleEntries is guaranteed non-empty by caller (rounds.length > 4 is checked earlier).
  const middleText = formatConversationHistoryForPrompt(middleEntries).slice(0, 120000);

  const payload = {
    model,
    temperature: 0.2,
    response_format: { type: 'json_object' },
    messages: [
      {
        role: 'system',
        content:
          lang === 'zh-CN'
            ? '你是对话压缩器。请把对话中段压缩成结构化摘要。保持事实，不新增观点，不输出Markdown。'
            : 'You are a conversation compressor. Compress middle conversation rounds into a structured factual summary. No markdown.'
      },
      {
        role: 'user',
        content:
          lang === 'zh-CN'
            ? [
                '请输出JSON对象，字段如下：',
                '{',
                '  "summary": "2-6句概述主线",',
                '  "userConcerns": ["最多5条用户关切"],',
                '  "mentorDirections": ["最多6条导师建议方向"],',
                '  "openLoops": ["最多4条未解决问题"]',
                '}',
                '',
                '对话中段如下：',
                middleText
              ].join('\n')
            : [
                'Return a JSON object with fields:',
                '{',
                '  "summary": "2-6 sentence overview",',
                '  "userConcerns": ["up to 5 user concerns"],',
                '  "mentorDirections": ["up to 6 mentor guidance directions"],',
                '  "openLoops": ["up to 4 unresolved items"]',
                '}',
                '',
                'Middle conversation rounds:',
                middleText
              ].join('\n')
      }
    ]
  };

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), compressTimeoutMs);
  let result = '';
  try {
    const response = await callChatCompletions({
      url: chatCompletionsUrl,
      apiKey,
      payload,
      signal: controller.signal
    });
    if (response.ok) {
      const data = await response.json();
      const content = extractAssistantContent(data);
      const parsed = tryParseJson(content);
      if (parsed && typeof parsed === 'object') {
        const summary = typeof parsed.summary === 'string' ? parsed.summary.trim() : '';
        const userConcerns = Array.isArray(parsed.userConcerns) ? parsed.userConcerns.filter((x) => typeof x === 'string') : [];
        const mentorDirections = Array.isArray(parsed.mentorDirections) ? parsed.mentorDirections.filter((x) => typeof x === 'string') : [];
        const openLoops = Array.isArray(parsed.openLoops) ? parsed.openLoops.filter((x) => typeof x === 'string') : [];

        result = [
          summary,
          userConcerns.length ? `UserConcerns: ${userConcerns.join(' | ')}` : '',
          mentorDirections.length ? `MentorDirections: ${mentorDirections.join(' | ')}` : '',
          openLoops.length ? `OpenLoops: ${openLoops.join(' | ')}` : ''
        ]
          .filter(Boolean)
          .join('\n')
          .trim();
      }
    }
  } catch {
    result = '';
  }
  clearTimeout(timeout);
  return result;
}

async function compactConversationHistory(history, options = {}) {
  const normalized = normalizeConversationHistory(history);
  const maxItems = Number(options.maxItems || 36);
  const maxChars = Number(options.maxChars || 6000);
  const tokenThreshold = Number(options.tokenThreshold || 100000);

  if (normalized.length === 0) {
    return { entries: [], summary: '', omittedCount: 0, usedLlmCompression: false, estimatedTokens: 0 };
  }

  const fullText = formatConversationHistoryForPrompt(normalized);
  const estimatedTokens = estimateTokens(fullText);
  // NEW-6: cost amplification via the LLM compressor. The old code only
  // checked estimatedTokens < tokenThreshold, which is the RIGHT check for
  // ASCII content but over-triggers compression on small-to-medium payloads
  // when a caller lowers the threshold (e.g. tests, misconfig). Add a raw
  // byte floor: if the content is under a small, absolute hard floor —
  // regardless of the configurable tokenThreshold — always use the cheap
  // deterministic compactor. The floor is picked so that it's well under
  // every LLM's real context window at every supported model, so skipping
  // compression is always safe.
  const byteSize = Buffer.byteLength(fullText, 'utf8');
  const RAW_BYTE_FLOOR = 32 * 1024; // 32KB hard floor — always safe to skip compression
  if (byteSize < RAW_BYTE_FLOOR || estimatedTokens < tokenThreshold) {
    return compactConversationHistoryDeterministic(normalized, maxItems, maxChars);
  }

  const rounds = buildConversationRounds(normalized);
  if (rounds.length <= 4) {
    const fallbackCompacted = compactConversationHistoryDeterministic(normalized, maxItems, maxChars);
    return { ...fallbackCompacted, estimatedTokens };
  }

  const protectedRoundIndexes = new Set([0, 1, rounds.length - 2, rounds.length - 1]);
  const preservedEntries = [];
  const middleEntries = [];

  rounds.forEach((round, idx) => {
    if (protectedRoundIndexes.has(idx)) preservedEntries.push(...round);
    else middleEntries.push(...round);
  });

  const llmSummary = await summarizeCompactedMiddleWithLLM({
    middleEntries,
    language: options.language,
    model: options.model,
    apiKey: options.apiKey,
    chatCompletionsUrl: options.chatCompletionsUrl,
    compressTimeoutMs: Number(options.compressTimeoutMs || 12000)
  });
  const summary = llmSummary || summarizeCompactedMiddleDeterministic(middleEntries);

  return {
    entries: preservedEntries,
    summary,
    omittedCount: middleEntries.length,
    usedLlmCompression: true,
    estimatedTokens
  };
}

module.exports = {
  normalizeHistoryRole,
  normalizeConversationHistory,
  estimateTokens,
  buildConversationRounds,
  summarizeCompactedMiddleDeterministic,
  compactConversationHistoryDeterministic,
  summarizeCompactedMiddleWithLLM,
  compactConversationHistory,
};
