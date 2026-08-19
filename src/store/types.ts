/**
 * Public persistence contracts.
 *
 * Extracted mechanically from db.ts so callers can depend on ledger/billing/
 * allocation shapes without importing the SQLite implementation. db.ts
 * re-exports every contract for backward compatibility. Keep runtime/query
 * behavior in db.ts or domain modules; keep transport/storage shapes here.
 */

import type { RequestPricingEvidence } from '../cost/pricing.ts';
import type { BillingChargeType, BillingCoverage, NormalizedBillingImport } from '../billing/types.ts';
import type { ScopeCaptureStatus } from '../billing/scope.ts';
import type { AttributionBasis } from '../value/characterization.ts';
import type { OpenAiCostObservation, OpenAiCostsFailureCode } from '../billing/openaiCosts.ts';
import type { ProviderSourceKind } from '../billing/reconcile.ts';

/** What an adoption would observe, and what it deliberately would not. */
export type OpenAiCostsAdoptionPlan =
  | {
      adoptable: true;
      importId: string;
      declaredScopeId: string;
      providerProjectRef: string;
      periodStartMs: number;
      periodEndMs: number;
      fileSha256: string;
      /** The operator's own coverage claim on the import. Never verified here. */
      declaredCoverage: string;
      observations: OpenAiCostObservation[];
      matchedRecordCount: number;
      matchedMicros: number;
      /**
       * Lines this adoption will NOT observe, with their money. Account-level
       * credits carry no project reference and cannot be attributed to one, so
       * they are excluded — and reported, because a silently dropped credit
       * would show up later as a residual that never existed.
       */
      excluded: { otherOrNoProjectRecordCount: number; otherOrNoProjectMicros: number };
    }
  | {
      adoptable: false;
      refusal:
        | 'no_such_import'
        | 'import_is_not_openai'
        | 'import_owns_no_records'
        | 'no_records_for_declared_project'
        | 'records_are_not_single_currency_usd'
        | 'records_are_not_whole_utc_days';
      detail: string;
    };

export interface RequestRow {
  requestId: string;
  sessionId: string | null;
  tsEpochMs: number;
  provider: string;
  model: string;
  /** The label exactly as recorded at metering time. Never rewritten by an alias. */
  project: string;
  /**
   * The project this row rolls up into once `project_aliases` is applied — the
   * same label `byProject` aggregates under. Equal to `project` when unaliased.
   *
   * Both are carried because they answer different questions: `project` is what
   * was actually recorded, `projectCanonical` is what it counts as. An export
   * that carried only the raw label would total differently from the dashboard
   * as soon as any alias existed; one that carried only the canonical would lose
   * the recorded evidence and could not survive the alias being removed.
   */
  projectCanonical?: string;
  taskWeight: number;
  inputTokens: number;
  outputTokens: number;
  cacheWriteTokens: number;
  cacheReadTokens: number;
  reasoningTokens: number;
  costUsd: number;
  estimated: boolean;
  streamed: boolean;
  statusCode: number | null;
  durationMs: number | null;
  user?: string | null; // developer/team attribution (x-aegis-user header); null = unassigned
  source?: string | null; // connected tool/feed attribution (x-aegis-source header); null = direct
  cwd?: string | null; // full working-directory path this request was made from; null = unknown. The
  // link that lets Fiscus find the git repo behind a project and auto-correlate
  // its spend into RoI with no --repo — the "no wiring" path. `project` is its basename.
  via?: 'proxy' | 'import'; // how the row entered the ledger: live proxy traffic
  // (blockable, marginal API cost) vs a native importer reading a tool's own logs
  // (sunk subscription cost, observed after the fact). Cap ENFORCEMENT keys on this.
  /** Evidence for the amount above. Missing only means a pre-lineage/legacy row. */
  pricing?: RequestPricingEvidence;
  /** Local route-scope provenance. Never a provider-account verification. */
  scopeCaptureStatus?: ScopeCaptureStatus;
  providerScopeDeclarationId?: string | null;
  /**
   * How `project` above was obtained. Never an identity verification — a declared
   * label is a self-assertion. Missing only means a pre-lineage/legacy row.
   */
  attributionBasis?: AttributionBasis;
}

/**
 * One immutable pricing-evidence cohort in the local request ledger. A cohort
 * never blends two cards, source kinds, or match paths: that would make a
 * later rate-card refresh look like it had priced an older request.
 */
export interface PricingEvidenceBucket {
  provider: string;
  model: string;
  costBasis: RequestPricingEvidence['costBasis'];
  rateCardSha256: string | null;
  rateCardSourceKind: RequestPricingEvidence['rateCardSourceKind'];
  rateMatchKind: RequestPricingEvidence['rateMatchKind'];
  rateMatchProvider: string | null;
  rateMatchModel: string | null;
  requests: number;
  costUsd: number;
  estimatedCostUsd: number;
  inputTokens: number;
  outputTokens: number;
}

/**
 * One attribution-evidence cohort: a project label paired with the basis it was
 * obtained by. A project that appears under two bases yields two rows — merging
 * them would hide that part of its cost is self-declared and part is unattributed,
 * which is the whole question this answers.
 */
export interface AttributionEvidenceBucket {
  /** The canonical project label, so this reconciles with `byProject`. */
  project: string;
  attributionBasis: AttributionBasis;
  requests: number;
  costUsd: number;
}

export interface RequestPriceEvent {
  eventId: number;
  requestId: string;
  action: 'reprice';
  appliedAtMs: number;
  previousCostUsd: number;
  previousEstimated: boolean;
  previousPricing: RequestPricingEvidence;
  newCostUsd: number;
  newEstimated: boolean;
  newPricing: RequestPricingEvidence;
}

export interface RepriceUpdate {
  requestId: string;
  costUsd: number;
  pricing: RequestPricingEvidence;
}

/** File-level provenance supplied with a validated, local billing-evidence import. */
export interface BillingImportInput {
  document: NormalizedBillingImport;
  fileName: string;
  fileSha256: string;
  fileSizeBytes: number;
  format: 'json';
}

export interface BillingImportRun {
  importId: string;
  importedAtMs: number;
  format: 'json';
  schemaVersion: number;
  importerVersion: string;
  fileName: string;
  fileSha256: string;
  fileSizeBytes: number;
  sourceSystem: 'operator-export';
  sourceExportId: string;
  provider: 'openai';
  billingAccountRef: string;
  exportedAtMs: number;
  periodStartMs: number;
  periodEndMs: number;
  coverage: BillingCoverage;
  trust: 'operator_supplied_unverified';
  rawRetention: 'digest_only';
  recordsSeen: number;
  recordsInserted: number;
  recordsDuplicate: number;
}

/** One immutable provider-declared charge line. It is never a request-ledger row. */
export interface BillingEvidenceRecord {
  recordId: string;
  sourceSystem: 'operator-export';
  billingAccountRef: string;
  sourceRecordId: string;
  sourceRecordSha256: string;
  firstImportId: string;
  sourceExportId: string;
  provider: 'openai';
  providerProjectRef: string | null;
  service: string;
  sku: string;
  model: string | null;
  region: string | null;
  observedAtMs: number;
  chargePeriodStartMs: number;
  chargePeriodEndMs: number;
  chargeType: BillingChargeType;
  currency: 'USD';
  amountMicros: number;
  usageUnit: string | null;
  usageQuantity: string | null;
  costBasis: 'provider_reported';
  trust: 'operator_supplied_unverified';
}

export interface BillingImportResult {
  run: BillingImportRun;
  duplicateFile: boolean;
}

export interface BillingSummary {
  importCount: number;
  recordCount: number;
  providerReportedUsdMicros: number;
  lastImportedAtMs: number | null;
  reconciliationStatus: 'not_reconciled';
}

/**
 * An immutable record of one direct, read-only OpenAI Costs API attempt. This
 * collection is intentionally separate from both operator file imports and the
 * request ledger. A successful later pull can restate or change a provider day;
 * it is retained as a new observation rather than an overwrite or a sum.
 */
export interface OpenAiCostsObservationRun {
  observationRunId: string;
  declaredScopeId: string;
  providerProjectRef: string;
  periodStartMs: number;
  periodEndMs: number;
  fetchedAtMs: number;
  paginationComplete: boolean;
  pageCount: number;
  pageDigestChainSha256: string | null;
  resultState: 'succeeded' | 'failed';
  failureCode: OpenAiCostsFailureCode | null;
  providerFinality: 'undocumented';
  trust: 'provider_observation_unreconciled';
  rawRetention: 'digest_only';
  observationsStored: number;
  /**
   * How these figures reached Fiscus. `legacy_unknown` on rows recorded before
   * the distinction existed — never backfilled to `provider_api_pull` merely
   * because that happened to be the only writer at the time.
   */
  sourceKind: ProviderSourceKind;
}

/** A retained provider daily grouping from exactly one completed observation run. */
export interface OpenAiCostsObservationLine extends OpenAiCostObservation {
  observationId: string;
  observationRunId: string;
  declaredScopeId: string;
  fetchedAtMs: number;
}

export interface OpenAiCostsObservationInput {
  declaredScopeId: string;
  providerProjectRef: string;
  periodStartMs: number;
  periodEndMs: number;
  fetchedAtMs: number;
  paginationComplete: boolean;
  pageCount: number;
  pageDigestChainSha256: string | null;
  resultState: 'succeeded' | 'failed';
  failureCode: OpenAiCostsFailureCode | null;
  observations: OpenAiCostObservation[];
  /** Defaults to the direct API pull — the only writer that existed before this. */
  sourceKind?: ProviderSourceKind;
}

export interface OpenAiCostsObservationStatus {
  latestRun: OpenAiCostsObservationRun | null;
  latestCompleteRun: OpenAiCostsObservationRun | null;
  reconciliationStatus: 'not_reconciled';
}

export interface SpendBucket {
  label: string;
  costUsd: number;
  requests: number;
  inputTokens: number;
  outputTokens: number;
}

/**
 * A window's spend characterized across the flat axes — the typed, one-call
 * breakdown the CLI and the HTTP API both render, so "by project / model / source
 * / user" means the same thing on every surface (see value/characterization.ts for
 * the axis vocabulary). Session is a finer per-thread drill-down with its own
 * shape (sessionUnits), not one of these uniform spend buckets.
 */
export interface Characterization {
  byProject: SpendBucket[];
  byModel: Array<SpendBucket & { provider: string }>;
  bySource: SpendBucket[];
  byUser: SpendBucket[];
}

export interface ProposalRow {
  proposalId: string;
  requestId: string | null;
  sessionId: string | null;
  tsEpochMs: number;
  provider: string;
  model: string;
  project: string;
  files: Array<{ path: string | null; addedLines: string[] }>;
}

/** A provider/model that has routed proxy traffic recently — dashboard connection status. */
export interface ProviderConnection {
  provider: string;
  model: string;
  lastSeenMs: number;
  requestCount: number;
}

export interface GateSignalRow {
  signalId: string;
  kind: string; // 'tested' | 'merged' | 'shipped' | 'incident'
  commitHash: string | null;
  project: string;
  tsEpochMs: number;
  verdict: string; // 'pass' | 'fail'
  detail: string | null;
  /** How the outcome entered the ledger; never silently collapse provenance. */
  evidenceSource?: 'manual' | 'local-command' | 'signed-ci';
}

/** A retained, verified external-evidence envelope plus the resulting gate signal. */
export interface VerifiedGateEvidenceInput {
  eventId: string;
  source: 'github-actions';
  evidenceClass: 'signed-ci';
  commitHash: string;
  repositoryId: string;
  policyId: string;
  bodyHash: string;
  signerKeyId: string;
  envelopeJson: string;
  verifiedAtMs: number;
  signal: Omit<GateSignalRow, 'signalId' | 'commitHash' | 'evidenceSource'>;
}

export type VerifiedGateEvidenceWrite = 'inserted' | 'duplicate' | 'conflict';

/**
 * A persisted snapshot of one computed work unit. The store keeps these so
 * realized value outlives the process (and the checkout) that produced it — the
 * full WorkUnit lives in `unitJson`; the broken-out columns are what we query on.
 */
export interface RealizationUnitRecord {
  commitHash: string;
  project: string;
  tsEpochMs: number;
  computedAtMs: number;
  attributedCostUsd: number;
  maturing: boolean;
  realized: boolean;
  unitJson: string; // serialized WorkUnit (funnel + attribution + taskType + dominantModel)
  /**
   * Which spend basis produced this snapshot's dollars: `project` when the
   * window was scoped to the unit's own project family, `window` when it was the
   * project-blind sum (the classic proxy default). Recorded so a later reprice
   * can re-attribute on the SAME basis — recomputing a project-scoped unit as a
   * window sum (or the reverse) would move its cost for a reason that has
   * nothing to do with the price change.
   */
  costScope: CostScope;
}

/**
 * How a persisted unit's dollars were attributed.
 *
 * `project` and `window` are the two real bases and are the only ones a reprice
 * can reproduce. `synthetic_demo` marks seeded units whose cost is asserted
 * rather than summed from any window — no re-attribution reproduces them, and a
 * reprice of the ledger does not make them wrong, because the ledger was never
 * their source. `legacy_unknown` predates the column: the basis is unrecoverable,
 * so such a unit is marked stale but never recomputed.
 */
export type CostScope = 'project' | 'window' | 'synthetic_demo' | 'legacy_unknown';

/** What a reprice did to the persisted realized-value snapshots. */
export interface RealizationCostSync {
  markedStale: number; // units whose window contained a repriced request
  resynced: number; // of those, re-attributed on their recorded basis
  unresolvable: number; // stale but pre-dating `cost_scope`, so left stale on purpose
  costUsdBefore: number; // Σ attributed cost of the resynced units, before
  costUsdAfter: number; // …and after
}
