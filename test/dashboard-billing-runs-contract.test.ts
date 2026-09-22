/**
 * `/api/billing` sends reconciliation history as the immutable RUN COLLECTION,
 * and the GUI must read it as one.
 *
 * The browser declared `reconciliation?: { runs?: number; latest?: {...} }`.
 * Neither field is on the wire: the server sends
 * `runs: store.reconciliationRuns(10)` — an array of records — and no `latest`
 * at all. Two screens consumed the fiction, and both failed silently rather
 * than loudly:
 *
 *   core/chain.ts    `established: runs > 0`, where `runs` is an array of
 *                    objects. `Number([{…}])` is `NaN`, so the comparison was
 *                    false for one recorded run exactly as it was for none —
 *                    the Billed band of the four-claim spine could never light
 *                    up, however many reconciliations had been recorded.
 *   views/evidence.ts  read `reconciliation.latest`, always undefined, so
 *                    Reconciliation status permanently reported "no check has
 *                    been run on this machine yet".
 *
 * Neither typecheck nor `dashboard-contract.test.ts` caught it. The contract
 * test asserts that every REQUIRED declared field is PRESENT; `reconciliation`
 * and its members are optional, and presence-checking says nothing about a
 * field whose declared type is a number and whose real value is an array. That
 * is the gap this file covers: the shape of the collection itself, asserted
 * against a run that actually exists.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { Store } from '../src/store/db.ts';
import { DEFAULT_CONFIG } from '../src/config.ts';
import { createDashboardServer } from '../src/dashboard/server.ts';
import type { ReconciliationRun } from '../src/billing/reconcile.ts';

const DAY = 24 * 60 * 60 * 1000;

function aRun(periodStartMs: number): ReconciliationRun {
  return {
    status: 'reconciled_with_residual',
    observationRunId: 'obs-1',
    declaredScopeId: 'scope-1',
    providerProjectRef: 'proj_test',
    periodStartMs,
    periodEndMs: periodStartMs + DAY,
    currency: 'USD',
    materialityUsd: 1,
    providerReportedMicros: 15_000_000,
    localCapturedMicros: 13_000_000,
    unexplainedVarianceMicros: 2_000_000,
        coverage: { providerDays: 1, localDays: 1, daysWithBoth: 1, providerOnlyDays: 0, localOnlyDays: 0, materialDays: 1 },
    days: [],
    offPathBound: 'upper_bound_conditional', snapshotStability: 'single_observation',
    unstableDayStartMs: [],
    providerSourceKind: 'operator_supplied_export',
    conditions: ['provider_report_is_operator_supplied_and_unverified'],
    trust: 'scope_conditional_reconciliation',
    excludedFrom: ['request_metered_spend', 'budget_enforcement', 'roi', 'model_recommendations'],
  } as ReconciliationRun;
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

function billing(base: string): Promise<any> {
  return new Promise((resolve, reject) => {
    const req = http.request(new URL('/api/billing', base), { method: 'GET' }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))));
    });
    req.on('error', reject);
    req.end();
  });
}

test('reconciliation history is an array of run records, and there is no `latest` field', async () => {
  const store = new Store(':memory:');
  const srv = await boot(store);
  try {
    const empty = await billing(srv.base);
    assert.ok(Array.isArray(empty.reconciliation.runs), 'runs must be an array, never a count');
    assert.equal(empty.reconciliation.runs.length, 0);
    // Pinning the ABSENCE matters as much: `latest` was consumed by the Evidence
    // view for as long as it has existed, and has never been sent.
    assert.equal('latest' in empty.reconciliation, false, 'no `latest` field is on the wire');
  } finally {
    await srv.close();
    store.close();
  }
});

test('a recorded run appears in the collection with the fields both screens read', async () => {
  const store = new Store(':memory:');
  const now = Date.now();
  store.saveReconciliationRun(aRun(now - DAY), now);
  const srv = await boot(store);
  try {
    const d = await billing(srv.base);
    assert.equal(d.reconciliation.runs.length, 1);

    const [run] = d.reconciliation.runs;
    // chain.ts counts the collection; evidence.ts reads these three off the newest.
    assert.equal(typeof run.reconciliationRunId, 'string');
    assert.equal(typeof run.computedAtMs, 'number');
    assert.equal(run.result.providerSourceKind, 'operator_supplied_export');
    assert.deepEqual(run.result.conditions, ['provider_report_is_operator_supplied_and_unverified']);

    // The defect, stated as arithmetic. Counting the array establishes Billed;
    // comparing the array itself never can, and that is what shipped.
    assert.equal(d.reconciliation.runs.length > 0, true, 'counting the collection establishes Billed');
    assert.equal((d.reconciliation.runs as unknown as number) > 0, false, 'comparing the array coerces through NaN');
  } finally {
    await srv.close();
    store.close();
  }
});

test('newest run is first, so `runs[0]` is the one Evidence should show', async () => {
  const store = new Store(':memory:');
  const now = Date.now();
  store.saveReconciliationRun(aRun(now - 3 * DAY), now - 2 * DAY);
  store.saveReconciliationRun(aRun(now - DAY), now);
  const srv = await boot(store);
  try {
    const d = await billing(srv.base);
    assert.equal(d.reconciliation.runs.length, 2);
    assert.equal(d.reconciliation.runs[0].computedAtMs, now, 'newest first');
    assert.ok(d.reconciliation.runs[0].computedAtMs > d.reconciliation.runs[1].computedAtMs);
  } finally {
    await srv.close();
    store.close();
  }
});
