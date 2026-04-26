'use strict';

// F-scope: pure contract utilities for the mentor-table API — response
// schema, safety normalization, language detection, provider payload
// normalization, and reply attribution. No I/O; everything here is
// deterministic and unit-testable in isolation (see api/__tests__).

const RESPONSE_SCHEMA_VERSION = 'mentor_table.v1';

const RESPONSE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    schemaVersion: { type: 'string', enum: [RESPONSE_SCHEMA_VERSION] },
    language: { type: 'string', enum: ['en', 'zh-CN'] },
    safety: {
      type: 'object',
      additionalProperties: false,
      properties: {
        riskLevel: { type: 'string', enum: ['none', 'low', 'medium', 'high'] },
        needsProfessionalHelp: { type: 'boolean' },
        emergencyMessage: { type: 'string' }
      },
      required: ['riskLevel', 'needsProfessionalHelp', 'emergencyMessage']
    },
    mentorReplies: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          mentorId: { type: 'string' },
          mentorName: { type: 'string' },
          likelyResponse: { type: 'string' },
          whyThisFits: { type: 'string' },
          oneActionStep: { type: 'string' },
          confidenceNote: { type: 'string' }
        },
        required: [
          'mentorId',
          'mentorName',
          'likelyResponse',
          'whyThisFits',
          'oneActionStep',
          'confidenceNote'
        ]
      }
    },
    meta: {
      type: 'object',
      additionalProperties: false,
      properties: {
        disclaimer: { type: 'string' },
        generatedAt: { type: 'string' },
        provider: { type: 'string' },
        model: { type: 'string' }
      },
      required: ['disclaimer', 'generatedAt']
    }
  },
  required: ['schemaVersion', 'language', 'safety', 'mentorReplies', 'meta']
};

function riskLevelScore(level) {
  if (level === 'high') return 3;
  if (level === 'medium') return 2;
  if (level === 'low') return 1;
  if (level === 'none') return 0;
  return 1;
}

function mergeSafetyState(acc, next) {
  if (!next || typeof next !== 'object') return acc;
  const nextRisk = normalizeRiskLevel(next.riskLevel);
  const accRisk = normalizeRiskLevel(acc.riskLevel);
  const useNext = riskLevelScore(nextRisk) > riskLevelScore(accRisk);
  return {
    riskLevel: useNext ? nextRisk : accRisk,
    needsProfessionalHelp: Boolean(acc.needsProfessionalHelp || next.needsProfessionalHelp),
    emergencyMessage: useNext
      ? next.emergencyMessage || acc.emergencyMessage || ''
      : acc.emergencyMessage || next.emergencyMessage || ''
  };
}

function normalizeLanguage(language) {
  return language === 'en' ? 'en' : 'zh-CN';
}

function defaultDisclaimer(language) {
  return normalizeLanguage(language) === 'zh-CN'
    ? '这是基于公开信息的AI模拟视角，不代表真实人物的观点。'
    : 'This is an AI-simulated perspective inspired by public information, not a real statement from the person.';
}

function detectLanguageFromText(text) {
  if (typeof text !== 'string') return null;
  const value = text.trim();
  if (!value) return null;
  const cjkCount = (value.match(/[\u3400-\u9fff]/g) || []).length;
  const latinCount = (value.match(/[A-Za-z]/g) || []).length;
  if (cjkCount === 0 && latinCount === 0) return null;
  if (cjkCount >= latinCount * 0.8) return 'zh-CN';
  // If cjk < latin*0.8 then latin > cjk*1.25 ≥ cjk*0.8, so this branch always returns 'en'.
  return 'en';
}

function resolveEffectiveLanguage(requestedLanguage, problem, conversationHistory) {
  if (requestedLanguage === 'zh-CN' || requestedLanguage === 'en') {
    return normalizeLanguage(requestedLanguage);
  }

  const problemLanguage = detectLanguageFromText(problem);
  if (problemLanguage) return problemLanguage;

  if (Array.isArray(conversationHistory)) {
    for (let i = conversationHistory.length - 1; i >= 0; i -= 1) {
      const item = conversationHistory[i];
      if (!item || item.role !== 'user') continue;
      const detected = detectLanguageFromText(item.text);
      if (detected) return detected;
    }
  }

  return normalizeLanguage(requestedLanguage);
}

function normalizeRiskLevel(value) {
  if (value === 'none' || value === 'low' || value === 'medium' || value === 'high') return value;
  return 'low';
}

function providerFromBaseUrl(baseUrl) {
  try {
    return new URL(baseUrl).hostname;
  } catch {
    return 'unknown';
  }
}

function finalizeContractShape(normalized, { language, baseUrl, model }) {
  const lang = normalizeLanguage(language);
  const safety = normalized?.safety || {};
  const meta = normalized?.meta || {};
  const replies = Array.isArray(normalized?.mentorReplies)
    ? normalized.mentorReplies.filter((item) => item && typeof item === 'object')
    : [];

  return {
    schemaVersion: RESPONSE_SCHEMA_VERSION,
    language: lang,
    safety: {
      riskLevel: normalizeRiskLevel(safety.riskLevel),
      needsProfessionalHelp: Boolean(safety.needsProfessionalHelp),
      emergencyMessage: typeof safety.emergencyMessage === 'string' ? safety.emergencyMessage : ''
    },
    mentorReplies: replies.map((item) => ({
      mentorId: String(item.mentorId || ''),
      mentorName: String(item.mentorName || 'Mentor'),
      likelyResponse: String(item.likelyResponse || ''),
      whyThisFits: String(item.whyThisFits || ''),
      oneActionStep: String(item.oneActionStep || ''),
      confidenceNote: String(item.confidenceNote || defaultConfidenceNote(lang))
    })),
    meta: {
      disclaimer:
        typeof meta.disclaimer === 'string' && meta.disclaimer.trim()
          ? meta.disclaimer
          : defaultDisclaimer(lang),
      generatedAt: new Date().toISOString(),
      provider: providerFromBaseUrl(baseUrl),
      model: typeof model === 'string' ? model : ''
    }
  };
}

function detectContentLanguage(text) {
  if (typeof text !== 'string') return null;
  const value = text.trim();
  if (!value) return null;
  const cjkCount = (value.match(/[\u3400-\u9fff]/g) || []).length;
  const latinCount = (value.match(/[A-Za-z]/g) || []).length;
  if (cjkCount === 0 && latinCount === 0) return null;
  if (cjkCount >= Math.max(3, latinCount * 0.7)) return 'zh-CN';
  if (latinCount >= Math.max(6, cjkCount * 1.4)) return 'en';
  return cjkCount >= latinCount ? 'zh-CN' : 'en';
}

function contentMatchesLanguage(text, language) {
  const detected = detectContentLanguage(text);
  if (!detected) return true;
  return detected === normalizeLanguage(language);
}

// They cover C0/C1 controls, DEL, bidi overrides, line/paragraph separators,
// zero-width chars, and BOM — see BYPASS-3 in the Round 2 security review.

function tryParseJson(text) {
  if (!text) return null;
  if (typeof text === 'object') return text;

  const normalizedText = String(text).trim();
  // Only called with strings; current only reassigned when parsed is string → always a string.
  const tryParseNested = (value) => {
    let current = value;
    for (let i = 0; i < 3; i += 1) {
      const trimmed = current.trim();
      if (!trimmed) return null;
      if (!(trimmed.startsWith('{') || trimmed.startsWith('[') || trimmed.startsWith('"'))) return null;
      try {
        const parsed = JSON.parse(trimmed);
        if (typeof parsed === 'string') {
          current = parsed;
          continue;
        }
        return parsed;
      } catch {
        return null;
      }
    }
    return null;
  };

  // Handle fenced code blocks: ```json ... ```
  const fenced = normalizedText.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced && fenced[1]) {
    const parsedFenced = tryParseNested(fenced[1].trim());
    if (parsedFenced) return parsedFenced;
  }

  const parsedDirect = tryParseNested(normalizedText);
  if (parsedDirect) return parsedDirect;

  {
    // Handle top-level array payloads.
    if (normalizedText.startsWith('[') && normalizedText.endsWith(']')) {
      try {
        const arr = JSON.parse(normalizedText);
        return { replies: arr };
      } catch {
        // Continue trying below.
      }
    }

    // FIX-CRITIQUE-6: the old regex `/\{[\s\S]*?\}/g` was non-greedy and
    // returned the INNERMOST `{...}` chunk, which for a payload like
    // `{"replies":[{"id":1}]}` would return `{"id":1}` and silently drop
    // the wrapper. Walk the text with a brace-balanced scanner so we only
    // ever pick out top-level objects.
    const topLevelObjects = extractTopLevelJsonObjects(normalizedText);
    if (topLevelObjects.length > 1) {
      const parsedItems = topLevelObjects
        .map((chunk) => {
          try {
            return JSON.parse(chunk);
          } catch {
            return null;
          }
        })
        .filter(Boolean);
      if (parsedItems.length > 0) {
        return { replies: parsedItems };
      }
    }

    if (topLevelObjects.length === 1) {
      const parsed = tryParseNested(topLevelObjects[0]);
      if (parsed) return parsed;
    }

    // Last-ditch: widest-span brace match (original Round 1 behavior) for
    // payloads with interleaved prose. Uses greedy match now.
    const match = normalizedText.match(/\{[\s\S]*\}/);
    if (!match) return null;
    return tryParseNested(match[0]);
  }
}

// Walk a string and return every top-level `{...}` object as a substring.
// Respects string literals (so braces inside "foo" don't confuse the
// counter) and backslash escapes inside strings. Used by tryParseJson
// to replace the old non-greedy regex that returned nested objects.
function extractTopLevelJsonObjects(text) {
  const results = [];
  let depth = 0;
  let startIdx = -1;
  let inString = false;
  let escape = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (inString) {
      if (escape) {
        escape = false;
      } else if (ch === '\\') {
        escape = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === '{') {
      if (depth === 0) startIdx = i;
      depth += 1;
      continue;
    }
    if (ch === '}') {
      if (depth > 0) {
        depth -= 1;
        if (depth === 0 && startIdx !== -1) {
          results.push(text.slice(startIdx, i + 1));
          startIdx = -1;
        }
      }
    }
  }
  return results;
}

function sanitizeFirstPerson(text) {
  if (!text || typeof text !== 'string') return text;
  return text
    .replace(/^\s*if i were[^,.]*[,.]\s*/i, '')
    .replace(/^\s*in a [^,.]*-like way[,.]?\s*/i, '')
    .replace(/^\s*as [^,.]+[,.]\s*/i, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function defaultConfidenceNote(language) {
  return language === 'zh-CN'
    ? '这是基于公开信息生成的AI模拟视角，不代表本人真实发言。'
    : 'This is an AI-simulated perspective based on public information, not an actual statement by the person.';
}

function defaultActionStep(language) {
  return language === 'zh-CN'
    ? '下一步：先写下今天能完成的一件小事，并在30分钟内执行。'
    : 'Next step: choose one small concrete action and complete it within 30 minutes today.';
}

function normalizeProviderPayload(raw, { mentors, language }) {
  if (!raw || typeof raw !== 'object') return null;

  const normalizeSafety = (safety) => ({
    riskLevel: safety?.riskLevel || 'low',
    needsProfessionalHelp: Boolean(safety?.needsProfessionalHelp),
    emergencyMessage: safety?.emergencyMessage || ''
  });

  const normalizeReply = (item) => {
    if (!item || typeof item !== 'object') return null;
    const mentorId = item.mentorId || item.MentorId || item.id || '';
    const mentorName = item.mentorName || item.MentorName || mentorId || 'Mentor';
    const likelyResponse =
      item.likelyResponse || item.Response || item.response || item.message || item.advice || '';
    if (!likelyResponse) return null;

    return {
      mentorId,
      mentorName,
      likelyResponse,
      whyThisFits: item.whyThisFits || item.WhyThisFits || item.reason || item.rationale || '',
      oneActionStep:
        item.oneActionStep ||
        item.OneActionStep ||
        item.nextAction ||
        item.NextAction ||
        defaultActionStep(language),
      confidenceNote:
        item.confidenceNote ||
        item.ConfidenceNote ||
        item.confidence ||
        item.note ||
        defaultConfidenceNote(language)
    };
  };

  // Shape variant: { mentorReplies: [...], ... } but missing strict safety/meta keys.
  if (Array.isArray(raw.mentorReplies)) {
    const mentorReplies = raw.mentorReplies.map(normalizeReply).filter(Boolean);
    if (mentorReplies.length > 0) {
      return {
        safety: normalizeSafety(raw.safety),
        mentorReplies,
        meta: {
          disclaimer:
            raw?.meta?.disclaimer ||
            raw?.GlobalDisclaimer ||
            raw?.globalDisclaimer ||
            raw?.disclaimer ||
            defaultDisclaimer(language)
        }
      };
    }
  }

  // Shape: { MentorId/mentorId, Response/response/message, GlobalDisclaimer, ... }
  // Some providers return a single mentor reply object in lowercase keys.
  const singleMentorId = raw.MentorId || raw.mentorId || raw.id;
  const singleResponse =
    raw.Response || raw.response || raw.message || raw.advice || raw.content || raw.reply;
  if (typeof singleMentorId === 'string' && typeof singleResponse === 'string') {
    const matchedMentor =
      (mentors || []).find(
        (m) =>
          m.id === singleMentorId ||
          m.displayName === (raw.MentorName || raw.mentorName || raw.name)
      ) || null;
    return {
      safety: {
        riskLevel: 'low',
        needsProfessionalHelp: false,
        emergencyMessage: ''
      },
      mentorReplies: [
        {
          mentorId: singleMentorId,
          mentorName:
            raw.MentorName ||
            raw.mentorName ||
            raw.name ||
            matchedMentor?.displayName ||
            singleMentorId,
          likelyResponse: singleResponse,
          whyThisFits: raw.WhyThisFits || raw.whyThisFits || raw.reason || '',
          oneActionStep:
            raw.OneActionStep ||
            raw.oneActionStep ||
            raw.NextAction ||
            raw.nextAction ||
            raw.next_step ||
            defaultActionStep(language),
          confidenceNote:
            raw.ConfidenceNote ||
            raw.confidenceNote ||
            raw.confidence ||
            defaultConfidenceNote(language)
        }
      ],
      meta: {
        disclaimer: raw.GlobalDisclaimer || raw.globalDisclaimer || raw.disclaimer || defaultDisclaimer(language)
      }
    };
  }

  // Shape: { replies: [{ MentorId, Response, ... }], ... }
  if (Array.isArray(raw.replies)) {
    const mentorReplies = raw.replies
      .map(normalizeReply)
      .filter(Boolean);

    if (mentorReplies.length > 0) {
      return {
        safety: normalizeSafety(raw.safety),
        mentorReplies,
        meta: {
          disclaimer:
            raw?.meta?.disclaimer ||
            raw?.GlobalDisclaimer ||
            raw?.globalDisclaimer ||
            raw?.disclaimer ||
            defaultDisclaimer(language)
        }
      };
    }
  }

  // Shape: { schemaVersion, response: { "<mentorIdOrName>": { message, ... } } }
  // Some providers wrap mentor replies under "response" as an object map.
  if (raw.response && typeof raw.response === 'object' && !Array.isArray(raw.response)) {
    const normalizeKey = (value) => String(value || '').trim().toLowerCase().replace(/\s+/g, '_');
    const mentorReplies = Object.entries(raw.response)
      .map(([key, value]) => {
        if (!value || typeof value !== 'object') return null;

        const item = value;
        const keyNormalized = normalizeKey(key);
        const matchedMentor =
          (mentors || []).find((m) => normalizeKey(m.id) === keyNormalized || normalizeKey(m.displayName) === keyNormalized) ||
          null;

        const mentorId = item.mentorId || item.MentorId || item.id || matchedMentor?.id || key;
        const mentorName =
          item.mentorName || item.MentorName || item.name || matchedMentor?.displayName || key;

        const likelyResponseRaw =
          item.likelyResponse ||
          item.Response ||
          item.response ||
          item.message ||
          item.advice ||
          item.content ||
          item.reply ||
          '';
        const likelyResponse = typeof likelyResponseRaw === 'string' ? likelyResponseRaw.trim() : '';
        if (!likelyResponse) return null;

        const oneActionStepRaw =
          item.oneActionStep ||
          item.OneActionStep ||
          item.nextAction ||
          item.NextAction ||
          item.next_step ||
          item.nextStep ||
          item.nextMove ||
          item.action ||
          defaultActionStep(language);

        const oneActionStep = typeof oneActionStepRaw === 'string' ? oneActionStepRaw : defaultActionStep(language);

        return {
          mentorId,
          mentorName,
          likelyResponse,
          whyThisFits: item.whyThisFits || item.WhyThisFits || item.reason || item.rationale || '',
          oneActionStep,
          confidenceNote:
            item.confidenceNote ||
            item.ConfidenceNote ||
            item.confidence ||
            item.note ||
            defaultConfidenceNote(language)
        };
      })
      .filter(Boolean);

    if (mentorReplies.length > 0) {
      return {
        safety: normalizeSafety(raw.safety),
        mentorReplies,
        meta: {
          disclaimer:
            raw?.meta?.disclaimer ||
            raw?.GlobalDisclaimer ||
            raw?.globalDisclaimer ||
            raw?.disclaimer ||
            defaultDisclaimer(language)
        }
      };
    }
  }

  // Shape: { "bill_gates": { mentorId, mentorName, response, ... }, ... }
  // Some providers return a mentorId-keyed object instead of an array.
  // raw is guaranteed non-null by the top-of-function guard.
  const objectValues = Object.values(raw).filter((v) => v && typeof v === 'object' && !Array.isArray(v));
  if (objectValues.length > 0) {
    const mentorReplies = objectValues
      .map((item) => normalizeReply(item))
      .filter(Boolean);

    if (mentorReplies.length > 0) {
      return {
        safety: normalizeSafety(raw.safety),
        mentorReplies,
        meta: {
          disclaimer:
            raw?.meta?.disclaimer ||
            raw?.GlobalDisclaimer ||
            raw?.globalDisclaimer ||
            raw?.disclaimer ||
            defaultDisclaimer(language)
        }
      };
    }
  }

  return null;
}

function buildServerFallbackNormalized({ mentors, language }) {
  const lang = normalizeLanguage(language);
  return {
    safety: {
      riskLevel: 'low',
      needsProfessionalHelp: false,
      emergencyMessage: ''
    },
    mentorReplies: (mentors || []).map((mentor) => ({
      mentorId: mentor.id,
      mentorName: mentor.displayName,
      likelyResponse:
        lang === 'zh-CN'
          ? '我理解你现在不容易。我会先把问题拆成一个最小可执行步骤，先完成第一步，再继续迭代。'
          : 'I understand this is difficult. I would break this into one smallest executable step, complete it first, and iterate.',
      whyThisFits:
        lang === 'zh-CN'
          ? `这条建议基于 ${mentor.displayName} 的公开风格生成。`
          : `This guidance is generated from ${mentor.displayName}'s public style.`,
      oneActionStep: defaultActionStep(lang),
      confidenceNote: defaultConfidenceNote(lang)
    })),
    meta: {
      disclaimer: defaultDisclaimer(lang)
    }
  };
}

function pickReplyForMentor(mentor, normalized) {
  if (!normalized) return null;
  const replies = normalized.mentorReplies;
  if (!Array.isArray(replies)) return null;
  const normalizeKey = (value) => String(value || '').trim().toLowerCase().replace(/\s+/g, '_');
  const mentorIdKey = normalizeKey(mentor.id);
  const mentorNameKey = normalizeKey(mentor.displayName);
  return (
    replies.find((item) => normalizeKey(item.mentorId) === mentorIdKey) ||
    replies.find((item) => normalizeKey(item.mentorName) === mentorNameKey) ||
    replies[0] ||
    null
  );
}

function buildFallbackReplyForMentor(mentor, language) {
  const normalized = buildServerFallbackNormalized({ mentors: [mentor], language });
  return normalized.mentorReplies[0];
}

module.exports = {
  RESPONSE_SCHEMA_VERSION,
  RESPONSE_SCHEMA,
  riskLevelScore,
  mergeSafetyState,
  normalizeLanguage,
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
};
