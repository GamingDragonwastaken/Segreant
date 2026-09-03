/**
 * Conservative boundary from interval certificates to kernel records.
 *
 * ISSUANCE CLASS: canonical — see `src/epistemic/issuance-map.ts`.
 * A plain engine certificate is not a durable truth or decision claim. This
 * adapter binds the interval observation, the decision-fitness witness, and
 * the derived claim into the same revocable epistemic graph.
 */
import { createHash } from 'node:crypto';
import { certifyDecision, type ActionUtilityInterval, type DecisionCertificate } from './engine.ts';
import { claim, type Claim } from '../epistemic/claim.ts';
import { derivation, type Derivation, type DerivationWitness } from '../epistemic/derivation.ts';
import { evidence, type Evidence } from '../epistemic/evidence.ts';
import { grain } from '../epistemic/grain.ts';
import { claimProfile } from '../epistemic/profile.ts';
import { scope } from '../epistemic/scope.ts';
import { instant, interval, type Instant } from '../epistemic/time.ts';
import { witness, type Witness } from '../epistemic/witness.ts';
import { canonicalJson } from '../epistemic/serialization.ts';
import { EpistemicLedger } from '../epistemic/ledger.ts';

export interface EvidenceBinding {
  readonly id: string;
  readonly record: Evidence;
}
export type DecisionEvidenceBinding = EvidenceBinding | Evidence;

export interface DecisionKernelIssuanceInput {
  readonly decisionId: string;
  readonly certificate: DecisionCertificate;
  readonly intervals: ReadonlyArray<ActionUtilityInterval>;
  readonly evidence: ReadonlyArray<DecisionEvidenceBinding>;
  readonly issuedAt: string;
}

export interface DecisionKernelIssuance {
  readonly evidence: Evidence;
  readonly observation: Claim;
  readonly witness: Witness | null;
  readonly decision: Claim | null;
  readonly derivation: Derivation | null;
}

function text(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`${label} must be non-empty`);
  return value.trim();
}
function issuedTime(value: unknown): Instant { return instant(text(value, 'issuedAt')); }
function hash(value: unknown): string { return `sha256:${createHash('sha256').update(canonicalJson(value)).digest('hex')}`; }
function sameJson(a: unknown, b: unknown): boolean { return canonicalJson(a) === canonicalJson(b); }

function validateCertificate(certificate: DecisionCertificate, intervals: ReadonlyArray<ActionUtilityInterval>): void {
  if (certificate === null || typeof certificate !== 'object') throw new Error('decision certificate must be an object');
  const recomputed = certifyDecision(intervals);
  if (!sameJson(certificate, recomputed)) throw new Error('decision certificate does not match action utility intervals');
}

function bindings(input: ReadonlyArray<DecisionEvidenceBinding>): readonly Evidence[] {
  if (!Array.isArray(input) || input.length === 0) throw new Error('at least one evidence binding is required');
  const ids = new Set<string>();
  return Object.freeze(input.map((candidate, index) => {
    const record = 'record' in (candidate as object) ? (candidate as EvidenceBinding).record : candidate as Evidence;
    const declared = 'record' in (candidate as object) ? (candidate as EvidenceBinding).id : (record as Evidence).id;
    const id = text(declared, `evidence binding ${index} id`);
    if (ids.has(id)) throw new Error(`duplicate evidence binding: ${id}`);
    ids.add(id);
    if (record === null || typeof record !== 'object' || record.id !== id) throw new Error(`evidence binding ${id} does not match its record`);
    const normalized = evidence(record);
    if (normalized.id !== id) throw new Error(`evidence binding ${id} does not match its record`);
    return normalized;
  }));
}

function coordinates(decisionId: string) {
  return { scope: scope({ ledger: 'fiscus-decision', decisionId }), grain: grain(['decision', 'action']) };
}

/** Build records without persistence; all decisions are recomputed and fail closed. */
export function buildDecisionKernelIssuance(input: DecisionKernelIssuanceInput): DecisionKernelIssuance {
  const decisionId = text(input.decisionId, 'decisionId');
  const at = issuedTime(input.issuedAt);
  validateCertificate(input.certificate, input.intervals);
  const source = bindings(input.evidence);
  const coordinate = coordinates(decisionId);
  const validTime = interval(source.reduce((min, item) => item.validTime?.from && item.validTime.from < min ? item.validTime.from : min, source[0]!.validTime?.from ?? at), source.reduce((max, item) => item.validTime?.to && item.validTime.to > max ? item.validTime.to : max, source[0]!.validTime?.to ?? at));
  const intervalValue = input.intervals.map((item) => ({ action: item.action, low: item.low, high: item.high }));
  const sourceIds = source.map((item) => item.id);
  const observation = claim({
    id: `claim:decision:utility:${decisionId}`, proposition: { predicate: 'decision.utility_interval_observed', value: { decisionId, intervals: intervalValue, certificate: input.certificate } as never },
    subject: decisionId, scope: coordinate.scope, grain: coordinate.grain, time: { validTime, asOf: at }, epistemic: 'supported',
    profile: claimProfile({ epistemic: 'supported', integrity: 'verified', authenticity: 'self_asserted', scope: 'conditional', coverage: 'complete', measurement: 'proxy_unvalidated', causality: 'none', monetaryBasis: 'none', finality: 'provisional', decisionFitness: 'insufficient' }),
    evidenceIds: sourceIds, derivationRule: 'decision.utility_interval_observation.v1', derivationVersion: 1,
    assumptions: input.certificate.assumptions, uncertainty: { kind: 'interval', lower: null, upper: null, description: 'Declared action utility intervals; no utility point estimate is inferred.' },
    causalStatus: 'none', monetaryBasis: 'none', finality: 'provisional', issuedAt: at, supersedes: [], supersededBy: null, revocation: null, decisionCertificateIds: [], schemaVersion: 1,
  });
  const observationEvidence = evidence({
    id: `evidence:decision:utility:${decisionId}`, evidenceType: 'decision.utility_interval', sourceIdentity: 'fiscus:decision-engine', sourceClass: 'fiscus_local_interval_certificate',
    payload: { decisionId, intervals: intervalValue, certificate: input.certificate } as never, scope: coordinate.scope, grain: coordinate.grain,
    occurredAt: at, validTime, observedAt: at, recordedAt: at, assertedAt: at, finalizedAt: null, integrity: 'verified', authenticity: 'self_asserted',
    completeness: { status: 'complete', method: 'explicit_action_interval_set', coveredEventTypes: ['decision_utility_interval'], coveredScope: coordinate.scope, coveredTime: validTime },
    measurementModelRef: null, monetaryBasis: null, assumptions: input.certificate.assumptions, supersedes: [], supersededBy: null, revocation: null, schemaVersion: 1, sensitivity: 'internal', redaction: 'none',
  });
  // The observation claim is deliberately returned with the interval Evidence as its own source.
  const observed = claim({ ...observation, evidenceIds: [observationEvidence.id, ...sourceIds] });
  if (input.certificate.status !== 'proven_dominant') return Object.freeze({ evidence: observationEvidence, observation: observed, witness: null, decision: null, derivation: null });
  const decision = claim({
    id: `claim:decision:fitness:${decisionId}`, proposition: { predicate: 'decision.fitness_sufficient', value: { decisionId, action: input.certificate.action, margin: input.certificate.margin, certificate: input.certificate } as never },
    subject: decisionId, scope: coordinate.scope, grain: coordinate.grain, time: { validTime, asOf: at }, epistemic: 'supported',
    profile: claimProfile({ epistemic: 'supported', integrity: 'verified', authenticity: 'self_asserted', scope: 'conditional', coverage: 'complete', measurement: 'proxy_unvalidated', causality: 'none', monetaryBasis: 'none', finality: 'provisional', decisionFitness: 'sufficient' }),
    measurementModelRef: null, evidenceIds: [observationEvidence.id, ...sourceIds], derivationRule: 'decision.strict_interval_dominance.v1', derivationVersion: 1, assumptions: input.certificate.assumptions,
    uncertainty: { kind: 'interval', lower: null, upper: null, description: 'Strict positive lower-bound margin over every rival upper bound.' }, causalStatus: 'none', monetaryBasis: 'none', finality: 'provisional', issuedAt: at, supersedes: [], supersededBy: null, revocation: null, decisionCertificateIds: [`certificate:decision:${decisionId}`], schemaVersion: 1,
  });
  const proof = witness({ id: `witness:decision:fitness:${decisionId}`, kind: 'decision_fitness', evidenceIds: [observationEvidence.id, ...sourceIds], detail: 'Strict interval dominance was recomputed from the bound utility intervals and the certificate matched exactly.', issuedAt: at, epistemic: 'supported', schemaVersion: 1 });
  const reference: DerivationWitness = { id: proof.id, kind: proof.kind, evidenceIds: proof.evidenceIds, detail: proof.detail };
  const outputValue = decision.proposition.value;
  const derived = derivation({ id: `derivation:decision:fitness:${decisionId}`, inputEvidenceIds: [observationEvidence.id, ...sourceIds], inputClaimIds: [observed.id], transformation: 'decision.strict_interval_dominance.v1', outputClaimId: decision.id, outputProposition: { predicate: 'decision.fitness_sufficient', value: outputValue }, coordinateChange: { from: coordinate, to: coordinate }, witnesses: [reference], assumptions: input.certificate.assumptions, uncertaintyTransformation: 'The strict positive dominance margin is carried from the observed intervals without narrowing utility uncertainty.', version: 1, reproducibilityHash: hash({ intervals: intervalValue, certificate: input.certificate }) });
  return Object.freeze({ evidence: observationEvidence, observation: observed, witness: proof, decision, derivation: derived });
}

/** Persist the complete issuance in one ledger transaction; replay is idempotent. */
export function issueDecisionToKernel(ledger: EpistemicLedger, input: DecisionKernelIssuanceInput): DecisionKernelIssuance {
  const result = buildDecisionKernelIssuance(input);
  ledger.runInTransaction(() => {
    ledger.appendEvidenceWithinTransaction(result.evidence);
    for (const source of bindings(input.evidence)) ledger.appendEvidenceWithinTransaction(source);
    ledger.appendClaimWithinTransaction(result.observation);
    if (result.witness !== null && result.decision !== null && result.derivation !== null) {
      ledger.appendWitnessWithinTransaction(result.witness);
      ledger.appendClaimWithinTransaction(result.decision);
      ledger.appendDerivationWithinTransaction(result.derivation);
    }
  });
  return result;
}
