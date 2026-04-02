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
});
