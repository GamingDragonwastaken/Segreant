/**
 * Typed access to the local API.
 *
 * Every response carries `demo` where the underlying data can be seeded, and the
 * GUI is required to surface it — a screen that cannot tell you it is showing
 * sample data is the one lie this product cannot afford.
 *
 * These interfaces describe only the fields the GUI reads. They are deliberately
 * not exhaustive mirrors of the server payloads: an interface that claims to
 * describe a whole payload rots silently, while one that describes what a screen
 * consumes fails loudly the moment that screen's data moves.
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

export interface Overview {
  demo: boolean;
  range: string;
  /**
   * ISO instant the server computed this payload. On the wire since the route
   * was written, undeclared here until the Claim Inspector needed to report
   * freshness — and an undeclared field is one a screen cannot read without a
   * cast, which is how the reconciliation run collection got read as a number.
   */
  generatedAt: string;
  summary: Summary;
  pricing: {
    status: { fresh?: boolean; ageDays?: number | null } | string;
    estimatedCostUsd: number;
    estimatedSpendShare: number;
  };
  byModel: GroupRow[];
  byProject: GroupRow[];
  bySource: GroupRow[];
  series: SeriesPoint[];
  recent: Array<Record<string, unknown>>;
  alerts?: AlertRow[] | null;
}

/**
 * How much local spend a reconciliation would actually match, reported BEFORE
 * an OpenAI Admin key is minted — the only moment the answer is useful.
 *
 * Every field is money or a count in the local ledger. `onDeclaredRouteUsd` is
 * the only bucket that can reconcile; the other two are real spend that
 * structurally cannot, and saying so is the point of the type.
 */
export interface ReconciliationCoverage {
  onDeclaredRouteUsd: number;
  onDeclaredRouteRequests: number;
  /** Natively imported rows: model and cost, but nothing tying them to a provider project. */
  importedUsd: number;
  importedRequests: number;
  /** Proxy rows predating the declaration, or carrying a different one. */
  proxyOffScopeUsd: number;
  proxyOffScopeRequests: number;
}

export interface ReconciliationReadiness {
  ready: boolean;
  missing: Array<{ step: string; detail: string; ownerAction: boolean }>;
  /** Null when the ledger holds no OpenAI spend at all — "no data", not "no coverage". */
  coverage: ReconciliationCoverage | null;
}

/**
 * Exact imported-record mapping coverage. This is intentionally a narrow GUI
 * projection of the server payload: the dashboard can explain residuals and
 * trust, but it cannot author a mapping or treat an operator declaration as a
 * provider-verified account binding.
 */
export interface BillingMappingCoveragePayload {
  coverageStatus: string;
  reconciliationStatus: string;
  reconciliationDetail: string;
  providerScopeAuthority: string;
  mappingTrust: string;
  totalRecordCount: number;
  mappedRecordCount: number;
  unmappedRecordCount: number;
  staleMappingRecordCount: number;
  ambiguousMappingRecordCount: number;
  totalMicros: number;
  mappedMicros: number;
  residualMicros: number;
  byStatus: Record<string, { recordCount: number; amountMicros: number }>;
  targets: Array<{ targetProject: string; targetAccountRef: string; recordCount: number; amountMicros: number }>;
  excludedFrom: string[];
}

export interface BillingKernelClaimSummary {
  id: string;
  proposition: unknown;
  profile: Record<string, string>;
  evidenceIds: string[];
  issuedAt: string;
  monetaryBasis: string;
  finality: string;
}

export interface BillingPayload {
  demo: boolean;
  evidence: { reconciliationStatus: string };
  summary: { recordCount: number };
  /** Bounded canonical billed Claims issued by the explicit billing adapter. */
  kernel?: {
    kind: string;
    claims: BillingKernelClaimSummary[];
    observedClaims: BillingKernelClaimSummary[];
    reconciliationClaims: BillingKernelClaimSummary[];
  };
  /**
   * Optional because a payload predating this field must not read as `ready`.
   * Absent means "not reported", which the view has to render differently from
   * `ready: false` — collapsing the two would invent a reassurance.
   */
  readiness?: ReconciliationReadiness;
  /** Exact imported-record mapping coverage; absent only for pre-mapping payloads. */
  mapping?: BillingMappingCoveragePayload;
  /**
   * The immutable reconciliation runs, newest first — the collection the server
   * actually sends (`store.reconciliationRuns(10)`), not a count.
   *
   * This was declared as `{ runs?: number; latest?: {...} }`, and neither field
   * existed on the wire. `chain.ts` then decided whether Billed was established
   * with `runs > 0`, where `runs` is an array of objects: `Number([{…}])` is
   * `NaN`, so the comparison was false for ONE run exactly as it was for none.
   * The Billed band of the four-claim spine could never light up, however many
   * reconciliations had been recorded. Count with `.length`.
   */
  reconciliation?: {
    kind?: string;
    grain?: string;
    runs?: ReconciliationRunRecord[];
    excludedFrom?: string[];
  };
}

/** JSON-safe exact economic projection served by `/api/economic`. */
export interface EconomicMoney {
  /** Canonical human-readable decimal amount, never a JavaScript number. */
  amount: string;
  /** Exact signed coefficient and decimal scale used for replay. */
  coefficient: string;
  scale: number;
  currency: string;
  basis: string;
}

export interface EconomicCoverage extends EconomicMoney {
  eventIds: string[];
  sourceBases: string[];
  requestCount: number;
  unresolvedRequests: number;
  complete: boolean;
}

export interface EconomicBalance extends EconomicMoney {
  role: string;
  eventIds: string[];
}

export interface EconomicMoneyJson {
  coefficient: string;
  scale: number;
  currency: string;
  basis: string;
}

export interface EconomicAttributionPayload {
  amount: EconomicMoneyJson;
  amountText: string;
  eventIds: string[];
  sourceBases: string[];
  requestCount: number;
  unresolvedRequests: number;
  complete: boolean;
}

export interface EconomicPayload {
  kind: 'economic_projection';
  schemaVersion: number;
  demo: boolean;
  window: {
    startMs: number;
    endMs: number;
    requestCoverage: EconomicCoverage;
  };
  projection: {
    asOf: string | null;
    eventIds: string[];
    balances: EconomicBalance[];
  };
}

export interface RealizationEconomicRollupPayload {
  coverage: 'exact' | 'partial' | 'legacy_unknown';
  total: EconomicAttributionPayload | null;
  realized: EconomicAttributionPayload | null;
}

/** One recorded run. `result` is the immutable reconciliation record itself. */
export interface ReconciliationRunRecord {
  reconciliationRunId: string;
  computedAtMs: number;
  result: {
    status?: string;
    providerSourceKind?: string;
    conditions?: string[];
    providerReportedMicros?: number;
    localCapturedMicros?: number;
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
  /** The immutable allocation runs, newest first. */
  runs: AllocationRunRecord[];
  /**
   * A CROSS-REFERENCE to the billing reconciliation, not an allocation
   * timestamp. `handleAllocation` fills this from `store.reconciliationRuns(1)`
   * because whether any reconciliation exists decides whether the residual
   * under every allocated figure has ever been looked at.
   *
   * It is therefore evidence ABOUT the inputs, and never this claim's own
   * freshness. Reading it as one dates the allocation claim by a different
   * claim's evidence — which is the collapse this product exists to refuse, and
   * which the Claim Inspector shipped doing for exactly one release.
   */
  reconciliation: { everRun: boolean; latestComputedAtMs: number | null };
}

/** One recorded allocation run. `result` is the immutable apportionment. */
export interface AllocationRunRecord {
  allocationRunId: string;
  computedAtMs: number;
  result?: Record<string, unknown>;
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
  /** Exact effective spend coverage; numeric fields remain compatibility projections. */
  economic?: RealizationEconomicRollupPayload;
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
    /** Deprecated compatibility flag; the observed score is not a ceiling when lenses are missing. */
    indexIsUpperBound?: boolean;
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
      evidenceState?: 'unpriced' | 'observational_scenario';
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

/** Read-only summary of Fiscus's separate causal-study evidence lane. */
export interface CausalPayload {
  demo: boolean;
  generatedAt: string;
  studies: Array<{
    studyId: string;
    protocolHash: string;
    committedAtMs: number;
    decisions: number;
    executions: number;
    outcomes: number;
    latestAnalysis: { analysisId: string; computedAtMs: number; state: string } | null;
  }>;
  study: {
    studyId: string;
    protocolHash: string;
    committedAtMs: number;
    question: 'model_cost_quality' | 'ai_vs_incumbent_net_benefit';
    counts: { decisions: number; executions: number; outcomes: number };
    qualification: {
      state: 'collecting' | 'invalid' | 'inconclusive' | 'qualified';
      evidenceGrade: string;
      reasons: string[];
      countsByArm: Record<string, {
        assigned: number;
        completed: number;
        missing: number;
        adherenceConfirmed: number;
      }>;
    };
    allowedClaim: 'not_established' | 'comparative_cost_quality_supported' | 'causal_net_benefit_supported';
    assignmentReplay: Array<{ blockId: string; allocationHash: string; errors: string[] }>;
  } | null;
  causalEvidence: string;
  boundary: string;
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
  enforcement: BudgetEnforcement;
  egress: {
    mode: 'local_locked' | 'controlled_cloud';
    rules: Array<{
      id: string;
      enabled: boolean;
      purpose: string;
      dataClass: string;
      method: string;
      origin: string;
      pathPrefix: string;
    }>;
    receipts: {
      path: string;
      ok: boolean;
      receiptCount: number;
      validThroughHash: string | null;
      errors: string[];
    };
    scope: string;
  };
  connections: Array<Record<string, unknown>>;
}

/**
 * Mirrors `BudgetEnforcementDescriptor` from `src/budget/enforceability.ts`.
 *
 * Declared structurally rather than imported: this module compiles under the
 * browser config, which has no node types, so it cannot reach server source —
 * the same reason `BudgetConfig` is restated above. `dashboard-contract.test.ts`
 * is what keeps the two in step.
 *
 * The four members are four different enforcement CLAIMS, and the screen must
 * not collapse them: what the local proxy can stop before it happens, spend that
 * was only ever observed after the fact, provider-side limits Fiscus does not
 * inspect at all, and advice that is a proposal until applied.
 */
export interface BudgetEnforcement {
  localProxy: {
    state: 'enforced_in_path';
    mechanism: 'local_proxy';
    hardControlActive: boolean;
    warningActive: boolean;
    /** True: the running guard re-reads config, so a saved cap is live. */
    liveConfig: boolean;
    spendScope: 'live_proxy' | 'all_observed';
  };
  importedSpend: { state: 'observed_only'; blockable: false; countsTowardInPathCap: boolean };
  providerNative: { state: 'unknown'; inspected: false };
  recommendation: { state: 'proposed'; automaticallyApplied: false };
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

export class ApiError extends Error {
  // Explicit fields rather than constructor parameter properties: the repo
  // compiles under `erasableSyntaxOnly`, so type syntax may never emit code.
  readonly status: number;
  readonly path: string;

  constructor(message: string, status: number, path: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.path = path;
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, {
      ...init,
      headers: {
        accept: 'application/json',
        // The server refuses every mutating route without this header. It is a
        // CSRF guard, and a good one: a cross-origin page cannot set a custom
        // header without a preflight this server never answers, so a malicious
        // site cannot drive the operator's local Fiscus by loading an image.
        'x-fiscus-local': '1',
        ...(init?.body ? { 'content-type': 'application/json' } : {}),
        ...init?.headers,
      },
    });
  } catch {
    // The server is on localhost, so a network failure means it stopped — worth
    // saying plainly rather than rendering an empty screen that looks like zero.
    throw new ApiError('Fiscus is not responding. Is it still running?', 0, path);
  }

  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new ApiError(detail.slice(0, 400) || `${response.status} ${response.statusText}`, response.status, path);
  }

  return (await response.json()) as T;
}

export const api = {
  health: () => request<HealthPayload>('/api/health'),
  overview: (range: string, signal?: AbortSignal) => request<Overview>(
    `/api/overview?range=${encodeURIComponent(range)}`,
    signal ? { signal } : undefined,
  ),
  billing: () => request<BillingPayload>('/api/billing'),
  allocation: () => request<AllocationPayload>('/api/allocation'),
  economic: (range: '30d' | 'all' = '30d') => request<EconomicPayload>(
    range === 'all' ? '/api/economic?all=1' : '/api/economic?days=30',
  ),
  causal: (studyId?: string) => request<CausalPayload>(
    studyId ? '/api/causal?study=' + encodeURIComponent(studyId) : '/api/causal',
  ),
  value: () => request<ValuePayload>('/api/value'),
  settings: () => request<SettingsSnapshot>('/api/settings'),
  guide: () => request<Record<string, unknown>>('/api/guide'),
  importers: () => request<{ importers: Importer[] }>('/api/importers'),
  /** GET /api/scan is the dry run: it detects and reports, and imports nothing. */
  scan: () => request<ScanPayload>('/api/scan'),

  /** Mutating calls are grouped so every write in the GUI is greppable in one place. */
  write: {
    settings: (patch: Record<string, unknown>) =>
      request<SettingsSnapshot>('/api/settings/update', { method: 'POST', body: JSON.stringify(patch) }),
    clearProposals: () =>
      request<{ ok: boolean; removed: number }>('/api/settings/clear-proposals', { method: 'POST' }),
    runImport: (tool = 'all') =>
      request<ImportResult>(`/api/import?tool=${encodeURIComponent(tool)}`, { method: 'POST' }),
    // POST, not GET. An earlier version of this client called /api/discover with
    // the default GET and the server -- which guards it as a mutating route --
    // answered 405 every time. Both correlation routes below write to the ledger.
    discover: () =>
      request<{ ok: boolean; foundFolders: number; correlated: number }>('/api/discover', { method: 'POST' }),
    runScan: () =>
      request<{ ok: boolean; totalNew: number; correlated: number }>('/api/scan', { method: 'POST' }),
  },
};

export type Range = 'today' | '7d' | '30d' | 'all';

export const RANGES: ReadonlyArray<{ id: Range; label: string; plain: string }> = [
  { id: 'today', label: 'Today', plain: 'since midnight' },
  { id: '7d', label: '7 days', plain: 'the last week' },
  { id: '30d', label: '30 days', plain: 'the last month' },
  { id: 'all', label: 'All', plain: 'everything recorded' },
];
