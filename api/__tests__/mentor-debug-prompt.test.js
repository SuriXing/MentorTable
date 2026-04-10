/**
 * Tests for api/mentor-debug-prompt.js
 */

const handler = require('../mentor-debug-prompt.js');

function mockReq(overrides = {}) {
  return { method: 'POST', body: {}, query: {}, headers: {}, ...overrides };
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

const sampleMentor = {
  id: 'lisa_su',
  displayName: 'Lisa Su',
  shortLabel: 'Lisa',
  speakingStyle: ['measured', 'data-driven'],
  coreValues: ['execution'],
  decisionPatterns: ['iterate'],
  knownExperienceThemes: ['semiconductors'],
  likelyBlindSpots: ['consumer-marketing'],
  avoidClaims: [],
};

describe('mentor-debug-prompt handler', () => {
  it('rejects non-POST with 405', async () => {
    const res = mockRes();
    await handler(mockReq({ method: 'GET' }), res);
    expect(res._status).toBe(405);
    expect(res._json.error).toMatch(/not allowed/i);
  });

  it('returns 400 when mentor is missing', async () => {
    const res = mockRes();
    await handler(mockReq({ body: {} }), res);
    expect(res._status).toBe(400);
    expect(res._json.error).toMatch(/mentor/i);
  });

  it('returns 400 when mentor is not an object', async () => {
    const res = mockRes();
    await handler(mockReq({ body: { mentor: 'string' } }), res);
    expect(res._status).toBe(400);
  });

  it('returns prompt for valid English request', async () => {
    const res = mockRes();
    await handler(mockReq({ body: { mentor: sampleMentor, language: 'en' } }), res);
    expect(res._status).toBe(200);
    expect(res._json.prompt).toBeTruthy();
    expect(res._json.prompt).toContain('lisa_su');
    expect(res._json.prompt).toContain('Lisa Su');
    // English output rules
    expect(res._json.prompt).toContain('first-person voice');
    expect(res._json.prompt).toContain('concrete next action');
  });

  it('returns Chinese output rules for zh-CN', async () => {
    const res = mockRes();
    await handler(mockReq({ body: { mentor: sampleMentor, language: 'zh-CN' } }), res);
    expect(res._status).toBe(200);
    expect(res._json.prompt).toContain('第一人称');
    expect(res._json.prompt).toContain('具体下一步动作');
  });

  it('defaults to English when language is omitted', async () => {
    const res = mockRes();
    await handler(mockReq({ body: { mentor: sampleMentor } }), res);
    expect(res._status).toBe(200);
    expect(res._json.prompt).toContain('first-person voice');
  });

  it('includes mentor metadata fields', async () => {
    const res = mockRes();
    await handler(mockReq({ body: { mentor: sampleMentor } }), res);
    const prompt = res._json.prompt;
    expect(prompt).toContain('execution');
    expect(prompt).toContain('semiconductors');
    expect(prompt).toContain('measured');
  });

  it('handles mentor with missing optional fields gracefully', async () => {
    const res = mockRes();
    const minimal = { id: 'test', displayName: 'Test Mentor' };
    await handler(mockReq({ body: { mentor: minimal } }), res);
    expect(res._status).toBe(200);
    expect(res._json.prompt).toContain('test');
    expect(res._json.prompt).toContain('Test Mentor');
  });

  it('returns 500 with error message when an exception is thrown', async () => {
    const res = mockRes();
    // Pass a body that causes req.body getter to throw
    const badReq = {
      method: 'POST',
      get body() { throw new Error('body parse failed'); },
    };
    await handler(badReq, res);
    expect(res._status).toBe(500);
    expect(res._json.error).toBe('body parse failed');
  });

  it('returns 500 with "Unknown server error" for non-Error throws', async () => {
    const res = mockRes();
    const badReq = {
      method: 'POST',
      get body() { throw 'string error'; },
    };
    await handler(badReq, res);
    expect(res._status).toBe(500);
    expect(res._json.error).toBe('Unknown server error');
  });

  it('zh-CN: falls back to empty id and "Mentor" label, empty arrays', async () => {
    const res = mockRes();
    // All optional fields missing → exercise `|| ''`, `|| 'Mentor'`, `|| []` falsy branches in zh-CN block
    await handler(mockReq({ body: { mentor: {}, language: 'zh-CN' } }), res);
    expect(res._status).toBe(200);
    expect(res._json.prompt).toContain('MentorId: \n');
    expect(res._json.prompt).toContain('MentorName: Mentor');
    expect(res._json.prompt).toContain('SpeakingStyle: \n');
    expect(res._json.prompt).toContain('CoreValues: \n');
    expect(res._json.prompt).toContain('DecisionPatterns: \n');
    expect(res._json.prompt).toContain('KnownExperienceThemes: \n');
    expect(res._json.prompt).toContain('LikelyBlindSpots: \n');
    expect(res._json.prompt).toContain('AvoidClaims: \n');
    expect(res._json.prompt).toContain('第一人称');
  });

  it('zh-CN: falls back to shortLabel when displayName is missing', async () => {
    const res = mockRes();
    await handler(mockReq({
      body: { mentor: { shortLabel: '短标签' }, language: 'zh-CN' },
    }), res);
    expect(res._status).toBe(200);
    expect(res._json.prompt).toContain('MentorName: 短标签');
  });

  it('en: falls back to empty id and "Mentor" label, empty arrays', async () => {
    const res = mockRes();
    await handler(mockReq({ body: { mentor: {} } }), res);
    expect(res._status).toBe(200);
    expect(res._json.prompt).toContain('MentorId: \n');
    expect(res._json.prompt).toContain('MentorName: Mentor');
    expect(res._json.prompt).toContain('SpeakingStyle: \n');
    expect(res._json.prompt).toContain('CoreValues: \n');
    expect(res._json.prompt).toContain('DecisionPatterns: \n');
    expect(res._json.prompt).toContain('KnownExperienceThemes: \n');
    expect(res._json.prompt).toContain('LikelyBlindSpots: \n');
    expect(res._json.prompt).toContain('AvoidClaims: \n');
  });

  it('en: falls back to shortLabel when displayName is missing', async () => {
    const res = mockRes();
    await handler(mockReq({
      body: { mentor: { shortLabel: 'Short' }, language: 'en' },
    }), res);
    expect(res._status).toBe(200);
    expect(res._json.prompt).toContain('MentorName: Short');
  });

  it('returns 400 when body is null (exercises `req.body || {}` fallback)', async () => {
    const res = mockRes();
    await handler(mockReq({ body: null }), res);
    expect(res._status).toBe(400);
    expect(res._json.error).toMatch(/mentor/i);
  });

  it('normalizes unknown language string to English', async () => {
    // Exercises `if (!ALLOWED_LANGUAGES.has(language)) return 'en'` branch
    const res = mockRes();
    await handler(mockReq({ body: { mentor: sampleMentor, language: 'fr' } }), res);
    expect(res._status).toBe(200);
    // English rules emitted, not Chinese
    expect(res._json.prompt).toContain('first-person voice');
    expect(res._json.prompt).not.toContain('第一人称');
  });

  it('coerces non-string mentor fields to strings via String()', async () => {
    // Exercises the `String(value)` branch in sanitizeField
    const res = mockRes();
    await handler(mockReq({
      body: {
        mentor: {
          id: 12345, // number, not string
          displayName: { toString: () => 'ObjMentor' }, // object with toString
          speakingStyle: [42, true], // non-string array items
        },
      },
    }), res);
    expect(res._status).toBe(200);
    expect(res._json.prompt).toContain('MentorId: 12345');
    expect(res._json.prompt).toContain('MentorName: ObjMentor');
    expect(res._json.prompt).toContain('SpeakingStyle: 42; true');
  });

  it('strips control characters from mentor fields', async () => {
    // Exercises the control-char regex replacement on line 15
    const res = mockRes();
    await handler(mockReq({
      body: {
        mentor: {
          id: 'safe',
          displayName: 'Name\u0001With\u0007Ctrl\nChars',
        },
      },
    }), res);
    expect(res._status).toBe(200);
    // control chars and newline replaced by spaces
    expect(res._json.prompt).toContain('MentorName: Name With Ctrl Chars');
    expect(res._json.prompt).not.toMatch(/Name\u0001/);
  });

  it('truncates mentor fields that exceed max length', async () => {
    // Exercises the `cleaned.length > maxLen` truncation branch
    const res = mockRes();
    const longName = 'x'.repeat(500); // displayName max is 120
    await handler(mockReq({
      body: { mentor: { id: 'id', displayName: longName } },
    }), res);
    expect(res._status).toBe(200);
    // Pull out the MentorName line and check length
    const line = res._json.prompt
      .split('\n')
      .find((l) => l.startsWith('MentorName: '));
    expect(line).toBeTruthy();
    const nameValue = line.replace('MentorName: ', '');
    expect(nameValue.length).toBe(120);
    expect(nameValue).toBe('x'.repeat(120));
  });
});
