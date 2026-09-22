/**
 * Pure functions backing the dashboard Settings view — read a snapshot of everything
 * a user needs to see without the CLI, and apply a validated patch back onto config.
 * Kept separate from server.ts (already large) and framework-free so it's unit-testable
 * without spinning up an HTTP server.
 */

import type { Store, ProviderConnection } from '../store/db.ts';
import type { FiscusConfig, BudgetConfig } from '../config.ts';
import { fiscusHome, configPath, dbPath, validateBudgetConfig } from '../config.ts';
import { describeBudgetEnforcement, type BudgetEnforcementDescriptor } from '../budget/enforceability.ts';
import { egressReceiptPath, verifyEgressReceipts } from '../egress/receipts.ts';

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
  egress: {
    mode: FiscusConfig['egress']['mode'];
    rules: FiscusConfig['egress']['rules'];
    receipts: ReturnType<typeof verifyEgressReceipts> & { path: string };
    scope: string;
  };
  connections: ProviderConnection[];
}

export function buildSettingsSnapshot(
  store: Store,
  config: FiscusConfig,
  version: string,
  windowDays = 14,
): SettingsSnapshot {
  const sinceMs = Date.now() - windowDays * 24 * 60 * 60 * 1000;
  return {
    version,
    home: fiscusHome(),
    configPath: configPath(),
    dbPath: dbPath(),
    proxyPort: config.port,
    dashboardPort: config.dashboardPort,
    retentionDays: config.retentionDays,
    proposalRetentionDays: config.proposalRetentionDays,
    metadataOnly: config.metadataOnly,
    budget: config.budget,
    enforcement: describeBudgetEnforcement(config.budget),
    egress: {
      mode: config.egress.mode,
      rules: config.egress.rules,
      receipts: { path: egressReceiptPath(), ...verifyEgressReceipts() },
      scope: 'Fiscus-process HTTP(S) transport only; not other apps, direct clients, OS networking, or provider retention.',
    },
    connections: store.recentProviderConnections(sinceMs),
  };
}

export interface SettingsPatch {
  metadataOnly?: boolean;
  retentionDays?: number;
  proposalRetentionDays?: number;
  budget?: Partial<BudgetConfig>;
}

export class SettingsValidationError extends Error {
  readonly code = 'SETTINGS_INVALID';

  constructor(message: string) {
    super(`SETTINGS_INVALID: ${message}`);
    this.name = 'SettingsValidationError';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

const PATCH_KEYS = new Set(['metadataOnly', 'retentionDays', 'proposalRetentionDays', 'budget']);
const BUDGET_KEYS = new Set([
  'dailyUsd', 'dailySoftUsd', 'sessionUsd', 'runawayWindowSec', 'runawayMaxUsd', 'capIncludesImported',
]);

/** Read-modify-write, mirroring cmdBudget's pattern in src/cli/showCmd.ts. Never mutates config. */
export function applySettingsPatch(config: FiscusConfig, patch: SettingsPatch): FiscusConfig {
  if (!isRecord(patch)) throw new SettingsValidationError('patch must be an object');
  for (const key of Object.keys(patch)) {
    if (!PATCH_KEYS.has(key)) throw new SettingsValidationError(`unsupported patch key: ${key}`);
  }
  const next: FiscusConfig = { ...config, budget: { ...config.budget } };
  if ('metadataOnly' in patch && typeof patch.metadataOnly !== 'boolean') {
    throw new SettingsValidationError('metadataOnly must be boolean');
  }
  if (typeof patch.metadataOnly === 'boolean') next.metadataOnly = patch.metadataOnly;
  if (typeof patch.retentionDays === 'number' && patch.retentionDays > 0) {
    next.retentionDays = patch.retentionDays;
  }
  if (typeof patch.proposalRetentionDays === 'number' && patch.proposalRetentionDays > 0) {
    next.proposalRetentionDays = patch.proposalRetentionDays;
  }
  if ('budget' in patch) {
    if (!isRecord(patch.budget)) throw new SettingsValidationError('budget must be an object');
    const b = patch.budget;
    for (const key of Object.keys(b)) {
      if (!BUDGET_KEYS.has(key)) throw new SettingsValidationError(`unsupported budget key: ${key}`);
    }
    if ('dailyUsd' in b) next.budget.dailyUsd = b.dailyUsd as BudgetConfig['dailyUsd'];
    if ('dailySoftUsd' in b) next.budget.dailySoftUsd = b.dailySoftUsd as BudgetConfig['dailySoftUsd'];
    if ('sessionUsd' in b) next.budget.sessionUsd = b.sessionUsd as BudgetConfig['sessionUsd'];
    if ('runawayMaxUsd' in b) next.budget.runawayMaxUsd = b.runawayMaxUsd as BudgetConfig['runawayMaxUsd'];
    if ('runawayWindowSec' in b) next.budget.runawayWindowSec = b.runawayWindowSec as number;
    if ('capIncludesImported' in b) next.budget.capIncludesImported = b.capIncludesImported as boolean;
    try {
      validateBudgetConfig(next.budget);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new SettingsValidationError(message.replace(/^CONFIG_INVALID:\s*/, ''));
    }
  }
  return next;
}
