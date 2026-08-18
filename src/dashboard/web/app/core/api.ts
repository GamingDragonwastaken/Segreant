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
  key?: string;
  name?: string;
  model?: string;
  project?: string;
  source?: string;
  requests: number;
  costUsd: number;
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

export interface ValuePayload {
  demo: boolean;
  allocation: unknown;
  frontier?: { modelSwitches?: Array<{ confidence: string }> } | null;
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
  settings: () => request<Record<string, unknown>>('/api/settings'),
  guide: () => request<Record<string, unknown>>('/api/guide'),
  importers: () => request<Record<string, unknown>>('/api/importers'),
  scan: () => request<Record<string, unknown>>('/api/scan'),
  discover: () => request<Record<string, unknown>>('/api/discover'),

  /** Mutating calls are grouped so every write in the GUI is greppable in one place. */
  write: {
    settings: (patch: Record<string, unknown>) =>
      request<Record<string, unknown>>('/api/settings/update', { method: 'POST', body: JSON.stringify(patch) }),
    clearProposals: () =>
      request<{ ok: boolean; removed: number }>('/api/settings/clear-proposals', { method: 'POST' }),
    runImport: (body: Record<string, unknown>) =>
      request<Record<string, unknown>>('/api/import', { method: 'POST', body: JSON.stringify(body) }),
  },
};

export type Range = 'today' | '7d' | '30d' | 'all';

export const RANGES: ReadonlyArray<{ id: Range; label: string; plain: string }> = [
  { id: 'today', label: 'Today', plain: 'since midnight' },
  { id: '7d', label: '7 days', plain: 'the last week' },
  { id: '30d', label: '30 days', plain: 'the last month' },
  { id: 'all', label: 'All', plain: 'everything recorded' },
];
