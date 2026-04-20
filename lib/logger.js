/**
 * Structured JSON-line logger for server-side code.
 *
 * U8.1: previously api/*.js emitted ad-hoc console.log/warn/error strings
 * that were hard to grep in Vercel Logs and occasionally leaked PII (user
 * prompts, email-shaped fields, tokens). This logger emits a single JSON
 * line per call of the shape:
 *
 *   { ts, level, event, ...fields }
 *
 * - ts: ISO-8601 UTC timestamp (millisecond precision).
 * - level: 'debug' | 'info' | 'warn' | 'error'. Routed to the matching
 *   console method so existing spyOn(console, ...) test hooks keep working.
 * - event: snake_case machine-readable event name (e.g. `api_request`,
 *   `api_ok`, `api_error`). Grep-friendly.
 * - fields: arbitrary JSON-serializable extra context. Callers MUST pipe
 *   anything that could contain PII (request bodies, user IDs, emails,
 *   headers) through `redactPII` from lib/security.js FIRST — this logger
 *   does not auto-redact, because it has no way to know which fields are
 *   user-controlled vs handler-generated.
 *
 * Error values: pass `errorName` and `errorMessageTruncated` instead of
 * the raw Error — never pass `error` / `stack` / `err` fields because we
 * never want full stack traces to hit logs (they leak file paths and
 * internal structure).
 */

const CONSOLE_BY_LEVEL = {
  debug: 'debug',
  info: 'log',
  warn: 'warn',
  error: 'error',
};

function log(level, event, fields) {
  const method = CONSOLE_BY_LEVEL[level] || 'log';
  const payload = {
    ts: new Date().toISOString(),
    level,
    event,
    ...(fields && typeof fields === 'object' ? fields : {}),
  };
  let line;
  try {
    line = JSON.stringify(payload);
  } catch {
    // Circular / unserializable — drop the fields and log a minimal record
    // rather than throwing out of a logger call.
    line = JSON.stringify({
      ts: payload.ts,
      level: payload.level,
      event: payload.event,
      _logger_error: 'fields_unserializable',
    });
  }
  // eslint-disable-next-line no-console
  console[method](line);
}

/**
 * Truncate an error message to the first N characters. Never pass the
 * full message (may echo user input) or the stack (leaks paths).
 */
function truncateErrorMessage(err, maxLen = 200) {
  if (!err) return '';
  const msg = err instanceof Error ? err.message || '' : String(err);
  return msg.length > maxLen ? msg.slice(0, maxLen) : msg;
}

module.exports = {
  log,
  truncateErrorMessage,
};
