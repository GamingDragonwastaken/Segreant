/**
 * Local capture-coverage view for a completed OpenAI Costs observation.
 *
 * This deliberately measures only what is present in the local request ledger.
 * It does not sum provider line-item amounts, calculate a variance, or convert
 * an operator-declared route scope into a verified billing-account binding.
 */

import type {
  OpenAiCostsObservationLine,
  OpenAiCostsObservationRun,
  RequestRow,
} from '../store/db.ts';

export interface CapturedUsageSummary {
  requestCount: number;
  costUsd: number;
  estimatedRequestCount: number;
  estimatedCostUsd: number;
  inputTokens: number;
  outputTokens: number;
  cacheWriteTokens: number;
  cacheReadTokens: number;
  reasoningTokens: number;
}

export interface OpenAiCostsCaptureCoverage {
  /** A deliberately blocked state, never a reconciliation result. */
  comparisonStatus: 'blocked_not_reconciled';
  varianceStatus: 'not_calculated';
  observation: {
    observationRunId: string;
    declaredScopeId: string;
    providerProjectRef: string;
    periodStartMs: number;
    periodEndMs: number;
    fetchedAtMs: number;
    providerLineCount: number;
    currencies: string[];
    providerFinality: 'undocumented';
  };
  /**
   * Only live proxy rows that carry the same immutable local declaration.
   * Their cost is still Fiscus's local rate-card estimate, not a provider total.
   */
  capturedOnDeclaredRoute: CapturedUsageSummary;
  /** Disjoint local-ledger categories that cannot join this provider snapshot. */
  excludedFromDeclaredRoute: {
    importedOrNative: CapturedUsageSummary;
    unscopedOrLegacyOpenAiProxy: CapturedUsageSummary;
    differentDeclaredOpenAiScope: CapturedUsageSummary;
    otherProvider: CapturedUsageSummary;
  };
  /** Conservation check: capturedOnDeclaredRoute plus every excluded bucket. */
  allLocalLedgerRowsInPeriod: CapturedUsageSummary;
  trust: 'operator_declared_unverified';
  /**
   * Whether retention deleted request rows from inside the OBSERVED period
   * (D-185).
   *
   * Every local-side bucket above is a count over rows that survive. A prune
   * whose boundary falls inside the provider's period empties them without
   * emptying the provider snapshot, so the report reads "the declared route
   * captured nothing" for a period on which it captured everything. Measured:
   * ten requests and $180.00 on the declared route became 0 and $0.00, with the
   * blocker list byte-for-byte identical.
   *
   * It is NOT in `blockers`, deliberately. That tuple's meaning is "these five
   * conditions hold always"; this one holds sometimes, and a conditional fact
   * in a permanent list either reads as permanent or makes the list's promise
   * false. Same separation D-173 made for the reconciliation conditions.
   */
  localLedgerRetention: { truncated: boolean; prunedBeforeMs: number | null };
  blockers: readonly [
    'local_route_scope_is_not_provider_verified',
    'off_path_provider_usage_is_not_observable',
    'provider_finality_is_undocumented',
    'provider_line_items_do_not_join_to_requests_or_models',
    'local_request_amounts_are_rate_card_estimates',
  ];
}

function emptyUsage(): CapturedUsageSummary {
  return {
    requestCount: 0,
    costUsd: 0,
    estimatedRequestCount: 0,
    estimatedCostUsd: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheWriteTokens: 0,
    cacheReadTokens: 0,
    reasoningTokens: 0,
  };
}

function addUsage(summary: CapturedUsageSummary, row: RequestRow): void {
  summary.requestCount += 1;
  summary.costUsd += row.costUsd;
  summary.inputTokens += row.inputTokens;
  summary.outputTokens += row.outputTokens;
  summary.cacheWriteTokens += row.cacheWriteTokens;
  summary.cacheReadTokens += row.cacheReadTokens;
  summary.reasoningTokens += row.reasoningTokens;
  if (row.estimated) {
    summary.estimatedRequestCount += 1;
    summary.estimatedCostUsd += row.costUsd;
  }
}

/**
 * Partition every local row in one completed provider snapshot period. The
 * categories are intentionally disjoint so a reviewer can account for all
 * observed local traffic without mistaking it for organization-wide coverage.
 */
export function buildOpenAiCostsCaptureCoverage(input: {
  run: OpenAiCostsObservationRun;
  observations: readonly OpenAiCostsObservationLine[];
  requests: readonly RequestRow[];
  /** The retention boundary in force; null is NO PRUNE ON RECORD (D-185). */
  requestsPrunedBeforeMs?: number | null;
}): OpenAiCostsCaptureCoverage {
  const capturedOnDeclaredRoute = emptyUsage();
  const importedOrNative = emptyUsage();
  const unscopedOrLegacyOpenAiProxy = emptyUsage();
  const differentDeclaredOpenAiScope = emptyUsage();
  const otherProvider = emptyUsage();
  const allLocalLedgerRowsInPeriod = emptyUsage();

  for (const row of input.requests) {
    addUsage(allLocalLedgerRowsInPeriod, row);
    const isMatchingDeclaredRoute = row.provider === 'openai'
      && row.via === 'proxy'
      && row.scopeCaptureStatus === 'declared_unverified'
      && row.providerScopeDeclarationId === input.run.declaredScopeId;
    if (isMatchingDeclaredRoute) {
      addUsage(capturedOnDeclaredRoute, row);
    } else if (row.via === 'import') {
      addUsage(importedOrNative, row);
    } else if (row.provider !== 'openai') {
      addUsage(otherProvider, row);
    } else if (row.scopeCaptureStatus === 'declared_unverified' && row.providerScopeDeclarationId !== input.run.declaredScopeId) {
      addUsage(differentDeclaredOpenAiScope, row);
    } else {
      addUsage(unscopedOrLegacyOpenAiProxy, row);
    }
  }

  return {
    comparisonStatus: 'blocked_not_reconciled',
    varianceStatus: 'not_calculated',
    observation: {
      observationRunId: input.run.observationRunId,
      declaredScopeId: input.run.declaredScopeId,
      providerProjectRef: input.run.providerProjectRef,
      periodStartMs: input.run.periodStartMs,
      periodEndMs: input.run.periodEndMs,
      fetchedAtMs: input.run.fetchedAtMs,
      providerLineCount: input.observations.length,
      currencies: [...new Set(input.observations.map((line) => line.currency))].sort(),
      providerFinality: 'undocumented',
    },
    capturedOnDeclaredRoute,
    excludedFromDeclaredRoute: {
      importedOrNative,
      unscopedOrLegacyOpenAiProxy,
      differentDeclaredOpenAiScope,
      otherProvider,
    },
    allLocalLedgerRowsInPeriod,
    trust: 'operator_declared_unverified',
    // Truncated when the OBSERVED period starts strictly before a recorded
    // boundary, because `prune` deletes rows strictly older than it. The period
    // compared here is the provider's, not a window the caller chose.
    localLedgerRetention: {
      truncated: input.requestsPrunedBeforeMs !== undefined
        && input.requestsPrunedBeforeMs !== null
        && input.run.periodStartMs < input.requestsPrunedBeforeMs,
      prunedBeforeMs: input.requestsPrunedBeforeMs ?? null,
    },
    blockers: [
      'local_route_scope_is_not_provider_verified',
      'off_path_provider_usage_is_not_observable',
      'provider_finality_is_undocumented',
      'provider_line_items_do_not_join_to_requests_or_models',
      'local_request_amounts_are_rate_card_estimates',
    ],
  };
}
