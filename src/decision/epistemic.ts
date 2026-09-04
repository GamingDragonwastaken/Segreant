/**
 * Conservative boundary from interval certificates to kernel records.
 *
 * ISSUANCE CLASS: canonical — see `src/epistemic/issuance-map.ts`.
 * A plain engine certificate is not a durable truth or decision claim. This
 * adapter binds the interval observation, the decision-fitness witness, and
 * the derived claim into the same revocable epistemic graph. Persistence is
 * deliberately a certificate bundle only: it carries no action executor and
 * every read reports `canAutoAct: false`.
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

export interface DecisionProblemIdentity {
  readonly id: string;
  readonly version: number;
}

export interface DecisionCertificateValidityInput {
  /** The certificate is issued at the parent input's `issuedAt`. */
  readonly expiresAt?: string | null;
  readonly revalidateAfter?: string | null;
  /** Conditions are retained as requirements; this adapter does not execute them. */
  readonly conditions?: readonly string[];
}

export interface DecisionCertificateValidity {
  readonly issuedAt: Instant;
  readonly expiresAt: Instant | null;
  readonly revalidateAfter: Instant | null;
  readonly conditions: readonly string[];
}

export interface DecisionCertificateDependencies {
  readonly evidenceIds: readonly string[];
  readonly claimIds: readonly string[];
  readonly witnessIds: readonly string[];
  readonly derivationIds: readonly string[];
}

/** A persisted certificate records a selected action but never authorizes it. */
export interface DecisionCertificateActionSemantics {
  readonly mode: 'no_action';
  readonly permitted: false;
  readonly selectedAction: string | null;
}

/**
 * The portable, explicit persistence unit for a decision certificate. The
 * bundle is stored as immutable kernel Evidence and is only readable as a
 * review/revalidation projection.
 */
export interface DecisionCertificateBundle {
  readonly id: string;
  readonly schemaVersion: 1;
  readonly decisionProblem: DecisionProblemIdentity;
  readonly actionSet: readonly ActionUtilityInterval[];
  readonly dependencies: DecisionCertificateDependencies;
  readonly rule: DecisionCertificate['rule'];
  readonly assumptions: readonly string[];
  readonly dominance: DecisionCertificate;
  readonly validity: DecisionCertificateValidity;
  readonly actionSemantics: DecisionCertificateActionSemantics;
}

export interface DecisionKernelIssuanceInput {
  readonly decisionId: string;
  /** Defaults to `{ id: decisionId, version: 1 }` for compatibility. */
  readonly decisionProblem?: DecisionProblemIdentity;
  readonly certificate: DecisionCertificate;
  readonly intervals: ReadonlyArray<ActionUtilityInterval>;
  readonly evidence: ReadonlyArray<DecisionEvidenceBinding>;
  readonly issuedAt: string;
  readonly validity?: DecisionCertificateValidityInput;
}

export interface DecisionKernelIssuance {
  /** The interval observation Evidence retained for the existing adapter contract. */
  readonly evidence: Evidence;
  /** The explicit persisted certificate bundle Evidence. */
  readonly certificateEvidence: Evidence;
  readonly certificateBundle: DecisionCertificateBundle;
  readonly observation: Claim;
  readonly witness: Witness | null;
  readonly decision: Claim | null;
  readonly derivation: Derivation | null;
}

export type DecisionCertificateReadStatus =
  | 'not_yet_issued'
  | 'valid'
  | 'revalidation_required'
  | 'expired'
  | 'invalidated';

export interface DecisionCertificateBundleRead {
  readonly bundle: DecisionCertificateBundle;
  readonly status: DecisionCertificateReadStatus;
  /** Direct bundle/dependency IDs in the as-of revocation projection. */
  readonly invalidatedBy: readonly string[];
  /** Always false: reading a certificate never performs or authorizes action. */
  readonly canAutoAct: false;
}

const DEFAULT_REVALIDATION_CONDITION = 'Required evidence remains available and unrevoked.';
const BUNDLE_SCHEMA_VERSION = 1 as const;

function text(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`${label} must be non-empty`);
  return value.trim();
}

function issuedTime(value: unknown): Instant { return instant(text(value, 'issuedAt')); }
function hash(value: unknown): string { return `sha256:${createHash('sha256').update(canonicalJson(value)).digest('hex')}`; }
function sameJson(a: unknown, b: unknown): boolean { return canonicalJson(a) === canonicalJson(b); }

function assertKnownKeys(value: unknown, allowed: ReadonlySet<string>, label: string): void {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`);
  for (const key of Object.keys(value)) if (!allowed.has(key)) throw new Error(`${label} contains unknown field: ${key}`);
}

function normalizedIntervals(input: ReadonlyArray<ActionUtilityInterval>): readonly ActionUtilityInterval[] {
  if (!Array.isArray(input) || input.length === 0) throw new Error('at least one action utility interval is required');
  const normalized = input.map((item, index) => {
    if (item === null || typeof item !== 'object') throw new Error(`action utility interval ${index} must be an object`);
    return Object.freeze({
      action: text(item.action, `action utility interval ${index} action`),
      low: item.low,
      high: item.high,
    });
  });
  // The engine remains the authority for finite bounds, duplicate actions and
  // low <= high. Re-running it here also normalizes the bundle boundary.
  certifyDecision(normalized);
  return Object.freeze(normalized);
}

function validatedCertificate(
  certificate: DecisionCertificate,
  inputIntervals: ReadonlyArray<ActionUtilityInterval>,
): { intervals: readonly ActionUtilityInterval[]; certificate: DecisionCertificate } {
  if (certificate === null || typeof certificate !== 'object') throw new Error('decision certificate must be an object');
  const intervals = normalizedIntervals(inputIntervals);
  const recomputed = certifyDecision(intervals);
  if (!sameJson(certificate, recomputed)) throw new Error('decision certificate does not match action utility intervals');
  return { intervals, certificate: recomputed };
}

function bindings(input: ReadonlyArray<DecisionEvidenceBinding>): readonly Evidence[] {
  if (!Array.isArray(input) || input.length === 0) throw new Error('at least one evidence binding is required');
  const ids = new Set<string>();
  return Object.freeze(input.map((candidate, index) => {
    const isBinding = candidate !== null && typeof candidate === 'object' && 'record' in candidate;
    const record = isBinding ? (candidate as EvidenceBinding).record : candidate as Evidence;
    const declared = isBinding ? (candidate as EvidenceBinding).id : (record as Evidence).id;
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

function decisionProblem(value: unknown, fallbackId: string): DecisionProblemIdentity {
  if (value === undefined) return Object.freeze({ id: fallbackId, version: 1 });
  assertKnownKeys(value, new Set(['id', 'version']), 'decisionProblem');
  const record = value as { id?: unknown; version?: unknown };
  const id = text(record.id, 'decisionProblem id');
  if (!Number.isSafeInteger(record.version) || (record.version as number) < 1) {
    throw new Error('decisionProblem version must be a positive safe integer');
  }
  return Object.freeze({ id, version: record.version as number });
}

function optionalInstant(value: unknown, label: string): Instant | null {
  if (value === undefined || value === null) return null;
  return instant(text(value, label));
}

function stringList(value: unknown, label: string, required = false, defaultValue: readonly string[] = []): readonly string[] {
  if (value === undefined) {
    if (required && defaultValue.length === 0) throw new Error(`${label} must contain at least one entry`);
    return Object.freeze([...defaultValue]);
  }
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  const seen = new Set<string>();
  const output = value.map((item, index) => {
    const itemValue = text(item, `${label}[${index}]`);
    if (seen.has(itemValue)) throw new Error(`duplicate ${label} entry: ${itemValue}`);
    seen.add(itemValue);
    return itemValue;
  });
  if (required && output.length === 0) throw new Error(`${label} must contain at least one entry`);
  return Object.freeze(output);
}

function validity(value: unknown, issuedAt: Instant): DecisionCertificateValidity {
  if (value !== undefined) assertKnownKeys(value, new Set(['expiresAt', 'revalidateAfter', 'conditions']), 'certificate validity');
  const record = value === undefined ? {} : value as { expiresAt?: unknown; revalidateAfter?: unknown; conditions?: unknown };
  const expiresAt = optionalInstant(record.expiresAt, 'certificate validity expiresAt');
  const revalidateAfter = optionalInstant(record.revalidateAfter, 'certificate validity revalidateAfter');
  const issuedMs = Date.parse(issuedAt);
  if (expiresAt !== null && Date.parse(expiresAt) <= issuedMs) throw new Error('certificate validity expiresAt must be after issuedAt');
  if (revalidateAfter !== null && Date.parse(revalidateAfter) <= issuedMs) throw new Error('certificate validity revalidateAfter must be after issuedAt');
  if (expiresAt !== null && revalidateAfter !== null && Date.parse(revalidateAfter) > Date.parse(expiresAt)) {
    throw new Error('certificate validity revalidateAfter must not be after expiresAt');
  }
  const conditions = stringList(
    record.conditions,
    'certificate validity conditions',
    true,
    [DEFAULT_REVALIDATION_CONDITION],
  );
  return Object.freeze({ issuedAt, expiresAt, revalidateAfter, conditions });
}

function dependencies(
  evidenceIds: readonly string[],
  claimIds: readonly string[],
  witnessIds: readonly string[],
  derivationIds: readonly string[],
): DecisionCertificateDependencies {
  return Object.freeze({
    evidenceIds: stringList(evidenceIds, 'certificate evidence dependencies', true),
    claimIds: stringList(claimIds, 'certificate claim dependencies', true),
    witnessIds: stringList(witnessIds, 'certificate witness dependencies'),
    derivationIds: stringList(derivationIds, 'certificate derivation dependencies'),
  });
}

/** Build records without persistence; all decisions are recomputed and fail closed. */
export function buildDecisionKernelIssuance(input: DecisionKernelIssuanceInput): DecisionKernelIssuance {
  const decisionId = text(input.decisionId, 'decisionId');
  const at = issuedTime(input.issuedAt);
  const problem = decisionProblem(input.decisionProblem, decisionId);
  const checked = validatedCertificate(input.certificate, input.intervals);
  const source = bindings(input.evidence);
  const coordinate = coordinates(decisionId);
  const validityRecord = validity(input.validity, at);
  const validTime = interval(
    source.reduce((min, item) => item.validTime?.from && item.validTime.from < min ? item.validTime.from : min, source[0]!.validTime?.from ?? at),
    source.reduce((max, item) => item.validTime?.to && item.validTime.to > max ? item.validTime.to : max, source[0]!.validTime?.to ?? at),
  );
  const intervalValue = checked.intervals.map((item) => Object.freeze({ action: item.action, low: item.low, high: item.high }));
  const sourceIds = source.map((item) => item.id);
  const observationId = `claim:decision:utility:${decisionId}`;
  const decisionClaimId = `claim:decision:fitness:${decisionId}`;
  const observationEvidenceId = `evidence:decision:utility:${decisionId}`;
  const certificateEvidenceId = `evidence:decision:certificate:${decisionId}`;
  const witnessId = `witness:decision:fitness:${decisionId}`;
  const derivationId = `derivation:decision:fitness:${decisionId}`;
  const decisionClaimIds = checked.certificate.status === 'proven_dominant'
    ? [observationId, decisionClaimId]
    : [observationId];
  const certificateBundle = Object.freeze({
    id: certificateEvidenceId,
    schemaVersion: BUNDLE_SCHEMA_VERSION,
    decisionProblem: problem,
    actionSet: checked.intervals,
    dependencies: dependencies(
      [observationEvidenceId, ...sourceIds],
      decisionClaimIds,
      checked.certificate.status === 'proven_dominant' ? [witnessId] : [],
      checked.certificate.status === 'proven_dominant' ? [derivationId] : [],
    ),
    rule: checked.certificate.rule,
    assumptions: Object.freeze([...checked.certificate.assumptions]),
    dominance: checked.certificate,
    validity: validityRecord,
    actionSemantics: Object.freeze({
      mode: 'no_action' as const,
      permitted: false as const,
      selectedAction: checked.certificate.action,
    }),
  });
  const observationEvidence = evidence({
    id: observationEvidenceId,
    evidenceType: 'decision.utility_interval',
    sourceIdentity: 'fiscus:decision-engine',
    sourceClass: 'fiscus_local_interval_certificate',
    payload: { decisionProblem: problem, decisionId, intervals: intervalValue, certificate: checked.certificate } as never,
    scope: coordinate.scope,
    grain: coordinate.grain,
    occurredAt: at,
    validTime,
    observedAt: at,
    recordedAt: at,
    assertedAt: at,
    finalizedAt: null,
    integrity: 'verified',
    authenticity: 'self_asserted',
    completeness: { status: 'complete', method: 'explicit_action_interval_set', coveredEventTypes: ['decision_utility_interval'], coveredScope: coordinate.scope, coveredTime: validTime },
    measurementModelRef: null,
    monetaryBasis: null,
    assumptions: checked.certificate.assumptions,
    supersedes: [],
    supersededBy: null,
    revocation: null,
    schemaVersion: 1,
    sensitivity: 'internal',
    redaction: 'none',
  });
  const certificateEvidence = evidence({
    id: certificateEvidenceId,
    evidenceType: 'decision.certificate_bundle',
    sourceIdentity: 'fiscus:decision-engine',
    sourceClass: 'fiscus_decision_certificate_bundle',
    payload: certificateBundle as never,
    scope: coordinate.scope,
    grain: coordinate.grain,
    occurredAt: at,
    validTime,
    observedAt: at,
    recordedAt: at,
    assertedAt: at,
    finalizedAt: null,
    integrity: 'verified',
    authenticity: 'self_asserted',
    completeness: { status: 'complete', method: 'explicit_certificate_bundle', coveredEventTypes: ['decision.utility_interval', 'decision.certificate'], coveredScope: coordinate.scope, coveredTime: validTime },
    measurementModelRef: null,
    monetaryBasis: null,
    assumptions: checked.certificate.assumptions,
    supersedes: [],
    supersededBy: null,
    revocation: null,
    schemaVersion: 1,
    sensitivity: 'internal',
    redaction: 'none',
  });
  const observation = claim({
    id: observationId,
    proposition: { predicate: 'decision.utility_interval_observed', value: { decisionProblem: problem, decisionId, intervals: intervalValue, certificate: checked.certificate, certificateBundleId: certificateBundle.id } as never },
    subject: decisionId,
    scope: coordinate.scope,
    grain: coordinate.grain,
    time: { validTime, asOf: at },
    epistemic: 'supported',
    profile: claimProfile({ epistemic: 'supported', integrity: 'verified', authenticity: 'self_asserted', scope: 'conditional', coverage: 'complete', measurement: 'proxy_unvalidated', causality: 'none', monetaryBasis: 'none', finality: 'provisional', decisionFitness: 'insufficient' }),
    evidenceIds: [certificateEvidence.id, observationEvidence.id, ...sourceIds],
    derivationRule: 'decision.utility_interval_observation.v1',
    derivationVersion: 1,
    assumptions: checked.certificate.assumptions,
    uncertainty: { kind: 'interval', lower: null, upper: null, description: 'Declared action utility intervals; no utility point estimate is inferred.' },
    causalStatus: 'none',
    monetaryBasis: 'none',
    finality: 'provisional',
    issuedAt: at,
    supersedes: [],
    supersededBy: null,
    revocation: null,
    decisionCertificateIds: [],
    schemaVersion: 1,
  });
  if (checked.certificate.status !== 'proven_dominant') {
    return Object.freeze({ evidence: observationEvidence, certificateEvidence, certificateBundle, observation, witness: null, decision: null, derivation: null });
  }
  const decision = claim({
    id: decisionClaimId,
    proposition: { predicate: 'decision.fitness_sufficient', value: { decisionProblem: problem, decisionId, action: checked.certificate.action, margin: checked.certificate.margin, certificate: checked.certificate, certificateBundleId: certificateBundle.id } as never },
    subject: decisionId,
    scope: coordinate.scope,
    grain: coordinate.grain,
    time: { validTime, asOf: at },
    epistemic: 'supported',
    profile: claimProfile({ epistemic: 'supported', integrity: 'verified', authenticity: 'self_asserted', scope: 'conditional', coverage: 'complete', measurement: 'proxy_unvalidated', causality: 'none', monetaryBasis: 'none', finality: 'provisional', decisionFitness: 'sufficient' }),
    measurementModelRef: null,
    evidenceIds: [certificateEvidence.id, observationEvidence.id, ...sourceIds],
    derivationRule: 'decision.strict_interval_dominance.v1',
    derivationVersion: 1,
    assumptions: checked.certificate.assumptions,
    uncertainty: { kind: 'interval', lower: null, upper: null, description: 'Strict positive lower-bound margin over every rival upper bound.' },
    causalStatus: 'none',
    monetaryBasis: 'none',
    finality: 'provisional',
    issuedAt: at,
    supersedes: [],
    supersededBy: null,
    revocation: null,
    decisionCertificateIds: [certificateBundle.id],
    schemaVersion: 1,
  });
  const proof = witness({
    id: witnessId,
    kind: 'decision_fitness',
    evidenceIds: [certificateEvidence.id, observationEvidence.id, ...sourceIds],
    detail: 'Strict interval dominance was recomputed from the bound utility intervals and the certificate matched exactly; no action was executed or authorized.',
    issuedAt: at,
    epistemic: 'supported',
    schemaVersion: 1,
  });
  const reference: DerivationWitness = { id: proof.id, kind: proof.kind, evidenceIds: proof.evidenceIds, detail: proof.detail };
  const outputValue = decision.proposition.value;
  const derived = derivation({
    id: derivationId,
    inputEvidenceIds: [certificateEvidence.id, observationEvidence.id, ...sourceIds],
    inputClaimIds: [observation.id],
    transformation: 'decision.strict_interval_dominance.v1',
    outputClaimId: decision.id,
    outputProposition: { predicate: 'decision.fitness_sufficient', value: outputValue },
    coordinateChange: { from: coordinate, to: coordinate },
    witnesses: [reference],
    assumptions: checked.certificate.assumptions,
    uncertaintyTransformation: 'The strict positive dominance margin is carried from the observed intervals without narrowing utility uncertainty.',
    version: 1,
    reproducibilityHash: hash({ decisionProblem: problem, intervals: intervalValue, certificate: checked.certificate, validity: validityRecord }),
  });
  return Object.freeze({ evidence: observationEvidence, certificateEvidence, certificateBundle, observation, witness: proof, decision, derivation: derived });
}

/** Persist the complete issuance in one ledger transaction; replay is idempotent. */
export function issueDecisionToKernel(ledger: EpistemicLedger, input: DecisionKernelIssuanceInput): DecisionKernelIssuance {
  const result = buildDecisionKernelIssuance(input);
  ledger.runInTransaction(() => {
    for (const source of bindings(input.evidence)) ledger.appendEvidenceWithinTransaction(source);
    ledger.appendEvidenceWithinTransaction(result.evidence);
    ledger.appendEvidenceWithinTransaction(result.certificateEvidence);
    ledger.appendClaimWithinTransaction(result.observation);
    if (result.witness !== null && result.decision !== null && result.derivation !== null) {
      ledger.appendWitnessWithinTransaction(result.witness);
      ledger.appendClaimWithinTransaction(result.decision);
      ledger.appendDerivationWithinTransaction(result.derivation);
    }
  });
  return result;
}

const BUNDLE_KEYS = new Set([
  'id', 'schemaVersion', 'decisionProblem', 'actionSet', 'dependencies', 'rule', 'assumptions',
  'dominance', 'validity', 'actionSemantics',
]);
const PROBLEM_KEYS = new Set(['id', 'version']);
const DEPENDENCY_KEYS = new Set(['evidenceIds', 'claimIds', 'witnessIds', 'derivationIds']);
const VALIDITY_KEYS = new Set(['issuedAt', 'expiresAt', 'revalidateAfter', 'conditions']);
const ACTION_SEMANTICS_KEYS = new Set(['mode', 'permitted', 'selectedAction']);

function storedProblem(value: unknown): DecisionProblemIdentity {
  assertKnownKeys(value, PROBLEM_KEYS, 'stored decisionProblem');
  const record = value as { id?: unknown; version?: unknown };
  const id = text(record.id, 'stored decisionProblem id');
  if (!Number.isSafeInteger(record.version) || (record.version as number) < 1) throw new Error('stored decisionProblem version is invalid');
  return Object.freeze({ id, version: record.version as number });
}

function storedValidity(value: unknown): DecisionCertificateValidity {
  assertKnownKeys(value, VALIDITY_KEYS, 'stored certificate validity');
  const record = value as { issuedAt?: unknown; expiresAt?: unknown; revalidateAfter?: unknown; conditions?: unknown };
  const issuedAt = instant(text(record.issuedAt, 'stored certificate validity issuedAt'));
  const expiresAt = optionalInstant(record.expiresAt, 'stored certificate validity expiresAt');
  const revalidateAfter = optionalInstant(record.revalidateAfter, 'stored certificate validity revalidateAfter');
  if (expiresAt !== null && Date.parse(expiresAt) <= Date.parse(issuedAt)) throw new Error('stored certificate validity expiresAt is invalid');
  if (revalidateAfter !== null && Date.parse(revalidateAfter) <= Date.parse(issuedAt)) throw new Error('stored certificate validity revalidateAfter is invalid');
  if (expiresAt !== null && revalidateAfter !== null && Date.parse(revalidateAfter) > Date.parse(expiresAt)) throw new Error('stored certificate validity ordering is invalid');
  return Object.freeze({
    issuedAt,
    expiresAt,
    revalidateAfter,
    conditions: stringList(record.conditions, 'stored certificate validity conditions', true),
  });
}

function storedDependencies(value: unknown): DecisionCertificateDependencies {
  assertKnownKeys(value, DEPENDENCY_KEYS, 'stored certificate dependencies');
  const record = value as { evidenceIds?: unknown; claimIds?: unknown; witnessIds?: unknown; derivationIds?: unknown };
  return dependencies(
    stringList(record.evidenceIds, 'stored certificate evidence dependencies', true),
    stringList(record.claimIds, 'stored certificate claim dependencies', true),
    stringList(record.witnessIds, 'stored certificate witness dependencies'),
    stringList(record.derivationIds, 'stored certificate derivation dependencies'),
  );
}

function storedActionSemantics(value: unknown, selectedAction: string | null): DecisionCertificateActionSemantics {
  assertKnownKeys(value, ACTION_SEMANTICS_KEYS, 'stored certificate actionSemantics');
  const record = value as { mode?: unknown; permitted?: unknown; selectedAction?: unknown };
  if (record.mode !== 'no_action' || record.permitted !== false) throw new Error('stored decision certificate must have explicit no_action semantics');
  const action = record.selectedAction === null ? null : text(record.selectedAction, 'stored certificate selectedAction');
  if (action !== selectedAction) throw new Error('stored certificate selectedAction does not match dominance');
  return Object.freeze({ mode: 'no_action', permitted: false, selectedAction: action });
}

function storedBundle(value: unknown): DecisionCertificateBundle {
  assertKnownKeys(value, BUNDLE_KEYS, 'stored decision certificate bundle');
  const record = value as {
    id?: unknown;
    schemaVersion?: unknown;
    decisionProblem?: unknown;
    actionSet?: unknown;
    dependencies?: unknown;
    rule?: unknown;
    assumptions?: unknown;
    dominance?: unknown;
    validity?: unknown;
    actionSemantics?: unknown;
  };
  const id = text(record.id, 'stored decision certificate bundle id');
  if (record.schemaVersion !== BUNDLE_SCHEMA_VERSION) throw new Error('stored decision certificate bundle schemaVersion is unsupported');
  const problem = storedProblem(record.decisionProblem);
  if (!Array.isArray(record.actionSet)) throw new Error('stored decision certificate actionSet must be an array');
  const actionSet = normalizedIntervals(record.actionSet as ReadonlyArray<ActionUtilityInterval>);
  const dominance = record.dominance as DecisionCertificate;
  const recomputed = certifyDecision(actionSet);
  if (!sameJson(dominance, recomputed)) throw new Error('stored decision certificate dominance does not match actionSet');
  const rule = text(record.rule, 'stored decision certificate rule');
  if (rule !== recomputed.rule) throw new Error('stored decision certificate rule does not match dominance');
  const assumptions = stringList(record.assumptions, 'stored decision certificate assumptions', true);
  if (!sameJson(assumptions, recomputed.assumptions)) throw new Error('stored decision certificate assumptions do not match dominance');
  return Object.freeze({
    id,
    schemaVersion: BUNDLE_SCHEMA_VERSION,
    decisionProblem: problem,
    actionSet,
    dependencies: storedDependencies(record.dependencies),
    rule: recomputed.rule,
    assumptions,
    dominance: recomputed,
    validity: storedValidity(record.validity),
    actionSemantics: storedActionSemantics(record.actionSemantics, recomputed.action),
  });
}

function ensureBundleDependencies(ledger: EpistemicLedger, bundle: DecisionCertificateBundle): void {
  for (const id of bundle.dependencies.evidenceIds) {
    if (ledger.readEvidence(id) === null) throw new Error(`decision certificate has unknown evidence dependency: ${id}`);
  }
  for (const id of bundle.dependencies.claimIds) {
    if (ledger.readClaim(id) === null) throw new Error(`decision certificate has unknown claim dependency: ${id}`);
  }
  for (const id of bundle.dependencies.witnessIds) {
    if (ledger.readWitness(id) === null) throw new Error(`decision certificate has unknown witness dependency: ${id}`);
  }
  for (const id of bundle.dependencies.derivationIds) {
    if (ledger.readDerivation(id) === null) throw new Error(`decision certificate has unknown derivation dependency: ${id}`);
  }
}

/**
 * Read a persisted certificate bundle at one immutable knowledge boundary.
 *
 * The read revalidates the canonical bundle, checks every recorded dependency,
 * projects revocation at `asOf`, and reports expiry/revalidation state. It does
 * not execute, approve, route, or mutate anything; `canAutoAct` is always false.
 */
export function readDecisionCertificateBundle(
  ledger: EpistemicLedger,
  bundleId: string,
  asOf: string,
): DecisionCertificateBundleRead | null {
  const id = text(bundleId, 'decision certificate bundle id');
  const boundary = instant(text(asOf, 'decision certificate read asOf'));
  const record = ledger.readEvidence(id);
  if (record === null) return null;
  if (record.evidenceType !== 'decision.certificate_bundle') throw new Error(`evidence ${id} is not a decision certificate bundle`);
  const bundle = storedBundle(record.payload);
  if (bundle.id !== id) throw new Error(`decision certificate bundle ${id} failed physical identity verification`);
  ensureBundleDependencies(ledger, bundle);

  const projection = ledger.revocationProjectionAsOf(boundary);
  const revoked = new Set(projection.revokedIds);
  const trackedIds = [
    bundle.id,
    ...bundle.dependencies.evidenceIds,
    ...bundle.dependencies.claimIds,
    ...bundle.dependencies.witnessIds,
    ...bundle.dependencies.derivationIds,
  ];
  const invalidatedBy = [...new Set(trackedIds.filter((candidate) => revoked.has(candidate)))].sort((a, b) => a.localeCompare(b));
  const boundaryMs = Date.parse(boundary);
  const issuedMs = Date.parse(bundle.validity.issuedAt);
  let status: DecisionCertificateReadStatus;
  if (invalidatedBy.length > 0) status = 'invalidated';
  else if (boundaryMs < issuedMs) status = 'not_yet_issued';
  else if (bundle.validity.expiresAt !== null && boundaryMs >= Date.parse(bundle.validity.expiresAt)) status = 'expired';
  else if (bundle.validity.revalidateAfter !== null && boundaryMs >= Date.parse(bundle.validity.revalidateAfter)) status = 'revalidation_required';
  else status = 'valid';
  return Object.freeze({
    bundle,
    status,
    invalidatedBy: Object.freeze(invalidatedBy),
    canAutoAct: false as const,
  });
}
