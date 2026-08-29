/**
 * Pure functions backing the dashboard Settings view — read a snapshot of everything
 * a user needs to see without the CLI, and apply a validated patch back onto config.
 * Kept separate from server.ts (already large) and framework-free so it's unit-testable
 * without spinning up an HTTP server.
 */

import type { Store, ProviderConnection } from '../store/db.ts';
import type { FiscusConfig, BudgetConfig } from '../config.ts';
import { fiscusHome, configPath, dbPath } from '../config.ts';
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

/** Read-modify-write, mirroring cmdBudget's pattern in src/cli/showCmd.ts. Never mutates config. */
export function applySettingsPatch(config: FiscusConfig, patch: SettingsPatch): FiscusConfig {
  const next: FiscusConfig = { ...config, budget: { ...config.budget } };
  if (typeof patch.metadataOnly === 'boolean') next.metadataOnly = patch.metadataOnly;
  if (typeof patch.retentionDays === 'number' && patch.retentionDays > 0) {
    next.retentionDays = patch.retentionDays;
  }
  if (typeof patch.proposalRetentionDays === 'number' && patch.proposalRetentionDays > 0) {
    next.proposalRetentionDays = patch.proposalRetentionDays;
  }
  if (patch.budget) {
    const b = patch.budget;
    if ('dailyUsd' in b) next.budget.dailyUsd = b.dailyUsd ?? null;
    if ('dailySoftUsd' in b) next.budget.dailySoftUsd = b.dailySoftUsd ?? null;
    if ('sessionUsd' in b) next.budget.sessionUsd = b.sessionUsd ?? null;
    if ('runawayMaxUsd' in b) next.budget.runawayMaxUsd = b.runawayMaxUsd ?? null;
    if (typeof b.runawayWindowSec === 'number' && b.runawayWindowSec > 0) {
      next.budget.runawayWindowSec = b.runawayWindowSec;
    }
    if (typeof b.capIncludesImported === 'boolean') next.budget.capIncludesImported = b.capIncludesImported;
  }
  return next;
}
