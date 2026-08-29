import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatMoneyAmount } from '../src/economics/money.ts';
import { buildOpenAiCostsKernelIssuance, buildOpenAiReconciliationKernelIssuance } from '../src/billing/epistemic.ts';
import type { OpenAiCostsObservationLine, OpenAiCostsObservationRun } from '../src/store/billing.ts';
import type { ReconciliationRun } from '../src/billing/reconcile.ts';
import { Store } from '../src/store/db.ts';

const run: OpenAiCostsObservationRun = {
  observationRunId: 'observation:provider:1', declaredScopeId: 'scope_provider_1', providerProjectRef: 'proj_kernel',
  periodStartMs: Date.parse('2026-08-01T00:00:00.000Z'), periodEndMs: Date.parse('2026-08-03T00:00:00.000Z'),
  fetchedAtMs: Date.parse('2026-08-05T12:00:00.000Z'), paginationComplete: true, pageCount: 1, pageDigestChainSha256: 'c'.repeat(64),
  resultState: 'succeeded', failureCode: null, providerFinality: 'undocumented', trust: 'provider_observation_unreconciled', rawRetention: 'digest_only',
  observationsStored: 2, sourceKind: 'provider_api_pull',
};

const observations: OpenAiCostsObservationLine[] = [
  {
    observationId: 'line:provider:1', observationRunId: run.observationRunId, declaredScopeId: run.declaredScopeId, fetchedAtMs: run.fetchedAtMs,
    providerProjectRef: run.providerProjectRef, bucketStartMs: run.periodStartMs, bucketEndMs: Date.parse('2026-08-02T00:00:00.000Z'),
    lineItem: 'completions', currency: 'USD', amountDecimal: '1.234567',
  },
  {
    observationId: 'line:provider:2', observationRunId: run.observationRunId, declaredScopeId: run.declaredScopeId, fetchedAtMs: run.fetchedAtMs,
    providerProjectRef: run.providerProjectRef, bucketStartMs: Date.parse('2026-08-02T00:00:00.000Z'), bucketEndMs: run.periodEndMs,
    lineItem: 'embeddings', currency: 'USD', amountDecimal: '0.500000',
  },
];

test('direct OpenAI Costs observations issue provider-observed Money and Claims without becoming billed', () => {
  const issuance = buildOpenAiCostsKernelIssuance({ run, observations });
  assert.equal(issuance.observationEvidence.length, 2);
  assert.equal(issuance.observationClaims.length, 2);
  assert.equal(formatMoneyAmount(issuance.total), '1.734567');
  assert.equal(issuance.total.basis, 'provider_observed');
  assert.deepEqual(issuance.observationEvidence[0]!.payload, {
    amount: { coefficient: '1234567', scale: 6, currency: 'USD', basis: 'provider_observed' },
    lineItem: 'completions', observationId: 'line:provider:1', sourceKind: 'provider_api_pull',
  });
  assert.equal(issuance.observationClaims[0]!.proposition.predicate, 'billing.provider_observed_amount');
  assert.equal(issuance.observationClaims[0]!.profile.monetaryBasis, 'provider_observed');
  assert.equal(issuance.observationClaims[0]!.profile.authenticity, 'provider_authenticated');
  assert.equal(issuance.aggregateClaim.proposition.predicate, 'billing.provider_observed_period_total');
  assert.equal(issuance.aggregateClaim.profile.monetaryBasis, 'provider_observed');
  assert.deepEqual(issuance.aggregateClaim.evidenceIds, issuance.observationEvidence.map((item) => item.id));
});

test('direct observation issuance refuses failed, partial, non-USD, duplicate, and malformed lines', () => {
  assert.throws(() => buildOpenAiCostsKernelIssuance({ run: { ...run, resultState: 'failed', paginationComplete: false, failureCode: 'network_error', observationsStored: 0 }, observations: [] }), /successful|complete/);
  assert.throws(() => buildOpenAiCostsKernelIssuance({ run: { ...run, pageDigestChainSha256: null }, observations }), /digest|complete/);
  assert.throws(() => buildOpenAiCostsKernelIssuance({ run, observations: [{ ...observations[0]!, currency: 'EUR' }, observations[1]!] }), /USD/);
  assert.throws(() => buildOpenAiCostsKernelIssuance({ run, observations: [observations[0]!, observations[0]!] }), /duplicate/);
  assert.throws(() => buildOpenAiCostsKernelIssuance({ run, observations: [{ ...observations[0]!, amountDecimal: '0.1e1' }, observations[1]!] }), /decimal/);
});

test('Store persists direct provider-observation Evidence and Claims with exact replay', () => {
  const store = new Store(':memory:');
  try {
    const stored = store.recordOpenAiCostsObservation({
      declaredScopeId: run.declaredScopeId,
      providerProjectRef: run.providerProjectRef,
      periodStartMs: run.periodStartMs,
      periodEndMs: run.periodEndMs,
      fetchedAtMs: run.fetchedAtMs,
      paginationComplete: true,
      pageCount: run.pageCount,
      pageDigestChainSha256: run.pageDigestChainSha256,
      resultState: 'succeeded',
      failureCode: null,
      sourceKind: run.sourceKind,
      observations: observations.map((line) => ({
        providerProjectRef: line.providerProjectRef,
        bucketStartMs: line.bucketStartMs,
        bucketEndMs: line.bucketEndMs,
        lineItem: line.lineItem,
        currency: line.currency,
        amountDecimal: line.amountDecimal,
      })),
    });
    const first = store.issueOpenAiCostsObservationToKernel(stored.observationRunId);
    assert.deepEqual(first.observationEvidence, { inserted: 2, duplicate: 0 });
    assert.deepEqual(first.observationClaims, { inserted: 2, duplicate: 0 });
    assert.equal(first.aggregateClaim.result, 'inserted');
    assert.equal(formatMoneyAmount(first.total), '1.734567');
    const replay = store.issueOpenAiCostsObservationToKernel(stored.observationRunId);
    assert.deepEqual(replay.observationEvidence, { inserted: 0, duplicate: 2 });
    assert.deepEqual(replay.observationClaims, { inserted: 0, duplicate: 2 });
    assert.equal(replay.aggregateClaim.result, 'duplicate');
  } finally {
    store.close();
  }
});

test('combined billing reconciliation issuance keeps provider and local Evidence bases distinct', () => {
  const reconciliation: ReconciliationRun = {
    status: 'reconciled_with_residual', observationRunId: run.observationRunId, declaredScopeId: run.declaredScopeId, providerProjectRef: run.providerProjectRef,
    periodStartMs: run.periodStartMs, periodEndMs: run.periodEndMs, currency: 'USD', materialityUsd: 0.5,
    providerReportedMicros: 1_734_567, localCapturedMicros: 1_000_000, unexplainedVarianceMicros: 734_567,
    coverage: { providerDays: 2, localDays: 2, daysWithBoth: 2, providerOnlyDays: 0, localOnlyDays: 0, materialDays: 1 }, days: [],
    snapshotStability: 'single_observation', unstableDayStartMs: [], providerSourceKind: 'provider_api_pull',
    conditions: ['local_route_scope_is_not_provider_verified', 'off_path_provider_usage_is_not_observable', 'provider_line_items_do_not_join_to_requests_or_models', 'local_request_amounts_are_rate_card_estimates'],
    trust: 'scope_conditional_reconciliation', excludedFrom: ['request_metered_spend', 'budget_enforcement', 'roi', 'model_recommendations'],
  };
  const issuance = buildOpenAiReconciliationKernelIssuance({
    observation: { run, observations }, reconciliation, reconciliationRunId: 'reconciliation:fixture:1', issuedAt: '2026-08-10T12:01:00.000Z',
  });
  assert.equal(issuance.localEvidence.monetaryBasis, 'estimated');
  assert.equal(issuance.reconciliationClaim.profile.monetaryBasis, 'mixed');
  assert.equal(issuance.reconciliationClaim.profile.authenticity, 'self_asserted');
  assert.equal(issuance.reconciliationClaim.evidenceIds.length, 3);
  assert.deepEqual(issuance.reconciliationClaim.proposition.value, {
    providerReported: { coefficient: '1734567', scale: 6, currency: 'USD', basis: 'provider_observed' },
    localCaptured: { coefficient: '1', scale: 0, currency: 'USD', basis: 'estimated' },
    unexplainedVariance: { coefficient: '734567', scale: 6, currency: 'USD', leftBasis: 'provider_observed', rightBasis: 'estimated' },
    snapshotStability: 'single_observation', providerSourceKind: 'provider_api_pull', reconciliationRunId: 'reconciliation:fixture:1',
  });
});

test('Store persists a recorded reconciliation as provider, local-capture, and mixed-basis kernel Claims', () => {
  const store = new Store(':memory:');
  try {
    const stored = store.recordOpenAiCostsObservation({
      declaredScopeId: run.declaredScopeId,
      providerProjectRef: run.providerProjectRef,
      periodStartMs: run.periodStartMs,
      periodEndMs: run.periodEndMs,
      fetchedAtMs: run.fetchedAtMs,
      paginationComplete: true,
      pageCount: run.pageCount,
      pageDigestChainSha256: run.pageDigestChainSha256,
      resultState: 'succeeded',
      failureCode: null,
      sourceKind: run.sourceKind,
      observations: observations.map((line) => ({
        providerProjectRef: line.providerProjectRef, bucketStartMs: line.bucketStartMs, bucketEndMs: line.bucketEndMs,
        lineItem: line.lineItem, currency: line.currency, amountDecimal: line.amountDecimal,
      })),
    });
    const reconciliation: ReconciliationRun = {
      status: 'reconciled_with_residual', observationRunId: stored.observationRunId, declaredScopeId: run.declaredScopeId, providerProjectRef: run.providerProjectRef,
      periodStartMs: run.periodStartMs, periodEndMs: run.periodEndMs, currency: 'USD', materialityUsd: 0.5,
      providerReportedMicros: 1_734_567, localCapturedMicros: 1_000_000, unexplainedVarianceMicros: 734_567,
      coverage: { providerDays: 2, localDays: 2, daysWithBoth: 2, providerOnlyDays: 0, localOnlyDays: 0, materialDays: 1 },
      days: [
        { dayStartMs: run.periodStartMs, providerReportedMicros: 1_234_567, localCapturedMicros: 700_000, localRequestCount: 1, differenceMicros: 534_567, residualReason: 'provider_exceeds_local', material: true, providerLineItems: ['completions'] },
        { dayStartMs: Date.parse('2026-08-02T00:00:00.000Z'), providerReportedMicros: 500_000, localCapturedMicros: 300_000, localRequestCount: 1, differenceMicros: 200_000, residualReason: 'provider_exceeds_local', material: false, providerLineItems: ['embeddings'] },
      ],
      snapshotStability: 'single_observation', unstableDayStartMs: [], providerSourceKind: 'provider_api_pull',
      conditions: ['local_route_scope_is_not_provider_verified', 'off_path_provider_usage_is_not_observable', 'provider_line_items_do_not_join_to_requests_or_models', 'local_request_amounts_are_rate_card_estimates'],
      trust: 'scope_conditional_reconciliation', excludedFrom: ['request_metered_spend', 'budget_enforcement', 'roi', 'model_recommendations'],
    };
    const reconciliationId = store.saveReconciliationRun(reconciliation, Date.parse('2026-08-10T12:01:00.000Z'));
    const first = store.issueOpenAiReconciliationToKernel(reconciliationId);
    assert.deepEqual(first.provider.observationEvidence, { inserted: 2, duplicate: 0 });
    assert.deepEqual(first.provider.observationClaims, { inserted: 2, duplicate: 0 });
    assert.equal(first.provider.aggregateClaim.result, 'inserted');
    assert.equal(first.localEvidence.result, 'inserted');
    assert.equal(first.reconciliationClaim.result, 'inserted');
    assert.equal(store.billingReconciliationKernelClaims(10).length, 1);
    const replay = store.issueOpenAiReconciliationToKernel(reconciliationId);
    assert.deepEqual(replay.provider.observationEvidence, { inserted: 0, duplicate: 2 });
    assert.deepEqual(replay.provider.observationClaims, { inserted: 0, duplicate: 2 });
    assert.equal(replay.provider.aggregateClaim.result, 'duplicate');
    assert.equal(replay.localEvidence.result, 'duplicate');
    assert.equal(replay.reconciliationClaim.result, 'duplicate');
    assert.equal(store.epistemic().readClaim(first.reconciliationClaim.id)?.profile.monetaryBasis, 'mixed');
  } finally {
    store.close();
  }
});
