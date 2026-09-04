/**
 * Provider reconciliation at the only grain that joins.
 *
 * `openaiCostsCoverage.ts` partitions the local ledger against a provider
 * snapshot and then refuses to compare them, listing five blockers. Three of
 * those five are not blockers to reconciliation — they are blockers to a
 * PER-REQUEST reconciliation, which nobody should attempt:
 *
 *   - `provider_line_items_do_not_join_to_requests_or_models` — true, and the
 *     reason this module compares project-DAY TOTALS. A line item is not a
 *     model and never will be; summing a day's line items and comparing that
 *     one number is a compatible join, not a lossy one.
 *   - `local_request_amounts_are_rate_card_estimates` — true, and it is the
 *     SUBJECT of the comparison rather than an obstacle to it. The gap between
 *     a list-price estimate and a provider report is the thing being measured.
 *   - `provider_finality_is_undocumented` — true of any single snapshot, which
 *     is why a run records whether independent snapshots of the same period
 *     agree. That is observed stability, never provider-attested finality.
 *
 * Two survive as permanent CONDITIONS on every result, and are carried on the
 * record rather than resolved:
 *
 *   - `local_route_scope_is_not_provider_verified` — the operator declared that
 *     traffic to one endpoint belongs to one project. Nothing here proves it.
 *     Every number below is conditional on that declaration being true.
 *   - `off_path_provider_usage_is_not_observable` — usage that never passed
 *     through Fiscus cannot be seen, only inferred from the residual.
 *
 * So the output is never `reconciled`. It is `reconciled_with_residual`: a
 * variance, per day, with a structural reason, under stated conditions. A
 * number that agreed exactly would be more suspicious than one that did not.
 *
 * Pure and store-free so it can be tested against fixtures without a database
 * and without a provider credential.
 */

import { usdMicros, formatUsdMicros } from './types.ts';
import { formatMoneyAmount } from '../economics/money.ts';
import type { OpenAiCostsObservationLine, OpenAiCostsObservationRun, RequestRow } from '../store/db.ts';

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * A provider day is not final the moment it ends — the Costs API documents no
 * finality, and a just-closed day can still accrue. A run refuses any period
 * whose end is inside this window rather than reporting a variance that is
 * really a lag. Deliberately generous: a wrong variance is worse than a late one.
 */
export const SETTLEMENT_LAG_MS = 48 * 60 * 60 * 1000;

/** Default per-day materiality. Days at or under this are still reported, just not flagged. */
export const DEFAULT_MATERIALITY_USD = 0.5;

export type ReconciliationRefusal =
  | 'no_provider_observation'
  | 'observation_period_may_still_accrue'
  | 'provider_currency_is_not_usd'
  | 'provider_reported_multiple_currencies'
  | 'local_exact_amount_is_not_usd'
  | 'local_exact_amount_requires_explicit_quantization';

/**
 * Why one day's two numbers differ. Structural only — this says what SHAPE the
 * difference has, never what caused it. Attributing a cause would be exactly
 * the force-fitting the roadmap forbids.
 */
export type ResidualReason =
  | 'exact_match'
  | 'provider_exceeds_local'
  | 'local_exceeds_provider'
  | 'no_local_capture'
  | 'no_provider_report';

export interface ReconciliationDayLine {
  /** UTC day start; the provider's own bucket boundary, never a local one. */
  dayStartMs: number;
  providerReportedMicros: number;
  localCapturedMicros: number;
  localRequestCount: number;
  /** provider − local. Positive means the provider reported more than Fiscus saw. */
  differenceMicros: number;
  residualReason: ResidualReason;
  material: boolean;
  providerLineItems: string[];
}

export type SnapshotStability =
  | 'single_observation'
  | 'stable_across_observations'
  | 'changed_across_observations';

/**
 * Where the provider side of the comparison came from. This is a real
 * difference in evidence class, not a bookkeeping detail:
 *
 *   - `provider_api_pull` — Fiscus read the figures from the provider itself
 *     over a read-only Costs call. Nobody stood between the provider and the
 *     number.
 *   - `operator_supplied_export` — a person exported a report and handed it to
 *     Fiscus. Fiscus validated its shape and digested the file, but nothing in
 *     it was obtained from the provider by Fiscus, so its authenticity rests
 *     entirely on the operator. It reconciles, and it must never be displayed
 *     as though the provider had confirmed it.
 *   - `legacy_unknown` — recorded before this distinction existed. Unknown
 *     stays unknown; it is never backfilled into either of the above.
 */
export type ProviderSourceKind =
  | 'provider_api_pull'
  | 'operator_supplied_export'
  | 'legacy_unknown';

/**
 * The permanent limits of a reconciliation. Four always apply. The fifth applies
 * only when the provider side was operator-supplied, which is why this is a list
 * rather than a fixed tuple — a condition that appears and disappears with the
 * evidence is exactly the kind a reader must be able to see.
 */
export type ReconciliationCondition =
  | 'local_route_scope_is_not_provider_verified'
  | 'off_path_provider_usage_is_not_observable'
  | 'provider_line_items_do_not_join_to_requests_or_models'
  | 'local_request_amounts_are_rate_card_estimates'
  | 'provider_report_is_operator_supplied_and_unverified';

export const PERMANENT_CONDITIONS: readonly ReconciliationCondition[] = [
  'local_route_scope_is_not_provider_verified',
  'off_path_provider_usage_is_not_observable',
  'provider_line_items_do_not_join_to_requests_or_models',
  'local_request_amounts_are_rate_card_estimates',
];

export interface ReconciliationRun {
  status: 'reconciled_with_residual';
  observationRunId: string;
  declaredScopeId: string;
  providerProjectRef: string;
  periodStartMs: number;
  periodEndMs: number;
  currency: 'USD';
  materialityUsd: number;
  /** Totals over the whole period, exact integer microdollars. */
  providerReportedMicros: number;
  localCapturedMicros: number;
  /**
   * The residual. NOT an error term: it is the part of the provider's report
   * that local metering does not account for (or the reverse), and it is the
   * headline output of a reconciliation rather than something to minimize.
   */
  unexplainedVarianceMicros: number;
  coverage: {
    providerDays: number;
    localDays: number;
    daysWithBoth: number;
    providerOnlyDays: number;
    localOnlyDays: number;
    materialDays: number;
  };
  days: ReconciliationDayLine[];
  /**
   * What the residual bounds, and whether it bounds anything at all (AII-002).
   * A residual near zero invites the reading "then nothing went off-path", and
   * that reading is an absence inference the arithmetic does not license. See
   * `offPathBoundFromResidual`.
   */
  offPathBound: OffPathBound;
  snapshotStability: SnapshotStability;
  /** Days whose provider total changed between independent observations. */
  unstableDayStartMs: number[];
  /**
   * Where the provider figures came from. An operator-supplied export
   * reconciles exactly as well arithmetically and is a weaker evidence class;
   * both facts travel with the result rather than only the first.
   */
  providerSourceKind: ProviderSourceKind;
  /** Permanent limits of this result. They are conditions, not defects. */
  conditions: readonly ReconciliationCondition[];
  trust: 'scope_conditional_reconciliation';
  excludedFrom: readonly ['request_metered_spend', 'budget_enforcement', 'roi', 'model_recommendations'];
}

/**
 * What a residual can and cannot say about spend that never passed through
 * Fiscus (AII-002).
 *
 * Write P for the provider's reported total on the declared scope, L for what
 * Fiscus metered on it, T for the true billed cost of the traffic that DID pass
 * through, and O for the true billed cost of the traffic that did not. The
 * provider bills both, so P = T + O, and the residual is
 *
 *   R = P - L = O + (T - L)
 *
 * Therefore `O <= R` holds exactly when `L <= T`: when the local rate-card
 * ESTIMATE does not exceed the true billed cost of on-path traffic. That is a
 * condition, not a fact, and it is the reason a residual is an upper bound
 * rather than a measurement.
 *
 * R < 0 is the interesting case. It says L > P = T + O >= T, which REFUTES the
 * condition outright: the local estimate exceeds everything the provider billed
 * on this scope. No upper bound on off-path spend survives, because local
 * over-estimation has absorbed an unknown amount of it. Reporting "unexplained:
 * -$3.10" and letting a reader conclude that nothing went off-path is inferring
 * absence from an observation that specifically undermines the inference.
 */
export type OffPathBound =
  /** `O <= R`, conditional on the route declaration and on `L <= T`. */
  | 'upper_bound_conditional'
  /** The local estimate exceeds the provider total, so no upper bound holds. */
  | 'none_local_estimate_exceeds_provider';

/**
 * Classify what this residual bounds. Deliberately a pure function of the two
 * totals: it introduces no threshold and no materiality, because the question
 * is which inequality holds, not whether the gap is large.
 */
export function offPathBoundFromResidual(providerMicros: number, localMicros: number): OffPathBound {
  return providerMicros - localMicros < 0 ? 'none_local_estimate_exceeds_provider' : 'upper_bound_conditional';
}

/** One sentence an operator can act on, for each bound state. */
export function describeOffPathBound(bound: OffPathBound): string {
  return bound === 'upper_bound_conditional'
    ? 'Upper bound on spend that never passed through Fiscus — conditional on your route declaration and on the local rate-card estimate not exceeding the true on-path billed cost. Not a measurement of off-path spend.'
    : 'No upper bound on off-path spend: the local rate-card estimate exceeds the provider total for this scope, so over-estimation has absorbed an unknown amount of it. A residual at or below zero is not evidence that nothing went off-path.';
}

export interface ReconciliationRefused {
  status: 'refused';
  refusal: ReconciliationRefusal;
  detail: string;
}

export type ReconciliationResult = ReconciliationRun | ReconciliationRefused;

function refuse(refusal: ReconciliationRefusal, detail: string): ReconciliationRefused {
  return { status: 'refused', refusal, detail };
}

/** UTC day key for a local ledger row, matching the provider's bucket boundary. */
function utcDayStart(tsEpochMs: number): number {
  return Math.floor(tsEpochMs / DAY_MS) * DAY_MS;
}

/**
 * A row belongs to this comparison only if it is live proxy traffic to OpenAI
 * carrying the exact immutable declaration the snapshot was pulled for. This is
 * the same test `buildOpenAiCostsCaptureCoverage` applies, and it must stay the
 * same test: two definitions of "on the declared route" would let a row be
 * excluded from coverage and included in a variance.
 */
export function isOnDeclaredRoute(row: RequestRow, declaredScopeId: string): boolean {
  return row.provider === 'openai'
    && row.via === 'proxy'
    && row.scopeCaptureStatus === 'declared_unverified'
    && row.providerScopeDeclarationId === declaredScopeId;
}

function sumProviderDay(lines: readonly OpenAiCostsObservationLine[]): number {
  let micros = 0;
  for (const line of lines) micros += usdMicros(line.amountDecimal, 'provider amount');
  return micros;
}

function residualReason(providerMicros: number, localMicros: number, hasProvider: boolean, hasLocal: boolean): ResidualReason {
  if (!hasLocal) return 'no_local_capture';
  if (!hasProvider) return 'no_provider_report';
  if (providerMicros === localMicros) return 'exact_match';
  return providerMicros > localMicros ? 'provider_exceeds_local' : 'local_exceeds_provider';
}

/**
 * Compare one completed provider snapshot with the local ledger for the same
 * period, at project-day grain.
 *
 * `priorObservations` are per-day provider totals from an EARLIER independent
 * observation of the same period, if one exists. They only ever set
 * `snapshotStability` — a changed day is disclosed, never averaged away or
 * used to pick a "better" number.
 */
export function reconcileOpenAiCosts(input: {
  run: OpenAiCostsObservationRun;
  observations: readonly OpenAiCostsObservationLine[];
  requests: readonly RequestRow[];
  priorDayTotals?: ReadonlyMap<number, number> | null;
  materialityUsd?: number;
  now?: number;
}): ReconciliationResult {
  const now = input.now ?? Date.now();
  const materialityUsd = input.materialityUsd ?? DEFAULT_MATERIALITY_USD;
  const materialityMicros = Math.round(materialityUsd * 1_000_000);
  // A run recorded before the distinction existed is `legacy_unknown`, never
  // assumed to be an API pull just because that was the only path at the time.
  const sourceKind: ProviderSourceKind = input.run.sourceKind ?? 'legacy_unknown';

  if (input.run.resultState !== 'succeeded' || !input.run.paginationComplete) {
    return refuse('no_provider_observation', 'a reconciliation needs one complete, successful provider observation');
  }
  if (input.run.periodEndMs > now - SETTLEMENT_LAG_MS) {
    return refuse(
      'observation_period_may_still_accrue',
      `the observed period ends less than ${SETTLEMENT_LAG_MS / (60 * 60 * 1000)}h ago; a variance now could be provider lag rather than a real difference`,
    );
  }

  const currencies = [...new Set(input.observations.map((line) => line.currency))];
  if (currencies.length > 1) {
    return refuse('provider_reported_multiple_currencies', `the snapshot mixes ${currencies.sort().join(', ')}; the local ledger is single-currency`);
  }
  if (currencies.length === 1 && currencies[0] !== 'USD') {
    return refuse('provider_currency_is_not_usd', `the snapshot reports ${currencies[0]}; local amounts are USD and no rate is applied here`);
  }

  const providerByDay = new Map<number, OpenAiCostsObservationLine[]>();
  for (const line of input.observations) {
    const list = providerByDay.get(line.bucketStartMs);
    if (list) list.push(line);
    else providerByDay.set(line.bucketStartMs, [line]);
  }

  const localByDay = new Map<number, { micros: number; requests: number }>();
  for (const row of input.requests) {
    if (!isOnDeclaredRoute(row, input.run.declaredScopeId)) continue;
    if (row.tsEpochMs < input.run.periodStartMs || row.tsEpochMs >= input.run.periodEndMs) continue;
    const key = utcDayStart(row.tsEpochMs);
    const bucket = localByDay.get(key) ?? { micros: 0, requests: 0 };
    let capturedMicros: number;
    if (row.economicAmount !== undefined) {
      if (row.economicAmount.currency !== 'USD') {
        return refuse(
          'local_exact_amount_is_not_usd',
          `request ${row.requestId} has an exact local amount in ${row.economicAmount.currency}; this reconciliation has no FX policy`,
        );
      }
      try {
        // Preserve the canonical exact amount until the fixed-point boundary.
        // If it cannot be represented in provider microdollars, refusing is safer
        // than inventing a rounding mode for a consequential comparison.
        capturedMicros = usdMicros(formatMoneyAmount(row.economicAmount), `request ${row.requestId} exact amount`);
      } catch (error) {
        return refuse(
          'local_exact_amount_requires_explicit_quantization',
          `request ${row.requestId} exact local amount cannot be represented in microdollars without an explicit quantization policy: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    } else {
      // Legacy rows have no exact economic event. Retain their compatibility
      // projection explicitly as the rate-card estimate documented by the result.
      capturedMicros = Math.round(row.costUsd * 1_000_000);
    }
    bucket.micros += capturedMicros;
    bucket.requests += 1;
    localByDay.set(key, bucket);
  }

  const days: ReconciliationDayLine[] = [];
  const allDays = [...new Set([...providerByDay.keys(), ...localByDay.keys()])].sort((a, b) => a - b);
  let providerTotal = 0;
  let localTotal = 0;
  let daysWithBoth = 0;
  let providerOnlyDays = 0;
  let localOnlyDays = 0;
  let materialDays = 0;

  for (const dayStartMs of allDays) {
    const providerLines = providerByDay.get(dayStartMs) ?? [];
    const local = localByDay.get(dayStartMs) ?? { micros: 0, requests: 0 };
    const hasProvider = providerLines.length > 0;
    const hasLocal = local.requests > 0;
    const providerReportedMicros = sumProviderDay(providerLines);
    const differenceMicros = providerReportedMicros - local.micros;
    const material = Math.abs(differenceMicros) > materialityMicros;

    providerTotal += providerReportedMicros;
    localTotal += local.micros;
    if (hasProvider && hasLocal) daysWithBoth++;
    else if (hasProvider) providerOnlyDays++;
    else localOnlyDays++;
    if (material) materialDays++;

    days.push({
      dayStartMs,
      providerReportedMicros,
      localCapturedMicros: local.micros,
      localRequestCount: local.requests,
      differenceMicros,
      residualReason: residualReason(providerReportedMicros, local.micros, hasProvider, hasLocal),
      material,
      providerLineItems: [...new Set(providerLines.map((l) => l.lineItem))].sort(),
    });
  }

  const unstableDayStartMs: number[] = [];
  let snapshotStability: SnapshotStability = 'single_observation';
  if (input.priorDayTotals && input.priorDayTotals.size > 0) {
    for (const day of days) {
      const prior = input.priorDayTotals.get(day.dayStartMs);
      if (prior !== undefined && prior !== day.providerReportedMicros) unstableDayStartMs.push(day.dayStartMs);
    }
    // A day present in one observation and absent from the other is a change too.
    for (const [dayStartMs] of input.priorDayTotals) {
      if (!providerByDay.has(dayStartMs) && !unstableDayStartMs.includes(dayStartMs)) unstableDayStartMs.push(dayStartMs);
    }
    unstableDayStartMs.sort((a, b) => a - b);
    snapshotStability = unstableDayStartMs.length > 0 ? 'changed_across_observations' : 'stable_across_observations';
  }

  return {
    status: 'reconciled_with_residual',
    observationRunId: input.run.observationRunId,
    declaredScopeId: input.run.declaredScopeId,
    providerProjectRef: input.run.providerProjectRef,
    periodStartMs: input.run.periodStartMs,
    periodEndMs: input.run.periodEndMs,
    currency: 'USD',
    materialityUsd,
    providerReportedMicros: providerTotal,
    localCapturedMicros: localTotal,
    unexplainedVarianceMicros: providerTotal - localTotal,
    offPathBound: offPathBoundFromResidual(providerTotal, localTotal),
    coverage: {
      providerDays: providerByDay.size,
      localDays: localByDay.size,
      daysWithBoth,
      providerOnlyDays,
      localOnlyDays,
      materialDays,
    },
    days,
    snapshotStability,
    unstableDayStartMs,
    providerSourceKind: sourceKind,
    // The fifth condition appears only when it is true. A reader who sees four
    // is looking at figures Fiscus read from the provider; a reader who sees
    // five is looking at figures a person handed it.
    conditions: sourceKind === 'operator_supplied_export'
      ? [...PERMANENT_CONDITIONS, 'provider_report_is_operator_supplied_and_unverified']
      : PERMANENT_CONDITIONS,
    trust: 'scope_conditional_reconciliation',
    excludedFrom: ['request_metered_spend', 'budget_enforcement', 'roi', 'model_recommendations'],
  };
}

/**
 * USD for a display surface: always at least two decimal places, and never
 * fewer digits than the amount actually has.
 *
 * `formatUsdMicros` is the exact form used in exports, and it strips trailing
 * zeros — correct for a data column, wrong for a money column, where `$70.2`
 * beside `$66.6` reads as sloppy rather than precise and the two do not align.
 */
export function displayUsd(micros: number): string {
  const exact = formatUsdMicros(Math.abs(micros));
  const [whole, fraction = ''] = exact.split('.');
  return `${whole}.${fraction.padEnd(2, '0')}`;
}

/** `displayUsd` with an explicit sign, so the direction of a residual is unmissable. */
export function signedUsd(micros: number): string {
  return `${micros < 0 ? '-' : micros > 0 ? '+' : ''}$${displayUsd(micros)}`;
}

/**
 * What still stands between an operator and a reconciliation run. Returned even
 * when nothing is missing, so the CLI has one place to explain the path rather
 * than scattering instructions across error branches.
 */
/**
 * What the local side of a reconciliation would actually contain.
 *
 * This exists because of a failure mode that only shows up on a real machine:
 * a user can have substantial OpenAI spend, obtain an Admin key, pull a real
 * bill — and still get a local side of exactly zero, because every one of their
 * rows arrived by NATIVE IMPORT rather than through the proxy. Reconciliation
 * counts only proxy traffic carrying the declared scope, and it must, since an
 * imported row cannot be shown to belong to the declared provider project.
 *
 * Telling someone that after they have gone and minted a credential is telling
 * them too late. This is reported BEFORE the credential step.
 */
export interface ReconciliationCoverage {
  /** Rows that would count: live proxy traffic carrying the declaration. */
  onDeclaredRouteUsd: number;
  onDeclaredRouteRequests: number;
  /** Natively imported OpenAI rows. Real spend, structurally uncountable here. */
  importedUsd: number;
  importedRequests: number;
  /** Proxy rows that predate the declaration or carry a different one. */
  proxyOffScopeUsd: number;
  proxyOffScopeRequests: number;
}

export interface ReconciliationReadiness {
  ready: boolean;
  missing: Array<{ step: string; detail: string; ownerAction: boolean }>;
  /** Null when no OpenAI spend exists at all, so there is nothing to warn about. */
  coverage: ReconciliationCoverage | null;
}
