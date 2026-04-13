const { applyApiSecurity } = require('../lib/security.js');

const ALLOWED_LANGUAGES = new Set(['zh-CN', 'en']);

function normalizeLanguage(language) {
  if (typeof language !== 'string') return 'en';
  if (!ALLOWED_LANGUAGES.has(language)) return 'en';
  return language;
}

// Cap per-field length and strip control chars so a 10MB speakingStyle array
// cannot produce a 10MB response body or smuggle newline-based injection.
function sanitizeField(value, maxLen = 300) {
  if (value === null || value === undefined) return '';
  const str = typeof value === 'string' ? value : String(value);
  // eslint-disable-next-line no-control-regex
  const cleaned = str.replace(/[\u0000-\u0008\u000a-\u001f\u007f]/g, ' ').trim();
  return cleaned.length > maxLen ? cleaned.slice(0, maxLen) : cleaned;
}

function sanitizeArray(arr, perItemMax = 200, maxItems = 12) {
  if (!Array.isArray(arr)) return [];
  return arr
    .slice(0, maxItems)
    .map((item) => sanitizeField(item, perItemMax))
    .filter(Boolean);
}

function buildMentorPromptBlock(mentor, language) {
  const lang = normalizeLanguage(language);
  const id = sanitizeField(mentor && mentor.id, 120);
  const displayName =
    sanitizeField(mentor && mentor.displayName, 120) ||
    sanitizeField(mentor && mentor.shortLabel, 120) ||
    'Mentor';
  const speakingStyle = sanitizeArray(mentor && mentor.speakingStyle).join('; ');
  const coreValues = sanitizeArray(mentor && mentor.coreValues).join('; ');
  const decisionPatterns = sanitizeArray(mentor && mentor.decisionPatterns).join('; ');
  const knownExperienceThemes = sanitizeArray(mentor && mentor.knownExperienceThemes).join('; ');
  const likelyBlindSpots = sanitizeArray(mentor && mentor.likelyBlindSpots).join('; ');
  const avoidClaims = sanitizeArray(mentor && mentor.avoidClaims).join('; ');

  if (lang === 'zh-CN') {
    return [
      `MentorId: ${id}`,
      `MentorName: ${displayName}`,
      `SpeakingStyle: ${speakingStyle}`,
      `CoreValues: ${coreValues}`,
      `DecisionPatterns: ${decisionPatterns}`,
      `KnownExperienceThemes: ${knownExperienceThemes}`,
      `LikelyBlindSpots: ${likelyBlindSpots}`,
      `AvoidClaims: ${avoidClaims}`,
      '',
      'OutputRules:',
      '1) 必须第一人称表达。',
      '2) 不要说“如果我是X/作为X”。',
      '3) 每次回复要有一个具体下一步动作。',
      '4) 不得虚构私密事实或伪造原话。'
    ].join('\n');
  }

  return [
    `MentorId: ${id}`,
    `MentorName: ${displayName}`,
    `SpeakingStyle: ${speakingStyle}`,
    `CoreValues: ${coreValues}`,
    `DecisionPatterns: ${decisionPatterns}`,
    `KnownExperienceThemes: ${knownExperienceThemes}`,
    `LikelyBlindSpots: ${likelyBlindSpots}`,
    `AvoidClaims: ${avoidClaims}`,
    '',
    'OutputRules:',
    '1) Use strict first-person voice.',
    '2) Do not use "if I were X" or "as X".',
    '3) End with one concrete next action.',
    '4) No fabricated private facts or direct quotes.'
  ].join('\n');
}

module.exports = async (req, res) => {
  // Apply shared security middleware: CORS, OPTIONS, body-size cap, rate limit.
  // This runs in BOTH the Vercel prod path (direct api/* routing) and the
  // server.js dev path (Express wrapper) — see lib/security.js header comment.
  if (!applyApiSecurity(req, res, { maxBodyBytes: '64kb' })) return;

  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  try {
    const { mentor, language } = req.body || {};
    if (!mentor || typeof mentor !== 'object') {
      res.status(400).json({ error: 'mentor is required' });
      return;
    }

    const prompt = buildMentorPromptBlock(mentor, language);
    res.status(200).json({ prompt });
  } catch (error) {
    // Log the full error server-side for debugging.
    console.error('[mentor-debug-prompt] error:', error);
    // Never pass raw thrown values to the client (bug #4 from R2B).
    let message = 'Unknown server error';
    if (error instanceof Error && error.message) {
      // Redact anything resembling an API key/token before returning.
      message = error.message
        .replace(/sk-[A-Za-z0-9_\-]{8,}/g, 'sk-[REDACTED]')
        .replace(/Bearer\s+[A-Za-z0-9_\-.=]+/gi, 'Bearer [REDACTED]');
    }
    res.status(500).json({ error: message });
  }
};

