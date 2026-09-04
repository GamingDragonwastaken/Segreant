/**
 * Typed access to the local API.
 *
 * Every response carries `demo` where the underlying data can be seeded, and the
 * GUI is required to surface it — a screen that cannot tell you it is showing
 * sample data is the one lie this product cannot afford.
 *
 * The named payload interfaces come from the canonical no-runtime shared source
 * and are generated into this browser compiler root. They describe only the
 * fields the GUI reads; inline route responses remain explicit until they receive
 * named shared types.
 */

import {
  DASHBOARD_API_CONTRACTS,
  DASHBOARD_PAYLOAD_CONTRACTS,
  dashboardApiContract,
  validateDashboardPayload,
  type DashboardApiContractId,
} from './generated-contract.ts';

const routePath = (id: DashboardApiContractId): string => dashboardApiContract(id).path;


import type {
  Summary,
  PricingCardProvenancePayload,
  PricingEvidencePayload,
  GroupRow,
  SeriesPoint,
  AlertRow,
  Overview,
  ReconciliationCoverage,
  ReconciliationReadiness,
  BillingMappingCoveragePayload,
  BillingKernelClaimSummary,
  BillingPayload,
  EconomicMoney,
  EconomicCoverage,
  EconomicTranslationCoverage,
  EconomicBalance,
  EconomicMoneyJson,
  EconomicAttributionPayload,
  EconomicPeriodClosePayload,
  EconomicPayload,
  RealizationEconomicRollupPayload,
  UsageUnitPayload,
  UsagePayload,
  ReconciliationRunRecord,
  CostCentre,
  AllocationRule,
  AllocationPayload,
  AllocationRunRecord,
  Matured,
  ValueProjectPayload,
  ValuePayload,
  BudgetAdvice,
  CausalPayload,
  BudgetConfig,
  SettingsSnapshot,
  BudgetEnforcement,
  Importer,
  ScanPayload,
  ImportResult,
  HealthPayload,
  ImportersPayload,
  DiscoverPayload,
  ScanSetupPayload,
  PricingPayload,
  RealizationPayload,
  GuidePayload,
  JudgePayload,
  ClearProposalsPayload,
  Range,
} from './generated-types.ts';

export type {
  Summary,
  PricingCardProvenancePayload,
  PricingEvidencePayload,
  GroupRow,
  SeriesPoint,
  AlertRow,
  Overview,
  ReconciliationCoverage,
  ReconciliationReadiness,
  BillingMappingCoveragePayload,
  BillingKernelClaimSummary,
  BillingPayload,
  EconomicMoney,
  EconomicCoverage,
  EconomicTranslationCoverage,
  EconomicBalance,
  EconomicMoneyJson,
  EconomicAttributionPayload,
  EconomicPeriodClosePayload,
  EconomicPayload,
  RealizationEconomicRollupPayload,
  UsageUnitPayload,
  UsagePayload,
  ReconciliationRunRecord,
  CostCentre,
  AllocationRule,
  AllocationPayload,
  AllocationRunRecord,
  Matured,
  ValueProjectPayload,
  ValuePayload,
  BudgetAdvice,
  CausalPayload,
  BudgetConfig,
  SettingsSnapshot,
  BudgetEnforcement,
  Importer,
  ScanPayload,
  ImportResult,
  HealthPayload,
  ImportersPayload,
  DiscoverPayload,
  ScanSetupPayload,
  PricingPayload,
  RealizationPayload,
  GuidePayload,
  JudgePayload,
  ClearProposalsPayload,
  Range,
} from './generated-types.ts';

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

  const payload: unknown = await response.json();
  // The generic type gives the compiler a view of what the caller consumes;
  // this shared runtime contract prevents a server-side envelope/type drift
  // from becoming an undefined field and an honest-looking empty screen.
  const method = (init?.method ?? 'GET').toUpperCase();
  const route = DASHBOARD_API_CONTRACTS.find((candidate) =>
    path === candidate.path || path.startsWith(candidate.path + '?'),
  );
  if (route !== undefined && (route.methods as readonly string[]).includes(method)) {
    const payloadContract = DASHBOARD_PAYLOAD_CONTRACTS.find((candidate) =>
      candidate.routeId === route.id && candidate.method === method,
    );
    if (payloadContract !== undefined) {
      try {
        validateDashboardPayload(payloadContract, payload);
      } catch (error) {
        throw new ApiError(
          `Dashboard payload contract violation: ${error instanceof Error ? error.message : String(error)}`,
          502,
          path,
        );
      }
    }
  }
  return payload as T;
}

type EconomicQueryOptions = {
  targetCurrency?: string;
  asOf?: string;
  effectiveAt?: string;
};

export const api = {
  health: () => request<HealthPayload>(routePath('health')),
  overview: (range: string, signal?: AbortSignal) => request<Overview>(
    `${routePath('overview')}?range=${encodeURIComponent(range)}`,
    signal ? { signal } : undefined,
  ),
  billing: () => request<BillingPayload>(routePath('billing')),
  allocation: () => request<AllocationPayload>(routePath('allocation')),
  economic: (range: '30d' | 'all' = '30d', options: EconomicQueryOptions = {}) => {
    const params = new URLSearchParams(range === 'all' ? { all: '1' } : { days: '30' });
    if (options.targetCurrency !== undefined) params.set('targetCurrency', options.targetCurrency);
    if (options.asOf !== undefined) params.set('asOf', options.asOf);
    if (options.effectiveAt !== undefined) params.set('effectiveAt', options.effectiveAt);
    return request<EconomicPayload>(`${routePath('economic')}?${params.toString()}`);
  },
  causal: (studyId?: string) => request<CausalPayload>(
    studyId ? routePath('causal') + '?study=' + encodeURIComponent(studyId) : routePath('causal'),
  ),
  value: () => request<ValuePayload>(routePath('value')),
  settings: () => request<SettingsSnapshot>(routePath('settings')),
  guide: () => request<GuidePayload>(routePath('guide')),
  importers: () => request<ImportersPayload>(routePath('importers')),
  /** GET /api/scan is the dry run: it detects and reports, and imports nothing. */
  scan: () => request<ScanPayload>(routePath('scan')),

  /** Mutating calls are grouped so every write in the GUI is greppable in one place. */
  write: {
    settings: (patch: Record<string, unknown>) =>
      request<SettingsSnapshot>(routePath('settings-update'), { method: 'POST', body: JSON.stringify(patch) }),
    clearProposals: () =>
      request<ClearProposalsPayload>(routePath('clear-proposals'), { method: 'POST' }),
    runImport: (tool = 'all') =>
      request<ImportResult>(`${routePath('import')}?tool=${encodeURIComponent(tool)}`, { method: 'POST' }),
    // POST, not GET. An earlier version of this client called /api/discover with
    // the default GET and the server -- which guards it as a mutating route --
    // answered 405 every time. Both correlation routes below write to the ledger.
    discover: () =>
      request<DiscoverPayload>(routePath('discover'), { method: 'POST' }),
    runScan: () =>
      request<ScanSetupPayload>(routePath('scan'), { method: 'POST' }),
  },
};


export const RANGES: ReadonlyArray<{ id: Range; label: string; plain: string }> = [
  { id: 'today', label: 'Today', plain: 'since midnight' },
  { id: '7d', label: '7 days', plain: 'the last week' },
  { id: '30d', label: '30 days', plain: 'the last month' },
  { id: 'all', label: 'All', plain: 'everything recorded' },
];
