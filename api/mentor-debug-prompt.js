const {
  applyApiSecurity,
  redactSensitive,
  sanitizeMentorField,
  sanitizeMentorFieldArray,
} = require('../lib/security.js');

const ALLOWED_LANGUAGES = new Set(['zh-CN', 'en']);

function normalizeLanguage(language) {
  if (typeof language !== 'string') return 'en';
  if (!ALLOWED_LANGUAGES.has(language)) return 'en';
  return language;
}

// R3 C-1 fix: this handler used to ship a local sanitizeField/sanitizeArray
// pair that only stripped C0+DEL — missing the C1, bidi (U+202A-U+202E,
// U+2066-U+2069), zero-width (U+200B-U+200D, U+2060, U+FEFF), and LS/PS
// (U+2028-U+2029) coverage that lib/security.js gained in R2 BYPASS-3.
// The handler now imports the shared helper so all three handlers
// (mentor-table.js, mentor-image.js, mentor-debug-prompt.js) share one
// sanitizer and the next BYPASS-3-style finding is fixed once, not three
// times.
const sanitizeField = (value, maxLen = 300) => sanitizeMentorField(value, maxLen);
const sanitizeArray = (arr, perItemMax = 200, maxItems = 12) =>
  sanitizeMentorFieldArray(arr, perItemMax, maxItems);

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
    // NEW-4: share the redactor from lib/security.js so this handler inherits
    // the BYPASS-1 fix (broader secret coverage, no UUID over-redaction).
    let message = 'Unknown server error';
    if (error instanceof Error && error.message) {
      message = redactSensitive(error.message);
    }
    res.status(500).json({ error: message });
  }
};

