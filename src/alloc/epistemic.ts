/**
 * Exact allocation-to-kernel issuance adapter.
 *
 * ISSUANCE CLASS: canonical — see `src/epistemic/issuance-map.ts`.
 */

import { claim, type Claim } from '../epistemic/claim.ts';
import { evidence, type Evidence } from '../epistemic/evidence.ts';
import { claimProfile } from '../epistemic/profile.ts';
import { grain } from '../epistemic/grain.ts';
import { scope } from '../epistemic/scope.ts';
import { instant, interval } from '../epistemic/time.ts';
import { canonicalPeriod } from '../economics/close.ts';
import { ECONOMIC_BASES, type EconomicBasis } from '../economics/money.ts';
import { exactAllocationToJson, serializeExactAllocationRun, validateExactAllocationResult, type ExactAllocationRunResult } from './exact.ts';

export type AllocationKernelAppendResult = 'inserted' | 'duplicate';

export interface ExactAllocationKernelIssuance {
  readonly evidence: Evidence;
  readonly claim: Claim;
}

export interface ExactAllocationKernelPersistenceResult {
  readonly evidenceId: string;
  readonly claimId: string;
  readonly evidence: Readonly<{ result: AllocationKernelAppendResult }>;
  readonly claim: Readonly<{ result: AllocationKernelAppendResult }>;
}

const ALLOCATION_ASSUMPTIONS = Object.freeze([
  'Allocation is a derived local showback projection, not provider settlement, chargeback, or causal attribution.',
  'The exact input event set and its pricing bases are retained in the allocation result; unresolved legacy requests remain outside the exact rows.',
]);

function computedAt(value: number): ReturnType<typeof instant> {
  if (!Number.isSafeInteger(value)) throw new Error('exact allocation computedAt must be a safe integer timestamp');
  const iso = new Date(value).toISOString();
  if (Date.parse(iso) !== value) throw new Error('exact allocation computedAt is outside the supported timestamp range');
  return instant(iso);
}

function sourceBasis(result: ExactAllocationRunResult): EconomicBasis | null {
  if (result.sourceBases.length !== 1) return null;
  const basis = result.sourceBases[0];
  if (basis === undefined || !ECONOMIC_BASES.includes(basis)) throw new Error(`exact allocation source basis is invalid: ${String(basis)}`);
  return basis;
}

function validateRecord(allocationRunId: string, result: ExactAllocationRunResult) {
  if (typeof allocationRunId !== 'string' || allocationRunId.trim().length === 0) throw new Error('exact allocation run ID is required');
  validateExactAllocationResult(result);
  const serialized = serializeExactAllocationRun(result);
  const expectedId = `economic:allocation:${serialized.digest.slice('sha256:'.length)}`;
  if (allocationRunId !== expectedId) throw new Error('exact allocation run ID does not match its canonical result digest');
  const period = canonicalPeriod(result.periodStartMs, result.periodEndMs);
  return { period, serialized, observedAt: computedAt(result.runAtMs), recordedAt: computedAt(result.runAtMs) };
}

/** Build immutable kernel Evidence/Claim records for one persisted exact run. */
export function buildExactAllocationKernelIssuance(allocationRunId: string, result: ExactAllocationRunResult, computedAtMs: number): ExactAllocationKernelIssuance {
  const { period, serialized, recordedAt } = validateRecord(allocationRunId, result);
  const computed = computedAt(computedAtMs);
  const validTime = interval(period.start, period.end);
  const allocationScope = scope({ ledger: 'fiscus-economic', period: period.subject, allocationRunId });
  const allocationJson = exactAllocationToJson(result);
  const payload = {
    allocationRunId,
    periodStartMs: period.startMs,
    periodEndMs: period.endMs,
    runAtMs: result.runAtMs,
    computedAtMs,
    result: allocationJson,
    resultDigest: serialized.digest,
  } as never;
  const coverage = result.complete ? 'complete' as const : 'partial' as const;
  const evidenceValue = evidence({
    id: `evidence:economic:allocation:${allocationRunId}`,
    evidenceType: 'economic.allocation',
    sourceIdentity: 'fiscus:economic-allocation',
    sourceClass: 'fiscus_local_exact_allocation_projection',
    payload,
    scope: allocationScope,
    grain: grain(['economic_period', 'cost_centre']),
    occurredAt: period.end,
    validTime,
    observedAt: recordedAt,
    recordedAt: computed,
    assertedAt: computed,
    finalizedAt: null,
    integrity: 'verified',
    authenticity: 'self_asserted',
    completeness: {
      status: coverage,
      method: 'exact_allocation_projection',
      coveredEventTypes: ['economic_event', 'economic_allocation'],
      coveredScope: allocationScope,
      coveredTime: validTime,
    },
    measurementModelRef: null,
    monetaryBasis: sourceBasis(result),
    assumptions: ALLOCATION_ASSUMPTIONS,
    supersedes: [],
    supersededBy: null,
    revocation: null,
    schemaVersion: 1,
    sensitivity: 'internal',
    redaction: 'none',
  });
  const claimValue = {
    allocationRunId,
    periodStartMs: period.startMs,
    periodEndMs: period.endMs,
    resultDigest: serialized.digest,
    complete: result.complete,
    conserves: result.conserves,
    sourceBases: [...result.sourceBases],
    unresolvedRequestIds: [...result.unresolvedRequestIds],
    result: allocationJson,
  } as never;
  const claimValueRecord = claim({
    id: `claim:economic:allocation:${allocationRunId}`,
    proposition: { predicate: 'economic.allocation_recorded', value: claimValue },
    subject: allocationRunId,
    scope: allocationScope,
    grain: grain(['economic_period', 'cost_centre']),
    time: { validTime, asOf: computed },
    epistemic: 'supported',
    profile: claimProfile({
      epistemic: 'supported',
      integrity: 'verified',
      authenticity: 'self_asserted',
      scope: 'conditional',
      coverage,
      measurement: 'proxy_unvalidated',
      causality: 'none',
      monetaryBasis: 'allocated',
      finality: 'provisional',
      decisionFitness: 'not_assessed',
    }),
    measurementModelRef: null,
    evidenceIds: [evidenceValue.id],
    derivationRule: 'economic.allocation.v1',
    derivationVersion: 1,
    assumptions: ALLOCATION_ASSUMPTIONS,
    uncertainty: { kind: 'qualitative', description: 'Exact arithmetic and source lineage are verified; allocation is a local derived showback, not provider billing or causal value.' },
    causalStatus: 'none',
    monetaryBasis: 'allocated',
    finality: 'provisional',
    issuedAt: computed,
    supersedes: [],
    supersededBy: null,
    revocation: null,
    decisionCertificateIds: [],
    schemaVersion: 1,
  });
  return Object.freeze({ evidence: evidenceValue, claim: claimValueRecord });
}
