import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatMoneyAmount } from '../src/economics/money.ts';
import { buildBillingKernelIssuance, billingReconciliationClaim } from '../src/billing/epistemic.ts';
import type { BillingEvidenceRecord, BillingImportRun } from '../src/store/billing.ts';
import { Store } from '../src/store/db.ts';
import type { ReconciliationRun } from '../src/billing/reconcile.ts';

const run: BillingImportRun = {
  importId: 'import:kernel:1', importedAtMs: Date.parse('2026-08-10T12:00:00.000Z'), format: 'json', schemaVersion: 1,
  importerVersion: '1.0.0', fileName: 'operator-export.json', fileSha256: 'a'.repeat(64), fileSizeBytes: 100,
  sourceSystem: 'operator-export', sourceExportId: 'export:kernel:1', provider: 'openai', billingAccountRef: 'acct-kernel',
  exportedAtMs: Date.parse('2026-08-10T11:00:00.000Z'), periodStartMs: Date.parse('2026-08-01T00:00:00.000Z'),
  periodEndMs: Date.parse('2026-08-03T00:00:00.000Z'), coverage: 'complete', trust: 'operator_supplied_unverified', rawRetention: 'digest_only',
  recordsSeen: 2, recordsInserted: 2, recordsDuplicate: 0,
};

const records: BillingEvidenceRecord[] = [
  {
    recordId: 'record:kernel:1', sourceSystem: 'operator-export', billingAccountRef: run.billingAccountRef,
    sourceRecordId: 'line-1', sourceRecordSha256: '1'.repeat(64), firstImportId: run.importId, sourceExportId: run.sourceExportId,
    provider: 'openai', providerProjectRef: 'project-a', service: 'api', sku: 'tokens', model: 'gpt-test', region: null,
    observedAtMs: Date.parse('2026-08-01T12:00:00.000Z'), chargePeriodStartMs: run.periodStartMs, chargePeriodEndMs: Date.parse('2026-08-02T00:00:00.000Z'),
    chargeType: 'usage', currency: 'USD', amountMicros: 100000, usageUnit: 'tokens', usageQuantity: '1000', costBasis: 'provider_reported', trust: 'operator_supplied_unverified',
  },
  {
    recordId: 'record:kernel:2', sourceSystem: 'operator-export', billingAccountRef: run.billingAccountRef,
    sourceRecordId: 'line-2', sourceRecordSha256: '2'.repeat(64), firstImportId: run.importId, sourceExportId: run.sourceExportId,
    provider: 'openai', providerProjectRef: 'project-a', service: 'api', sku: 'tokens', model: 'gpt-test', region: null,
    observedAtMs: Date.parse('2026-08-02T12:00:00.000Z'), chargePeriodStartMs: Date.parse('2026-08-02T00:00:00.000Z'), chargePeriodEndMs: run.periodEndMs,
    chargeType: 'usage', currency: 'USD', amountMicros: 1234567, usageUnit: 'tokens', usageQuantity: '12345', costBasis: 'provider_reported', trust: 'operator_supplied_unverified',
  },
];

test('billing kernel adapter emits exact Money-backed Evidence and billed Claims without float round-trips', () => {
  const issuance = buildBillingKernelIssuance({ run, records });
  assert.equal(issuance.recordEvidence.length, 2);
  assert.equal(issuance.recordClaims.length, 2);
  assert.equal(formatMoneyAmount(issuance.total), '1.334567');
  assert.equal(issuance.total.basis, 'billed');
  assert.deepEqual(issuance.recordEvidence[0]!.payload, {
    amount: { coefficient: '1', scale: 1, currency: 'USD', basis: 'billed' },
    chargeType: 'usage', sourceRecordId: 'line-1', sourceRecordSha256: '1'.repeat(64),
  });
  assert.equal(issuance.recordClaims[0]!.profile.monetaryBasis, 'billed');
  assert.equal(issuance.recordClaims[0]!.profile.authenticity, 'self_asserted');
  assert.deepEqual(issuance.aggregateClaim.evidenceIds, issuance.recordEvidence.map((item) => item.id));
  assert.equal(Object.isFrozen(issuance.total), true);
});

test('reconciliation claim keeps billed and local estimate bases explicit and preserves exact residual semantics', () => {
  const reconciliation: ReconciliationRun = {
    status: 'reconciled_with_residual', observationRunId: 'observation:1', declaredScopeId: 'scope:1', providerProjectRef: 'project-a',
    periodStartMs: run.periodStartMs, periodEndMs: run.periodEndMs, currency: 'USD', materialityUsd: 0.5,
    providerReportedMicros: 1_334_567, localCapturedMicros: 1_000_000, unexplainedVarianceMicros: 334_567,
    coverage: { providerDays: 2, localDays: 2, daysWithBoth: 2, providerOnlyDays: 0, localOnlyDays: 0, materialDays: 1 },
    days: [], snapshotStability: 'single_observation', unstableDayStartMs: [], providerSourceKind: 'operator_supplied_export',
    conditions: ['local_route_scope_is_not_provider_verified', 'off_path_provider_usage_is_not_observable', 'provider_line_items_do_not_join_to_requests_or_models', 'local_request_amounts_are_rate_card_estimates', 'provider_report_is_operator_supplied_and_unverified'],
    trust: 'scope_conditional_reconciliation', excludedFrom: ['request_metered_spend', 'budget_enforcement', 'roi', 'model_recommendations'],
  };
  const claim = billingReconciliationClaim({
    id: 'claim:reconciliation:1', run: reconciliation, evidenceIds: ['evidence:provider-total', 'evidence:local-capture'], issuedAt: '2026-08-10T12:01:00.000Z',
  });
  assert.equal(claim.proposition.predicate, 'billing.reconciled_with_residual');
  assert.equal(claim.profile.monetaryBasis, 'mixed');
  assert.equal(claim.profile.finality, 'provisional');
  assert.deepEqual(claim.proposition.value, {
    providerReported: { coefficient: '1334567', scale: 6, currency: 'USD', basis: 'billed' },
    localCaptured: { coefficient: '1', scale: 0, currency: 'USD', basis: 'estimated' },
    unexplainedVariance: { coefficient: '334567', scale: 6, currency: 'USD', leftBasis: 'billed', rightBasis: 'estimated' },
    snapshotStability: 'single_observation', providerSourceKind: 'operator_supplied_export',
  });
});

test('reconciliation claim refuses a non-conserving residual instead of certifying arithmetic drift', () => {
  const reconciliation: ReconciliationRun = {
    status: 'reconciled_with_residual', observationRunId: 'observation:bad', declaredScopeId: 'scope:bad', providerProjectRef: 'project-a',
    periodStartMs: run.periodStartMs, periodEndMs: run.periodEndMs, currency: 'USD', materialityUsd: 0.5,
    providerReportedMicros: 10, localCapturedMicros: 3, unexplainedVarianceMicros: 8,
    coverage: { providerDays: 1, localDays: 1, daysWithBoth: 1, providerOnlyDays: 0, localOnlyDays: 0, materialDays: 1 }, days: [],
    snapshotStability: 'single_observation', unstableDayStartMs: [], providerSourceKind: 'operator_supplied_export',
    conditions: [], trust: 'scope_conditional_reconciliation', excludedFrom: ['request_metered_spend', 'budget_enforcement', 'roi', 'model_recommendations'],
  };
  assert.throws(() => billingReconciliationClaim({ id: 'claim:reconciliation:bad', run: reconciliation, evidenceIds: ['evidence:provider', 'evidence:local'], issuedAt: '2026-08-10T12:01:00.000Z' }), /does not conserve/);
});

test('Store billing import adapter persists canonical Evidence and Claims and replays idempotently', () => {
  const store = new Store(':memory:');
  try {
    const normalized = {
      schemaVersion: 1 as const,
      source: {
        system: 'operator-export' as const, provider: 'openai' as const, exportId: run.sourceExportId,
        billingAccountRef: run.billingAccountRef, exportedAt: new Date(run.exportedAtMs).toISOString(),
        periodStart: new Date(run.periodStartMs).toISOString(), periodEnd: new Date(run.periodEndMs).toISOString(), coverage: run.coverage,
      },
      exportedAtMs: run.exportedAtMs, periodStartMs: run.periodStartMs, periodEndMs: run.periodEndMs,
      records: records.map((record) => ({
        sourceRecordId: record.sourceRecordId, sourceRecordSha256: record.sourceRecordSha256, observedAtMs: record.observedAtMs,
        chargePeriodStartMs: record.chargePeriodStartMs, chargePeriodEndMs: record.chargePeriodEndMs, service: record.service,
        sku: record.sku, model: record.model, region: record.region, providerProjectRef: record.providerProjectRef,
        chargeType: record.chargeType, currency: record.currency, amountMicros: record.amountMicros,
        usageUnit: record.usageUnit, usageQuantity: record.usageQuantity,
      })),
    };
    const imported = store.applyBillingImport({
      document: normalized, fileName: 'operator-export.json', fileSha256: run.fileSha256, fileSizeBytes: run.fileSizeBytes, format: 'json',
    }, run.importedAtMs);
    const first = store.issueBillingImportToKernel(imported.run.importId);
    assert.deepEqual(first.recordEvidence, { inserted: 2, duplicate: 0 });
    assert.deepEqual(first.recordClaims, { inserted: 2, duplicate: 0 });
    assert.equal(first.aggregateClaim.result, 'inserted');
    assert.equal(formatMoneyAmount(first.total), '1.334567');
    const replay = store.issueBillingImportToKernel(imported.run.importId);
    assert.deepEqual(replay.recordEvidence, { inserted: 0, duplicate: 2 });
    assert.deepEqual(replay.recordClaims, { inserted: 0, duplicate: 2 });
    assert.equal(replay.aggregateClaim.result, 'duplicate');
    assert.equal(store.epistemic().graph().nodes.filter((node) => node.kind === 'evidence').length, 2);
    assert.equal(store.epistemic().graph().nodes.filter((node) => node.kind === 'claim').length, 3);
  } finally {
    store.close();
  }
});

test('Store persists a mixed-basis reconciliation Claim only from existing Evidence IDs', () => {
  const store = new Store(':memory:');
  try {
    const normalized = {
      schemaVersion: 1 as const,
      source: {
        system: 'operator-export' as const, provider: 'openai' as const, exportId: run.sourceExportId,
        billingAccountRef: run.billingAccountRef, exportedAt: new Date(run.exportedAtMs).toISOString(),
        periodStart: new Date(run.periodStartMs).toISOString(), periodEnd: new Date(run.periodEndMs).toISOString(), coverage: run.coverage,
      },
      exportedAtMs: run.exportedAtMs, periodStartMs: run.periodStartMs, periodEndMs: run.periodEndMs,
      records: records.map((record) => ({
        sourceRecordId: record.sourceRecordId, sourceRecordSha256: record.sourceRecordSha256, observedAtMs: record.observedAtMs,
        chargePeriodStartMs: record.chargePeriodStartMs, chargePeriodEndMs: record.chargePeriodEndMs, service: record.service,
        sku: record.sku, model: record.model, region: record.region, providerProjectRef: record.providerProjectRef,
        chargeType: record.chargeType, currency: record.currency, amountMicros: record.amountMicros,
        usageUnit: record.usageUnit, usageQuantity: record.usageQuantity,
      })),
    };
    const imported = store.applyBillingImport({
      document: normalized, fileName: 'operator-export.json', fileSha256: 'b'.repeat(64), fileSizeBytes: run.fileSizeBytes, format: 'json',
    }, run.importedAtMs);
    store.issueBillingImportToKernel(imported.run.importId);
    const reconciliation: ReconciliationRun = {
      status: 'reconciled_with_residual', observationRunId: 'observation:kernel', declaredScopeId: 'scope:kernel', providerProjectRef: 'project-a',
      periodStartMs: run.periodStartMs, periodEndMs: run.periodEndMs, currency: 'USD', materialityUsd: 0.5,
      providerReportedMicros: 1_334_567, localCapturedMicros: 1_000_000, unexplainedVarianceMicros: 334_567,
      coverage: { providerDays: 2, localDays: 2, daysWithBoth: 2, providerOnlyDays: 0, localOnlyDays: 0, materialDays: 1 }, days: [],
      snapshotStability: 'single_observation', unstableDayStartMs: [], providerSourceKind: 'operator_supplied_export',
      conditions: ['local_route_scope_is_not_provider_verified', 'off_path_provider_usage_is_not_observable', 'provider_line_items_do_not_join_to_requests_or_models', 'local_request_amounts_are_rate_card_estimates', 'provider_report_is_operator_supplied_and_unverified'],
      trust: 'scope_conditional_reconciliation', excludedFrom: ['request_metered_spend', 'budget_enforcement', 'roi', 'model_recommendations'],
    };
    const evidenceIds = store.epistemic().graph().nodes.filter((node) => node.kind === 'evidence').map((node) => node.id);
    const first = store.issueBillingReconciliationClaim({ id: 'claim:reconciliation:stored', run: reconciliation, evidenceIds, issuedAt: '2026-08-10T12:01:00.000Z' });
    assert.deepEqual(first, { claimId: 'claim:reconciliation:stored', result: 'inserted' });
    const replay = store.issueBillingReconciliationClaim({ id: 'claim:reconciliation:stored', run: reconciliation, evidenceIds, issuedAt: '2026-08-10T12:01:00.000Z' });
    assert.deepEqual(replay, { claimId: 'claim:reconciliation:stored', result: 'duplicate' });
    assert.equal(store.epistemic().readClaim(first.claimId)?.profile.monetaryBasis, 'mixed');
  } finally {
    store.close();
  }
});
