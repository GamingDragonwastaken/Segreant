import { test } from 'node:test';
import assert from 'node:assert/strict';
import { causalRequestPricingDigestV2 } from '../src/store/causalLineage.ts';
import {
  verifyCausalLedgerEvidence,
  verifiedOrdinaryLedgerVerifier,
  type CausalLedgerEvidenceRowV2,
} from '../src/causal/ledger.ts';
import { decodeCausalExecutionV2, causalExecutionV2EventHash } from '../src/causal/records.ts';

const D = (char: string): string => 'sha256:' + char.repeat(64);

function row(overrides: Partial<CausalLedgerEvidenceRowV2> = {}): CausalLedgerEvidenceRowV2 {
  return {
    requestId: 'request:ledger1',
    tsEpochMs: 1_700_000_000_200,
    provider: 'provider:openai',
    model: 'model:test',
    project: 'project:test',
    costUsd: 1.25,
    estimated: false,
    via: 'proxy',
    statusCode: 200,
    costBasis: 'tool_reported_unverified',
    rateCardSha256: null,
    rateCardSourceKind: 'none',
    rateMatchKind: 'reported',
    rateMatchProvider: null,
    rateMatchModel: null,
    scopeCaptureStatus: 'declared_unverified',
    providerScopeDeclarationId: 'scope:test',
    ...overrides,
  };
}

function expected(rows: readonly CausalLedgerEvidenceRowV2[]) {
  return {
    providerId: 'provider:openai',
    modelId: 'model:test',
    startedAtMs: 1_700_000_000_100,
    completedAtMs: 1_700_000_000_300,
    directCostUsd: rows.reduce((sum, current) => sum + current.costUsd, 0),
    scopeDeclarationId: 'scope:test',
    priceLineageDigests: rows.map((current) => causalRequestPricingDigestV2({
      requestId: current.requestId,
      tsEpochMs: current.tsEpochMs,
      provider: current.provider,
      model: current.model,
      project: current.project,
      costMicros: Math.round(current.costUsd * 1_000_000),
      costBasis: 'tool_reported_unverified',
      rateCardSha256: null,
      rateCardSourceKind: 'none',
      rateMatchKind: 'reported',
      rateMatchProvider: null,
      rateMatchModel: null,
      scopeCaptureStatus: 'declared_unverified',
      providerScopeDeclarationId: current.providerScopeDeclarationId!,
    })),
  };
}

test('ordinary-ledger verifier accepts a coherent observed proxy set and emits a replayable manifest', () => {
  const requests = [row()];
  const result = verifyCausalLedgerEvidence({ requests, expected: expected(requests), checkedAtMs: 1_700_000_000_400 });
  assert.equal(result.state, 'verified');
  assert.equal(result.reasonCodes.length, 0);
  assert.equal(result.requestCount, 1);
  assert.equal(result.actualCostUsd, 1.25);
  assert.match(result.evidenceManifestHash!, /^sha256:[a-f0-9]{64}$/);
  assert.ok(result.verifier);
  assert.equal(result.verifier!.state, 'verified');
  assert.equal(result.verifier!.requestCount, 1);
  assert.equal(result.verifier!.reasonCodes.length, 0);

  const verifier = verifiedOrdinaryLedgerVerifier({ requests, expected: expected(requests), checkedAtMs: 1_700_000_000_400 });
  const executionMaterial = {
    type: 'fiscus.causal-execution' as const,
    version: 2 as const,
    executionId: 'execution:ledger1',
    decisionId: 'decision:ledger1',
    studyId: 'study:ledger1',
    protocolHash: D('a'),
    startedAtMs: 1_700_000_000_100,
    completedAtMs: 1_700_000_000_300,
    assignedExecutionPlanDigest: D('b'),
    actualExecutionPlanDigest: D('b'),
    adherence: 'confirmed' as const,
    requestIds: ['request:ledger1'],
    directAiCostUsd: 1.25,
    directCostSourceClass: 'actual_observed' as const,
    priceLineageDigests: expected(requests).priceLineageDigests,
    fullArmCostUsd: null,
    fullCostSourceClass: 'incomplete_or_unknown' as const,
    ordinaryLedgerVerifier: verifier,
    previousEventHash: D('c'),
  };
  assert.doesNotThrow(() => decodeCausalExecutionV2({
    ...executionMaterial,
    eventHash: causalExecutionV2EventHash(executionMaterial),
  }));
});

test('ordinary-ledger verifier fails closed for imported, estimated, failed, and scope-mismatched rows', () => {
  const requests = [row({ via: 'import', estimated: true, statusCode: 500, providerScopeDeclarationId: 'scope:other' })];
  const result = verifyCausalLedgerEvidence({ requests, expected: expected([row()]), checkedAtMs: 1_700_000_000_400 });
  assert.equal(result.state, 'unverified');
  assert.equal(result.verifier, null);
  assert.ok(result.reasonCodes.includes('request_not_proxy'));
  assert.ok(result.reasonCodes.includes('request_cost_estimated'));
  assert.ok(result.reasonCodes.includes('request_status_not_success'));
  assert.ok(result.reasonCodes.includes('request_scope_unresolved'));
  assert.ok(result.reasonCodes.includes('request_price_lineage_mismatch'));
  assert.equal(result.actualCostUsd, null);
});

test('ordinary-ledger verifier rejects duplicate or out-of-order request identities', () => {
  const requests = [
    row({ requestId: 'request:ledger:2', costUsd: 0.25 }),
    row({ requestId: 'request:ledger:2', costUsd: 1.0 }),
  ];
  const result = verifyCausalLedgerEvidence({
    requests,
    expected: { ...expected(requests), directCostUsd: 1.25 },
    checkedAtMs: 1_700_000_000_400,
  });
  assert.equal(result.state, 'unverified');
  assert.ok(result.reasonCodes.includes('request_ids_not_sorted_or_unique'));
});
