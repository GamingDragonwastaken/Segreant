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

import type { Summary, GroupRow, SeriesPoint, AlertRow, Overview, BillingPayload, CostCentre, AllocationRule, AllocationPayload, Matured, ValuePayload, BudgetAdvice, BudgetConfig, SettingsSnapshot, Importer, ScanPayload, ImportResult, HealthPayload } from './contracts.ts';
export type { Summary, GroupRow, SeriesPoint, AlertRow, Overview, BillingPayload, CostCentre, AllocationRule, AllocationPayload, Matured, ValuePayload, BudgetAdvice, BudgetConfig, SettingsSnapshot, Importer, ScanPayload, ImportResult, HealthPayload } from './contracts.ts';

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
