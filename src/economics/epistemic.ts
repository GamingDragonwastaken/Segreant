/** Exact economic period-close issuance into the Trusted Epistemic Kernel. */

import { claim, type Claim } from '../epistemic/claim.ts';
import { evidence, type Evidence } from '../epistemic/evidence.ts';
import { claimProfile, type MonetaryBasisStatus } from '../epistemic/profile.ts';
import { grain } from '../epistemic/grain.ts';
import { scope } from '../epistemic/scope.ts';
import { interval } from '../epistemic/time.ts';
import { canonicalPeriod, closeProjectionDigest, type CloseProjectionBalance } from './close.ts';
import { moneyToJson, type EconomicBasis } from './money.ts';
import type { PeriodFinalizationResult } from './ledger.ts';

export type EconomicKernelAppendResult = 'inserted' | 'duplicate';

export interface EconomicPeriodCloseKernelIssuance {
  readonly evidence: Evidence;
  readonly claim: Claim;
}

export interface EconomicPeriodCloseKernelPersistenceResult {
  readonly evidenceId: string;
  readonly claimId: string;
  readonly evidence: Readonly<{ result: EconomicKernelAppendResult }>;
  readonly claim: Readonly<{ result: EconomicKernelAppendResult }>;
}

const CLOSE_ASSUMPTIONS = Object.freeze([
  'The snapshot is complete for economic events retained by the local Fiscus ledger at the recording boundary.',
  'Provider billing completeness, provider account scope, and external settlement finality are not established by a local period close.',
]);

function sortedUnique(values: readonly string[], label: string): string[] {
  const sorted = [...values].sort();
  for (let index = 1; index < sorted.length; index += 1) {
    if (sorted[index] === sorted[index - 1]) throw new Error(`${label} must not contain duplicate IDs`);
  }
  if (values.some((value, index) => value !== sorted[index])) throw new Error(`${label} must be sorted`);
  return sorted;
}

function basisFor(balances: readonly CloseProjectionBalance[]): { evidence: EconomicBasis | null; claim: MonetaryBasisStatus } {
  const bases = [...new Set(balances.map((balance) => balance.basis))];
  if (bases.length === 0) return { evidence: null, claim: 'none' };
  if (bases.length === 1) {
    const basis = bases[0]!;
    return { evidence: basis as EconomicBasis, claim: basis as MonetaryBasisStatus };
  }
  return { evidence: null, claim: 'mixed' };
}

function balancesJson(balances: readonly CloseProjectionBalance[]) {
  return balances.map((balance) => ({
    role: balance.role,
    currency: balance.currency,
    basis: balance.basis,
    amount: { ...moneyToJson(balance.amount) },
    eventIds: [...balance.eventIds],
  }));
}

function validateResult(result: PeriodFinalizationResult): { period: ReturnType<typeof canonicalPeriod>; sourceEventIds: string[]; balances: CloseProjectionBalance[] } {
  const period = canonicalPeriod(result.periodStartMs, result.periodEndMs);
  if (result.status !== 'finalized') throw new Error('economic close kernel issuance requires a finalized result');
  if (typeof result.eventId !== 'string' || result.eventId.trim().length === 0) throw new Error('economic close finalization event ID is required');
  if (result.recordedAt < period.end) throw new Error('economic close finalization recordedAt precedes its period end');
  const sourceEventIds = sortedUnique(result.sourceEventIds, 'economic close sourceEventIds');
  if (sourceEventIds.length !== result.eventCount) throw new Error('economic close event count does not match sourceEventIds');
  const balances = [...result.balances].map((balance) => ({
    role: balance.role,
    currency: balance.currency,
    basis: balance.basis,
    amount: balance.amount,
    eventIds: sortedUnique(balance.eventIds, 'economic close balance eventIds'),
  }));
  const digest = closeProjectionDigest(period, sourceEventIds, balances);
  if (digest !== result.projectionDigest) throw new Error('economic close kernel issuance projection digest mismatch');
  return { period, sourceEventIds, balances };
}

/** Build the immutable Evidence/Claim pair for one authenticated close snapshot. */
export function buildEconomicPeriodCloseKernelIssuance(result: PeriodFinalizationResult): EconomicPeriodCloseKernelIssuance {
  const { period, sourceEventIds, balances } = validateResult(result);
  const basis = basisFor(balances);
  const validTime = interval(period.start, period.end);
  const closeScope = scope({ ledger: 'fiscus-economic', period: period.subject });
  const payload = {
    finalizationId: result.eventId,
    periodStartMs: period.startMs,
    periodEndMs: period.endMs,
    projectionDigest: result.projectionDigest,
    eventCount: result.eventCount,
    sourceEventIds,
    balances: balancesJson(balances),
  };
  const evidenceValue = evidence({
    id: `evidence:economic:period-close:${result.eventId}`,
    evidenceType: 'economic.period_close',
    sourceIdentity: 'fiscus:economic-ledger',
    sourceClass: 'fiscus_local_append_only_subledger',
    payload,
    scope: closeScope,
    grain: grain(['economic_period']),
    occurredAt: period.end,
    validTime,
    observedAt: result.recordedAt,
    recordedAt: result.recordedAt,
    assertedAt: result.recordedAt,
    finalizedAt: result.recordedAt,
    integrity: 'verified',
    authenticity: 'self_asserted',
    completeness: {
      status: 'complete',
      method: 'economic_ledger_finalization',
      coveredEventTypes: ['economic_event'],
      coveredScope: closeScope,
      coveredTime: validTime,
    },
    measurementModelRef: null,
    monetaryBasis: basis.evidence,
    assumptions: CLOSE_ASSUMPTIONS,
    supersedes: [],
    supersededBy: null,
    revocation: null,
    schemaVersion: 1,
    sensitivity: 'internal',
    redaction: 'none',
  });
  const claimValue = {
    ...payload,
    // Keep the claim's proposition exact and reviewable; it is not a mutable
    // balance and it does not collapse unlike currency/basis groups.
    balances: balancesJson(balances),
  };
  const claimValueRecord = claim({
    id: `claim:economic:period-close:${result.eventId}`,
    proposition: { predicate: 'economic.period_closed', value: claimValue },
    subject: period.subject,
    scope: closeScope,
    grain: grain(['economic_period']),
    time: { validTime, asOf: result.recordedAt },
    epistemic: 'supported',
    profile: claimProfile({
      epistemic: 'supported',
      integrity: 'verified',
      authenticity: 'self_asserted',
      scope: 'conditional',
      coverage: 'complete',
      // Exact arithmetic is verified, but the local ledger's economic
      // measurement model has not been independently validated against a
      // provider statement. Keep the epistemic boundary at proxy_unvalidated.
      measurement: 'proxy_unvalidated',
      causality: 'none',
      monetaryBasis: basis.claim,
      finality: 'provisional',
      decisionFitness: 'not_assessed',
    }),
    measurementModelRef: null,
    evidenceIds: [evidenceValue.id],
    derivationRule: 'economic.period_close.v1',
    derivationVersion: 1,
    assumptions: CLOSE_ASSUMPTIONS,
    uncertainty: { kind: 'qualitative', description: 'Exact local snapshot arithmetic is verified; external provider completeness, account scope and settlement finality remain conditional.' },
    causalStatus: 'none',
    monetaryBasis: basis.claim,
    finality: 'provisional',
    issuedAt: result.recordedAt,
    supersedes: [],
    supersededBy: null,
    revocation: null,
    decisionCertificateIds: [],
    schemaVersion: 1,
  });
  return Object.freeze({ evidence: evidenceValue, claim: claimValueRecord });
}
