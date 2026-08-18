/**
 * The dashboard's allocation page.
 *
 * ALLOCATION.md withheld this surface until the viewer question was answered.
 * The answer this page implements is "the budget owner, with the auditor served
 * on the same page", and these tests pin the three properties that answer is
 * made of:
 *
 *   - it serves RECORDED runs and never computes one, so the page and
 *     `fiscus alloc run --apply` can never disagree;
 *   - a derived allocation never leaks back into metered spend, budgets, or RoI;
 *   - the page states whether the residual under its figures has been examined,
 *     because an allocated estimate presented as settled cost is the one failure
 *     this layer must not have.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import http from 'node:http';
import { Store, type RequestRow } from '../src/store/db.ts';
import { DEFAULT_CONFIG } from '../src/config.ts';
import { createDashboardServer } from '../src/dashboard/server.ts';
import type { AllocationRunResult } from '../src/alloc/apply.ts';
import type { AllocationRule, CostCentre } from '../src/alloc/rules.ts';

const HTML = join(import.meta.dirname, '..', 'src', 'dashboard', 'web', 'classic.html');
const DAY = 24 * 60 * 60 * 1000;
const T0 = Date.UTC(2026, 6, 1);
const T1 = T0 + 5 * DAY;

interface AllocationPayload {
  demo: boolean;
  kind: string;
  trust: string;
  basis: string;
  excludedFrom: string[];
  costCentres: CostCentre[];
  rules: AllocationRule[];
  runs: Array<{ allocationRunId: string; computedAtMs: number; result: AllocationRunResult }>;
  reconciliation: { everRun: boolean; latestComputedAtMs: number | null };
}

let seq = 0;
function request(costUsd: number, over: Partial<RequestRow> = {}): RequestRow {
  return {
    requestId: `alloc-dash-${seq++}`, sessionId: null, tsEpochMs: T0 + DAY, provider: 'openai', model: 'gpt-4o',
    project: 'backend-api', taskWeight: 1, inputTokens: 10, outputTokens: 10, cacheWriteTokens: 0, cacheReadTokens: 0,
    reasoningTokens: 0, costUsd, estimated: false, streamed: false, statusCode: 200, durationMs: 1,
    ...over,
  };
}

function boot(store: Store): Promise<{ base: string; close: () => Promise<void> }> {
  const server = createDashboardServer({ store, config: structuredClone(DEFAULT_CONFIG), version: 'test' });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as AddressInfo).port;
      resolve({ base: `http://127.0.0.1:${port}`, close: () => new Promise((r) => server.close(() => r())) });
    });
  });
}

function rawRequest(base: string, path: string, method: string, host: string): Promise<{ status: number; allow: string | undefined; text: string }> {
  const url = new URL(path, base);
  return new Promise((resolve, reject) => {
    const req = http.request(url, { method, headers: { host } }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => resolve({
        status: res.statusCode ?? 0,
        allow: typeof res.headers.allow === 'string' ? res.headers.allow : undefined,
        text: Buffer.concat(chunks).toString('utf8'),
      }));
    });
    req.on('error', reject);
    req.end();
  });
}

/** A store with two centres, one direct rule, and spend that only partly matches. */
function seeded(): Store {
  const store = new Store(':memory:');
  store.upsertCostCentre({ costCentreId: 'eng', name: 'Engineering', owner: 'cto', createdAtMs: T0 });
  store.upsertCostCentre({ costCentreId: 'platform', name: 'Platform', createdAtMs: T0 });
  store.saveAllocationRule({
    ruleId: 'backend', method: 'direct', match: { project: 'backend-api' },
    targets: [{ costCentreId: 'eng', ratio: 1 }], priority: 10,
    effectiveFromMs: 0, effectiveToMs: null, revokedAtMs: null, owner: null, note: null, createdAtMs: T0,
  });
  store.insertRequest(request(4, {
    pricing: {
      costBasis: 'local_list_price', rateCardSha256: 'a'.repeat(64), rateCardSourceKind: 'bundled',
      rateMatchKind: 'exact_provider', rateMatchProvider: 'openai', rateMatchModel: 'gpt-4o',
    },
  }));
  // Claimed by no rule: the unallocated position the page must show at full weight.
  store.insertRequest(request(1, { project: 'default', tsEpochMs: T0 + 2 * DAY }));
  return store;
}

test('GET /api/allocation: an unconfigured store reports no runs and an unexamined residual', async () => {
  const store = new Store(':memory:');
  const srv = await boot(store);
  try {
    const res = await fetch(`${srv.base}/api/allocation`);
    assert.equal(res.status, 200);
    const body = await res.json() as AllocationPayload;
    assert.equal(body.kind, 'derived_cost_allocation');
    assert.equal(body.trust, 'derived_allocation_of_local_estimates');
    assert.equal(body.basis, 'showback_only', 'showback, never chargeback');
    assert.deepEqual(body.excludedFrom, [
      'request_metered_spend', 'budget_enforcement', 'roi', 'model_recommendations',
    ]);
    assert.deepEqual(body.costCentres, []);
    assert.deepEqual(body.rules, []);
    assert.deepEqual(body.runs, []);
    assert.equal(body.reconciliation.everRun, false);
    assert.equal(body.reconciliation.latestComputedAtMs, null);
  } finally {
    await srv.close();
    store.close();
  }
});

test('GET /api/allocation serves a recorded run with its rule versions and cost basis intact', async () => {
  const store = seeded();
  const result = store.allocatePeriod(T0, T1);
  const runId = store.saveAllocationRun(result, 9_000);
  const srv = await boot(store);
  try {
    const res = await fetch(`${srv.base}/api/allocation`);
    const body = await res.json() as AllocationPayload;
    assert.equal(body.runs.length, 1);
    assert.equal(body.runs[0]!.allocationRunId, runId);
    assert.equal(body.runs[0]!.computedAtMs, 9_000);

    const run = body.runs[0]!.result;
    assert.equal(run.conserves, true);
    assert.equal(run.trust, 'derived_allocation_of_local_estimates');
    assert.equal(run.totalMicros, 5_000_000);
    assert.equal(run.allocatedMicros, 4_000_000);
    assert.equal(run.unallocatedMicros, 1_000_000);
    assert.equal(run.allocatedMicros + run.unallocatedMicros, run.totalMicros);

    // The auditor's question is answered on the same payload as the owner's:
    // every line names the rule VERSION that placed it and the basis it rests on.
    assert.equal(run.lines.length, 1);
    assert.equal(run.lines[0]!.costCentreId, 'eng');
    assert.equal(run.lines[0]!.ruleId, 'backend');
    assert.equal(run.lines[0]!.ruleVersion, 1);
    assert.equal(run.lines[0]!.sourceBasis, 'local_list_price');

    // Unallocated keeps its reason and its largest labels, so it is actionable
    // rather than a number the page invites someone to sweep away.
    assert.equal(run.unallocated.length, 1);
    assert.equal(run.unallocated[0]!.reason, 'no_matching_rule');
    assert.deepEqual(run.unallocated[0]!.topProjects, [{ project: 'default', micros: 1_000_000 }]);
    // A row with no captured pricing evidence stays `legacy_unknown` rather than
    // borrowing the basis of the row next to it. Unknown stays unknown.
    assert.equal(run.unallocated[0]!.sourceBasis, 'legacy_unknown');
    assert.deepEqual(run.sourceBases, ['legacy_unknown', 'local_list_price']);

    // Centres and rules are served live, because they are configuration rather
    // than derived money — the page needs them to name a centre.
    assert.deepEqual(body.costCentres.map((c) => c.costCentreId), ['eng', 'platform']);
    assert.equal(body.rules.length, 1);
    assert.equal(body.rules[0]!.version, 1);
  } finally {
    await srv.close();
    store.close();
  }
});

test('GET /api/allocation reads recorded runs and never recomputes one', async () => {
  const store = seeded();
  store.saveAllocationRun(store.allocatePeriod(T0, T1), 9_000);
  // Spend that lands INSIDE the already-recorded period. A page that recomputed
  // on load would silently restate the run; the recorded statement must not move.
  store.insertRequest(request(50, { requestId: 'late-arrival', tsEpochMs: T0 + 3 * DAY }));
  const srv = await boot(store);
  try {
    const body = await (await fetch(`${srv.base}/api/allocation`)).json() as AllocationPayload;
    assert.equal(body.runs.length, 1, 'reading the page does not record a run');
    assert.equal(body.runs[0]!.result.totalMicros, 5_000_000, 'the recorded total is what it was when recorded');
    assert.equal(body.runs[0]!.result.allocatedMicros, 4_000_000);

    // Re-running is an explicit act, and it APPENDS rather than edits.
    const second = store.saveAllocationRun(store.allocatePeriod(T0, T1), 10_000);
    const after = await (await fetch(`${srv.base}/api/allocation`)).json() as AllocationPayload;
    assert.equal(after.runs.length, 2, 'a restatement is a second record, never an edit');
    assert.equal(after.runs[0]!.allocationRunId, second, 'newest first');
    assert.equal(after.runs[0]!.result.totalMicros, 55_000_000);
    assert.equal(after.runs[0]!.result.allocatedMicros, 54_000_000);
    assert.equal(after.runs[1]!.result.totalMicros, 5_000_000, 'the earlier run is unchanged');
  } finally {
    await srv.close();
    store.close();
  }
});

test('a version superseded at epoch 0 is reported as superseded, not as in force', async () => {
  const store = seeded();
  // The default effective date for a first rule is the epoch, so superseding it
  // closes v1 AT 0 — a value a truthiness check reads as "never closed".
  store.saveAllocationRule({
    ruleId: 'backend', method: 'direct', match: { project: 'backend-api' },
    targets: [{ costCentreId: 'platform', ratio: 1 }], priority: 10,
    effectiveFromMs: 0, effectiveToMs: null, revokedAtMs: null, owner: null, note: null, createdAtMs: T0 + DAY,
  });
  const srv = await boot(store);
  try {
    const body = await (await fetch(`${srv.base}/api/allocation`)).json() as AllocationPayload;
    const v1 = body.rules.find((r) => r.ruleId === 'backend' && r.version === 1)!;
    const v2 = body.rules.find((r) => r.ruleId === 'backend' && r.version === 2)!;
    assert.equal(v1.effectiveToMs, 0, 'v1 is closed at the epoch, and 0 is falsy');
    assert.equal(v2.effectiveToMs, null);

    // Both surfaces must decide "superseded" on null, never on truthiness.
    const html = readFileSync(HTML, 'utf8');
    assert.match(html, /r\.effectiveToMs != null \? '<span style="color:var\(--faint\)">superseded/);
    const cli = readFileSync(join(import.meta.dirname, '..', 'src', 'cli', 'allocCmd.ts'), 'utf8');
    assert.match(cli, /r\.effectiveToMs != null\s*\?\s*color\(tty, C\.gray, ' \[superseded\]'\)/);
  } finally {
    await srv.close();
    store.close();
  }
});

test('a recorded allocation never reaches metered spend, budgets, or RoI', async () => {
  const store = seeded();
  store.saveAllocationRun(store.allocatePeriod(T0, T1), 9_000);
  const srv = await boot(store);
  try {
    const overview = await (await fetch(`${srv.base}/api/overview?range=all`)).json() as {
      summary: { costUsd: number; requests: number };
      budget: { todaySpendUsd: number };
    };
    assert.equal(overview.summary.costUsd, 5, 'allocation is derived from the ledger, never added to it');
    assert.equal(overview.summary.requests, 2);
    assert.equal(overview.budget.todaySpendUsd, 0, 'a 2026-07 allocation cannot enter today budget enforcement');
    assert.equal('allocation' in overview, false, 'the overview payload gains no allocation section');

    const value = await (await fetch(`${srv.base}/api/value`)).json() as { allocation: unknown; projectAllocation: unknown };
    assert.equal(value.allocation, null, 'RoI never consumes an allocated amount');
    assert.equal(value.projectAllocation, null);
  } finally {
    await srv.close();
    store.close();
  }
});

test('/api/allocation is read-only and keeps the dashboard loopback host protection', async () => {
  const store = new Store(':memory:');
  const srv = await boot(store);
  try {
    const post = await rawRequest(srv.base, '/api/allocation', 'POST', '127.0.0.1');
    assert.equal(post.status, 405);
    assert.equal(post.allow, 'GET');

    const rebound = await rawRequest(srv.base, '/api/allocation', 'GET', 'untrusted.example');
    assert.equal(rebound.status, 403);
    assert.equal(rebound.text, 'forbidden');
  } finally {
    await srv.close();
    store.close();
  }
});

test('demo mode seeds no cost centre, rule, or allocation run', async () => {
  const previousDemo = process.env.AEGIS_DEMO;
  process.env.AEGIS_DEMO = '1';
  const store = new Store(':memory:');
  const srv = await boot(store);
  try {
    const body = await (await fetch(`${srv.base}/api/allocation`)).json() as AllocationPayload;
    assert.equal(body.demo, true);
    assert.deepEqual(body.costCentres, [], 'demo mode does not invent an organization');
    assert.deepEqual(body.rules, [], 'demo mode does not invent an allocation policy');
    assert.deepEqual(body.runs, []);
  } finally {
    await srv.close();
    store.close();
    if (previousDemo === undefined) delete process.env.AEGIS_DEMO;
    else process.env.AEGIS_DEMO = previousDemo;
  }
});

test('the allocation view is wired, disclosed, and never offers a chargeback', () => {
  const html = readFileSync(HTML, 'utf8');
  assert.match(html, /data-view="allocation"/);
  assert.match(html, /id="view-allocation"/);
  assert.match(html, /fetch\('\/api\/allocation'\)/);

  // The disclosure that makes an allocated estimate safe to show a budget owner.
  assert.match(html, /RESIDUAL UNEXAMINED/);
  assert.match(html, /No provider reconciliation has been recorded/);
  assert.match(html, /SHOWBACK · DERIVED FROM LOCAL ESTIMATES/);

  // The two gaps must stay distinguishable on the page, not just in the docs.
  assert.match(html, /instrumentation/i);
  assert.match(html, /Unallocated/);

  // A proportional pool splits across every directly-allocated centre, so the
  // placeholder centre its rule had to name is not where the money went. The
  // page must not echo that id back into a Targets column — that is precisely
  // the "number the author believes and the engine discards" the rule layer
  // refuses for ratios.
  assert.match(html, /every directly-allocated centre/);

  // A chargeback implies a settlement process this product does not have. The
  // page may say the word only to disclaim it — never to describe what it does.
  // (The Overview attribution tooltip already carries one such disclaimer, so
  // this guards the whole dashboard, not only the new view.)
  const disclaimers = /no chargeback export exists|becomes a chargeback|not chargeback-grade/;
  for (const m of html.matchAll(/chargeback/gi)) {
    const around = html.slice(Math.max(0, m.index! - 240), m.index! + 240);
    assert.match(around, disclaimers, 'chargeback may only appear as an explicit non-offer');
  }
});
