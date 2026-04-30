#!/usr/bin/env node
/**
 * P31 / F172 — load smoke for /api/mentor-table.
 *
 * Drives concurrent virtual users against a LOCAL server.js instance
 * (no LLM key required — requests exercise the full middleware chain and
 * degrade to the deterministic server-fallback reply). Reports p50/p95/p99
 * latency, error rate, and 429 rate.
 *
 * Usage:
 *   MENTOR_API_PORT=8787 node server.js &   # terminal 1
 *   node scripts/load-smoke.mjs --vus 10 --duration 30   # terminal 2
 *
 * Pass criteria (documented in RUNBOOK.md):
 *   - error rate (non-429 failures) < 1%
 *   - p95 < 500ms on the fallback path
 *   - 429s appear under sustained overload (limiter is doing its job)
 */

const args = process.argv.slice(2);
function argOf(name, fallback) {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? Number(args[i + 1]) || fallback : fallback;
}
const BASE = process.env.LOAD_SMOKE_BASE || 'http://127.0.0.1:8787';
const VUS = argOf('vus', 10);
const DURATION_S = argOf('duration', 30);
const WARMUP_S = argOf('warmup', 3);

const MENTORS = [
  { id: 'elon_musk', displayName: 'Elon Musk' },
  { id: 'marie_curie', displayName: 'Marie Curie' },
  { id: 'ada_lovelace', displayName: 'Ada Lovelace' },
];

const latencies = [];
let errors = 0;
let limited = 0;
let ok = 0;
let stopAt = Date.now() + (DURATION_S + WARMUP_S) * 1000;
const warmupUntil = Date.now() + WARMUP_S * 1000;

async function vu(id) {
  let seq = 0;
  while (Date.now() < stopAt) {
    const started = Date.now();
    try {
      const resp = await fetch(`${BASE}/api/mentor-table`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-forwarded-for': `10.0.0.${id}` },
        body: JSON.stringify({
          problem: `load-smoke vu=${id} seq=${seq++}`,
          language: 'en',
          mentors: MENTORS.slice(0, 1 + (seq % 3)),
        }),
      });
      const elapsed = Date.now() - started;
      if (resp.status === 429) {
        limited += 1;
      } else if (resp.ok) {
        ok += 1;
        if (Date.now() > warmupUntil) latencies.push(elapsed);
      } else {
        errors += 1;
      }
    } catch {
      errors += 1;
    }
    await new Promise((r) => setTimeout(r, 50));
  }
}

function percentile(sorted, p) {
  if (!sorted.length) return 0;
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx];
}

(async () => {
  const health = await fetch(`${BASE}/api/health`).then((r) => r.status).catch(() => 0);
  if (health !== 200) {
    console.error(`server not healthy at ${BASE} (health=${health}). Start it first: node server.js`);
    process.exit(1);
  }

  await Promise.all(Array.from({ length: VUS }, (_, i) => vu(i + 1)));

  const sorted = [...latencies].sort((a, b) => a - b);
  const total = ok + errors + limited;
  const summary = {
    vus: VUS,
    duration_s: DURATION_S,
    requests: total,
    ok,
    rate_limited: limited,
    errors,
    error_rate: total ? Number((errors / total).toFixed(4)) : 0,
    p50_ms: percentile(sorted, 50),
    p95_ms: percentile(sorted, 95),
    p99_ms: percentile(sorted, 99),
    max_ms: sorted.length ? sorted[sorted.length - 1] : 0,
  };
  console.log(JSON.stringify(summary, null, 2));

  const failed =
    summary.error_rate >= 0.01 ||
    (summary.p95_ms > 500 && summary.p95_ms !== 0);
  if (failed) {
    console.error('LOAD SMOKE FAILED (error_rate >= 1% or p95 > 500ms on fallback path)');
    process.exit(1);
  }
  console.log('LOAD SMOKE PASSED');
})();
