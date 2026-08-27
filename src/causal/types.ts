/**
 * Canonical local evidence records for Fiscus's randomized causal-study lane.
 *
 * These are deliberately narrow structural records. They identify a protocol,
 * randomized allocation, execution lineage, and outcome lineage without making
 * raw prompts, source text, credentials, or model outputs required evidence.
 */

export const CAUSAL_PROTOCOL_TYPE = 'fiscus.causal-study' as const;
export const CAUSAL_PROTOCOL_VERSION = 1 as const;
export const CAUSAL_PROTOCOL_VERSION_V2 = 2 as const;

export type CausalStudyQuestion =
  | 'model_cost_quality'
  | 'ai_vs_incumbent_net_benefit';

export type CausalStudyLifecycle =
  | 'draft'
  | 'committed'
  | 'collecting'
  | 'data_locked'
  | 'analyzed'
  | 'qualified'
  | 'inconclusive'
  | 'invalid'
  | 'exported';

export type CausalArmRole =
  | 'candidate'
  | 'control'
  | 'ai'
  | 'incumbent'
  | 'no_ai';

export type CostSourceClass =
  | 'actual_reconciled'
  | 'actual_observed'
  | 'modeled_price_card'
  | 'incomplete_or_unknown';

export type QualityEvidenceClass =
  | 'deterministic'
  | 'independent_operational'
  | 'structured_human'
  | 'local_ai_judge'
  | 'operator_attested';

export type OutcomeMaturity = 'pending' | 'matured' | 'censored' | 'invalid';

export type ExecutionAdherence =
  | 'confirmed'
  | 'deviated'
  | 'incomplete'
  | 'unverifiable';

export type CausalEvidenceGrade =
  | 'not_identified'
  | 'protocol_registered'
  | 'randomized_collecting'
  | 'randomized_inconclusive'
  | 'randomized_causal';

export interface NumericBounds {
  low: number;
  high: number;
}

export interface CausalStudyArm {
  armId: string;
  role: CausalArmRole;
  /**
   * Content hash for the provider/model/prompt-policy/tool/fallback execution
   * plan. The underlying plan belongs in a separately governed local system;
   * Fiscus needs the identifier, not the prompt or credentials themselves.
   */
  executionPlanHash: string;
  providerId: string | null;
  modelId: string | null;
}

export interface CausalAllocation {
  method: 'blocked_randomized_equal_allocation';
  /** Every arm's probability is positive and equal in version 1. */
  probabilityPerArm: number;
  blockSize: number;
}

export interface CausalCostOutcome {
  metricId: string;
  /** Bound declared before outcomes for conservative interval construction. */
  boundsUsd: NumericBounds;
  acceptedSourceClasses: Array<'actual_reconciled' | 'actual_observed'>;
}

export interface CausalQualityOutcome {
  metricId: string;
  bounds: NumericBounds;
  evidenceClass: QualityEvidenceClass;
  /**
   * Candidate minus control may be no lower than minus this margin. This must
   * be fixed before collection and cannot be supplied by a local AI judge.
   */
  nonInferiorityMargin: number;
}

export interface CausalEconomicOutcome {
  metricId: string;
  boundsUsd: NumericBounds;
  evidenceClass: Exclude<QualityEvidenceClass, 'local_ai_judge'>;
  /** Records that both arm costs have the declared full-cost coverage. */
  fullCostAccountingRequired: true;
}

export interface CausalAnalysisPlan {
  estimand: 'intention_to_treat';
  confidenceLevel: number;
  minCompletedPerArm: number;
  maxMissingFractionPerArm: number;
}

export interface CausalEligibility {
  cohortId: string;
  unitOfAssignment: 'agent_run' | 'task' | 'request' | 'repository_change' | 'workflow_block';
  contextSchemaId: string;
}

export interface CausalStudyProtocolDraft {
  type: typeof CAUSAL_PROTOCOL_TYPE;
  version: typeof CAUSAL_PROTOCOL_VERSION;
  studyId: string;
  createdAtMs: number;
  question: CausalStudyQuestion;
  eligibility: CausalEligibility;
  arms: CausalStudyArm[];
  allocation: CausalAllocation;
  costOutcome: CausalCostOutcome;
  qualityOutcome: CausalQualityOutcome;
  economicOutcome: CausalEconomicOutcome | null;
  analysis: CausalAnalysisPlan;
}

export interface CommittedCausalStudyProtocol extends CausalStudyProtocolDraft {
  lifecycle: 'committed';
  committedAtMs: number;
  protocolHash: string;
}

/** Additive protocol-v2 declarations. Version 1 remains byte-compatible. */
export type CausalEvidenceClassV2 =
  | 'deterministic'
  | 'independent_operational'
  | 'structured_human'
  | 'operator_attested';

export interface CausalEligibilityV2 {
  cohortId: string;
  contextSchemaId: string;
  unitOfAssignment: 'agent_run' | 'task' | 'request' | 'repository_change' | 'workflow_block';
  inclusionRuleIds: string[];
  exclusionRuleIds: string[];
}

export interface CausalStudyWindowV2 {
  startsAtMs: number;
  endsAtMs: number | null;
}

export interface CausalStoppingRuleV2 {
  kind: 'fixed_enrollment' | 'fixed_time' | 'fixed_enrollment_or_time';
  maxAssignments: number | null;
}

export interface CausalStudyArmV2 {
  armId: string;
  role: CausalArmRole;
  executionPlanDigest: string;
  providerId: string | null;
  modelId: string | null;
}

export interface CausalCostOutcomeV2 {
  metricId: string;
  currency: 'USD';
  boundsUsd: NumericBounds;
  acceptedSourceClasses: Array<'actual_reconciled' | 'actual_observed'>;
  priceLineageRule: 'every_included_cost_has_retained_sha256_lineage';
}

export interface CausalQualityOutcomeV2 {
  metricId: string;
  collectionMethodId: string;
  bounds: NumericBounds;
  evidenceClass: CausalEvidenceClassV2;
  nonInferiorityMargin: number;
}

export interface CausalEconomicOutcomeV2 {
  metricId: string;
  collectionMethodId: string;
  currency: 'USD';
  boundsUsd: NumericBounds;
  evidenceClass: CausalEvidenceClassV2;
  fullCostAccountingRequired: true;
}

export interface CausalAnalysisPlanV2 {
  estimand: 'intention_to_treat';
  confidenceLevel: number;
  minCompletedPerArm: number;
  maxMissingFractionPerArm: number;
  exclusionPolicyId: string;
}

export interface CausalDataGovernanceV2 {
  minimizedSourceIds: string[];
  retentionClassId: string;
  egressReceiptDigests: string[];
}

export interface CausalClaimTemplateIdsV2 {
  qualified: string;
  inconclusive: string;
  invalid: string;
}

export interface CausalStudyProtocolDraftV2 {
  type: typeof CAUSAL_PROTOCOL_TYPE;
  version: typeof CAUSAL_PROTOCOL_VERSION_V2;
  studyId: string;
  seriesId: string;
  studyVersion: number;
  ownerId: string;
  scopeId: string;
  createdAtMs: number;
  question: CausalStudyQuestion;
  eligibility: CausalEligibilityV2;
  studyWindow: CausalStudyWindowV2;
  stoppingRule: CausalStoppingRuleV2;
  arms: CausalStudyArmV2[];
  allocation: CausalAllocation;
  costOutcome: CausalCostOutcomeV2;
  qualityOutcome: CausalQualityOutcomeV2;
  economicOutcome: CausalEconomicOutcomeV2 | null;
  analysis: CausalAnalysisPlanV2;
  dataGovernance: CausalDataGovernanceV2;
  claimTemplateIds: CausalClaimTemplateIdsV2;
}

export interface CommittedCausalStudyProtocolV2 extends CausalStudyProtocolDraftV2 {
  lifecycle: 'committed';
  committedAtMs: number;
  protocolHash: string;
}

export type AnyCausalStudyProtocolDraft = CausalStudyProtocolDraft | CausalStudyProtocolDraftV2;
export type AnyCommittedCausalStudyProtocol = CommittedCausalStudyProtocol | CommittedCausalStudyProtocolV2;

export interface CausalDecisionRecord {
  decisionId: string;
  studyId: string;
  protocolHash: string;
  unitIdHash: string;
  assignedAtMs: number;
  randomizationBlockId: string;
  assignedArmId: string;
  propensity: number;
  allocationHash: string;
  randomizationMaterialSha256: string;
  previousEventHash: string;
  eventHash: string;
}

export interface CausalAssignmentPlan {
  studyId: string;
  protocolHash: string;
  blockId: string;
  createdAtMs: number;
  unitIdHashes: string[];
  randomizationMaterialHex: string;
  randomizationMaterialSha256: string;
  allocationHash: string;
  decisions: CausalDecisionRecord[];
}

/** Exact persisted v2 assignment-plan record. Raw entropy is never serialized. */
export interface CausalAssignmentPlanV2 {
  type: 'fiscus.causal-assignment-plan';
  version: 2;
  studyId: string;
  blockId: string;
  protocolHash: string;
  sequence: number;
  createdAtMs: number;
  blockRoot: string;
  unitIdDigests: string[];
  randomizationMaterialDigest: string;
  allocationHash: string;
  decisionIds: string[];
  firstDecisionHash: string;
  lastDecisionHash: string;
  planHash: string;
}

/** Exact persisted v2 assignment decision. */
export interface CausalDecisionRecordV2 {
  type: 'fiscus.causal-decision';
  version: 2;
  decisionId: string;
  studyId: string;
  blockId: string;
  protocolHash: string;
  blockSequence: number;
  decisionIndex: number;
  unitIdDigest: string;
  assignedAtMs: number;
  assignedArmId: string;
  propensity: 0.5;
  blockRoot: string;
  planHash: string;
  allocationHash: string;
  randomizationMaterialDigest: string;
  previousEventHash: string;
  eventHash: string;
}

/** In-memory Slice 2 envelope; only its plan and decisions are persisted records. */
export interface CausalAssignmentBlockV2 {
  plan: CausalAssignmentPlanV2;
  decisions: CausalDecisionRecordV2[];
}

/** Public Store input. Sequence, entropy, allocation, roots, and plans are Store-owned. */
export interface CausalAssignmentRequestV2 {
  studyId: string;
  blockId: string;
  createdAtMs: number;
  unitIdDigests: string[];
}

export interface CausalAssignmentManifestPlanV2 {
  blockId: string;
  sequence: number;
  blockRoot: string;
  planHash: string;
  allocationHash: string;
  firstDecisionHash: string;
  lastDecisionHash: string;
  decisionCount: number;
}

export interface CausalAssignmentManifestDecisionV2 {
  decisionId: string;
  blockId: string;
  blockSequence: number;
  decisionIndex: number;
  unitIdDigest: string;
  assignedArmId: string;
  eventHash: string;
  planHash: string;
}

/** Exact authoritative manifest derived from all retained v2 assignment rows. */
export interface CausalAssignmentManifestV2 {
  type: 'fiscus.causal-assignment-manifest';
  version: 2;
  studyId: string;
  protocolHash: string;
  planCount: number;
  decisionCount: number;
  unitCount: number;
  plans: CausalAssignmentManifestPlanV2[];
  decisions: CausalAssignmentManifestDecisionV2[];
  assignmentManifestHash: string;
}

export interface CausalAssignmentResultV2 {
  status: 'created' | 'existing';
  block: CausalAssignmentBlockV2;
  manifest: CausalAssignmentManifestV2;
}

/**
 * The production Slice 4 verifier is intentionally unresolved.  A caller may
 * retain only the closed result shape; the Store derives and authenticates the
 * result hash and does not accept a caller-selected verified result.
 */
export interface OrdinaryLedgerVerifierResultV2 {
  type: 'fiscus.causal-ordinary-ledger-verifier';
  version: 2;
  state: 'unresolved';
  checkedAtMs: null;
  requestCount: 0;
  evidenceManifestHash: null;
  reasonCodes: Array<'task4_not_implemented'>;
  resultHash: string;
}

/** Exact v2 execution record. It is deliberately distinct from the retained v1 shape. */
export interface CausalExecutionRecordV2 {
  type: 'fiscus.causal-execution';
  version: 2;
  executionId: string;
  decisionId: string;
  studyId: string;
  protocolHash: string;
  startedAtMs: number;
  completedAtMs: number;
  assignedExecutionPlanDigest: string;
  actualExecutionPlanDigest: string | null;
  adherence: ExecutionAdherence;
  requestIds: string[];
  directAiCostUsd: number | null;
  directCostSourceClass: CostSourceClass;
  priceLineageDigests: string[];
  fullArmCostUsd: number | null;
  fullCostSourceClass: CostSourceClass;
  ordinaryLedgerVerifier: OrdinaryLedgerVerifierResultV2;
  previousEventHash: string;
  eventHash: string;
}

export interface CausalExecutionRecord {
  executionId: string;
  decisionId: string;
  studyId: string;
  protocolHash: string;
  startedAtMs: number;
  completedAtMs: number;
  assignedExecutionPlanHash: string;
  actualExecutionPlanHash: string | null;
  adherence: ExecutionAdherence;
  /** Local references to independently metered Fiscus request records. */
  requestIds: string[];
  directAiCostUsd: number | null;
  directCostSourceClass: CostSourceClass;
  priceLineageHashes: string[];
  /** Required for the AI-versus-incumbent net-benefit question. */
  fullArmCostUsd: number | null;
  fullCostSourceClass: CostSourceClass;
  previousEventHash: string;
  eventHash: string;
}

export interface CausalOutcomeRecord {
  outcomeId: string;
  decisionId: string;
  studyId: string;
  protocolHash: string;
  observedAtMs: number;
  maturity: OutcomeMaturity;
  qualityValue: number | null;
  qualityEvidenceClass: QualityEvidenceClass | null;
  economicValueUsd: number | null;
  economicEvidenceClass: Exclude<QualityEvidenceClass, 'local_ai_judge'> | null;
  outcomeEvidenceRefs: string[];
  missingReason: string | null;
  previousEventHash: string;
  eventHash: string;
}

export interface CausalStudyData {
  protocol: CommittedCausalStudyProtocol;
  decisions: CausalDecisionRecord[];
  executions: CausalExecutionRecord[];
  outcomes: CausalOutcomeRecord[];
}

export interface ArmCounts {
  assigned: number;
  completed: number;
  missing: number;
  adherenceConfirmed: number;
}

export interface CausalQualification {
  state: 'collecting' | 'invalid' | 'inconclusive' | 'qualified';
  evidenceGrade: CausalEvidenceGrade;
  reasons: string[];
  countsByArm: Record<string, ArmCounts>;
  includedDecisionIds: string[];
}

export interface CausalEffectInterval {
  estimate: number;
  lower: number;
  upper: number;
}

export interface CausalStudyEstimate {
  qualification: CausalQualification;
  protocolHash: string;
  costEffectUsd: CausalEffectInterval | null;
  qualityEffect: CausalEffectInterval | null;
  netBenefitEffectUsd: CausalEffectInterval | null;
  qualityNonInferiorityPassed: boolean | null;
  lowerCostPassed: boolean | null;
  causalNetBenefitSupported: boolean | null;
  allowedClaim:
    | 'not_established'
    | 'comparative_cost_quality_supported'
    | 'causal_net_benefit_supported';
  limitations: string[];
}
