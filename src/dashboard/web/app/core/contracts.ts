/**
 * Canonical dashboard transport contracts.
 *
 * This file contains type declarations only: no Node or DOM globals, no runtime
 * imports. Both the browser client and the Node dashboard server may import it,
 * eliminating the previous structurally-unrelated copies of payload shapes.
 * Runtime contract tests remain as defense in depth because TypeScript does not
 * validate JSON at runtime.
 */

export interface Summary {
  requests: number;
  costUsd: number;
  inputTokens?: number;
  outputTokens?: number;
}

export interface GroupRow {
  /** The payload's actual key for the thing being grouped. Every grouping
   *  endpoint uses `label`; writing this interface from memory instead of from
   *  the payload is how both breakdown tables shipped rendering an em-dash in
   *  every row while the numbers beside them were correct. */
  label: string;
  provider?: string;
  requests: number;
  costUsd: number;
  inputTokens?: number;
  outputTokens?: number;
}

/** Mirrors the server's series bucket. The key is `bucketMs`, not `ts`. */
export interface SeriesPoint {
  bucketMs: number;
  costUsd: number;
  requests: number;
}

/**
 * Mirrors `Alert` in src/alerts/detect.ts. This was declared as
 * `{ level, title?, message }` and the server sends `{ id, severity, title,
 * detail, metric }` -- three of four names wrong. Nothing consumed it yet, so it
 * never failed; the first screen to render an alert would have shown a blank
 * severity and no text, with no error anywhere.
 */
export interface AlertRow {
  /** Stable kind id, e.g. 'budget-exhausted'. */
  id: string;
  severity: 'critical' | 'warn' | 'info';
  title: string;
  detail: string;
  /** Short quantified evidence, e.g. '$39.73 / $30.00'. Null when unquantified. */
  metric: string | null;
}

export interface PricingStatusSnapshot {
  source?: string;
  sourceKind?: string;
  sourceUrl?: string | null;
  stale?: boolean;
  fresh?: boolean;
  ageDays?: number | null;
  modelCount?: number;
  cacheIntegrity?: string;
  fetchedAt?: string | null;
  updated?: string;
  freshnessBasis?: string;
  cardSha256?: string | null;
}

/** One immutable pricing-evidence cohort captured on request rows. */
export interface PricingEvidenceRow {
  provider: string;
  model: string;
  costBasis: string;
  rateCardSha256: string | null;
  rateCardSourceKind: string;
  rateMatchKind: string;
  rateMatchProvider: string | null;
  rateMatchModel: string | null;
  requests: number;
  costUsd: number;
  estimatedCostUsd: number;
  inputTokens: number;
  outputTokens: number;
}

export interface PricingCoveragePayload {
  demo: boolean;
  generatedAt: string;
  window: { startMs: number; endMs: number; label: string };
  activeRateCard: PricingStatusSnapshot;
  total: { costUsd: number; requests: number };
  provenance: PricingEvidenceRow[];
  boundary: string;
}

export interface Overview {
  demo: boolean;
  range: string;
  generatedAt?: string;
  budget?: unknown;
  summary: Summary;
  pricing: {
    status: PricingStatusSnapshot | string;
    autoRefresh?: boolean;
    estimatedCostUsd: number;
    estimatedSpendShare: number;
    provenance?: PricingEvidenceRow[];
  };
  byModel: GroupRow[];
  byProject: GroupRow[];
  attributionEvidence?: unknown;
  byUser?: GroupRow[];
  bySource: GroupRow[];
  characterization?: unknown;
  dimensions?: unknown;
  series: SeriesPoint[];
  recent: unknown[];
  alerts?: AlertRow[] | null;
}

export interface BillingPayload {
  demo: boolean;
  evidence: { reconciliationStatus: string };
  summary: { recordCount: number };
  reconciliation?: {
    runs: Array<{
      reconciliationRunId: string;
      computedAtMs: number;
      result: {
        status: string;
        providerSourceKind?: string;
        conditions?: readonly string[];
      };
    }>;
  };
}

export interface CostCentre {
  id: string;
  label?: string;
  name?: string;
}

export interface AllocationRule {
  id: string;
  version: number;
  method: string;
  targets?: string[] | null;
  revokedAtMs?: number | null;
  effectiveToMs?: number | null;
}

export interface AllocationPayload {
  demo: boolean;
  kind: string;
  trust: string;
  basis: string;
  excludedFrom: string[];
  costCentres: CostCentre[];
  rules: AllocationRule[];
  runs: Array<Record<string, unknown>>;
  reconciliation: { everRun: boolean; latestComputedAtMs: number | null };
}

/**
 * The realized-value payload.
 *
 * Every field here was read off an actual /api/value response, not inferred from
 * the computation's input types -- `RealizationLike` in src/value/lenses.ts is
 * the minimal shape the calculator ACCEPTS, while the store snapshot the server
 * returns carries considerably more. Typing this from the input interface would
 * have silently dropped `realizedUnits`, which is the field the spine uses to
 * decide whether the realized claim is established at all.
 */
export interface Matured {
  units: number;
  realizedUnits: number;
  realizationRate: number;
  totalCostUsd: number;
  /**
   * CAUTION: this is the attributed SPEND on units that realized
   * (`sum of attributedCostUsd`), not the value they produced. The value claim
   * lives on `roi.returnRatio.realizedValueUsd`, which is manual-equivalent
   * dollars and a completely different quantity. Both fields are spelled
   * `realizedValueUsd` in the payload; presenting this one as realized value
   * collapses cost into value, which is the exact failure this product exists
   * to refuse.
   */
  realizedValueUsd: number;
  netRealizedValueUsd?: number;
  realizedValueRate?: number;
  /** Where units died, in stage order. The stage that costs most is the one to fix. */
  wasteByStage?: Array<{ stage: string; units: number; costUsd: number }>;
  instrumentation?: Record<string, number>;
  /** Partial-identification bounds on the realization rate. */
  realizationBounds?: { lower: number; upper: number; n: number };
}

export interface ValuePayload {
  demo: boolean;
  allocation: unknown;
  frontier?: { modelSwitches?: Array<{ confidence: string }> } | null;
  /** 'git' | 'store' | null. Null means no matured outcomes could be observed. */
  valueSource?: string | null;
  gitRepo?: boolean;
  /** Whether realized dollars came from spend scoped to this project, or a window sum. */
  projectScoped?: boolean | null;
  repo?: string;
  realization?: {
    matured?: Matured;
    firstPassAcceptance?: number | null;
    proposalCoverage?: number | null;
    projectScoped?: boolean | null;
    costStaleUnits?: number;
  } | null;
  roi?: {
    roiIndex?: number | null;
    roiInterval?: { low: number | null; high: number | null } | null;
    /** Compatibility flag; observed-only score is not a bound and current server returns false. */
    indexIsUpperBound?: boolean;
    instrumentationInterval?: { low: number | null; observed: number | null; high: number | null };
    coverage?: number | null;
    /** The money claim. `realizedValueUsd` here IS value, not cost. */
    returnRatio?: {
      grossRatio?: number | null;
      causalRatio?: number | null;
      causalRange?: { low: number | null; high: number | null };
      realizedValueUsd?: number | null;
      costUsd?: number;
      counterfactualCredit?: number | null;
      supervisionPriced?: boolean;
      paysForItself?: boolean | null;
      basis?: string;
    } | null;
    tokenCostUsd?: number;
    effortTaxUsd?: number;
    notes?: string[];
  } | null;
  /** Goodhart drift alarm — an e-process over mature units. Needs ten to exist. */
  drift?: { n: number; alarm: boolean; recentRate?: number; overallRate?: number } | null;
  reclaimed?: {
    savedMinutes?: number | null;
    savedRange?: { low: number; high: number } | null;
    workWeeksSaved?: number | null;
    workWeeksRange?: { low: number; high: number } | null;
    /** Matured units that earned no time credit: died, or had no baseline. */
    uncreditedUnits?: number;
    notes?: string[];
  } | null;
  /** Per-user distribution, gated by opt-in AND a k-anonymity floor. Never names people. */
  team?: {
    enabled: boolean;
    suppressed: boolean;
    reason?: string;
    distribution?: {
      cohortSize: number;
      medianExtraction: number;
      dispersion: number;
      broadBased: boolean;
      coachingHeadroomUsd: number;
    } | null;
  } | null;
  budget?: BudgetAdvice | null;
}

/** The budget advisor's output. `status` gates whether it is safe to act on. */
export interface BudgetAdvice {
  status: string;
  canApply: boolean;
  minActiveDays?: number;
  /** Days of real observation behind the recommendation. Fewer means less to trust. */
  basisDays?: number;
  observed?: { medianDaily: number; p90Daily: number; maxDaily: number; avgDaily: number };
  recommendedDailyUsd?: number | null;
  recommendedSoftUsd?: number | null;
  realizedValueRate?: number | null;
  /** Spend not turning into kept outcomes, projected monthly. The number to attack. */
  projectedMonthlyWasteUsd?: number | null;
  rationale?: string[];
  spendBasis?: string;
  windowDays?: number;
}

/**
 * Mirrors `BudgetConfig` in src/config.ts EXACTLY. Verified against that file and
 * against a live /api/settings response, not written from memory: the first
 * version of this interface invented `dailyCapUsd`/`sessionCapUsd`, so the
 * Control screen read undefined and told operators "no cap set" while a $30 cap
 * was configured and enforcing, and the cap-setting action posted a patch
 * `applySettingsPatch` ignores. A test pins these names to the server's.
 */
export interface BudgetConfig {
  /** Hard daily cap. null = unlimited. */
  dailyUsd: number | null;
  /** Soft daily threshold; past this a warning header is injected. null = off. */
  dailySoftUsd: number | null;
  /** Hard per-session cap. null = unlimited. */
  sessionUsd: number | null;
  /** Sliding window (seconds) for runaway-loop detection. */
  runawayWindowSec: number;
  /** Spend within that window that flags a runaway loop. null = off. */
  runawayMaxUsd: number | null;
  /** Whether imported (unblockable) spend counts toward enforcement. */
  capIncludesImported: boolean;
}

export type EnforceabilityState =
  | 'enforced_in_path'
  | 'provider_native'
  | 'observed_only'
  | 'proposed'
  | 'unknown';

export interface BudgetEnforcementDescriptor {
  localProxy: {
    state: 'enforced_in_path';
    mechanism: 'local_proxy';
    hardControlActive: boolean;
    warningActive: boolean;
    liveConfig: boolean;
    spendScope: 'live_proxy' | 'all_observed';
  };
  importedSpend: {
    state: 'observed_only';
    blockable: false;
    countsTowardInPathCap: boolean;
  };
  providerNative: { state: 'unknown'; inspected: false };
  recommendation: { state: 'proposed'; automaticallyApplied: false };
}

export interface SettingsSnapshot {
  version: string;
  home: string;
  configPath: string;
  dbPath: string;
  proxyPort: number;
  dashboardPort: number;
  retentionDays: number;
  proposalRetentionDays: number;
  metadataOnly: boolean;
  budget: BudgetConfig;
  enforcement: BudgetEnforcementDescriptor;
  connections: Array<Record<string, unknown>>;
}

export interface Importer {
  id: string;
  label: string;
  blurb: string;
  /** Whether this tool's data was actually found on this machine. */
  available: boolean;
  location: string | null;
}

export interface ScanPayload {
  ok: boolean;
  tools: Array<{ id: string; label?: string; present?: boolean }>;
  otherApps: Array<{ id?: string; label?: string; name?: string }>;
  roots: string[];
  repoCount: number;
  reposWithSpend: number;
  /** True when the bounded filesystem walk stopped early — the count is a floor. */
  hitBudget: boolean;
  dirsVisited: number;
  unreadableDirs: number;
  diff?: Record<string, unknown>;
}

export interface ImportResult {
  ok: boolean;
  totalNew: number;
  results: Record<string, { inserted: number; costUsd?: number; available: boolean }>;
}

export interface HealthPayload {
  ok: boolean;
  service: string;
}

