import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatMoneyAmount } from '../src/economics/money.ts';
import { buildOpenAiCostsKernelIssuance } from '../src/billing/epistemic.ts';
import type { OpenAiCostsObservationLine, OpenAiCostsObservationRun } from '../src/store/billing.ts';
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
