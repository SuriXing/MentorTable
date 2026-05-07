#!/usr/bin/env node
/**
 * P31 / F172 — load smoke for /api/mentor-table.
 * P39 — added --sweep: a VU staircase that measures the shed curve.
 *
 * Drives concurrent virtual users against a LOCAL server.js instance
 * (no LLM key required — requests exercise the full middleware chain and
 * degrade to the deterministic server-fallback reply). Reports p50/p95/p99
 * latency, error rate, and 429 rate.
 *
 * Usage:
 *   MENTOR_API_PORT=8787 node server.js &   # terminal 1
 *   node scripts/load-smoke.mjs --vus 10 --duration 30   # terminal 2
 *   node scripts/load-smoke.mjs --sweep                  # VU staircase
 *   node scripts/load-smoke.mjs --sweep --levels 1,4,16,64 --burst 8
 *
 * Pass criteria (documented in RUNBOOK.md):
 *   - error rate (non-429 failures) < 1%
 *   - p95 < 500ms on the fallback path
 *   - 429s appear under sustained overload (limiter is doing its job)
 *
 * Sweep semantics (RUNBOOK "shed curve"): 429s are the DESIGN at every VU
 * count (each VU's 20 rps think-time empties the 20-token burst in ~1s
 * against a 0.3/s refill), so the sweep does NOT look for where 429s start.
 * It measures, per level: shed %, error rate, and latency percentiles —
 * the practical boundary is the highest level where admitted traffic still
 * flows with 0 errors and flat p95. Each level uses its own x-forwarded-for
 * subnet (10.<level>.0.<vu>) so per-IP buckets never carry state between
 * levels. Exit code 1 only if any level produces non-429 errors.
 *
 * Breaker interaction: admitted requests fan out to the upstream and each
 * fan-out call counts against the F19 rolling LLM_HOURLY_BUDGET (default
 * 1000 per instance). A full sweep spends that in the first few levels, so
 * start the sweep target with a raised budget — the in-memory counter is
 * fresh per process, so a restart alone resets it:
 *   LLM_HOURLY_BUDGET=1000000 node server.js
 * The sweep classifies budget-503s separately and stops at the level where
 * the breaker opens (higher levels would measure the breaker, not the curve).
 */

const args = process.argv.slice(2);
function argOf(name, fallback) {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? (args[i + 1] !== undefined ? args[i + 1] : fallback) : fallback;
}
function flagOn(name) {
  return args.includes(`--${name}`);
}
const BASE = process.env.LOAD_SMOKE_BASE || 'http://127.0.0.1:8787';

const MENTORS = [
  { id: 'elon_musk', displayName: 'Elon Musk' },
  { id: 'marie_curie', displayName: 'Marie Curie' },
  { id: 'ada_lovelace', displayName: 'Ada Lovelace' },
];

function percentile(sorted, p) {
  if (!sorted.length) return 0;
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx];
}

async function runBurst({ vus, durationS, warmupS = 0, ipPrefix = '10.0.0', thinkMs = 50 }) {
  const latencies = [];
  let errors = 0;
  let limited = 0;
  let ok = 0;
  let breaker = 0;
  const stopAt = Date.now() + durationS * 1000;
  const warmupUntil = Date.now() + warmupS * 1000;

  async function vu(id) {
    let seq = 0;
    while (Date.now() < stopAt) {
      const started = Date.now();
      try {
        const resp = await fetch(`${BASE}/api/mentor-table`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-forwarded-for': `${ipPrefix}.${id}` },
          body: JSON.stringify({
            problem: `load-smoke ip=${ipPrefix} vu=${id} seq=${seq++}`,
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
        } else if (resp.status === 503 && (await resp.text()).includes('hourly budget')) {
          // F19 breaker open (LLM_HOURLY_BUDGET exhausted): not a service
          // failure, but it invalidates every remaining level.
          breaker += 1;
        } else {
          errors += 1;
        }
      } catch {
        errors += 1;
      }
      await new Promise((r) => setTimeout(r, thinkMs));
    }
  }

  await Promise.all(Array.from({ length: vus }, (_, i) => vu(i + 1)));

  const sorted = [...latencies].sort((a, b) => a - b);
  const total = ok + errors + limited;
  return {
    vus,
    duration_s: durationS,
    requests: total,
    ok,
    rate_limited: limited,
    errors,
    breaker_open: breaker,
    error_rate: total ? Number((errors / total).toFixed(4)) : 0,
    p50_ms: percentile(sorted, 50),
    p95_ms: percentile(sorted, 95),
    p99_ms: percentile(sorted, 99),
    max_ms: sorted.length ? sorted[sorted.length - 1] : 0,
  };
}

async function assertServerUp() {
  const health = await fetch(`${BASE}/api/health`).then((r) => r.status).catch(() => 0);
  if (health !== 200) {
    console.error(`server not healthy at ${BASE} (health=${health}). Start it first: node server.js`);
    process.exit(1);
  }
}

async function runSingle() {
  const VUS = Number(argOf('vus', 10));
  const DURATION_S = Number(argOf('duration', 30));
  const WARMUP_S = Number(argOf('warmup', 3));

  const summary = await runBurst({ vus: VUS, durationS: DURATION_S, warmupS: WARMUP_S });
  console.log(JSON.stringify(summary, null, 2));

  const failed =
    summary.error_rate >= 0.01 ||
    (summary.p95_ms > 500 && summary.p95_ms !== 0);
  if (failed) {
    console.error('LOAD SMOKE FAILED (error_rate >= 1% or p95 > 500ms on fallback path)');
    process.exit(1);
  }
  console.log('LOAD SMOKE PASSED');
}

async function runSweep() {
  const levels = String(argOf('levels', '1,2,5,10,20,40'))
    .split(',')
    .map((n) => Number(n.trim()))
    .filter((n) => n > 0);
  const BURST_S = Number(argOf('burst', 6));
  // Capacity/refill mirror api/mentor-table.js's memory-bucket config so the
  // arithmetic column can be checked against the server's actual knobs.
  const CAPACITY = 20;
  const REFILL_PER_S = 0.3;
  const expectedPerVu = CAPACITY + REFILL_PER_S * BURST_S;

  console.log(`shed-curve sweep: levels=[${levels.join(',')}] burst=${BURST_S}s think=50ms`);
  console.log(`limiter: capacity=${CAPACITY} refill=${REFILL_PER_S}/s -> expected admitted/VU ~= ${expectedPerVu.toFixed(1)}\n`);
  console.log(
    'VU'.padStart(4),
    'attempts'.padStart(9),
    'admitted'.padStart(9),
    'shed%'.padStart(7),
    'err%'.padStart(6),
    'p50'.padStart(5),
    'p95'.padStart(5),
    'p99'.padStart(5),
    '  status'
  );

  let anyErrors = false;
  let highestHealthy = 0;
  const admittedPerVu = [];

  for (const level of levels) {
    // 10.<level>.0.<vu> — fresh per-IP buckets per level (see header comment).
    const summary = await runBurst({
      vus: level,
      durationS: BURST_S,
      ipPrefix: `10.${level}.0`,
    });
    const shedPct = summary.requests ? ((summary.rate_limited / summary.requests) * 100).toFixed(1) : '0.0';
    const errPct = (summary.error_rate * 100).toFixed(2);
    const healthy = summary.error_rate < 0.01 && summary.p95_ms <= 500;
    if (healthy && level > highestHealthy) highestHealthy = level;
    if (summary.errors > 0) anyErrors = true;
    if (summary.ok) admittedPerVu.push(summary.ok / level);
    console.log(
      String(level).padStart(4),
      String(summary.requests).padStart(9),
      String(summary.ok).padStart(9),
      `${shedPct}%`.padStart(7),
      `${errPct}%`.padStart(6),
      String(summary.p50_ms).padStart(5),
      String(summary.p95_ms).padStart(5),
      String(summary.p99_ms).padStart(5),
      healthy ? 'HEALTHY' : 'DEGRADED'
    );
    if (summary.breaker_open > 0) {
      console.error(`\nF19 breaker opened at ${level} VUs (${summary.breaker_open} budget-503s) — the rolling LLM_HOURLY_BUDGET is spent.`);
      console.error('Restart the server with a raised budget for a full sweep, e.g.:');
      console.error('  LLM_HOURLY_BUDGET=1000000 node server.js   # sweep rigs only');
      console.error('Levels above this point measure the breaker, not the shed curve — stopping.');
      process.exit(1);
    }
  }

  const minPerVu = admittedPerVu.length ? Math.min(...admittedPerVu) : 0;
  const maxPerVu = admittedPerVu.length ? Math.max(...admittedPerVu) : 0;
  console.log(`\nlimiter arithmetic: admitted/VU measured ${minPerVu.toFixed(1)}-${maxPerVu.toFixed(1)} vs expected ~${expectedPerVu.toFixed(1)}`);
  console.log(`practical boundary: HEALTHY up to ${highestHealthy} VUs (0 non-429 errors, p95 <= 500ms)`);
  if (anyErrors) {
    console.error('SWEEP FAILED: non-429 errors present — investigate before trusting the curve');
    process.exit(1);
  }
  console.log('SHED SWEEP PASSED');
}

(async () => {
  await assertServerUp();
  if (flagOn('sweep')) {
    await runSweep();
  } else {
    await runSingle();
  }
})();
