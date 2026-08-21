/**
 * Adopting an operator-supplied export as a provider observation.
 *
 * This route exists because the reconciliation was blocked on the wrong thing.
 * A read-only Costs pull is better evidence and stays the recommended path, but
 * an account owner who can export a bill should not be unable to reconcile
 * merely because minting an Admin key needs a different permission than reading
 * one.
 *
 * The whole risk of that trade is one failure: a reconciliation built on
 * figures a person handed over, displayed as though the provider had confirmed
 * them. These tests pin the guards against it — the observation is stamped, the
 * stamp survives into the reconciliation, a fifth condition appears, and
 * nothing that cannot be attributed to the declared project is silently
 * swallowed.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.FISCUS_HOME = mkdtempSync(join(tmpdir(), 'fiscus-adopt-'));

import { Store, type RequestRow } from '../src/store/db.ts';
import { readBillingImportFile } from '../src/billing/importer.ts';
import { PERMANENT_CONDITIONS } from '../src/billing/reconcile.ts';

const DAY = 24 * 60 * 60 * 1000;
const D0 = Date.UTC(2026, 6, 1);
const NOW = D0 + 30 * DAY;
const PROJECT = 'proj_adopt_fixture';

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

function day(index: number): string {
  return new Date(D0 + index * DAY).toISOString();
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

/** Write an operator export to disk and import it, returning its import id. */
function importExport(store: Store, records: ExportRecord[], coverage = 'complete'): string {
  const dir = mkdtempSync(join(tmpdir(), 'fiscus-export-'));
  const file = join(dir, 'costs.fiscus.json');
  writeFileSync(file, JSON.stringify({
    schemaVersion: 1,
    source: {
      system: 'operator-export',
      provider: 'openai',
      exportId: `export-${records.length}-${records[0]!.sourceRecordId}`,
      billingAccountRef: 'acct-adopt-fixture',
      exportedAt: new Date(NOW).toISOString(),
      periodStart: day(0),
      periodEnd: day(4),
      coverage,
    },
    records: records.map((r) => ({
      ...r,
      observedAt: r.chargePeriodEnd,
      service: 'api',
      model: 'gpt-5',
      region: null,
      usageUnit: 'tokens',
      usageQuantity: '1000',
    })),
  }), 'utf8');
  return store.applyBillingImport(readBillingImportFile(file).input, NOW).run.importId;
}

function scoped(store: Store): string {
  return store.setOpenAiScope({
    billingAccountRef: 'org_adopt_fixture',
    providerProjectRef: PROJECT,
    upstreamBase: 'https://api.openai.com',
    declaredAtMs: 1,
    activatedAtMs: 1,
  }).declarationId;
}

function proxyRequest(scopeId: string, costUsd: number, tsEpochMs: number, id: string): RequestRow {
  return {
    requestId: id, sessionId: null, tsEpochMs, provider: 'openai', model: 'gpt-5',
    project: 'p', taskWeight: 1, inputTokens: 1, outputTokens: 1, cacheWriteTokens: 0, cacheReadTokens: 0,
    reasoningTokens: 0, costUsd, estimated: false, streamed: false, statusCode: 200, durationMs: 1,
    scopeCaptureStatus: 'declared_unverified', providerScopeDeclarationId: scopeId,
  };
}

test('an adoption plan groups matched lines by UTC day without a float round-trip', () => {
  const store = new Store(':memory:');
  try {
    const scopeId = scoped(store);
    const importId = importExport(store, [
      record({ sourceRecordId: 'a', amount: '12.345678' }),
      record({ sourceRecordId: 'b', amount: '0.000001' }),
      record({ sourceRecordId: 'c', chargePeriodStart: day(1), chargePeriodEnd: day(2), amount: '3.500000' }),
    ]);
    const plan = store.planOpenAiCostsAdoption({ importId, declaredScopeId: scopeId, providerProjectRef: PROJECT });
    assert.equal(plan.adoptable, true);
    if (!plan.adoptable) return;
    assert.equal(plan.observations.length, 2, 'two days, each one grouping');
    // 12.345678 + 0.000001 exactly. A float sum would show 12.345678999999999.
    assert.equal(plan.observations[0]!.amountDecimal, '12.345679');
    assert.equal(plan.observations[1]!.amountDecimal, '3.500000');
    assert.equal(plan.periodStartMs, D0);
    assert.equal(plan.periodEndMs, D0 + 2 * DAY);
    assert.equal(plan.matchedMicros, 12_345_679 + 3_500_000);
    assert.equal(plan.declaredCoverage, 'complete');
  } finally {
    store.close();
  }
});

test('an account-level credit is excluded from the adoption AND reported, never dropped', () => {
  const store = new Store(':memory:');
  try {
    const scopeId = scoped(store);
    const importId = importExport(store, [
      record({ sourceRecordId: 'usage', amount: '10.000000' }),
      // No project reference: it cannot be attributed to this project.
      record({ sourceRecordId: 'credit', providerProjectRef: null, chargeType: 'credit', amount: '-4.000000', sku: 'account-credit' }),
      record({ sourceRecordId: 'other-project', providerProjectRef: 'proj_somewhere_else', amount: '7.000000' }),
    ]);
    const plan = store.planOpenAiCostsAdoption({ importId, declaredScopeId: scopeId, providerProjectRef: PROJECT });
    assert.equal(plan.adoptable, true);
    if (!plan.adoptable) return;
    assert.equal(plan.matchedMicros, 10_000_000, 'only the project line is observed');
    assert.equal(plan.excluded.otherOrNoProjectRecordCount, 2);
    assert.equal(plan.excluded.otherOrNoProjectMicros, -4_000_000 + 7_000_000);
    // The point of reporting rather than dropping: an operator can see that the
    // provider total they are comparing against is not their whole bill.
    assert.notEqual(plan.excluded.otherOrNoProjectMicros, 0);
  } finally {
    store.close();
  }
});

test('an adoption refuses anything it cannot honestly observe', () => {
  const store = new Store(':memory:');
  try {
    const scopeId = scoped(store);
    const ask = (importId: string) => store.planOpenAiCostsAdoption({ importId, declaredScopeId: scopeId, providerProjectRef: PROJECT });

    assert.equal(ask('no-such-import').adoptable, false);
    const missing = ask('no-such-import');
    if (!missing.adoptable) assert.equal(missing.refusal, 'no_such_import');

    // Not a whole UTC day: the provider bucket grain is the only grain that joins.
    const hourly = importExport(store, [record({
      sourceRecordId: 'hourly',
      chargePeriodStart: new Date(D0).toISOString(),
      chargePeriodEnd: new Date(D0 + 3_600_000).toISOString(),
    })]);
    const hourlyPlan = ask(hourly);
    assert.equal(hourlyPlan.adoptable, false);
    if (!hourlyPlan.adoptable) assert.equal(hourlyPlan.refusal, 'records_are_not_whole_utc_days');

    // No line carries the declared project.
    const elsewhere = importExport(store, [record({ sourceRecordId: 'elsewhere', providerProjectRef: 'proj_other' })]);
    const elsewherePlan = ask(elsewhere);
    assert.equal(elsewherePlan.adoptable, false);
    if (!elsewherePlan.adoptable) assert.equal(elsewherePlan.refusal, 'no_records_for_declared_project');
  } finally {
    store.close();
  }
});

test('a non-USD export is refused rather than converted at an invented rate', () => {
  const store = new Store(':memory:');
  try {
    scoped(store);
    // The refusal lands at the IMPORT boundary, before adoption is even
    // reachable — the v1 evidence schema is single-currency. Asserting where it
    // actually happens keeps this test honest about which guard is load-bearing;
    // the plan's own currency check is a second line for direct callers of the
    // store method, and is deliberately unreachable through this path.
    assert.throws(
      () => importExport(store, [record({ sourceRecordId: 'eur', currency: 'EUR' })]),
      /currency must be USD/,
    );
  } finally {
    store.close();
  }
});

test('an adopted observation is stamped, and the stamp survives into the reconciliation', () => {
  const store = new Store(':memory:');
  try {
    const scopeId = scoped(store);
    const importId = importExport(store, [
      record({ sourceRecordId: 'd0', amount: '10.000000' }),
      record({ sourceRecordId: 'd1', chargePeriodStart: day(1), chargePeriodEnd: day(2), amount: '5.000000' }),
    ]);
    const plan = store.planOpenAiCostsAdoption({ importId, declaredScopeId: scopeId, providerProjectRef: PROJECT });
    assert.equal(plan.adoptable, true);
    const run = store.adoptOpenAiCostsFromImport(plan, NOW);
    assert.equal(run.sourceKind, 'operator_supplied_export');
    assert.equal(run.resultState, 'succeeded');
    assert.equal(run.pageCount, 1, 'the operator file is the single page');
    if (plan.adoptable) assert.equal(run.pageDigestChainSha256, plan.fileSha256);

    // Local capture on the declared route, deliberately less than the provider.
    store.insertRequest(proxyRequest(scopeId, 8, D0 + 3_600_000, 'r1'));
    store.insertRequest(proxyRequest(scopeId, 5, D0 + DAY + 3_600_000, 'r2'));

    const result = store.reconcileOpenAiCosts({ now: NOW });
    assert.ok(result, 'a complete observation is reconcilable');
    assert.equal(result!.status, 'reconciled_with_residual');
    if (result!.status !== 'reconciled_with_residual') return;

    assert.equal(result!.providerSourceKind, 'operator_supplied_export');
    assert.equal(result!.providerReportedMicros, 15_000_000);
    assert.equal(result!.localCapturedMicros, 13_000_000);
    assert.equal(result!.unexplainedVarianceMicros, 2_000_000);

    // The fifth condition, present only because the provider side was handed over.
    assert.equal(result!.conditions.length, 5);
    assert.ok(result!.conditions.includes('provider_report_is_operator_supplied_and_unverified'));
    for (const permanent of PERMANENT_CONDITIONS) assert.ok(result!.conditions.includes(permanent));

    // It is still never called clean, and still never feeds a control.
    assert.equal(result!.trust, 'scope_conditional_reconciliation');
    assert.deepEqual(result!.excludedFrom, ['request_metered_spend', 'budget_enforcement', 'roi', 'model_recommendations']);

    const recordedId = store.saveReconciliationRun(result!);
    const reread = store.reconciliationRuns(1)[0]!;
    assert.equal(reread.reconciliationRunId, recordedId);
    assert.equal(reread.result.providerSourceKind, 'operator_supplied_export', 'the stamp survives a round-trip through the store');
    assert.equal(reread.result.conditions.length, 5);
  } finally {
    store.close();
  }
});

test('a directly pulled observation carries four conditions, not five', () => {
  const store = new Store(':memory:');
  try {
    const scopeId = scoped(store);
    store.recordOpenAiCostsObservation({
      declaredScopeId: scopeId,
      providerProjectRef: PROJECT,
      periodStartMs: D0,
      periodEndMs: D0 + DAY,
      fetchedAtMs: NOW,
      paginationComplete: true,
      pageCount: 1,
      pageDigestChainSha256: 'a'.repeat(64),
      resultState: 'succeeded',
      failureCode: null,
      observations: [{
        providerProjectRef: PROJECT,
        bucketStartMs: D0,
        bucketEndMs: D0 + DAY,
        lineItem: 'completions',
        currency: 'USD',
        amountDecimal: '9.000000',
      }],
    });
    store.insertRequest(proxyRequest(scopeId, 9, D0 + 3_600_000, 'r1'));

    const result = store.reconcileOpenAiCosts({ now: NOW });
    assert.equal(result!.status, 'reconciled_with_residual');
    if (result!.status !== 'reconciled_with_residual') return;
    assert.equal(result!.providerSourceKind, 'provider_api_pull', 'the pull path defaults to itself, explicitly');
    assert.deepEqual([...result!.conditions], [...PERMANENT_CONDITIONS]);
    assert.equal(result!.unexplainedVarianceMicros, 0, 'an exact match is still reconciled WITH RESIDUAL');
  } finally {
    store.close();
  }
});

test('a run recorded before the distinction existed stays legacy_unknown', () => {
  const store = new Store(':memory:');
  try {
    const scopeId = scoped(store);
    store.recordOpenAiCostsObservation({
      declaredScopeId: scopeId,
      providerProjectRef: PROJECT,
      periodStartMs: D0,
      periodEndMs: D0 + DAY,
      fetchedAtMs: NOW,
      paginationComplete: true,
      pageCount: 1,
      pageDigestChainSha256: 'b'.repeat(64),
      resultState: 'succeeded',
      failureCode: null,
      observations: [{
        providerProjectRef: PROJECT,
        bucketStartMs: D0,
        bucketEndMs: D0 + DAY,
        lineItem: 'completions',
        currency: 'USD',
        amountDecimal: '4.000000',
      }],
    });
    // Simulate a row written before the column existed. The migration defaults
    // it to `legacy_unknown`; it must never be promoted to a known source.
    store.raw().prepare("UPDATE openai_cost_observation_runs SET source_kind = 'legacy_unknown'").run();

    const result = store.reconcileOpenAiCosts({ now: NOW });
    assert.equal(result!.status, 'reconciled_with_residual');
    if (result!.status !== 'reconciled_with_residual') return;
    assert.equal(result!.providerSourceKind, 'legacy_unknown');
    assert.deepEqual([...result!.conditions], [...PERMANENT_CONDITIONS],
      'unknown provenance does not earn the operator-supplied condition, and does not lose the permanent ones');
  } finally {
    store.close();
  }
});

test('imported OpenAI spend is reported as uncountable BEFORE the credential step', () => {
  const store = new Store(':memory:');
  try {
    const scopeId = scoped(store);
    // The real-machine failure this exists to prevent: hundreds of dollars of
    // genuine OpenAI spend, all of it natively imported, and a reconciliation
    // that would therefore report the entire provider bill as residual.
    store.insertRequest({
      ...proxyRequest(scopeId, 400, D0 + 3_600_000, 'imported-1'),
      via: 'import',
      source: 'codex',
      scopeCaptureStatus: undefined,
      providerScopeDeclarationId: undefined,
    } as RequestRow);
    store.insertRequest(proxyRequest(scopeId, 12, D0 + 7_200_000, 'on-route-1'));

    const coverage = store.openAiReconciliationCoverage(scopeId);
    assert.ok(coverage, 'OpenAI spend exists, so there is something to report');
    assert.equal(coverage!.importedUsd, 400);
    assert.equal(coverage!.importedRequests, 1);
    assert.equal(coverage!.onDeclaredRouteUsd, 12, 'only proxy traffic carrying the declaration counts');
    assert.equal(coverage!.onDeclaredRouteRequests, 1);

    // A ledger with no OpenAI rows at all has nothing to warn about.
    const empty = new Store(':memory:');
    try {
      assert.equal(empty.openAiReconciliationCoverage(null), null);
    } finally {
      empty.close();
    }
  } finally {
    store.close();
  }
});
