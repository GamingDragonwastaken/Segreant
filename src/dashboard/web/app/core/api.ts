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

export interface SeriesPoint {
  ts: number;
  costUsd: number;
  requests: number;
}

export interface AlertRow {
  level: string;
  title?: string;
  message: string;
}

export interface Overview {
  demo: boolean;
  range: string;
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

export interface BillingPayload {
  demo: boolean;
  evidence: { reconciliationStatus: string };
  summary: { recordCount: number };
  reconciliation?: {
    runs?: number;
    latest?: {
      providerSourceKind?: string;
      conditions?: string[];
      status?: string;
      computedAtMs?: number;
    } | null;
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
    /** True when the index can only be read as a ceiling, not a point estimate. */
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
        'x-aegis-local': '1',
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
  overview: (range: string) => request<Overview>(`/api/overview?range=${encodeURIComponent(range)}`),
  billing: () => request<BillingPayload>('/api/billing'),
  allocation: () => request<AllocationPayload>('/api/allocation'),
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
