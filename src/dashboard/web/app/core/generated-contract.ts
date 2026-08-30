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

export type DashboardPayloadValueKind = 'string' | 'number' | 'boolean' | 'object' | 'array';

export interface DashboardPayloadField {
  readonly name: string;
  readonly kind: DashboardPayloadValueKind;
  readonly nullable?: boolean;
}

export interface DashboardPayloadContract {
  readonly routeId: DashboardApiContractId;
  readonly method: DashboardHttpMethod;
  readonly contentType: 'json' | 'text';
  readonly responseType: string;
  /** Required top-level envelope fields; nested types stay in browser interfaces. */
  readonly required: readonly DashboardPayloadField[];
}

const field = (name: string, kind: DashboardPayloadValueKind, nullable = false): DashboardPayloadField => Object.freeze({
  name,
  kind,
  ...(nullable ? { nullable: true } : {}),
});

/**
 * Shared top-level envelopes for every dashboard API method. This is purposely
 * narrower than a generated JSON Schema: it is the stable boundary that lets
 * the runtime checker catch missing/wrong envelope fields while the detailed
 * browser interfaces continue to describe the fields each view consumes.
 */
export const DASHBOARD_PAYLOAD_CONTRACTS = [
  { routeId: 'health', method: 'GET', contentType: 'json', responseType: 'HealthPayload', required: [field('ok', 'boolean'), field('service', 'string')] },
  { routeId: 'importers', method: 'GET', contentType: 'json', responseType: '{ importers: Importer[] }', required: [field('importers', 'array')] },
  { routeId: 'import', method: 'POST', contentType: 'json', responseType: 'ImportResult', required: [field('ok', 'boolean'), field('totalNew', 'number'), field('results', 'object')] },
  { routeId: 'discover', method: 'POST', contentType: 'json', responseType: 'inline discover response', required: [field('ok', 'boolean'), field('foundFolders', 'number'), field('correlated', 'number'), field('discovered', 'array')] },
  { routeId: 'scan', method: 'GET', contentType: 'json', responseType: 'ScanPayload', required: [field('ok', 'boolean'), field('tools', 'array'), field('otherApps', 'array'), field('roots', 'array'), field('repoCount', 'number'), field('reposWithSpend', 'number'), field('hitBudget', 'boolean'), field('dirsVisited', 'number'), field('unreadableDirs', 'number'), field('diff', 'object')] },
  { routeId: 'scan', method: 'POST', contentType: 'json', responseType: 'inline scan setup response', required: [field('ok', 'boolean'), field('totalNew', 'number'), field('imported', 'object'), field('correlated', 'number'), field('discovered', 'array')] },
  { routeId: 'overview', method: 'GET', contentType: 'json', responseType: 'Overview', required: [field('range', 'string'), field('demo', 'boolean'), field('generatedAt', 'string'), field('budget', 'object'), field('summary', 'object'), field('pricing', 'object'), field('byModel', 'array'), field('byProject', 'array'), field('attributionEvidence', 'array'), field('byUser', 'array'), field('bySource', 'array'), field('characterization', 'object'), field('dimensions', 'array'), field('series', 'array'), field('recent', 'array'), field('alerts', 'array')] },
  { routeId: 'billing', method: 'GET', contentType: 'json', responseType: 'BillingPayload', required: [field('demo', 'boolean'), field('generatedAt', 'string'), field('evidence', 'object'), field('summary', 'object'), field('imports', 'array'), field('kernel', 'object'), field('readiness', 'object'), field('mapping', 'object'), field('directOpenAiCosts', 'object'), field('reconciliation', 'object')] },
  { routeId: 'allocation', method: 'GET', contentType: 'json', responseType: 'AllocationPayload', required: [field('demo', 'boolean'), field('generatedAt', 'string'), field('kind', 'string'), field('trust', 'string'), field('basis', 'string'), field('excludedFrom', 'array'), field('costCentres', 'array'), field('rules', 'array'), field('runs', 'array'), field('reconciliation', 'object')] },
  { routeId: 'economic', method: 'GET', contentType: 'json', responseType: 'EconomicPayload', required: [field('kind', 'string'), field('schemaVersion', 'number'), field('demo', 'boolean'), field('window', 'object'), field('projection', 'object'), field('periodClose', 'object')] },
  { routeId: 'pricing', method: 'GET', contentType: 'json', responseType: 'inline pricing payload', required: [field('demo', 'boolean'), field('generatedAt', 'string'), field('window', 'object'), field('activeRateCard', 'object'), field('total', 'object'), field('provenance', 'array'), field('boundary', 'string')] },
  { routeId: 'export-csv', method: 'GET', contentType: 'text', responseType: 'text/csv', required: [] },
  { routeId: 'realization', method: 'GET', contentType: 'json', responseType: 'inline realization payload', required: [field('available', 'boolean'), field('repo', 'string')] },
  { routeId: 'guide', method: 'GET', contentType: 'json', responseType: 'Record<string, unknown>', required: [field('stage', 'string'), field('headline', 'string'), field('steps', 'array'), field('next', 'object'), field('hint', 'object', true)] },
  { routeId: 'judge', method: 'POST', contentType: 'json', responseType: 'inline judge payload', required: [] },
  { routeId: 'value', method: 'GET', contentType: 'json', responseType: 'ValuePayload', required: [field('demo', 'boolean'), field('gitRepo', 'boolean'), field('valueSource', 'string', true), field('repo', 'string'), field('generatedAt', 'string'), field('realization', 'object', true), field('roi', 'object', true), field('frontier', 'object', true), field('budget', 'object', true), field('allocation', 'object', true), field('projects', 'array'), field('projectAllocation', 'object', true), field('usage', 'object', true), field('team', 'object', true), field('drift', 'object', true), field('reclaimed', 'object', true)] },
  { routeId: 'causal', method: 'GET', contentType: 'json', responseType: 'CausalPayload', required: [field('demo', 'boolean'), field('generatedAt', 'string'), field('studies', 'array'), field('study', 'object', true), field('causalEvidence', 'string'), field('boundary', 'string')] },
  { routeId: 'settings', method: 'GET', contentType: 'json', responseType: 'SettingsSnapshot', required: [field('version', 'string'), field('home', 'string'), field('configPath', 'string'), field('dbPath', 'string'), field('proxyPort', 'number'), field('dashboardPort', 'number'), field('retentionDays', 'number'), field('proposalRetentionDays', 'number'), field('metadataOnly', 'boolean'), field('budget', 'object'), field('enforcement', 'object'), field('egress', 'object'), field('connections', 'array')] },
  { routeId: 'settings-update', method: 'POST', contentType: 'json', responseType: 'SettingsSnapshot', required: [field('version', 'string'), field('home', 'string'), field('configPath', 'string'), field('dbPath', 'string'), field('proxyPort', 'number'), field('dashboardPort', 'number'), field('retentionDays', 'number'), field('proposalRetentionDays', 'number'), field('metadataOnly', 'boolean'), field('budget', 'object'), field('enforcement', 'object'), field('egress', 'object'), field('connections', 'array')] },
  { routeId: 'clear-proposals', method: 'POST', contentType: 'json', responseType: 'inline clear-proposals response', required: [field('ok', 'boolean'), field('removed', 'number')] },
] as const satisfies readonly DashboardPayloadContract[];

export function dashboardPayloadContract(routeId: DashboardApiContractId, method: DashboardHttpMethod): DashboardPayloadContract {
  const contract = DASHBOARD_PAYLOAD_CONTRACTS.find((candidate) => candidate.routeId === routeId && candidate.method === method);
  if (contract === undefined) throw new Error(`unknown dashboard payload contract: ${routeId} ${method}`);
  return contract;
}
