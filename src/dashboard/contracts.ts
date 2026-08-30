/**
 * Canonical, runtime-safe dashboard API route contract.
 *
 * This module deliberately has no Node or DOM imports. The server consumes it
 * directly, and the build copies the exact bytes into the browser app so route
 * paths, methods and CSRF declarations cannot fork between the two runtimes.
 * Payload field schemas are being migrated in the next contract tranche; the
 * responseType names here make that migration explicit rather than hiding it
 * behind an untyped route map.
 */

export type DashboardHttpMethod = 'GET' | 'HEAD' | 'POST';

export interface DashboardApiContract {
  readonly id: string;
  readonly path: string;
  readonly methods: readonly DashboardHttpMethod[];
  readonly localOnly: readonly DashboardHttpMethod[];
  readonly allow?: string;
  /** Browser payload interface or an explicit inline response description. */
  readonly responseType: string;
  /** Which shipped browser surface binds this route, or `[]` when CLI/API-only. */
  readonly browserBinding: readonly ('modern-api' | 'classic' | 'actions')[];
}

export const DASHBOARD_API_CONTRACTS = [
  { id: 'health', path: '/api/health', methods: ['GET', 'HEAD'], localOnly: [], responseType: 'HealthPayload', browserBinding: ['modern-api'] },
  { id: 'importers', path: '/api/importers', methods: ['GET', 'HEAD'], localOnly: [], responseType: '{ importers: Importer[] }', browserBinding: ['modern-api', 'classic'] },
  { id: 'import', path: '/api/import', methods: ['POST'], localOnly: ['POST'], responseType: 'ImportResult', browserBinding: ['modern-api', 'classic'] },
  { id: 'discover', path: '/api/discover', methods: ['POST'], localOnly: ['POST'], responseType: '{ ok: boolean; foundFolders: number; correlated: number }', browserBinding: ['modern-api', 'classic'] },
  { id: 'scan', path: '/api/scan', methods: ['GET', 'POST'], localOnly: ['POST'], responseType: 'ScanPayload', browserBinding: ['modern-api', 'classic'] },
  { id: 'overview', path: '/api/overview', methods: ['GET', 'HEAD'], localOnly: [], responseType: 'Overview', browserBinding: ['modern-api', 'classic'] },
  { id: 'billing', path: '/api/billing', methods: ['GET'], localOnly: [], responseType: 'BillingPayload', browserBinding: ['modern-api', 'classic'] },
  { id: 'allocation', path: '/api/allocation', methods: ['GET'], localOnly: [], responseType: 'AllocationPayload', browserBinding: ['modern-api', 'classic'] },
  { id: 'economic', path: '/api/economic', methods: ['GET', 'HEAD'], localOnly: [], responseType: 'EconomicPayload', browserBinding: ['modern-api'] },
  { id: 'pricing', path: '/api/pricing', methods: ['GET', 'HEAD'], localOnly: [], responseType: 'inline pricing payload', browserBinding: [] },
  { id: 'export-csv', path: '/api/export.csv', methods: ['GET', 'HEAD'], localOnly: [], responseType: 'text/csv', browserBinding: ['classic', 'actions'] },
  { id: 'realization', path: '/api/realization', methods: ['GET', 'HEAD'], localOnly: [], responseType: 'inline realization payload', browserBinding: [] },
  { id: 'guide', path: '/api/guide', methods: ['GET', 'HEAD'], localOnly: [], responseType: 'Record<string, unknown>', browserBinding: ['modern-api', 'classic'] },
  { id: 'judge', path: '/api/judge', methods: ['POST'], localOnly: ['POST'], responseType: 'inline judge payload', browserBinding: ['classic'] },
  { id: 'value', path: '/api/value', methods: ['GET', 'HEAD'], localOnly: [], responseType: 'ValuePayload', browserBinding: ['modern-api', 'classic'] },
  { id: 'causal', path: '/api/causal', methods: ['GET', 'HEAD'], localOnly: [], responseType: 'CausalPayload', browserBinding: ['modern-api'] },
  { id: 'settings', path: '/api/settings', methods: ['GET'], localOnly: [], allow: 'GET, POST', responseType: 'SettingsSnapshot', browserBinding: ['modern-api', 'classic'] },
  { id: 'settings-update', path: '/api/settings/update', methods: ['POST'], localOnly: ['POST'], responseType: 'SettingsSnapshot', browserBinding: ['modern-api', 'classic'] },
  { id: 'clear-proposals', path: '/api/settings/clear-proposals', methods: ['POST'], localOnly: ['POST'], responseType: '{ ok: boolean; removed: number }', browserBinding: ['modern-api', 'classic'] },
] as const satisfies readonly DashboardApiContract[];

export type DashboardApiContractId = (typeof DASHBOARD_API_CONTRACTS)[number]['id'];

export function dashboardApiContract(id: DashboardApiContractId): DashboardApiContract {
  const contract = DASHBOARD_API_CONTRACTS.find((candidate) => candidate.id === id);
  if (contract === undefined) throw new Error(`unknown dashboard API contract: ${id}`);
  return contract;
}
