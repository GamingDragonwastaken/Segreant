import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { detectAlerts, computeAlerts, type AlertInputs } from '../src/alerts/detect.ts';
import { buildWebhookPayload, notifyWebhook } from '../src/alerts/notify.ts';
import { Store } from '../src/store/db.ts';
import { DEFAULT_CONFIG, type FiscusConfig } from '../src/config.ts';

function base(over: Partial<AlertInputs> = {}): AlertInputs {
  return {
    todaySpendUsd: 0,
    dailyCapUsd: null,
    dailySoftUsd: null,
    baselineActiveDaySpends: [],
    blocked24h: 0,
    estimatedShare: 0,
    runaway: null,
    realizedValueRate: null,
    ...over,
  };
}

const ids = (inp: AlertInputs) => detectAlerts(inp).map((a) => a.id);

test('alerts: nothing wrong → no alerts', () => {
  assert.deepEqual(detectAlerts(base()), []);
});

test('alerts: hard cap reached is critical; soft cap is a warning (not both)', () => {
  const hard = detectAlerts(base({ todaySpendUsd: 25, dailyCapUsd: 25, dailySoftUsd: 20 }));
  assert.equal(hard[0]!.id, 'budget-exhausted');
  assert.equal(hard[0]!.severity, 'critical');
  assert.ok(!hard.some((a) => a.id === 'budget-soft'), 'hard cap supersedes soft');

  const soft = detectAlerts(base({ todaySpendUsd: 21, dailyCapUsd: 25, dailySoftUsd: 20 }));
  assert.deepEqual(soft.map((a) => a.id), ['budget-soft']);
  assert.equal(soft[0]!.severity, 'warn');
});

test('alerts: spend spike fires when today is >2x the p90 active day', () => {
  const spiked = ids(base({ todaySpendUsd: 10, baselineActiveDaySpends: [1, 2, 2, 3, 2] }));
  assert.ok(spiked.includes('spend-spike'));
  // A normal day does not fire.
  const normal = ids(base({ todaySpendUsd: 3, baselineActiveDaySpends: [1, 2, 2, 3, 2] }));
  assert.ok(!normal.includes('spend-spike'));
  // No baseline → no spike (can't call something a spike with nothing to compare).
  assert.ok(!ids(base({ todaySpendUsd: 10, baselineActiveDaySpends: [] })).includes('spend-spike'));
});

test('alerts: blocked requests surface throttling', () => {
  assert.ok(ids(base({ blocked24h: 4 })).includes('throttled'));
  assert.ok(!ids(base({ blocked24h: 0 })).includes('throttled'));
});

test('alerts: value crater only when instrumented', () => {
  assert.ok(ids(base({ realizedValueRate: 0.2 })).includes('value-crater'));
  assert.ok(!ids(base({ realizedValueRate: 0.8 })).includes('value-crater'));
  assert.ok(!ids(base({ realizedValueRate: null })).includes('value-crater'), 'uninstrumented never alerts');
});

test('alerts: runaway is critical; estimated pricing is info', () => {
  assert.ok(detectAlerts(base({ runaway: { tripped: true, windowCostUsd: 5, windowSec: 60 } }))
    .some((a) => a.id === 'runaway' && a.severity === 'critical'));
  const est = detectAlerts(base({ estimatedShare: 0.5 }));
  assert.ok(est.some((a) => a.id === 'estimated-pricing' && a.severity === 'info'));
  assert.ok(!ids(base({ estimatedShare: 0.1 })).includes('estimated-pricing'), 'below threshold stays quiet');
});

test('alerts: sorted by severity (critical → warn → info)', () => {
  const all = detectAlerts(base({
    todaySpendUsd: 25,
    dailyCapUsd: 25,
    blocked24h: 2,
    estimatedShare: 0.9,
  }));
  const sev = all.map((a) => a.severity);
  assert.deepEqual(sev, [...sev].sort((a, b) => ({ critical: 0, warn: 1, info: 2 })[a] - ({ critical: 0, warn: 1, info: 2 })[b]));
  assert.equal(sev[0], 'critical');
});

test('webhook payload carries ONLY alert metadata — no field that could hold a prompt/code/key', () => {
  const alerts = detectAlerts(base({ todaySpendUsd: 25, dailyCapUsd: 25, blocked24h: 2, estimatedShare: 0.9 }));
  const payload = buildWebhookPayload(alerts, 'warn');
  assert.equal(payload.source, 'fiscus');
  assert.ok(payload.alerts.every((a) => a.severity !== 'info'), 'info filtered at minSeverity warn');
  for (const a of payload.alerts) {
    assert.deepEqual(Object.keys(a).sort(), ['detail', 'id', 'metric', 'severity', 'title']);
  }
});

test('buildWebhookPayload filters below minSeverity', () => {
  const infoOnly = detectAlerts(base({ estimatedShare: 0.9 })); // info-level only
  assert.equal(buildWebhookPayload(infoOnly, 'warn').alerts.length, 0);
  assert.equal(buildWebhookPayload(infoOnly, 'info').alerts.length, 1);
});

test('notifyWebhook POSTs the metadata payload and reports delivery', async () => {
  let received: { source?: string; alerts?: Array<{ id: string }> } | null = null;
  const server = http.createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    received = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    res.writeHead(200);
    res.end('ok');
  });
  server.listen(0);
  await once(server, 'listening');
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  try {
    const alerts = detectAlerts(base({ todaySpendUsd: 25, dailyCapUsd: 25 }));
    const r = await notifyWebhook(`http://127.0.0.1:${port}/hook`, alerts, { minSeverity: 'warn' });
    assert.equal(r.delivered, true);
    assert.equal(r.status, 200);
    assert.ok(r.posted >= 1);
    assert.equal(received!.source, 'fiscus');
    assert.equal(received!.alerts![0]!.id, 'budget-exhausted');
  } finally {
    await new Promise<void>((res) => server.close(() => res()));
  }
});

test('notifyWebhook never throws on an unreachable URL — returns delivered:false', async () => {
  const alerts = detectAlerts(base({ todaySpendUsd: 25, dailyCapUsd: 25 }));
  const r = await notifyWebhook('http://127.0.0.1:1/nope', alerts, { minSeverity: 'warn', timeoutMs: 300 });
  assert.equal(r.delivered, false);
  assert.ok(r.error);
});

test('computeAlerts: reads the store + config end-to-end (soft cap + throttling)', () => {
  const store = new Store(':memory:');
  const now = Date.now();
  // A real metered request today, above the soft cap.
  store.insertRequest({
    requestId: 'r1', sessionId: null, tsEpochMs: now, provider: 'anthropic', model: 'claude-opus-4-8',
    project: 'default', taskWeight: 1, inputTokens: 1000, outputTokens: 100, cacheWriteTokens: 0,
    cacheReadTokens: 0, reasoningTokens: 0, costUsd: 12, estimated: false, streamed: false, statusCode: 200, durationMs: 5,
  });
  // A blocked request (429, zero cost).
  store.insertRequest({
    requestId: 'r2', sessionId: null, tsEpochMs: now, provider: 'anthropic', model: 'claude-opus-4-8',
    project: 'default', taskWeight: 1, inputTokens: 0, outputTokens: 0, cacheWriteTokens: 0,
    cacheReadTokens: 0, reasoningTokens: 0, costUsd: 0, estimated: false, streamed: false, statusCode: 429, durationMs: 0,
  });
  const config: FiscusConfig = { ...DEFAULT_CONFIG, budget: { ...DEFAULT_CONFIG.budget, dailyUsd: 50, dailySoftUsd: 10 } };
  const alerts = computeAlerts(store, config, { now });
  const got = alerts.map((a) => a.id);
  assert.ok(got.includes('budget-soft'), 'soft cap crossed');
  assert.ok(got.includes('throttled'), 'blocked request surfaced');
  store.close();
});
