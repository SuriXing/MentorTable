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

function cjkTokens(text) {
  const normalized = String(text || '').normalize('NFKC').toLowerCase();
  // Latin words survive in mixed text (names, years) — same as chineseTokens.
  const tokens = englishTokens(normalized);
  const sequence = [];
  for (const char of normalized) {
    const code = char.codePointAt(0) || 0;
    if (
      (code >= 0x3400 && code <= 0x9fff) || // CJK ideographs
      (code >= 0x3040 && code <= 0x30ff) || // kana
      (code >= 0xac00 && code <= 0xd7af)    // Hangul
    ) {
      sequence.push(char);
    }
  }
  // Bigrams as strings (Array.slice would yield arrays, and Set compares
  // arrays by identity — the bug the zh test caught immediately).
  for (let index = 0; index < sequence.length - 1; index += 1) {
    tokens.push(sequence[index] + sequence[index + 1]);
  }
  return tokens;
}

function tokenSet(text, language) {
  if (language === 'zh-CN' || language === 'ja' || language === 'ko') {
    return new Set(cjkTokens(text));
  }
  return new Set(englishTokens(text));
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
  if (language === 'zh-CN' || language === 'ja' || language === 'ko') {
    return /(?:\d+|[一二三四五六七八九十两]+)(?:个|次|项|步|分钟|小时|天|周)|今天|明天|今日|明日|本周|今週|この週|截至|之前|以内|内完成|오늘|내일|이번\s*주/u.test(value);
  }
  if (language === 'es') {
    return /\b(?:\d+|uno|una|dos|tres|cuatro|cinco|seis|siete|ocho|nueve|diez)\b|\b(?:hoy|mañana|minuto|hora|día|semana|antes|dentro|plazo)\b/i.test(value);
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
