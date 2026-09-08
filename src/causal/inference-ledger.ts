/**
 * An account of the inferential looks a study has been subjected to.
 *
 * `estimate.ts` is a pure function of the evidence it is handed, which is the
 * right shape for an estimator and the reason it cannot answer the question a
 * reader most needs answered: how many times has someone already asked this?
 * Ten looks at one accumulating study produce ten `CausalStudyEstimate` values
 * whose disclosure text is byte-identical, and the tenth can cross the
 * pre-registered decision rule that the ninth refused. Nothing on that tenth
 * result says nine looks preceded it, so its stated 97.50% endpoint confidence
 * reads as though it were the only question ever asked. It was not.
 *
 * This module does not fix that by adjusting the interval. Widening a number
 * after the fact would replace one unstated assumption with another, and the
 * whole point of the pre-registered rule in `estimate.ts` is that the caller
 * cannot choose the level after seeing the data. What it does instead is
 * record every inferential act and put the resulting arithmetic ON the result,
 * next to the interval, so the reported number and the reason to discount it
 * arrive together.
 *
 * Three things are deliberately withheld:
 *
 * - No corrected interval and no corrected p-value. The single-look decision is
 *   reported exactly as the estimator produced it; the ledger reports separately
 *   whether that decision survives the multiplicity, and says so in words.
 * - No family-wise GUARANTEE without a pre-registered plan. A Bonferroni
 *   allocation over a count discovered after the fact is not error control, it
 *   is arithmetic dressed as error control. Without a plan the ledger reports a
 *   union bound over exactly the acts it recorded, and says that is all it is.
 * - No claim of completeness. An estimate produced outside this ledger is
 *   invisible to it. The act chain makes a REMOVED act detectable; it cannot
 *   make an unrecorded one detectable, and it does not pretend to.
 */

import { estimateCausalStudy } from './estimate.ts';
import { canonicalJson, sha256 } from './protocol.ts';
import type {
  CausalQualification,
  CausalStudyData,
  CausalStudyEstimate,
  CommittedCausalStudyProtocol,
} from './types.ts';

export const CAUSAL_INFERENCE_LEDGER_TYPE = 'fiscus.causal-inference-ledger' as const;
export const CAUSAL_INFERENCE_LEDGER_VERSION = 1 as const;

export const DEFAULT_INFERENCE_SLICE_ID = 'slice:registered_population';

/**
 * Alphas arrive from division (`(1 - level) / endpointCount`) on both sides of
 * this comparison, so an exact `<=` rejects a plan the act genuinely satisfies
 * by a couple of units in the last binary place. The tolerance is deliberately
 * far below any alpha anyone registers and far above that representation error.
 */
const ALPHA_COMPARISON_TOLERANCE = 1e-9;

/** An endpoint is only ever one the protocol's registered family names. */
export type InferentialEndpoint = 'cost' | 'quality' | 'net_benefit';

/**
 * `interval_report` produced a number a reader could act on and therefore had a
 * chance to be wrong. `non_estimating_read` looked at the study while it was
 * still collecting or structurally invalid: a look worth recording, because
 * looking is how optional stopping happens, but not one that spends error
 * budget because no interval was reported.
 */
export type InferentialActKind = 'interval_report' | 'non_estimating_read';

/**
 * `identical_repeat` means an act with the same estimand, endpoint, slice and
 * evidence digest is already recorded. Re-reading unchanged evidence is a
 * deterministic re-read of one answer, not a second chance to be wrong, so it
 * is recorded as history and excluded from the error arithmetic.
 */
export type InferentialActNovelty = 'first_of_key' | 'identical_repeat';

export interface RecordedInferentialAct {
  sequence: number;
  lookSequence: number;
  studyId: string;
  protocolHash: string;
  estimandId: string | null;
  endpoint: InferentialEndpoint;
  sliceId: string;
  evidenceDigest: string;
  includedUnits: number;
  kind: InferentialActKind;
  novelty: InferentialActNovelty;
  actAlpha: number;
  reportedAtMs: number;
  previousActDigest: string;
  actDigest: string;
}

/**
 * A plan is registered before the first act or it is not a plan. It bounds the
 * family that error control has to cover: how many times the study will be
 * looked at, how many endpoints each look reports, and which slices are in
 * scope. Everything the ledger can say with a family-wise guarantee depends on
 * this being fixed in advance.
 */
export interface CausalInferencePlan {
  declaredAtMs: number;
  maxLooks: number;
  endpointsPerLook: number;
  sliceIds: readonly string[];
  targetFamilywiseErrorRate: number;
}

export interface CausalInferencePlanDisclosure extends CausalInferencePlan {
  plannedActs: number;
  requiredActAlpha: number;
  requiredActConfidenceLevel: number;
  actAlphaMeetsPlan: boolean;
  actsExceedPlan: boolean;
}

export interface CausalInferenceLedger {
  type: typeof CAUSAL_INFERENCE_LEDGER_TYPE;
  version: typeof CAUSAL_INFERENCE_LEDGER_VERSION;
  studyId: string;
  protocolHash: string;
  plan: CausalInferencePlan | null;
  acts: readonly RecordedInferentialAct[];
  genesisDigest: string;
  ledgerDigest: string;
}

export interface CausalInferenceMultiplicity {
  looks: number;
  intervalReportingActs: number;
  identicalRepeatActs: number;
  nonEstimatingReads: number;
  actsInErrorBudget: number;
  endpoints: number;
  slices: number;
  /** The nominal per-act error of the most recent interval-reporting act. */
  actAlpha: number | null;
  actConfidenceLevel: number | null;
  familywiseErrorUpperBound: number | null;
  simultaneousConfidenceLowerBound: number | null;
  basis: 'pre_registered_plan' | 'recorded_acts_only';
  plan: CausalInferencePlanDisclosure | null;
  chainIntact: boolean;
  assumptions: readonly string[];
  limitations: readonly string[];
}

export interface CausalStudyInferenceReport {
  estimate: CausalStudyEstimate;
  multiplicity: CausalInferenceMultiplicity;
  claimAfterMultiplicity: CausalStudyEstimate['allowedClaim'];
  claimAfterMultiplicityReason: string | null;
}

export interface CausalStudyReportContext {
  reportedAtMs: number;
  sliceId?: string;
}

function digestOf(domain: string, material: unknown): string {
  return 'sha256:' + sha256(domain + '\n' + String(CAUSAL_INFERENCE_LEDGER_VERSION) + '\n' + canonicalJson(material));
}

function positiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function validatePlan(plan: CausalInferencePlan): void {
  if (!positiveInteger(plan.maxLooks)) throw new Error('inference plan maxLooks must be a positive integer');
  if (!positiveInteger(plan.endpointsPerLook)) throw new Error('inference plan endpointsPerLook must be a positive integer');
  if (!Array.isArray(plan.sliceIds) || plan.sliceIds.length === 0
      || plan.sliceIds.some((sliceId) => typeof sliceId !== 'string' || sliceId.length === 0)) {
    throw new Error('inference plan must register at least one non-empty slice id');
  }
  if (new Set(plan.sliceIds).size !== plan.sliceIds.length) {
    throw new Error('inference plan slice ids must be unique');
  }
  if (typeof plan.targetFamilywiseErrorRate !== 'number'
      || !Number.isFinite(plan.targetFamilywiseErrorRate)
      || plan.targetFamilywiseErrorRate <= 0
      || plan.targetFamilywiseErrorRate >= 1) {
    throw new Error('inference plan targetFamilywiseErrorRate must be in (0,1)');
  }
  if (!Number.isSafeInteger(plan.declaredAtMs) || plan.declaredAtMs <= 0) {
    throw new Error('inference plan declaredAtMs must be a positive integer timestamp');
  }
}

/** The size of the family the plan committed to cover, before any act is taken. */
export function plannedInferenceActs(plan: CausalInferencePlan): number {
  return plan.maxLooks * plan.endpointsPerLook * plan.sliceIds.length;
}

/**
 * The per-act error a registered plan can afford. This is a Bonferroni
 * allocation, which is only error control because the denominator was fixed
 * before the looks were taken; the same arithmetic applied to a count
 * discovered afterwards would be a rationalisation.
 */
export function requiredActAlphaForPlan(plan: CausalInferencePlan): number {
  return plan.targetFamilywiseErrorRate / plannedInferenceActs(plan);
}

export function openCausalInferenceLedger(input: {
  studyId: string;
  protocolHash: string;
  plan?: CausalInferencePlan | null;
}): CausalInferenceLedger {
  const plan = input.plan ?? null;
  if (plan !== null) validatePlan(plan);
  const genesisDigest = digestOf('fiscus.causal.inference-ledger', {
    studyId: input.studyId,
    protocolHash: input.protocolHash,
    plan: plan === null ? null : { ...plan, sliceIds: [...plan.sliceIds] },
  });
  return Object.freeze({
    type: CAUSAL_INFERENCE_LEDGER_TYPE,
    version: CAUSAL_INFERENCE_LEDGER_VERSION,
    studyId: input.studyId,
    protocolHash: input.protocolHash,
    plan: plan === null ? null : Object.freeze({ ...plan, sliceIds: Object.freeze([...plan.sliceIds]) }),
    acts: Object.freeze([]),
    genesisDigest,
    ledgerDigest: genesisDigest,
  });
}

/**
 * The exact evidence an act consumed, reduced to one digest. Two acts that
 * consumed the same rows produce the same digest and are therefore recognised
 * as a re-read rather than a second look; one more completed unit changes it.
 */
export function causalStudyEvidenceDigest(
  protocol: CommittedCausalStudyProtocol,
  qualification: CausalQualification,
): string {
  return digestOf('fiscus.causal.inference-evidence', {
    protocolHash: protocol.protocolHash,
    state: qualification.state,
    evidenceGrade: qualification.evidenceGrade,
    countsByArm: qualification.countsByArm,
    includedDecisionIds: [...qualification.includedDecisionIds].sort(),
  });
}

function actMaterial(act: Omit<RecordedInferentialAct, 'actDigest'>): Record<string, unknown> {
  return {
    sequence: act.sequence,
    lookSequence: act.lookSequence,
    studyId: act.studyId,
    protocolHash: act.protocolHash,
    estimandId: act.estimandId,
    endpoint: act.endpoint,
    sliceId: act.sliceId,
    evidenceDigest: act.evidenceDigest,
    includedUnits: act.includedUnits,
    kind: act.kind,
    novelty: act.novelty,
    actAlpha: act.actAlpha,
    reportedAtMs: act.reportedAtMs,
    previousActDigest: act.previousActDigest,
  };
}

function actKey(act: Pick<RecordedInferentialAct, 'estimandId' | 'endpoint' | 'sliceId' | 'evidenceDigest'>): string {
  return canonicalJson([act.estimandId, act.endpoint, act.sliceId, act.evidenceDigest]);
}

/**
 * Append the acts of one look. The caller does not get to choose the sequence,
 * the previous digest, or whether an act counts as novel: all three are derived
 * from what is already recorded, so a caller cannot record a tenth look as
 * though it were the first.
 */
export function recordInferentialActs(
  ledger: CausalInferenceLedger,
  acts: ReadonlyArray<{
    endpoint: InferentialEndpoint;
    sliceId: string;
    evidenceDigest: string;
    estimandId: string | null;
    includedUnits: number;
    kind: InferentialActKind;
    actAlpha: number;
    reportedAtMs: number;
  }>,
): CausalInferenceLedger {
  // `validatePlan` refuses an empty slice id inside a plan, and this path
  // accepted one -- so an act could be keyed on no slice identity at all while
  // the plan describing it could not. `actKey` includes the slice, so a blank
  // one is not a harmless default: it is an identity two unrelated acts can
  // share.
  for (const act of acts) {
    if (typeof act.sliceId !== 'string' || act.sliceId.trim().length === 0) {
      throw new Error('inferential act must name a non-empty slice id; a slice is part of the act identity, not a label');
    }
  }

  const seenKeys = new Set(ledger.acts.map(actKey));
  const lookSequence = (ledger.acts[ledger.acts.length - 1]?.lookSequence ?? 0) + 1;
  const recorded: RecordedInferentialAct[] = [];
  let previousActDigest = ledger.ledgerDigest;
  let sequence = ledger.acts.length;
  for (const act of acts) {
    sequence += 1;
    const novelty: InferentialActNovelty = seenKeys.has(actKey(act)) ? 'identical_repeat' : 'first_of_key';
    seenKeys.add(actKey(act));
    const core: Omit<RecordedInferentialAct, 'actDigest'> = {
      sequence,
      lookSequence,
      studyId: ledger.studyId,
      protocolHash: ledger.protocolHash,
      estimandId: act.estimandId,
      endpoint: act.endpoint,
      sliceId: act.sliceId,
      evidenceDigest: act.evidenceDigest,
      includedUnits: act.includedUnits,
      kind: act.kind,
      novelty,
      actAlpha: act.actAlpha,
      reportedAtMs: act.reportedAtMs,
      previousActDigest,
    };
    const actDigest = digestOf('fiscus.causal.inference-act', actMaterial(core));
    previousActDigest = actDigest;
    recorded.push(Object.freeze({ ...core, actDigest }));
  }
  return Object.freeze({
    ...ledger,
    acts: Object.freeze([...ledger.acts, ...recorded]),
    ledgerDigest: previousActDigest,
  });
}

function entersErrorBudget(act: RecordedInferentialAct): boolean {
  return act.kind === 'interval_report' && act.novelty === 'first_of_key';
}

function verifyActChain(ledger: CausalInferenceLedger): boolean {
  let previousActDigest = ledger.genesisDigest;
  for (const [index, act] of ledger.acts.entries()) {
    if (act.sequence !== index + 1) return false;
    if (act.previousActDigest !== previousActDigest) return false;
    if (act.actDigest !== digestOf('fiscus.causal.inference-act', actMaterial(act))) return false;
    previousActDigest = act.actDigest;
  }
  return ledger.ledgerDigest === previousActDigest;
}

function percent(value: number): string {
  return (value * 100).toFixed(4) + '%';
}

/**
 * Summarise what the ledger holds. This is the only place the error arithmetic
 * happens, and it is a union bound: for any FIXED collection of acts the chance
 * that at least one of their intervals misses is at most the sum of their
 * individual error rates. The union bound needs no independence between acts,
 * which matters here because successive looks at accumulating data are about as
 * dependent as evidence gets.
 */
export function summarizeInferenceMultiplicity(
  ledger: CausalInferenceLedger,
): CausalInferenceMultiplicity {
  const chainIntact = verifyActChain(ledger);
  const acts = ledger.acts;
  const budgeted = acts.filter(entersErrorBudget);
  const intervalActs = acts.filter((act) => act.kind === 'interval_report');
  const looks = acts[acts.length - 1]?.lookSequence ?? 0;
  const slices = new Set(acts.map((act) => act.sliceId));
  const endpoints = new Set(acts.map((act) => act.endpoint));
  const latestInterval = [...intervalActs].reverse()[0] ?? null;
  const actAlpha = latestInterval?.actAlpha ?? null;
  const familywiseErrorUpperBound = budgeted.length === 0
    ? null
    : Math.min(1, budgeted.reduce((sum, act) => sum + act.actAlpha, 0));

  let plan: CausalInferencePlanDisclosure | null = null;
  // WHICH CONDITION FIRED, NOT MERELY THAT ONE DID. `actsExceedPlan` is the
  // union of three distinct facts, and one message was emitted for all three:
  // "The recorded acts exceeded the pre-registered plan". On a plan of eight
  // acts with ONE act recorded on an unregistered slice, nothing was exceeded,
  // and the reader was sent looking for extra looks that do not exist while the
  // real reason was named nowhere.
  const unregisteredSlices: string[] = [];
  let overranActs = false;
  let overranLooks = false;
  if (ledger.plan !== null) {
    const registeredSlices = new Set(ledger.plan.sliceIds);
    const requiredActAlpha = requiredActAlphaForPlan(ledger.plan);
    const plannedActs = plannedInferenceActs(ledger.plan);
    plan = Object.freeze({
      ...ledger.plan,
      sliceIds: Object.freeze([...ledger.plan.sliceIds]),
      plannedActs,
      requiredActAlpha,
      requiredActConfidenceLevel: 1 - requiredActAlpha,
      actAlphaMeetsPlan: actAlpha !== null
        && actAlpha <= requiredActAlpha * (1 + ALPHA_COMPARISON_TOLERANCE),
      actsExceedPlan: budgeted.length > plannedActs
        || looks > ledger.plan.maxLooks
        || [...slices].some((sliceId) => !registeredSlices.has(sliceId)),
    });
    overranActs = budgeted.length > plannedActs;
    overranLooks = looks > ledger.plan.maxLooks;
    unregisteredSlices.push(...[...slices].filter((sliceId) => !registeredSlices.has(sliceId)).sort());
  }
  const basis: CausalInferenceMultiplicity['basis'] = plan !== null && !plan.actsExceedPlan
    ? 'pre_registered_plan'
    : 'recorded_acts_only';

  const assumptions = [
    'The bound is a union bound over the recorded acts; it assumes nothing about independence between looks, endpoints, or slices.',
    'Two acts count as one when their estimand, endpoint, slice and evidence digest match: re-reading unchanged evidence is deterministic and is not a second chance to be wrong.',
    'Every act is assumed to have been recorded through this ledger. An estimate produced outside it is not counted and cannot be.',
  ];

  const limitations = [
    `Inference ledger: this is look ${looks} on study ${ledger.studyId}; ${intervalActs.length} interval-reporting act(s) across ${endpoints.size} endpoint(s) and ${slices.size} slice(s), of which ${budgeted.length} spend error budget (${intervalActs.length - budgeted.length} identical re-read(s) and ${acts.length - intervalActs.length} non-estimating read(s) do not).`,
  ];
  if (familywiseErrorUpperBound === null) {
    limitations.push('No interval has been reported through this ledger yet, so there is no error budget to bound; the look count above is a record of access, not of inference.');
  } else {
    limitations.push(`Union bound at ${percent(actAlpha!)} nominal error per act: family-wise error at most ${percent(familywiseErrorUpperBound)}, simultaneous confidence at least ${percent(1 - familywiseErrorUpperBound)} across every act recorded here. The reported interval still states its own nominal level and has deliberately not been widened.`);
  }
  if (basis === 'recorded_acts_only') {
    limitations.push('Basis: recorded acts only. The number of looks was not fixed in advance, so this bounds exactly the acts this ledger holds and is not a family-wise error guarantee.');
  }
  if (plan !== null) {
    // The prefix is load-bearing. A plan that no longer bounds the family was
    // being printed as `Basis: a pre-registered plan of ...` directly after
    // `Basis: recorded acts only`, so two contradictory basis lines sat side by
    // side and the stronger-sounding one came second.
    const planPrefix = plan.actsExceedPlan
      ? 'The registered plan, which no longer bounds this family, was'
      : 'Basis:';
    limitations.push(`${planPrefix} a pre-registered plan of ${plan.maxLooks} look(s) x ${plan.endpointsPerLook} endpoint(s) x ${plan.sliceIds.length} slice(s) = ${plan.plannedActs} act(s) at family-wise ${percent(plan.targetFamilywiseErrorRate)}, which requires ${percent(plan.requiredActConfidenceLevel)} per act.${plan.actAlphaMeetsPlan ? '' : actAlpha === null ? '' : ` The reported act used ${percent(1 - actAlpha)} and does not meet it; Fiscus reports the shortfall rather than restating the interval at the level the plan wanted.`}`);
    if (overranActs) {
      limitations.push(`The recorded acts exceeded the pre-registered plan: ${budgeted.length} act(s) spend error budget against a planned ${plan.plannedActs}. The plan no longer bounds this family and is retained as history rather than as error control.`);
    }
    if (overranLooks) {
      limitations.push(`The recorded looks exceeded the pre-registered plan: ${looks} look(s) against a planned ${plan.maxLooks}. The plan no longer bounds this family and is retained as history rather than as error control.`);
    }
    if (unregisteredSlices.length > 0) {
      limitations.push(`Acts were recorded on slice(s) the plan never registered: ${unregisteredSlices.join(', ')}. The planned act count was computed from ${plan.sliceIds.length} registered slice(s), so its denominator does not describe what was actually looked at; the plan no longer bounds this family and is retained as history rather than as error control.`);
    }
  }
  if (!chainIntact) {
    limitations.push('The recorded act chain does not verify: acts have been removed or altered, so every count and bound above understates the inference actually performed.');
  }

  return Object.freeze({
    looks,
    intervalReportingActs: intervalActs.length,
    identicalRepeatActs: intervalActs.length - budgeted.length,
    nonEstimatingReads: acts.length - intervalActs.length,
    actsInErrorBudget: budgeted.length,
    endpoints: endpoints.size,
    slices: slices.size,
    actAlpha,
    actConfidenceLevel: actAlpha === null ? null : 1 - actAlpha,
    familywiseErrorUpperBound,
    simultaneousConfidenceLowerBound: familywiseErrorUpperBound === null ? null : 1 - familywiseErrorUpperBound,
    basis,
    plan,
    chainIntact,
    assumptions: Object.freeze(assumptions),
    limitations: Object.freeze(limitations),
  });
}

/** The endpoints the protocol's registered decision family actually contains. */
function familyEndpoints(family: 'cost_quality' | 'net_benefit'): InferentialEndpoint[] {
  return family === 'cost_quality' ? ['cost', 'quality'] : ['net_benefit'];
}

/**
 * Whether the single-look decision survives what the ledger knows.
 *
 * The registered joint rule in `estimate.ts` already pays for the endpoints of
 * ONE look; that is what its Bonferroni allocation is for. What it never
 * covered is a second look, a second slice, or a tenth of either. So a claim
 * stands when the recorded budget is no larger than the family the protocol
 * registered, or when a pre-registered plan covered the excess at an alpha the
 * reported act actually met. Otherwise Fiscus withholds it — which is the
 * conservative direction, and the only one available without inventing a
 * denominator after the fact.
 */
function claimAfterMultiplicity(
  estimate: CausalStudyEstimate,
  multiplicity: CausalInferenceMultiplicity,
): { claim: CausalStudyEstimate['allowedClaim']; reason: string | null } {
  if (estimate.allowedClaim === 'not_established') return { claim: 'not_established', reason: null };
  if (!multiplicity.chainIntact) {
    return { claim: 'not_established', reason: 'the recorded act chain does not verify, so the number of looks behind this claim is unknown' };
  }
  if (multiplicity.basis === 'pre_registered_plan' && multiplicity.plan!.actAlphaMeetsPlan) {
    return { claim: estimate.allowedClaim, reason: null };
  }
  if (multiplicity.actsInErrorBudget <= estimate.jointInference.endpointCount) {
    return { claim: estimate.allowedClaim, reason: null };
  }
  return {
    claim: 'not_established',
    reason: `${multiplicity.actsInErrorBudget} inferential acts have been recorded against a registered family of ${estimate.jointInference.endpointCount}, without a pre-registered plan the act's alpha satisfies`,
  };
}

/**
 * The reporting boundary. Estimating and reporting were the same act until now,
 * which is precisely why the look count had nowhere to live: a pure function
 * cannot count its own invocations, and should not try. So the estimator stays
 * exactly as it was and this wraps it, recording what was asked before handing
 * back an estimate whose limitations carry the answer.
 */
export function reportCausalStudyEstimate(
  ledger: CausalInferenceLedger,
  data: CausalStudyData,
  context: CausalStudyReportContext,
): { ledger: CausalInferenceLedger; report: CausalStudyInferenceReport } {
  if (data.protocol.protocolHash !== ledger.protocolHash || data.protocol.studyId !== ledger.studyId) {
    throw new Error('inference ledger is bound to a different committed protocol; a shared ledger across protocols would count unrelated looks as one family');
  }
  const estimate = estimateCausalStudy(data);
  const sliceId = context.sliceId ?? DEFAULT_INFERENCE_SLICE_ID;
  const evidenceDigest = causalStudyEvidenceDigest(data.protocol, estimate.qualification);
  const kind: InferentialActKind = estimate.qualification.state === 'qualified'
    ? 'interval_report'
    : 'non_estimating_read';
  const nextLedger = recordInferentialActs(
    ledger,
    familyEndpoints(estimate.jointInference.endpointFamily).map((endpoint) => ({
      endpoint,
      sliceId,
      evidenceDigest,
      estimandId: estimate.estimandId,
      includedUnits: estimate.qualification.includedDecisionIds.length,
      kind,
      actAlpha: estimate.jointInference.endpointAlpha,
      reportedAtMs: context.reportedAtMs,
    })),
  );
  const multiplicity = summarizeInferenceMultiplicity(nextLedger);
  const { claim, reason } = claimAfterMultiplicity(estimate, multiplicity);
  const limitations = [...estimate.limitations, ...multiplicity.limitations];
  if (reason !== null) {
    limitations.push(`Multiplicity withholds the single-look conclusion '${estimate.allowedClaim}': ${reason}. The single-look decision above is reported unchanged and has not been re-derived at an adjusted level.`);
  }
  return {
    ledger: nextLedger,
    report: Object.freeze({
      estimate: { ...estimate, limitations },
      multiplicity,
      claimAfterMultiplicity: claim,
      claimAfterMultiplicityReason: reason,
    }),
  };
}
