/** Narrow coding-realization issuance into the Trusted Epistemic Kernel. */

import { createHash } from 'node:crypto';
import { claim, type Claim } from '../epistemic/claim.ts';
import { evidence, type Evidence } from '../epistemic/evidence.ts';
import { claimProfile, type MonetaryBasisStatus } from '../epistemic/profile.ts';
import { grain } from '../epistemic/grain.ts';
import { scope } from '../epistemic/scope.ts';
import { instant, interval } from '../epistemic/time.ts';
import { canonicalJson } from '../epistemic/serialization.ts';
import { canonicalEconomicAttribution, type EconomicAttribution } from '../economics/attribution.ts';
import { GATE_LADDER, type Gate } from './gates.ts';

export type ValueKernelAppendResult = 'inserted' | 'duplicate';

export interface CodingRealizationKernelInput {
  readonly commitHash: string;
  readonly project: string;
  readonly tsEpochMs: number;
  readonly computedAtMs: number;
  readonly attributedCostUsd: number;
  readonly maturing: boolean;
  readonly realized: boolean;
  readonly unitJson: string;
  readonly costScope: 'project' | 'window' | 'synthetic_demo' | 'legacy_unknown';
}

export interface CodingRealizationKernelIssuance {
  readonly evidence: Evidence;
  readonly claim: Claim;
}

export interface CodingRealizationKernelPersistenceResult {
  readonly evidenceId: string;
  readonly claimId: string;
  readonly evidence: Readonly<{ result: ValueKernelAppendResult }>;
  readonly claim: Readonly<{ result: ValueKernelAppendResult }>;
}

const REALIZATION_ASSUMPTIONS = Object.freeze([
  'Terminal realization means every gate in the declared legacy coding contract was observed pass; it is not a causal or business-value claim.',
  'Git, signal and proposal gates are local Fiscus observations; provider authority, human approval and downstream business outcomes are not established.',
  'The retained effective amount is exact request-lineage spend on the work window, not realized economic value or settlement; a window-scoped amount is project-blind and is not commit-specific cost proof.',
  'Completeness is bounded to the retained Fiscus observation boundary; absence of an unlinked incident is not a universal claim that no incident occurred.',
]);

interface ParsedUnit {
  readonly hash: string;
  readonly subject: string;
  readonly tsEpochMs: number;
  readonly linesAdded: number;
  readonly linesDeleted: number;
  readonly filesChanged: number;
  readonly windowStartMs: number;
  readonly windowEndMs: number;
  readonly taskType: string;
  readonly acceptance: number | null;
  readonly maturing: boolean;
  readonly costStale: boolean;
  readonly reverted: boolean;
  readonly survivalRatio: number;
  readonly funnel: {
    readonly realized: boolean;
    readonly results: ReadonlyArray<{ readonly gate: string; readonly verdict: string }>;
  };
  readonly economic?: unknown;
}

function text(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) throw new Error(`${label} must be a non-empty string`);
  return value.trim();
}

function safeMs(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value)) throw new Error(`${label} must be a safe integer timestamp`);
  let parsed: string;
  try {
    parsed = new Date(value as number).toISOString();
  } catch {
    throw new Error(`${label} is outside the supported timestamp range`);
  }
  if (Date.parse(parsed) !== value) throw new Error(`${label} is outside the supported timestamp range`);
  return value as number;
}

function nonNegativeInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw new Error(`${label} must be a non-negative safe integer`);
  return value as number;
}

function acceptance(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) throw new Error('coding realization acceptance must be null or within [0,1]');
  return value;
}

function ratio(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) throw new Error(`${label} must be finite and within [0,1]`);
  return value;
}

function booleanFlag(value: unknown, label: string): boolean {
  if (typeof value !== 'boolean') throw new Error(`${label} flag is invalid`);
  return value;
}

function parseUnit(unitJson: string): ParsedUnit {
  if (typeof unitJson !== 'string' || unitJson.length === 0) throw new Error('coding realization unit JSON is required');
  let parsed: unknown;
  try {
    parsed = JSON.parse(unitJson);
  } catch (error) {
    throw new Error(`coding realization unit JSON is invalid: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('coding realization unit JSON must be an object');
  const value = parsed as Record<string, unknown>;
  if (value.funnel === undefined && value.economic === undefined) {
    throw new Error('coding realization unit is a legacy snapshot without kernel fields');
  }
  const funnelValue = value.funnel;
  if (funnelValue === null || typeof funnelValue !== 'object' || Array.isArray(funnelValue)) throw new Error('coding realization funnel is invalid');
  const funnelRecord = funnelValue as Record<string, unknown>;
  if (typeof funnelRecord.realized !== 'boolean' || !Array.isArray(funnelRecord.results)) throw new Error('coding realization funnel is invalid');
  if (funnelRecord.results.length !== GATE_LADDER.length) throw new Error(`coding realization funnel must contain exactly ${GATE_LADDER.length} gates`);
  const results = funnelRecord.results.map((item, index) => {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) throw new Error(`coding realization gate ${index} is invalid`);
    const row = item as Record<string, unknown>;
    return { gate: text(row.gate, `coding realization gate ${index} name`), verdict: text(row.verdict, `coding realization gate ${index} verdict`) };
  });
  return {
    hash: text(value.hash, 'coding realization unit hash'),
    subject: text(value.subject, 'coding realization subject'),
    tsEpochMs: safeMs(value.tsEpochMs, 'coding realization unit timestamp'),
    linesAdded: nonNegativeInteger(value.linesAdded, 'coding realization linesAdded'),
    linesDeleted: nonNegativeInteger(value.linesDeleted, 'coding realization linesDeleted'),
    filesChanged: nonNegativeInteger(value.filesChanged, 'coding realization filesChanged'),
    windowStartMs: safeMs(value.windowStartMs, 'coding realization window start'),
    windowEndMs: safeMs(value.windowEndMs, 'coding realization window end'),
    taskType: text(value.taskType, 'coding realization taskType'),
    acceptance: acceptance(value.acceptance),
    maturing: booleanFlag(value.maturing, 'coding realization maturing'),
    costStale: booleanFlag(value.costStale, 'coding realization costStale'),
    reverted: booleanFlag(value.reverted, 'coding realization reverted'),
    survivalRatio: ratio(value.survivalRatio, 'coding realization survivalRatio'),
    funnel: { realized: funnelRecord.realized, results },
    economic: value.economic,
  };
}

function canonicalTimestamp(value: number, label: string): ReturnType<typeof instant> {
  return instant(new Date(safeMs(value, label)).toISOString());
}

function allGatesPass(unit: ParsedUnit): boolean {
  if (!unit.funnel.realized || unit.funnel.results.length !== GATE_LADDER.length) return false;
  return unit.funnel.results.every((result, index) => result.gate === GATE_LADDER[index] && result.verdict === 'pass');
}

function validated(input: CodingRealizationKernelInput): { unit: ParsedUnit; economic: EconomicAttribution; validTime: ReturnType<typeof interval>; computed: ReturnType<typeof instant> } {
  const commitHash = text(input.commitHash, 'coding realization commitHash');
  text(input.project, 'coding realization project');
  const recorded = safeMs(input.computedAtMs, 'coding realization computedAtMs');
  if (input.maturing) throw new Error('coding realization kernel issuance requires a mature unit');
  if (!input.realized) throw new Error('coding realization kernel issuance requires a realized unit');
  if (input.costScope !== 'project' && input.costScope !== 'window') throw new Error('coding realization kernel issuance requires a reproducible spend scope');
  const unit = parseUnit(input.unitJson);
  if (unit.hash !== commitHash) throw new Error('coding realization unit hash does not match its record');
  if (unit.tsEpochMs !== safeMs(input.tsEpochMs, 'coding realization record timestamp')) throw new Error('coding realization timestamp does not match its unit');
  if (unit.windowStartMs >= unit.windowEndMs) throw new Error('coding realization window must have a start before its end');
  if (unit.windowEndMs !== unit.tsEpochMs) throw new Error('coding realization window end must equal the commit timestamp');
  if (recorded < unit.windowEndMs) throw new Error('coding realization computedAtMs must be at or after its attribution window');
  if (unit.maturing || unit.costStale) throw new Error('coding realization kernel issuance requires a current mature unit');
  if (unit.reverted) throw new Error('coding realization kernel issuance refuses a reverted unit');
  if (!allGatesPass(unit)) throw new Error('every legacy realization gate must be pass before kernel issuance');
  if (unit.acceptance === null) throw new Error('coding realization kernel issuance requires an observed acceptance value');
  const economic = canonicalEconomicAttribution(unit.economic);
  if (!economic.complete || economic.unresolvedRequests !== 0) throw new Error('coding realization kernel issuance requires complete exact economic coverage');
  if (economic.amount.currency !== 'USD') throw new Error('coding realization kernel issuance supports USD effective spend only');
  if (!Number.isFinite(input.attributedCostUsd) || input.attributedCostUsd < 0) throw new Error('coding realization attributedCostUsd must be finite and non-negative');
  const projectedCost = Number(economic.amountText);
  if (Number.isFinite(projectedCost) && Math.abs(input.attributedCostUsd - projectedCost) > Math.max(1e-12, Math.abs(projectedCost) * 1e-12)) {
    throw new Error('coding realization compatibility cost disagrees with exact effective amount');
  }
  const validTime = interval(canonicalTimestamp(unit.windowStartMs, 'coding realization window start'), canonicalTimestamp(unit.windowEndMs, 'coding realization window end'));
  const computed = canonicalTimestamp(recorded, 'coding realization computedAtMs');
  return { unit, economic, validTime, computed };
}

function digestPayload(value: unknown): string {
  return `sha256:${createHash('sha256').update(`fiscus.value.realization\n1\n${canonicalJson(value)}`, 'utf8').digest('hex')}`;
}

/** Whether the canonical save path should issue a kernel pair for this record. */
export function codingRealizationKernelEligible(input: CodingRealizationKernelInput): boolean {
  if (input.maturing || !input.realized || (input.costScope !== 'project' && input.costScope !== 'window')) return false;
  let raw: unknown;
  try {
    raw = JSON.parse(input.unitJson);
  } catch (error) {
    throw new Error(`coding realization unit JSON is invalid: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (raw !== null && typeof raw === 'object' && !Array.isArray(raw)) {
    const value = raw as Record<string, unknown>;
    // A legacy snapshot may carry a funnel but predate the exact economic
    // seam. It remains a compatibility record and is not parsed as a kernel
    // candidate; once the economic field exists, malformed lifecycle fields
    // fail closed instead of being treated as safe defaults.
    if (value.economic === undefined) return false;
  }
  const unit = parseUnit(input.unitJson);
  if (unit.economic === undefined) return false;
  const economic = canonicalEconomicAttribution(unit.economic);
  return economic.complete && economic.unresolvedRequests === 0;
}

/** Build a truthful kernel pair for one persisted, exact, mature realization unit. */
export function buildCodingRealizationKernelIssuance(input: CodingRealizationKernelInput): CodingRealizationKernelIssuance {
  const project = text(input.project, 'coding realization project');
  const { unit, economic, validTime, computed } = validated(input);
  const occurredAt = canonicalTimestamp(unit.tsEpochMs, 'coding realization unit timestamp');
  const scopeValue = scope({ project, commit: unit.hash });
  const basis: MonetaryBasisStatus = economic.requestCount > 0 ? 'effective' : 'none';
  const corePayload = {
    commitHash: unit.hash,
    project,
    subject: unit.subject,
    taskType: unit.taskType,
    tsEpochMs: unit.tsEpochMs,
    linesAdded: unit.linesAdded,
    linesDeleted: unit.linesDeleted,
    filesChanged: unit.filesChanged,
    windowStartMs: unit.windowStartMs,
    windowEndMs: unit.windowEndMs,
    computedAtMs: input.computedAtMs,
    spendAttributionScope: input.costScope,
    acceptance: unit.acceptance,
    realized: true,
    gates: GATE_LADDER.map((gate) => ({ gate, verdict: 'pass' as const })),
    economic,
  };
  const realizationDigest = digestPayload(corePayload);
  const payload = { ...corePayload, realizationDigest };
  const evidenceValue = evidence({
    id: `evidence:value:realization:${realizationDigest}`,
    evidenceType: 'value.realization',
    sourceIdentity: 'fiscus:value-realization',
    sourceClass: 'fiscus_local_coding_realization_projection',
    payload: payload as never,
    scope: scopeValue,
    grain: grain(['coding_commit']),
    occurredAt,
    validTime,
    observedAt: computed,
    recordedAt: computed,
    assertedAt: computed,
    finalizedAt: null,
    integrity: 'verified',
    authenticity: 'self_asserted',
    completeness: {
      status: 'complete',
      method: 'coding_realization_funnel',
      coveredEventTypes: ['git_commit', 'proposal_capture', 'gate_signal', 'revert_scan', 'economic_request'],
      coveredScope: scopeValue,
      coveredTime: validTime,
    },
    measurementModelRef: null,
    monetaryBasis: basis === 'none' ? null : 'effective',
    assumptions: REALIZATION_ASSUMPTIONS,
    supersedes: [],
    supersededBy: null,
    revocation: null,
    schemaVersion: 1,
    sensitivity: 'internal',
    redaction: 'none',
  });
  const claimValue = { ...payload };
  const claimValueRecord = claim({
    id: `claim:value:realization:${realizationDigest}`,
    proposition: { predicate: 'value.realization_recorded', value: claimValue as never },
    subject: unit.hash,
    scope: scopeValue,
    grain: grain(['coding_commit']),
    time: { validTime, asOf: computed },
    epistemic: 'supported',
    profile: claimProfile({
      epistemic: 'supported',
      integrity: 'verified',
      authenticity: 'self_asserted',
      scope: 'conditional',
      coverage: 'complete',
      measurement: 'proxy_unvalidated',
      causality: 'none',
      monetaryBasis: basis,
      finality: 'provisional',
      decisionFitness: 'not_assessed',
    }),
    measurementModelRef: null,
    evidenceIds: [evidenceValue.id],
    derivationRule: 'value.realization.v1',
    derivationVersion: 1,
    assumptions: REALIZATION_ASSUMPTIONS,
    uncertainty: { kind: 'qualitative', description: 'All declared coding lifecycle gates and exact request-lineage arithmetic are locally observed; provider authority, causal effect and business value remain unestablished.' },
    causalStatus: 'none',
    monetaryBasis: basis,
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
