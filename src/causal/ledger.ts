/**
 * Read-only ordinary-ledger verification for a causal execution.
 *
 * This verifier intentionally works on the exact request ids named by an
 * execution. It proves that the retained scalar rows are a coherent local
 * evidence set: one provider/model, one declared route scope, successful proxy
 * responses, accepted observed-cost metadata, an exact fixed-point sum, and a
 * matching price-lineage digest set. It does not prove invoice finality,
 * provider account ownership, or an outcome's causal validity.
 */

import { canonicalJson, sha256 } from './protocol.ts';
import { ordinaryLedgerVerifierHash } from './records.ts';
import type { OrdinaryLedgerVerifierVerifiedV2 } from './types.ts';

const DIGEST_RE = /^sha256:[a-f0-9]{64}$/;
const ID_RE = /^[A-Za-z0-9._:-]{1,160}$/;
const MAX_SAFE_MICROS = BigInt(Number.MAX_SAFE_INTEGER);

export interface CausalLedgerEvidenceRowV2 {
  requestId: string;
  tsEpochMs: number;
  provider: string;
  model: string;
  project: string;
  costUsd: number;
  estimated: boolean;
  via: 'proxy' | 'import';
  statusCode: number | null;
  costBasis: string;
  rateCardSha256: string | null;
  rateCardSourceKind: string;
  rateMatchKind: string;
  rateMatchProvider: string | null;
  rateMatchModel: string | null;
  scopeCaptureStatus: string;
  providerScopeDeclarationId: string | null;
}

export interface CausalLedgerVerificationInputV2 {
  requests: readonly CausalLedgerEvidenceRowV2[];
  expected: {
    providerId: string;
    modelId: string;
    startedAtMs: number;
    completedAtMs: number;
    directCostUsd: number;
    scopeDeclarationId: string;
    priceLineageDigests: readonly string[];
  };
  checkedAtMs: number;
}

export type CausalLedgerReasonCodeV2 =
  | 'request_ids_empty'
  | 'request_ids_not_sorted_or_unique'
  | 'request_id_invalid'
  | 'request_timestamp_invalid'
  | 'request_provider_mismatch'
  | 'request_model_mismatch'
  | 'request_status_not_success'
  | 'request_not_proxy'
  | 'request_cost_estimated'
  | 'request_cost_basis_unaccepted'
  | 'request_price_metadata_unaccepted'
  | 'request_scope_unresolved'
  | 'request_cost_invalid'
  | 'request_cost_sum_mismatch'
  | 'request_price_lineage_mismatch'
  | 'verification_clock_invalid';

export interface CausalLedgerVerificationResultV2 {
  state: 'verified' | 'unverified';
  reasonCodes: CausalLedgerReasonCodeV2[];
  requestCount: number;
  actualCostUsd: number | null;
  evidenceManifestHash: string | null;
  verifier: OrdinaryLedgerVerifierVerifiedV2 | null;
}

function providerKey(providerId: string): string {
  return providerId === 'provider:openai' ? 'openai' : providerId;
}

function digest(value: unknown): value is string {
  return typeof value === 'string' && DIGEST_RE.test(value);
}

function identifier(value: unknown): value is string {
  return typeof value === 'string' && ID_RE.test(value);
}

function micros(value: number): number | null {
  if (!Number.isFinite(value)) return null;
  const encoded = Math.round(value * 1_000_000);
  return Number.isSafeInteger(encoded) ? encoded : null;
}

function requestPricingDigest(row: CausalLedgerEvidenceRowV2): string {
  const costMicros = micros(row.costUsd);
  if (costMicros === null) throw new Error('request cost is not representable in fixed-point USD');
  return 'sha256:' + sha256(
    'fiscus.causal.request-cost-lineage\n2\n' + canonicalJson({
      requestId: row.requestId,
      tsEpochMs: row.tsEpochMs,
      provider: row.provider,
      model: row.model,
      project: row.project,
      costMicros,
      costBasis: 'tool_reported_unverified',
      rateCardSha256: null,
      rateCardSourceKind: 'none',
      rateMatchKind: 'reported',
      rateMatchProvider: null,
      rateMatchModel: null,
      scopeCaptureStatus: 'declared_unverified',
      providerScopeDeclarationId: row.providerScopeDeclarationId ?? '',
    }),
  );
}

function manifestHash(
  rows: readonly CausalLedgerEvidenceRowV2[],
  expected: CausalLedgerVerificationInputV2['expected'],
): string {
  const material = {
    providerId: expected.providerId,
    modelId: expected.modelId,
    startedAtMs: expected.startedAtMs,
    completedAtMs: expected.completedAtMs,
    directCostUsdMicros: micros(expected.directCostUsd),
    scopeDeclarationId: expected.scopeDeclarationId,
    requestIds: rows.map((row) => row.requestId),
    rows: rows.map((row) => ({
      requestId: row.requestId,
      tsEpochMs: row.tsEpochMs,
      provider: row.provider,
      model: row.model,
      project: row.project,
      costUsdMicros: micros(row.costUsd),
      statusCode: row.statusCode,
      via: row.via,
      costBasis: row.costBasis,
      scopeCaptureStatus: row.scopeCaptureStatus,
      providerScopeDeclarationId: row.providerScopeDeclarationId,
    })),
    priceLineageDigests: [...expected.priceLineageDigests].sort(),
  };
  return 'sha256:' + sha256('fiscus.causal.ordinary-ledger-manifest\n2\n' + canonicalJson(material));
}

function uniqueReasons(reasons: CausalLedgerReasonCodeV2[]): CausalLedgerReasonCodeV2[] {
  return [...new Set(reasons)];
}

/** Verify exact retained request evidence without writing or contacting a provider. */
export function verifyCausalLedgerEvidence(
  input: CausalLedgerVerificationInputV2,
): CausalLedgerVerificationResultV2 {
  const reasons: CausalLedgerReasonCodeV2[] = [];
  const expected = input.expected;
  if (!Number.isSafeInteger(input.checkedAtMs) || input.checkedAtMs <= 0
      || !Number.isSafeInteger(expected.startedAtMs) || !Number.isSafeInteger(expected.completedAtMs)
      || expected.startedAtMs <= 0 || expected.completedAtMs < expected.startedAtMs) {
    reasons.push('verification_clock_invalid');
  }
  if (input.requests.length === 0) reasons.push('request_ids_empty');

  const ids = input.requests.map((row) => row.requestId);
  if (new Set(ids).size !== ids.length
      || ids.some((id, index) => index > 0 && ids[index - 1]! >= id)) {
    reasons.push('request_ids_not_sorted_or_unique');
  }

  let totalMicros = 0n;
  const observedDigests: string[] = [];
  for (const row of input.requests) {
    if (!identifier(row.requestId)) reasons.push('request_id_invalid');
    if (!Number.isSafeInteger(row.tsEpochMs)
        || row.tsEpochMs < expected.startedAtMs || row.tsEpochMs > expected.completedAtMs) {
      reasons.push('request_timestamp_invalid');
    }
    if (providerKey(row.provider) !== providerKey(expected.providerId)) reasons.push('request_provider_mismatch');
    if (row.model !== expected.modelId) reasons.push('request_model_mismatch');
    if (row.statusCode === null || !Number.isInteger(row.statusCode) || row.statusCode < 200 || row.statusCode >= 300) {
      reasons.push('request_status_not_success');
    }
    if (row.via !== 'proxy') reasons.push('request_not_proxy');
    if (row.estimated) reasons.push('request_cost_estimated');
    if (row.costBasis !== 'tool_reported_unverified') reasons.push('request_cost_basis_unaccepted');
    if (row.rateCardSha256 !== null || row.rateCardSourceKind !== 'none'
        || row.rateMatchKind !== 'reported' || row.rateMatchProvider !== null || row.rateMatchModel !== null) {
      reasons.push('request_price_metadata_unaccepted');
    }
    if (row.scopeCaptureStatus !== 'declared_unverified'
        || row.providerScopeDeclarationId !== expected.scopeDeclarationId) {
      reasons.push('request_scope_unresolved');
    }
    const cost = micros(row.costUsd);
    if (cost === null || cost < 0) {
      reasons.push('request_cost_invalid');
    } else {
      totalMicros += BigInt(cost);
      if (totalMicros > MAX_SAFE_MICROS) reasons.push('request_cost_invalid');
    }
    try {
      observedDigests.push(requestPricingDigest(row));
    } catch {
      reasons.push('request_cost_invalid');
    }
  }

  const expectedCostMicros = micros(expected.directCostUsd);
  if (expectedCostMicros === null || expectedCostMicros < 0
      || totalMicros !== BigInt(expectedCostMicros)) {
    reasons.push('request_cost_sum_mismatch');
  }
  const expectedDigests = [...expected.priceLineageDigests];
  if (new Set(expectedDigests).size !== expectedDigests.length
      || expectedDigests.some((value) => !digest(value))) {
    reasons.push('request_price_lineage_mismatch');
  } else {
    observedDigests.sort();
    expectedDigests.sort();
    if (canonicalJson(observedDigests) !== canonicalJson(expectedDigests)) {
      reasons.push('request_price_lineage_mismatch');
    }
  }

  const finalReasons = uniqueReasons(reasons);
  if (finalReasons.length > 0) {
    return {
      state: 'unverified',
      reasonCodes: finalReasons,
      requestCount: input.requests.length,
      actualCostUsd: null,
      evidenceManifestHash: null,
      verifier: null,
    };
  }

  const evidenceManifestHash = manifestHash(input.requests, expected);
  const verifierMaterial = {
    type: 'fiscus.causal-ordinary-ledger-verifier' as const,
    version: 2 as const,
    state: 'verified' as const,
    checkedAtMs: input.checkedAtMs,
    requestCount: input.requests.length,
    evidenceManifestHash,
    reasonCodes: [] as [],
  };
  const verifier: OrdinaryLedgerVerifierVerifiedV2 = {
    ...verifierMaterial,
    resultHash: ordinaryLedgerVerifierHash(verifierMaterial),
  };
  return {
    state: 'verified',
    reasonCodes: [],
    requestCount: input.requests.length,
    actualCostUsd: expected.directCostUsd,
    evidenceManifestHash,
    verifier,
  };
}

/** Build the immutable verified result for an execution record, refusing weak input. */
export function verifiedOrdinaryLedgerVerifier(
  input: CausalLedgerVerificationInputV2,
): OrdinaryLedgerVerifierVerifiedV2 {
  const result = verifyCausalLedgerEvidence(input);
  if (result.state !== 'verified' || result.verifier === null) {
    throw new Error('ordinary ledger evidence is not verified: ' + result.reasonCodes.join(', '));
  }
  return result.verifier;
}
