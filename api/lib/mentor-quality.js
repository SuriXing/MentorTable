'use strict';

const NEAR_DUPLICATE_THRESHOLD = 0.72;

const ENGLISH_STOP_WORDS = new Set([
  'a', 'an', 'and', 'as', 'at', 'be', 'by', 'for', 'from', 'i', 'in',
  'is', 'it', 'of', 'on', 'or', 'that', 'the', 'this', 'to', 'with',
  'would', 'you', 'your',
]);

function englishTokens(text) {
  return (String(text || '').normalize('NFKC').toLowerCase().match(/[a-z0-9]+/g) || [])
    .filter((token) => token.length > 1 && !ENGLISH_STOP_WORDS.has(token));
}

function chineseTokens(text) {
  const normalized = String(text || '').normalize('NFKC').toLowerCase();
  const tokens = englishTokens(normalized);
  const sequences = normalized.match(/[\u3400-\u9fff]+/g) || [];
  for (const sequence of sequences) {
    if (sequence.length === 1) {
      tokens.push(sequence);
      continue;
    }
    for (let index = 0; index < sequence.length - 1; index += 1) {
      tokens.push(sequence.slice(index, index + 2));
    }
  }
  return tokens;
}

function tokenSet(text, language) {
  return new Set(language === 'zh-CN' ? chineseTokens(text) : englishTokens(text));
}

function jaccardSimilarity(left, right) {
  if (left.size === 0 || right.size === 0) return 0;
  let intersection = 0;
  for (const token of left) {
    if (right.has(token)) intersection += 1;
  }
  const union = left.size + right.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

function hasMeasurableAction(action, language) {
  const value = String(action || '').normalize('NFKC').toLowerCase();
  if (!value.trim()) return false;
  if (language === 'zh-CN') {
    return /(?:\d+|[一二三四五六七八九十两]+)(?:个|次|项|步|分钟|小时|天|周)|今天|明天|本周|截至|之前|以内|内完成/u.test(value);
  }
  return /\b(?:\d+|one|two|three|four|five|six|seven|eight|nine|ten)\b|\b(?:today|tomorrow|minute|hour|day|week|before|within|deadline)\b|\bby\s+\w+/i.test(value);
}

function assessMentorReplyQuality(replies, language) {
  const safeReplies = Array.isArray(replies) ? replies : [];
  const normalized = safeReplies.map((reply, index) => ({
    mentorId: String(reply && reply.mentorId ? reply.mentorId : `mentor_${index + 1}`),
    tokens: tokenSet(
      `${reply && reply.likelyResponse ? reply.likelyResponse : ''} ${reply && reply.oneActionStep ? reply.oneActionStep : ''}`,
      language
    ),
    measurableAction: hasMeasurableAction(reply && reply.oneActionStep, language),
  }));

  let maxSimilarity = 0;
  let maxSimilarityMentorIds = [];
  const nearDuplicatePairs = [];

  for (let left = 0; left < normalized.length; left += 1) {
    for (let right = left + 1; right < normalized.length; right += 1) {
      const similarity = jaccardSimilarity(normalized[left].tokens, normalized[right].tokens);
      const rounded = Number(similarity.toFixed(3));
      if (similarity > maxSimilarity) {
        maxSimilarity = similarity;
        maxSimilarityMentorIds = [normalized[left].mentorId, normalized[right].mentorId];
      }
      if (similarity >= NEAR_DUPLICATE_THRESHOLD) {
        nearDuplicatePairs.push({
          mentorIds: [normalized[left].mentorId, normalized[right].mentorId],
          similarity: rounded,
        });
      }
    }
  }

  return {
    mentorCount: normalized.length,
    maxSimilarity: Number(maxSimilarity.toFixed(3)),
    maxSimilarityMentorIds,
    nearDuplicatePairs,
    weakActionMentorIds: normalized
      .filter((reply) => !reply.measurableAction)
      .map((reply) => reply.mentorId),
  };
}

module.exports = {
  NEAR_DUPLICATE_THRESHOLD,
  hasMeasurableAction,
  assessMentorReplyQuality,
};
