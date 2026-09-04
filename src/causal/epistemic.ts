/**
 * Causal-study issuance adapter: the observational-to-causal boundary, inside
 * the kernel.
 *
 * ISSUANCE CLASS: canonical — see `src/epistemic/issuance-map.ts`.
 *
 * WHAT WAS WRONG, AND IT WAS NOT THE ARITHMETIC. `qualification.ts` and
 * `estimate.ts` are conservative: they refuse to derive causality from Lift, a
 * baseline or a model comparison, and they withhold a claim whenever the
 * pre-registered interval rule is not met. Nothing they compute is false. The
 * defect (AII-036, AII-021) is structural — they decided the single largest
 * strengthening in the product OUTSIDE the Trusted Epistemic Kernel, so the
 * conclusion was bound to nothing. Revoking the assignment evidence changed no
 * downstream record, because there was no downstream record to change.
 *
 * THE STRENGTHENING IS NOW A DERIVATION, WHICH IS THE POINT. Two claims, not
 * one:
 *
 *   claim:causal:arm_difference:<study>   causality: observational
 *   claim:causal:effect:<study>           causality: randomized
 *
 * and a Derivation between them. `assessDerivationLegality` sees `observational
 * -> randomized` on the `causality` axis and demands a `causal_identification`
 * witness; `EpistemicLedger.appendDerivation` refuses to persist without it.
 * The witness is grounded in the assignment Evidence, so the ledger's
 * dependency edges make the causal claim a descendant of the randomization
 * record: revoke the assignment and `revocationClosure` carries the effect
 * claim with it.
 *
 * That is the difference between a claim bound to its evidence and one asserted
 * beside it, and it is the whole reason the split exists. A single claim
 * carrying `causality: 'randomized'` would be legal on its own — the kernel only
 * checks STRENGTHENING — and would have re-created the defect in kernel types.
 *
 * WHAT ISSUANCE DOES NOT DO. It does not make the estimate more true. The
 * interval, the joint rule and the qualification gates are unchanged and remain
 * the only things deciding whether an effect is supported; this module refuses
 * to issue a causal claim at all unless they already said so. It adds
 * revocability and an auditable binding, not strength.
 */

import { claim, type Claim } from '../epistemic/claim.ts';
import { derivation, type Derivation, type DerivationWitness } from '../epistemic/derivation.ts';
import { evidence, type Evidence } from '../epistemic/evidence.ts';
import { grain } from '../epistemic/grain.ts';
import { claimProfile } from '../epistemic/profile.ts';
import { scope } from '../epistemic/scope.ts';
import { instant, interval } from '../epistemic/time.ts';
import { witness, type Witness } from '../epistemic/witness.ts';
import { canonicalJson, sha256, verifyCommittedCausalProtocol } from './protocol.ts';
import { resolveEstimandDefinition } from './estimand.ts';
import type { EstimandDefinition } from './estimand.ts';
import type { CausalStudyData, CausalStudyEstimate } from './types.ts';

/**
 * Kernel records for one analysed study.
 *
 * `identification`, `effect` and `derivation` travel together and are null
 * together: they are the causal half, and it exists only when the study earned
 * it. `armDifference` is always issued, because an unqualified or inconclusive
 * study still produced an observed difference and withholding that would hide
 * the measurement rather than the conclusion.
 */
export interface CausalStudyKernelIssuance {
  /** The canonical estimand used by every record in this issuance. */
  readonly estimandId: EstimandDefinition['id'];
  readonly estimandDefinition: EstimandDefinition;
  readonly assignmentEvidence: Evidence;
  readonly outcomeEvidence: Evidence;
  readonly armDifference: Claim;
  readonly identification: Witness | null;
  readonly effect: Claim | null;
  readonly derivation: Derivation | null;
}

const CAUSAL_ASSUMPTIONS = Object.freeze([
  'A scoped local intention-to-treat result for the registered eligible population and study period. It is not a forecast and does not transport to another population.',
  'The declared no-interference, outcome-completeness, assignment-following, and measurement assumptions are conditions of the estimate, not findings of it.',
  'Fiscus verifies retained protocol, assignment, execution and outcome lineage locally. That is not an independent audit and not a provider-invoice certification.',
]);

function timestamp(value: number, label: string): ReturnType<typeof instant> {
  if (!Number.isSafeInteger(value)) throw new Error(`causal ${label} must be a safe integer timestamp`);
  const iso = new Date(value).toISOString();
  if (Date.parse(iso) !== value) throw new Error(`causal ${label} is outside the supported timestamp range`);
  return instant(iso);
}

/**
 * The interval the study actually observed.
 *
 * Anchored on the protocol commitment rather than the first assignment: a
 * protocol committed before any unit was assigned is what makes the design
 * pre-registered, and the valid time of the claim has to include it or the
 * record would place the design inside the period it governs.
 */
function studyInterval(data: CausalStudyData) {
  let last = data.protocol.committedAtMs;
  for (const outcome of data.outcomes) {
    if (Number.isSafeInteger(outcome.observedAtMs) && outcome.observedAtMs > last) last = outcome.observedAtMs;
  }
  return interval(timestamp(data.protocol.committedAtMs, 'protocol commitment'), timestamp(last, 'last observation'));
}

/** A digest over exactly the records the qualification admitted. */
function includedDigest(data: CausalStudyData, estimate: CausalStudyEstimate): string {
  const included = new Set(estimate.qualification.includedDecisionIds);
  return 'sha256:' + sha256(canonicalJson({
    protocolHash: data.protocol.protocolHash,
    decisions: data.decisions.filter((item) => included.has(item.decisionId)).map((item) => item.eventHash),
    executions: data.executions.filter((item) => included.has(item.decisionId)).map((item) => item.eventHash),
    outcomes: data.outcomes.filter((item) => included.has(item.decisionId)).map((item) => item.eventHash),
  }));
}

function sameRegisteredEstimand(
  value: unknown,
  expected: EstimandDefinition,
): boolean {
  try {
    return canonicalJson(value) === canonicalJson(expected);
  } catch {
    return false;
  }
}

/**
 * Whether this estimate is entitled to a causal claim at all.
 *
 * Both conditions are the existing modules', restated rather than reinvented:
 * the structural gates must have passed, and the pre-registered interval rule
 * must have authorised claim language. An `inconclusive` study is a study whose
 * design was valid and whose evidence was not sufficient — issuing a causal
 * claim for it is precisely the escalation this boundary exists to refuse.
 */
export function causalClaimIsEarned(estimate: CausalStudyEstimate): boolean {
  return estimate.qualification.state === 'qualified' && estimate.allowedClaim !== 'not_established';
}

/**
 * Build the kernel records for one analysed study.
 *
 * Pure: it reads the study and the estimate and returns records. Persisting
 * them — and therefore enforcing legality — is the ledger's job, and it is
 * deliberately not done here, so that a caller cannot obtain a causal Claim
 * without the Derivation that legalises it passing through
 * `appendDerivation`.
 */
export function buildCausalStudyKernelIssuance(
  data: CausalStudyData,
  estimate: CausalStudyEstimate,
  issuedAtMs: number,
): CausalStudyKernelIssuance {
  if (estimate.protocolHash !== data.protocol.protocolHash) {
    throw new Error('causal estimate does not belong to this study protocol');
  }
  const declaredEstimand = (data.protocol.analysis as unknown as { estimand?: unknown }).estimand;
  const estimandDefinition = data.protocol.version === 1
    && verifyCommittedCausalProtocol(data.protocol).length === 0
    ? resolveEstimandDefinition(declaredEstimand)
    : undefined;
  if (estimandDefinition === undefined
      || estimate.estimandId !== estimandDefinition.id
      || !sameRegisteredEstimand(estimate.estimandDefinition, estimandDefinition)) {
    throw new Error('causal kernel issuance requires a registered estimand definition');
  }
  const issued = timestamp(issuedAtMs, 'issuance timestamp');
  const validTime = studyInterval(data);
  const studyId = data.protocol.studyId;
  const studyScope = scope({
    ledger: 'fiscus-causal',
    studyId,
    protocolHash: data.protocol.protocolHash,
  });
  const studyGrain = grain(['causal_study', 'assignment_arm']);
  const committedAt = timestamp(data.protocol.committedAtMs, 'protocol commitment');
  const digest = includedDigest(data, estimate);

  // The kernel refuses `proxy_validated` without a model reference, and it is
  // right to: a measurement is validated AGAINST something, and a claim that
  // cannot name it is asserting the validation rather than carrying it. The
  // protocol is that something — it fixes the metric, its finite range and the
  // evidence class before collection, and `qualifyCausalStudy` rejects any
  // outcome whose observed class differs. The reference is pinned to the
  // protocol hash so it cannot survive a change to the thing it names.
  const measurementModelRef = `causal:quality-metric:${data.protocol.qualityOutcome.metricId}@${data.protocol.protocolHash}`;

  const assignmentEvidence = evidence({
    id: `evidence:causal:assignment:${studyId}`,
    evidenceType: 'causal.assignment',
    sourceIdentity: 'fiscus:causal-randomization',
    sourceClass: 'fiscus_local_randomized_assignment',
    payload: {
      studyId,
      protocolHash: data.protocol.protocolHash,
      committedAtMs: data.protocol.committedAtMs,
      probabilityPerArm: data.protocol.allocation.probabilityPerArm,
      decisions: data.decisions.map((item) => ({
        decisionId: item.decisionId,
        assignedArmId: item.assignedArmId,
        randomizationBlockId: item.randomizationBlockId,
        allocationHash: item.allocationHash,
        eventHash: item.eventHash,
      })),
    } as never,
    scope: studyScope,
    grain: studyGrain,
    occurredAt: committedAt,
    validTime,
    observedAt: issued,
    recordedAt: issued,
    assertedAt: issued,
    finalizedAt: null,
    integrity: 'verified',
    authenticity: 'self_asserted',
    completeness: {
      // The assignment record set is complete BY CONSTRUCTION: a decision that
      // is not retained was never made, because the allocation hash chain would
      // not close. This is the one completeness claim in the module that does
      // not rest on a scan having reached far enough.
      status: 'complete',
      method: 'retained_allocation_chain',
      coveredEventTypes: ['causal_decision'],
      coveredScope: studyScope,
      coveredTime: validTime,
    },
    measurementModelRef: null,
    monetaryBasis: null,
    assumptions: CAUSAL_ASSUMPTIONS,
    supersedes: [],
    supersededBy: null,
    revocation: null,
    schemaVersion: 1,
    sensitivity: 'internal',
    redaction: 'none',
  });

  const outcomeEvidence = evidence({
    id: `evidence:causal:outcomes:${studyId}`,
    evidenceType: 'causal.outcomes',
    sourceIdentity: 'fiscus:causal-outcomes',
    sourceClass: 'fiscus_local_execution_and_outcome_records',
    payload: {
      studyId,
      protocolHash: data.protocol.protocolHash,
      executions: data.executions.map((item) => item.eventHash),
      outcomes: data.outcomes.map((item) => item.eventHash),
      includedDecisionIds: [...estimate.qualification.includedDecisionIds],
      includedDigest: digest,
    } as never,
    scope: studyScope,
    grain: studyGrain,
    occurredAt: committedAt,
    validTime,
    observedAt: issued,
    recordedAt: issued,
    assertedAt: issued,
    finalizedAt: null,
    integrity: 'verified',
    authenticity: 'self_asserted',
    completeness: {
      // Outcome completeness is NOT by construction: a unit can be assigned and
      // never observed, which is exactly what the missingness limit governs.
      // `qualified` means the limit was met, not that nothing is missing.
      status: estimate.qualification.state === 'qualified' ? 'complete' : 'partial',
      method: 'declared_missingness_limit',
      coveredEventTypes: ['causal_execution', 'causal_outcome'],
      coveredScope: studyScope,
      coveredTime: validTime,
    },
    measurementModelRef: null,
    monetaryBasis: null,
    assumptions: CAUSAL_ASSUMPTIONS,
    supersedes: [],
    supersededBy: null,
    revocation: null,
    schemaVersion: 1,
    sensitivity: 'internal',
    redaction: 'none',
  });

  const observedValue = {
    studyId,
    protocolHash: data.protocol.protocolHash,
    question: data.protocol.question,
    estimand: data.protocol.analysis.estimand,
    estimandId: estimandDefinition.id,
    estimandDefinition,
    countsByArm: estimate.qualification.countsByArm,
    costEffectUsd: estimate.costEffectUsd,
    qualityEffect: estimate.qualityEffect,
    netBenefitEffectUsd: estimate.netBenefitEffectUsd,
    jointInference: estimate.jointInference,
    includedDigest: digest,
  } as never;

  // THE SOURCE CLAIM. Everything measured, and `causality: 'observational'` —
  // an assigned-arm difference is a difference between groups until something
  // witnesses that the assignment was randomized. That witness is the next
  // record, and the axis gap between these two claims is what forces it to
  // exist.
  const armDifference = claim({
    id: `claim:causal:arm_difference:${studyId}`,
    proposition: { predicate: 'causal.arm_difference_observed', value: observedValue },
    subject: studyId,
    scope: studyScope,
    grain: studyGrain,
    time: { validTime, asOf: issued },
    epistemic: 'supported',
    profile: claimProfile({
      epistemic: 'supported',
      integrity: 'verified',
      authenticity: 'self_asserted',
      scope: 'conditional',
      coverage: estimate.qualification.state === 'qualified' ? 'complete' : 'partial',
      measurement: 'proxy_validated',
      causality: 'observational',
      monetaryBasis: 'none',
      finality: 'provisional',
      decisionFitness: 'not_assessed',
    }),
    measurementModelRef,
    evidenceIds: [assignmentEvidence.id, outcomeEvidence.id],
    derivationRule: 'causal.arm_difference.v1',
    derivationVersion: 1,
    assumptions: CAUSAL_ASSUMPTIONS,
    uncertainty: {
      kind: 'interval',
      description: 'Union-bound Hoeffding intervals on the pre-declared finite outcome ranges, at the joint endpoint level. No empirical variance is fitted after observation.',
    } as never,
    causalStatus: 'observational',
    monetaryBasis: 'none',
    finality: 'provisional',
    issuedAt: issued,
    supersedes: [],
    supersededBy: null,
    revocation: null,
    decisionCertificateIds: [],
    schemaVersion: 1,
  });

  if (!causalClaimIsEarned(estimate)) {
    // An unqualified or inconclusive study issues the measurement and stops.
    // No witness is minted, so no legal derivation to a randomized claim can be
    // constructed from these records by anyone — which is the refusal, stated
    // as an absent record rather than as a flag a caller could ignore.
    return Object.freeze({
      estimandId: estimandDefinition.id,
      estimandDefinition,
      assignmentEvidence,
      outcomeEvidence,
      armDifference,
      identification: null,
      effect: null,
      derivation: null,
    });
  }

  const identification = witness({
    id: `witness:causal:identification:${studyId}`,
    kind: 'causal_identification',
    evidenceIds: [assignmentEvidence.id],
    detail: `Randomized assignment at probability ${String(data.protocol.allocation.probabilityPerArm)} per arm, under protocol ${data.protocol.protocolHash} committed before the first assignment, with every included decision carrying a verified allocation-hash chain.`,
    issuedAt: issued,
    epistemic: 'supported',
    schemaVersion: 1,
  });

  const effectValue = {
    ...(observedValue as object),
    allowedClaim: estimate.allowedClaim,
    qualityNonInferiorityPassed: estimate.qualityNonInferiorityPassed,
    lowerCostPassed: estimate.lowerCostPassed,
    causalNetBenefitSupported: estimate.causalNetBenefitSupported,
    limitations: [...estimate.limitations],
  } as never;

  const effect = claim({
    id: `claim:causal:effect:${studyId}`,
    proposition: { predicate: 'causal.effect_supported', value: effectValue },
    subject: studyId,
    scope: studyScope,
    grain: studyGrain,
    time: { validTime, asOf: issued },
    epistemic: 'supported',
    profile: claimProfile({
      epistemic: 'supported',
      integrity: 'verified',
      authenticity: 'self_asserted',
      scope: 'conditional',
      coverage: 'complete',
      measurement: 'proxy_validated',
      // The ONLY axis that differs from the source claim. Anything else moving
      // here would demand its own witness, and would mean this module had
      // quietly strengthened something it has no evidence for.
      causality: 'randomized',
      monetaryBasis: 'none',
      finality: 'provisional',
      decisionFitness: 'not_assessed',
    }),
    measurementModelRef,
    evidenceIds: [assignmentEvidence.id, outcomeEvidence.id],
    derivationRule: 'causal.randomized_effect.v1',
    derivationVersion: 1,
    assumptions: CAUSAL_ASSUMPTIONS,
    uncertainty: {
      kind: 'interval',
      description: 'Pre-registered joint decision rule over the declared endpoint family. Passing it authorises claim language for this study and period only.',
    } as never,
    causalStatus: 'randomized',
    monetaryBasis: 'none',
    finality: 'provisional',
    issuedAt: issued,
    supersedes: [],
    supersededBy: null,
    revocation: null,
    decisionCertificateIds: [],
    schemaVersion: 1,
  });

  const witnessReference: DerivationWitness = {
    id: identification.id,
    kind: identification.kind,
    evidenceIds: identification.evidenceIds,
    detail: identification.detail,
  };

  const derivationRecord = derivation({
    id: `derivation:causal:randomization:${studyId}`,
    inputEvidenceIds: [assignmentEvidence.id, outcomeEvidence.id],
    inputClaimIds: [armDifference.id],
    transformation: 'causal.randomization_identifies_arm_difference.v1',
    outputClaimId: effect.id,
    outputProposition: { predicate: 'causal.effect_supported', value: effectValue },
    coordinateChange: {
      from: { grain: studyGrain, scope: studyScope },
      to: { grain: studyGrain, scope: studyScope },
    },
    witnesses: [witnessReference],
    assumptions: CAUSAL_ASSUMPTIONS,
    uncertaintyTransformation: 'Interval bounds are carried through unchanged; randomization licenses the causal reading of the same interval, it does not narrow it.',
    version: 1,
    reproducibilityHash: digest,
  });

  return Object.freeze({
    estimandId: estimandDefinition.id,
    estimandDefinition,
    assignmentEvidence,
    outcomeEvidence,
    armDifference,
    identification,
    effect,
    derivation: derivationRecord,
  });
}
