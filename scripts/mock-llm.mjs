#!/usr/bin/env node
// P31: minimal OpenAI-compatible mock for load-smoke runs. Returns a valid
// mentor_table.v1 completion for any chat-completions request.
import http from 'node:http';

const port = Number(process.env.MOCK_LLM_PORT || 8790);
const replies = {
  elon_musk: ['Strip the problem to first principles and ship the smallest version this week.', 'Cut scope until the core loop works end to end.'],
  marie_curie: ['Measure one variable at a time and keep a dated log of results.', 'Isolate the unknown before theorizing.'],
  ada_lovelace: ['Write the algorithm down before touching a keyboard.', 'Trace the loop by hand once.'],
};

const mockServer = http.createServer((req, res) => {
  // Under a sweep, the fetch client can abort a keep-alive socket between
  // requests; without handlers an 'error' event here kills the process
  // (unhandled 'error' event) and every later admitted request 502s.
  req.on('error', () => {});
  res.on('error', () => {});
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    let mentorId = 'elon_musk';
    try {
      const text = JSON.parse(body).messages?.find((m) => m.role === 'user')?.content || '';
      for (const id of Object.keys(replies)) {
        if (text.includes(id)) { mentorId = id; break; }
      }
    } catch { /* default mentor */ }
    const pool = replies[mentorId];
    const payload = {
      schemaVersion: 'mentor_table.v1',
      language: 'en',
      safety: { riskLevel: 'none', needsProfessionalHelp: false, emergencyMessage: '' },
      mentorReplies: [{
        mentorId,
        mentorName: mentorId.replace(/_/g, ' '),
        likelyResponse: pool[Math.floor(Math.random() * pool.length)],
        whyThisFits: 'Mock-generated for load smoke.',
        oneActionStep: 'Do the smallest next thing.',
        confidenceNote: 'Load-smoke mock.',
      }],
      meta: { model: 'mock', baseUrl: 'mock' },
    };
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(payload) } }] }));
  });
}).listen(port, '127.0.0.1', () => console.log(`mock LLM on :${port}`));

// Same for transport-level client errors (malformed request line, TLS to an
// HTTP port, aborted upgrades) — log-and-continue, never crash the mock.
mockServer.on('clientError', (err, socket) => {
  if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
});
