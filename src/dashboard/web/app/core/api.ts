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
  checkInterfaceShape,
  dashboardApiContract,
  validateDashboardPayload,
  type DashboardApiContractId,
} from './generated-contract.ts';
import { DASHBOARD_INTERFACE_CONTRACTS } from './generated-payload-contract.ts';

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
  StatementPayload,
  StatementBilledRun,
  StatementAllocatedRun,
  BillingImportSummary,
  BillingWritePayload,
  BillingImportPreviewPayload,
  BillingAdoptionPlanPayload,
  BillingReconcileResultPayload,
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
  SelfReportedValuePayload,
  ReportedValueCellPayload,
  OutcomeRecordPayload,
  MarketPayload,
  MarketBoardPayload,
  MarketBenchmarkRowPayload,
  MarketRatingRowPayload,
  MarketConsensusPayload,
  ReconciliationRunRecord,
  CostCentre,
  AllocationTarget,
  AllocationRule,
  AllocationCentreShare,
  AllocationUnallocated,
  AllocationRunResultPayload,
  AllocationPayload,
  AllocationRunRecord,
  AllocationWritePayload,
  Matured,
  ValueProjectPayload,
  ValuePayload,
  BudgetAdvice,
  CausalPayload,
  KernelNodePayload,
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
  StatementPayload,
  StatementBilledRun,
  StatementAllocatedRun,
  BillingImportSummary,
  BillingWritePayload,
  BillingImportPreviewPayload,
  BillingAdoptionPlanPayload,
  BillingReconcileResultPayload,
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
  SelfReportedValuePayload,
  ReportedValueCellPayload,
  OutcomeRecordPayload,
  MarketPayload,
  MarketBoardPayload,
  MarketBenchmarkRowPayload,
  MarketRatingRowPayload,
  MarketConsensusPayload,
  ReconciliationRunRecord,
  CostCentre,
  AllocationTarget,
  AllocationRule,
  AllocationCentreShare,
  AllocationUnallocated,
  AllocationRunResultPayload,
  AllocationPayload,
  AllocationRunRecord,
  AllocationWritePayload,
  Matured,
  ValueProjectPayload,
  ValuePayload,
  BudgetAdvice,
  CausalPayload,
  KernelNodePayload,
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
        // site cannot drive the operator's local Segreant by loading an image.
        'x-segreant-local': '1',
        ...(init?.body ? { 'content-type': 'application/json' } : {}),
        ...init?.headers,
      },
    });
  } catch {
    // The server is on localhost, so a network failure means it stopped — worth
    // saying plainly rather than rendering an empty screen that looks like zero.
    throw new ApiError('Segreant is not responding. Is it still running?', 0, path);
  }

  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    // Show the human message, never the raw JSON envelope. The dashboard's own
    // routes answer `{ error: "sentence" }`; some answer `{ error: { message } }`.
    // Only the second was read, so every refusal from a dashboard route, an
    // allocation or billing write included, reached the screen as raw JSON.
    let human: string | null = null;
    try {
      const parsed: unknown = JSON.parse(detail);
      const error = typeof parsed === 'object' && parsed !== null && 'error' in parsed ? (parsed as { error: unknown }).error : undefined;
      if (typeof error === 'string' && error.trim()) human = error;
      else if (typeof error === 'object' && error !== null && typeof (error as { message?: unknown }).message === 'string') {
        human = (error as { message: string }).message;
      }
    } catch {
      // Not JSON: keep the text fallback below.
    }
    throw new ApiError(human ?? (detail.slice(0, 400) || `${response.status} ${response.statusText}`), response.status, path);
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
      // Deep check against the generated field table of shared-types.ts
      // (D-243): the same walk the contract test runs against live routes, so a
      // declaration that does not match the wire fails here in the browser
      // rather than as NaN in a view. Fail closed: a screen built on a payload
      // the declaration misdescribes is the defect this repository keeps finding.
      if (/^[A-Z]\w*$/.test(payloadContract.responseType)) {
        const problems = checkInterfaceShape(payloadContract.responseType, payload, DASHBOARD_INTERFACE_CONTRACTS, payloadContract.responseType);
        if (problems.length > 0) {
          throw new ApiError(`Dashboard interface contract violation: ${problems.slice(0, 3).join('; ')}${problems.length > 3 ? ` (+${problems.length - 3} more)` : ''}`, 502, path);
        }
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
  /** One calendar month, `YYYY-MM`; the four claims side by side, never summed. */
  statement: (month?: string) => request<StatementPayload>(month ? `${routePath('statement')}?month=${encodeURIComponent(month)}` : routePath('statement')),
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
  /** One kernel node with its neighbourhood, live or as the ledger had it at `asOf` (D-257). */
  kernel: (nodeId: string, asOf?: string) => request<KernelNodePayload>(
    `${routePath('kernel')}?node=${encodeURIComponent(nodeId)}${asOf ? '&asOf=' + encodeURIComponent(asOf) : ''}`,
  ),
  value: () => request<ValuePayload>(routePath('value')),
  /** Public evidence only; reads the local snapshot, never fetches. */
  market: () => request<MarketPayload>(routePath('market')),
  settings: () => request<SettingsSnapshot>(routePath('settings')),
  guide: () => request<GuidePayload>(routePath('guide')),
  importers: () => request<ImportersPayload>(routePath('importers')),
  /** GET /api/scan is the dry run: it detects and reports, and imports nothing. */
  scan: () => request<ScanPayload>(routePath('scan')),

  /** Mutating calls are grouped so every write in the GUI is greppable in one place. */
  write: {
    /**
     * Month close: `scope`, `import`, `adopt`, `reconcile`. Without `apply: true`
     * every op is a preview and writes nothing. An import carries the file's raw
     * bytes in base64, so its digest is the one the CLI computes for the file.
     */
    billing: (body: Record<string, unknown>) =>
      request<BillingWritePayload>(routePath('billing-write'), { method: 'POST', body: JSON.stringify(body) }),
    /** Cost centres, rules and runs. A run with `apply: false` is a preview and records nothing. */
    allocation: (body: Record<string, unknown>) =>
      request<AllocationWritePayload>(routePath('allocation-write'), { method: 'POST', body: JSON.stringify(body) }),
    outcome: (input: Record<string, unknown>, apply: boolean) =>
      request<OutcomeRecordPayload>(routePath('outcome-record'), { method: 'POST', body: JSON.stringify({ ...input, apply }) }),
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
