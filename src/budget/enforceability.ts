/**
 * Enforcement truth for budget controls.
 *
 * A configured threshold, a blockable threshold, an observed-only amount, and a
 * provider-native control are different claims. This module names the distinction
 * without changing BudgetGuard behavior.
 */

import type { BudgetConfig } from '../config.ts';

export const ENFORCEABILITY_STATES = [
  'enforced_in_path',
  'provider_native',
  'observed_only',
  'proposed',
  'unknown',
] as const;

export type EnforceabilityState = (typeof ENFORCEABILITY_STATES)[number];

export interface BudgetEnforcementDescriptor {
  localProxy: {
    state: 'enforced_in_path';
    mechanism: 'local_proxy';
    /** At least one hard blocker (daily/session/runaway) is configured now. */
    hardControlActive: boolean;
    /** The warning-only daily threshold is configured now. */
    warningActive: boolean;
    /** Dashboard/CLI config changes are read by the running guard. */
    liveConfig: boolean;
    /** Which observed dollars are used to decide whether a future proxy request is blocked. */
    spendScope: 'live_proxy' | 'all_observed';
  };
  importedSpend: {
    state: 'observed_only';
    blockable: false;
    /** Imported spend may influence a later proxy decision, but cannot itself be stopped. */
    countsTowardInPathCap: boolean;
  };
  providerNative: {
    /** Fiscus does not currently inspect or attest provider-side limits. */
    state: 'unknown';
    inspected: false;
  };
  recommendation: {
    /** Budget advice is a proposal until the operator applies it. */
    state: 'proposed';
    automaticallyApplied: false;
  };
}

export function describeBudgetEnforcement(cfg: BudgetConfig): BudgetEnforcementDescriptor {
  return {
    localProxy: {
      state: 'enforced_in_path',
      mechanism: 'local_proxy',
      hardControlActive: cfg.dailyUsd !== null || cfg.sessionUsd !== null || cfg.runawayMaxUsd !== null,
      warningActive: cfg.dailySoftUsd !== null,
      liveConfig: true,
      spendScope: cfg.capIncludesImported ? 'all_observed' : 'live_proxy',
    },
    importedSpend: {
      state: 'observed_only',
      blockable: false,
      countsTowardInPathCap: cfg.capIncludesImported,
    },
    providerNative: {
      state: 'unknown',
      inspected: false,
    },
    recommendation: {
      state: 'proposed',
      automaticallyApplied: false,
    },
  };
}
