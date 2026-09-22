/**
 * A reconciliation must know when its own ledger was truncated by retention.
 *
 * THE COUNTEREXAMPLE, MEASURED BEFORE IT WAS WRITTEN DOWN. A provider reported
 * $10.00 over two days. Fiscus had metered $6.00 on each of them, so the
 * residual was -$2.00 and the run said `none_local_estimate_exceeds_provider`:
 * the local rate-card estimate exceeds everything the provider billed on this
 * scope, so no upper bound on off-path spend survives. That is the alarming,
 * honest state, and D-068 exists to make it visible.
 *
 * Then `fiscus prune` deleted the first day's request on the operator's own
 * retention policy. The same reconciliation, over the same period, against the
 * same provider report, now said: residual +$4.00, `upper_bound_conditional`.
 * A deletion RESTORED a bound the evidence refutes, and re-labelled $6.00 of
 * Fiscus's own metered traffic as spend the provider charged for and Fiscus
 * never saw. Nothing anywhere in the run mentioned retention.
 *
 * WHY THE ARITHMETIC DOES THIS. With P the provider total, L what Fiscus
 * metered on the scope, T the true billed cost of on-path traffic and O of
 * off-path traffic: `P = T + O`, `R = P - L = O + (T - L)`, so `O <= R` holds
 * exactly when `L <= T`. Retention does not change P, T or O. It changes what
 * can be COMPUTED for L: the surviving ledger yields `L' = L - D` for some
 * deleted on-path amount `D >= 0` that no surviving row records. So the
 * computed residual is `R' = R + D`.
 *
 * THE RULE THAT FOLLOWS IS ASYMMETRIC, AND THE ASYMMETRY IS THE WHOLE FIX.
 *
 *   A REFUTATION SURVIVES TRUNCATION. `R' < 0` implies `R = R' - D <= R' < 0`,
 *   so a negative residual still establishes `L > T`. Truncation can only HIDE
 *   a refutation, never manufacture one, and refusing to report one because the
 *   ledger was pruned would discard a sound conclusion.
 *
 *   AN UPPER BOUND DOES NOT. `R' >= 0` implies nothing about the sign of R,
 *   because D is unknown. `upper_bound_conditional` is therefore not
 *   established, and reporting it is the absence inference AII-002 names: an
 *   absence produced by deletion read as an absence of events.
 *
 * So the third state is `unknown_local_total_truncated_by_retention`, and it is
 * a refusal to classify rather than a weaker classification.
 *
 * THE THREE STATES OF THE RETENTION RECORD ARE PRESERVED (D-170). A boundary on
 * record with a period starting at or after it is intact and says nothing
 * extra. NO boundary on record is UNKNOWN, not "nothing was pruned" -- a ledger
 * pruned before `retention_prunes` existed reports exactly that, and inferring
 * a boundary from the oldest surviving row would invent the provenance this
 * project refuses to infer. Neither of those licenses a sentence about deleted
 * data, and two tests below hold that a clean ledger stays quiet.
 *
 * WHAT IS NOT TESTED HERE, AND WHY IT IS GATED ANYWAY. That the wire and the
 * browser carry the third state is enforced by the compilers rather than by
 * this file: `src/dashboard/routes.ts` assigns the run's bound into the
 * payload, so a `shared-types.ts` union missing the member fails the ROOT
 * typecheck, and the browser renders through a `Record` keyed by that union, so
 * a missing rendering fails the BROWSER typecheck. A test asserting the same
 * thing would be weaker than the two compilers that already refuse it.
 *
 * WHAT THIS DOES NOT ESTABLISH. That the residual is otherwise trustworthy --
 * the five conditions on every run say otherwise and none of them is closed
 * here. Nor that D is small: it is unknown by construction, and the point of
 * the new state is that it is unknown rather than that it is large. Nor
 * anything about `pruneProposals`, which deletes proposal rows and cannot move
 * a spend total.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.FISCUS_HOME = mkdtempSync(join(tmpdir(), 'fiscus-retention-reconcile-'));

import { Store, type RequestRow } from '../src/store/db.ts';
import { readBillingImportFile } from '../src/billing/importer.ts';
import { describeOffPathBound, type ReconciliationRun } from '../src/billing/reconcile.ts';
import { reconciliationCountermodels } from '../src/billing/countermodels.ts';

const DAY = 24 * 60 * 60 * 1000;
const D0 = Date.UTC(2026, 6, 1);
const NOW = D0 + 30 * DAY;
const PROJECT = 'proj_retention_fixture';

const day = (index: number): string => new Date(D0 + index * DAY).toISOString();

interface ExportRecord {
  sourceRecordId: string;
  chargePeriodStart: string;
  chargePeriodEnd: string;
  providerProjectRef: string | null;
  chargeType: string;
  currency: string;
  amount: string;
  sku: string;
}

function record(over: Partial<ExportRecord> & { sourceRecordId: string }): ExportRecord {
  return {
    chargePeriodStart: day(0),
    chargePeriodEnd: day(1),
    providerProjectRef: PROJECT,
    chargeType: 'usage',
    currency: 'USD',
    amount: '1.000000',
    sku: 'model-usage',
    ...over,
  };
}

function proxyRequest(scopeId: string, costUsd: number, tsEpochMs: number, id: string): RequestRow {
  return {
    requestId: id, sessionId: null, tsEpochMs, provider: 'openai', model: 'gpt-5',
    project: 'p', taskWeight: 1, inputTokens: 1, outputTokens: 1, cacheWriteTokens: 0, cacheReadTokens: 0,
    reasoningTokens: 0, costUsd, estimated: false, streamed: false, statusCode: 200, durationMs: 1,
    scopeCaptureStatus: 'declared_unverified', providerScopeDeclarationId: scopeId,
  };
}

/**
 * A store with an adopted two-day provider observation totalling $10.00 and one
 * local request per day at the amounts the caller asks for.
 *
 * The operator-export route is used because it needs no network and no
 * credential. It costs the run a fifth condition, which is why the condition
 * count below is asserted against a measured baseline rather than a literal.
 */
function fixture(dayZeroUsd: number, dayOneUsd: number): Store {
  const store = new Store(':memory:');
  const scopeId = store.setOpenAiScope({
    billingAccountRef: 'org_retention_fixture',
    providerProjectRef: PROJECT,
    upstreamBase: 'https://api.openai.com',
    declaredAtMs: 1,
    activatedAtMs: 1,
  }).declarationId;

  const dir = mkdtempSync(join(tmpdir(), 'fiscus-retention-export-'));
  const file = join(dir, 'costs.fiscus.json');
  const records = [
    record({ sourceRecordId: 'd0', amount: '6.000000' }),
    record({ sourceRecordId: 'd1', chargePeriodStart: day(1), chargePeriodEnd: day(2), amount: '4.000000' }),
  ];
  writeFileSync(file, JSON.stringify({
    schemaVersion: 1,
    source: {
      system: 'operator-export', provider: 'openai', exportId: 'export-retention',
      billingAccountRef: 'acct-retention-fixture', exportedAt: new Date(NOW).toISOString(),
      periodStart: day(0), periodEnd: day(4), coverage: 'complete',
    },
    records: records.map((r) => ({
      ...r, observedAt: r.chargePeriodEnd, service: 'api', model: 'gpt-5',
      region: null, usageUnit: 'tokens', usageQuantity: '1000',
    })),
  }), 'utf8');

  const importId = store.applyBillingImport(readBillingImportFile(file).input, NOW).run.importId;
  const plan = store.planOpenAiCostsAdoption({ importId, declaredScopeId: scopeId, providerProjectRef: PROJECT });
  assert.equal(plan.adoptable, true, 'the fixture export must be adoptable');
  if (!plan.adoptable) throw new Error('unreachable');
  store.adoptOpenAiCostsFromImport(plan, NOW);

  store.insertRequest(proxyRequest(scopeId, dayZeroUsd, D0 + 3_600_000, 'r0'));
  store.insertRequest(proxyRequest(scopeId, dayOneUsd, D0 + DAY + 3_600_000, 'r1'));
  return store;
}

function reconciled(store: Store): ReconciliationRun {
  const result = store.reconcileOpenAiCosts({ now: NOW });
  assert.ok(result, 'the fixture must produce a reconciliation');
  assert.equal(result.status, 'reconciled_with_residual', JSON.stringify(result));
  if (result.status !== 'reconciled_with_residual') throw new Error('unreachable');
  return result;
}

test('a prune inside the reconciled period must not restore an upper bound the evidence refutes', () => {
  const store = fixture(6, 6);
  try {
    const before = reconciled(store);
    assert.equal(before.unexplainedVarianceMicros, -2_000_000);
    assert.equal(
      before.offPathBound,
      'none_local_estimate_exceeds_provider',
      'the baseline is the alarming state: the local estimate exceeds the provider total',
    );

    // Retention, on the operator's own policy. Nothing about the provider, the
    // period, or the traffic has changed -- only what survives to be counted.
    assert.equal(store.prune(D0 + DAY), 1, 'exactly the first day of local traffic is deleted');

    const after = reconciled(store);
    assert.equal(after.localCapturedMicros, 6_000_000, 'the surviving ledger is a strict undercount');
    assert.notEqual(
      after.offPathBound,
      'upper_bound_conditional',
      'a deletion must not manufacture an upper bound on off-path spend',
    );
    assert.equal(after.offPathBound, 'unknown_local_total_truncated_by_retention');
  } finally {
    store.close();
  }
});

test('a residual still negative under truncation keeps its refutation', () => {
  // The other direction, and the reason this cannot be fixed by refusing to
  // classify any truncated run. R' = R + D with D >= 0, so R' < 0 implies
  // R < 0: truncation can hide a refutation and can never invent one. Throwing
  // the surviving refutation away would be the loss of a sound conclusion
  // dressed as caution.
  // The surviving day alone has to out-price the whole provider total, or the
  // fixture would only be re-testing the case above.
  const store = fixture(9, 12);
  try {
    assert.equal(reconciled(store).unexplainedVarianceMicros, -11_000_000);
    assert.equal(store.prune(D0 + DAY), 1);

    const after = reconciled(store);
    assert.equal(after.unexplainedVarianceMicros, -2_000_000, 'still negative on the surviving rows alone');
    assert.equal(
      after.offPathBound,
      'none_local_estimate_exceeds_provider',
      'a negative residual establishes L > T whether or not the ledger was pruned',
    );
  } finally {
    store.close();
  }
});

test('a period that starts at or after the retention boundary is untouched', () => {
  // A disclosure that appeared on every pruned ledger regardless of period
  // would be noise, and noise stops being read. `prune` deletes rows strictly
  // older than the boundary, so a period starting exactly there lost nothing.
  const store = fixture(2, 2);
  try {
    assert.equal(store.prune(D0), 0, 'nothing in this fixture is older than the period');
    const after = reconciled(store);
    assert.equal(after.offPathBound, 'upper_bound_conditional');
    assert.ok(
      !after.conditions.includes('local_ledger_truncated_by_retention'),
      'an intact period must not carry a truncation condition',
    );
  } finally {
    store.close();
  }
});

test('with no prune on record nothing is asserted about truncation', () => {
  // The third state (D-170). Null is "no prune is ON RECORD", not "nothing was
  // pruned", and it licenses neither a warning nor a claim of coverage.
  const store = fixture(2, 2);
  try {
    assert.equal(store.retentionFloor().requestsPrunedBeforeMs, null);
    const only = reconciled(store);
    assert.equal(only.offPathBound, 'upper_bound_conditional');
    assert.ok(!only.conditions.includes('local_ledger_truncated_by_retention'));
  } finally {
    store.close();
  }
});

test('a truncated run carries the limit in the conditions that travel with it', () => {
  const store = fixture(6, 6);
  try {
    const baseline = reconciled(store).conditions.length;
    store.prune(D0 + DAY);
    const after = reconciled(store);
    assert.ok(
      after.conditions.includes('local_ledger_truncated_by_retention'),
      'the limit must travel with the result, not only with the bound state',
    );
    assert.equal(after.conditions.length, baseline + 1, 'exactly one condition is added, and none is dropped');
  } finally {
    store.close();
  }
});

test('the truncation countermodel is realized by the record, not merely live', () => {
  // Every other world on a reconciliation is `live` -- an unexcluded
  // possibility. This one is a fact Fiscus performed and recorded itself, so
  // reporting it as a possibility would understate what is known.
  const store = fixture(6, 6);
  try {
    store.prune(D0 + DAY);
    const models = reconciliationCountermodels(reconciled(store));
    const truncation = models.find((m) => m.violates === 'local_ledger_truncated_by_retention');
    assert.ok(truncation, 'a condition without a countermodel is a limit nobody can act on');
    assert.equal(truncation.status, 'realized');
    assert.equal(truncation.excludedBy, null, 'a deletion cannot be undone by any check an operator could run');
  } finally {
    store.close();
  }
});

test('the sentence for a truncated run names retention and claims no upper bound', () => {
  const words = describeOffPathBound('unknown_local_total_truncated_by_retention');
  assert.match(words, /retention|deleted|prun/i, 'the reader must be told why the residual cannot be classified');
  assert.doesNotMatch(
    words,
    /\bUpper bound on spend that never passed through Fiscus\b/,
    'it must not repeat the claim the truncation withdraws',
  );
});
