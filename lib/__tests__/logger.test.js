/**
 * Tests for lib/logger.js
 *
 * Covers:
 *  - `log()` emits a single-line valid JSON payload.
 *  - Envelope shape: ts (ISO-8601), level, event, and merged fields.
 *  - Level routing: debug/info/warn/error → matching console methods.
 *  - Unknown levels fall back to console.log without throwing.
 *  - Circular / unserializable payloads degrade gracefully (no throw,
 *    logger emits a minimal record with `_logger_error`).
 *  - Non-object fields arg is ignored (no crash, no merge).
 *  - `truncateErrorMessage` truncates long messages and tolerates non-Errors.
 *  - PII redaction contract: handlers pipe fields through redactPII BEFORE
 *    logging; this test verifies the full pipeline scrubs email/ip/uid/
 *    user_id/token/authorization/cookie/api_key keys and preserves
 *    non-sensitive fields (name/event/count/…).
 */

const { log, truncateErrorMessage } = require('../logger');
const { redactPII } = require('../security');

/** Capture all console output for the duration of a test. */
function captureConsole() {
  const spies = {
    log: vi.spyOn(console, 'log').mockImplementation(() => {}),
    debug: vi.spyOn(console, 'debug').mockImplementation(() => {}),
    warn: vi.spyOn(console, 'warn').mockImplementation(() => {}),
    error: vi.spyOn(console, 'error').mockImplementation(() => {}),
  };
  return {
    spies,
    restore() {
      Object.values(spies).forEach((s) => s.mockRestore());
    },
  };
}

describe('logger.log', () => {
  let cap;
  beforeEach(() => { cap = captureConsole(); });
  afterEach(() => { cap.restore(); });

  it('emits a single-line valid JSON payload with ts/level/event', () => {
    log('info', 'api_ok', { duration_ms: 42 });
    expect(cap.spies.log).toHaveBeenCalledTimes(1);
    const line = cap.spies.log.mock.calls[0][0];
    // Exactly one line — no embedded newlines.
    expect(typeof line).toBe('string');
    expect(line.includes('\n')).toBe(false);
    const parsed = JSON.parse(line);
    expect(parsed.level).toBe('info');
    expect(parsed.event).toBe('api_ok');
    expect(parsed.duration_ms).toBe(42);
    // ISO-8601 UTC timestamp.
    expect(typeof parsed.ts).toBe('string');
    expect(Number.isNaN(Date.parse(parsed.ts))).toBe(false);
    expect(parsed.ts.endsWith('Z')).toBe(true);
  });

  it('routes each level to the matching console method', () => {
    log('debug', 'd');
    log('info', 'i');
    log('warn', 'w');
    log('error', 'e');
    expect(cap.spies.debug).toHaveBeenCalledTimes(1);
    expect(cap.spies.log).toHaveBeenCalledTimes(1);
    expect(cap.spies.warn).toHaveBeenCalledTimes(1);
    expect(cap.spies.error).toHaveBeenCalledTimes(1);
  });

  it('falls back to console.log for an unknown level without throwing', () => {
    expect(() => log('trace', 'weird', { x: 1 })).not.toThrow();
    expect(cap.spies.log).toHaveBeenCalledTimes(1);
    const parsed = JSON.parse(cap.spies.log.mock.calls[0][0]);
    expect(parsed.level).toBe('trace');
  });

  it('ignores a non-object fields arg', () => {
    log('info', 'x', 'not-an-object');
    const parsed = JSON.parse(cap.spies.log.mock.calls[0][0]);
    expect(parsed.event).toBe('x');
    // No extra keys merged.
    expect(Object.keys(parsed).sort()).toEqual(['event', 'level', 'ts']);
  });

  it('handles circular references gracefully', () => {
    const obj = { a: 1 };
    obj.self = obj;
    expect(() => log('warn', 'circular', obj)).not.toThrow();
    const parsed = JSON.parse(cap.spies.warn.mock.calls[0][0]);
    expect(parsed.level).toBe('warn');
    expect(parsed.event).toBe('circular');
    expect(parsed._logger_error).toBe('fields_unserializable');
  });

  it('preserves non-sensitive fields in the final log line', () => {
    const scrubbed = redactPII({
      event: 'ignored-by-log',
      count: 3,
      name: 'mentor-table',
      nested: { ok: true, latency_ms: 120 },
    });
    log('info', 'api_request', scrubbed);
    const parsed = JSON.parse(cap.spies.log.mock.calls[0][0]);
    expect(parsed.count).toBe(3);
    expect(parsed.name).toBe('mentor-table');
    expect(parsed.nested).toEqual({ ok: true, latency_ms: 120 });
  });

  it('scrubs PII keys (email/ip/uid/user_id/token/authorization/cookie/api_key) via redactPII', () => {
    const raw = {
      email: 'suri@example.com',
      ip: '203.0.113.42',
      uid: 'u_1234',
      user_id: 'u_1234',
      token: 'sk-ant-abcdef',
      authorization: 'Bearer xyz',
      cookie: 'sid=abc',
      api_key: 'LTAIAAAAAAAAAAAAAAAA',
      API_KEY: 'leak',
      safeField: 'keep-me',
      nested: { email: 'nested@x.com', safe: 'ok' },
      arr: [{ token: 'bad' }, 'plain'],
    };
    const scrubbed = redactPII(raw);
    log('info', 'api_request', scrubbed);
    const parsed = JSON.parse(cap.spies.log.mock.calls[0][0]);
    expect(parsed.email).toBe('[redacted]');
    expect(parsed.ip).toBe('[redacted]');
    expect(parsed.uid).toBe('[redacted]');
    expect(parsed.user_id).toBe('[redacted]');
    expect(parsed.token).toBe('[redacted]');
    expect(parsed.authorization).toBe('[redacted]');
    expect(parsed.cookie).toBe('[redacted]');
    expect(parsed.api_key).toBe('[redacted]');
    expect(parsed.API_KEY).toBe('[redacted]');
    expect(parsed.safeField).toBe('keep-me');
    expect(parsed.nested.email).toBe('[redacted]');
    expect(parsed.nested.safe).toBe('ok');
    expect(parsed.arr[0].token).toBe('[redacted]');
    expect(parsed.arr[1]).toBe('plain');
  });

  it('scrubs a realistic req.headers fixture (mixed casing, array Set-Cookie, x-forwarded-for, Bearer)', () => {
    // F62 (U8.1 R2): regression guard for the PII_KEY_RE key list. If a
    // future edit drops `authorization` or `cookie` or fails to cover the
    // IP-leak header family, this test fires.
    const headers = {
      'X-Api-Key': 'sk-live-abcd1234',
      'Set-Cookie': ['sid=abc; Path=/', 'tracking=xyz; HttpOnly'],
      'x-forwarded-for': '203.0.113.42, 10.0.0.1',
      Forwarded: 'for=203.0.113.42;proto=https',
      Authorization: 'Bearer eyJhbGciOiJIUzI1NiJ9.payload.sig',
      Cookie: 'sid=abc; csrf=xyz',
      'X-Real-Ip': '203.0.113.42',
      'User-Agent': 'Mozilla/5.0 (keep this)',
      'content-type': 'application/json',
    };
    const scrubbed = redactPII({ headers });
    log('info', 'req', scrubbed);
    const parsed = JSON.parse(cap.spies.log.mock.calls[0][0]);
    const h = parsed.headers;
    expect(h['X-Api-Key']).toBe('[redacted]');
    expect(h['Set-Cookie']).toBe('[redacted]');
    expect(h['x-forwarded-for']).toBe('[redacted]');
    expect(h.Forwarded).toBe('[redacted]');
    expect(h.Authorization).toBe('[redacted]');
    expect(h.Cookie).toBe('[redacted]');
    expect(h['X-Real-Ip']).toBe('[redacted]');
    // Non-sensitive headers preserved.
    expect(h['User-Agent']).toBe('Mozilla/5.0 (keep this)');
    expect(h['content-type']).toBe('application/json');
  });
});

describe('logger.truncateErrorMessage', () => {
  it('returns "" for falsy input', () => {
    expect(truncateErrorMessage(null)).toBe('');
    expect(truncateErrorMessage(undefined)).toBe('');
    expect(truncateErrorMessage('')).toBe('');
  });

  it('returns the Error.message when it fits', () => {
    expect(truncateErrorMessage(new Error('short'))).toBe('short');
  });

  it('truncates long Error.message to maxLen', () => {
    const long = 'x'.repeat(500);
    const out = truncateErrorMessage(new Error(long), 200);
    expect(out.length).toBe(200);
    expect(out).toBe('x'.repeat(200));
  });

  it('coerces non-Error values to string', () => {
    expect(truncateErrorMessage('plain string', 5)).toBe('plain');
    expect(truncateErrorMessage(12345, 3)).toBe('123');
  });

  it('handles Error with empty message', () => {
    expect(truncateErrorMessage(new Error(''))).toBe('');
  });
});
