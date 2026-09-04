/**
 * Request-level effective economic read model.
 *
 * The immutable event ledger is the accounting authority; request rows are a
 * compatibility index that supplies grouping dimensions. This adapter joins
 * the two without mutating either one, preserving unresolved legacy rows and
 * refusing a request/event identity mismatch before a value consumer can group
 * the wrong dollars under a project, model, session, or provider.
 */

import type { RequestRow } from './db.ts';
import type { EconomicLedger } from '../economics/ledger.ts';
import type { EffectiveFxChargeProjection } from '../economics/fx.ts';
import type { Instant } from '../epistemic/time.ts';
import { compareMoney, moneyFromJson, type EconomicBasis, type Money } from '../economics/money.ts';
import { economicAttributionFromRows, economicAttributionNumber, type EconomicAttribution } from '../economics/attribution.ts';
import { economicEventRole, type EconomicEventKind } from '../economics/events.ts';
import { requestEconomicEventId } from '../economics/request.ts';

export type EconomicRequestUnresolvedReason = 'no_exact_economic_event';

export interface EffectiveRequestRow {
  requestId: string;
  tsEpochMs: number;
  sessionId: string | null;
  provider: string;
  model: string;
  project: string;
  projectCanonical: string;
  source: string | null;
  user: string | null;
  via: 'proxy' | 'import';
  /** Legacy numeric column retained only as a compatibility projection. */
  compatibilityCostUsd: number;
  /** Effective exact charge, or null when this legacy row has no event. */
  effectiveAmount: Money | null;
  /** Explicit target-currency projection; null when no FX policy was requested. */
  fxTranslation: EffectiveFxChargeProjection | null;
  sourceBases: readonly EconomicBasis[];
  sourceEventIds: readonly string[];
  unresolvedReason: EconomicRequestUnresolvedReason | null;
}

export interface EffectiveRequestOptions {
  /** Recorded-time knowledge boundary for both corrections and FX evidence. */
  readonly asOf?: Instant;
  /** Explicit target currency; omitted means no FX translation is performed. */
  readonly targetUnit?: string;
  /** Optional modeled effective instant; defaults to the source occurrence. */
  readonly effectiveAt?: Instant;
}

export interface EconomicSessionUnit {
  sessionId: string;
  costUsd: number;
  requests: number;
  hasProposals: boolean;
  economic: EconomicAttribution;
}

export interface EconomicSessionUserUnit {
  sessionId: string;
  user: string;
  costUsd: number;
  requests: number;
  economic: EconomicAttribution;
}

export interface EconomicModelUnit {
  provider: string;
  model: string;
  costUsd: number;
  requests: number;
  economic: EconomicAttribution;
}

export type EconomicModelCoverage = 'exact' | 'partial' | 'legacy_unknown';

/**
 * The one authority used when a consequential consumer needs to name a
 * dominant provider/model. `groups` remains useful for descriptive displays,
 * but `dominant` is populated only when every request in the window has an
 * exact effective charge. A partial window therefore cannot combine corrected
 * exact dollars with legacy compatibility dollars to manufacture a winner.
 */
export interface CanonicalModelAttribution {
  groups: EconomicModelUnit[];
  coverage: EconomicModelCoverage;
  total: EconomicAttribution;
  dominant: EconomicModelUnit | null;
  /** Exact dominant/total ratio, projected to a bounded UI number only at the edge. */
  dominantShare: number | null;
  /** Finite compatibility projection, or null when exact dollars exceed safe numeric magnitude. */
  dominantCostUsd: number | null;
}

export interface EconomicSeriesPoint {
  bucketMs: number;
  costUsd: number;
  requests: number;
  economic: EconomicAttribution;
}

function metadataRecord(value: unknown, id: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`economic request event ${id} metadata must be an object`);
  }
  return value as Record<string, unknown>;
}

function assertMatches(request: RequestRow, event: {
  id: string;
  kind: string;
  subject: string;
  amount: Money | null;
  metadata: unknown;
}): void {
  if (event.subject !== `request:${request.requestId}` || event.amount === null || economicEventRole(event.kind as EconomicEventKind) !== 'charge') {
    throw new Error(`economic request event ${event.id} is not a canonical charge for ${request.requestId}`);
  }
  const metadata = metadataRecord(event.metadata, event.id);
  const expectedVia = request.via ?? 'proxy';
  if (metadata.requestId !== request.requestId
      || metadata.provider !== request.provider
      || metadata.model !== request.model
      || metadata.project !== request.project
      || metadata.via !== expectedVia) {
    throw new Error(`economic request event ${event.id} metadata disagrees with request ${request.requestId}`);
  }
  if (request.sessionId === null || request.sessionId === undefined) {
    if (metadata.sessionId !== undefined && metadata.sessionId !== null) {
      throw new Error(`economic request event ${event.id} session metadata disagrees with request ${request.requestId}`);
    }
  } else if (metadata.sessionId !== request.sessionId) {
    throw new Error(`economic request event ${event.id} session metadata disagrees with request ${request.requestId}`);
  }
}

/** Join one request row to its exact effective charge, failing closed on drift. */
export function effectiveRequestRow(
  request: RequestRow,
  ledger: EconomicLedger,
  options: EffectiveRequestOptions = {},
): EffectiveRequestRow {
  const sourceId = requestEconomicEventId(request.requestId);
  const source = ledger.read(sourceId);
  const base = {
    requestId: request.requestId,
    tsEpochMs: request.tsEpochMs,
    sessionId: request.sessionId ?? null,
    provider: request.provider,
    model: request.model,
    project: request.project,
    projectCanonical: request.projectCanonical ?? request.project,
    source: request.source ?? null,
    user: request.user ?? null,
    via: (request.via ?? 'proxy') as 'proxy' | 'import',
    compatibilityCostUsd: request.costUsd,
  };
  if (source === null) {
    return Object.freeze({
      ...base,
      effectiveAmount: null,
      fxTranslation: null,
      sourceBases: Object.freeze([]),
      sourceEventIds: Object.freeze([]),
      unresolvedReason: 'no_exact_economic_event',
    });
  }
  assertMatches(request, source);
  const effectiveAsOf = options.targetUnit === undefined ? options.asOf : (options.asOf ?? source.recordedAt);
  const effective = ledger.effectiveChargeFor(sourceId, effectiveAsOf);
  if (effective === null) {
    if (options.asOf !== undefined && Date.parse(source.recordedAt) > Date.parse(options.asOf)) {
      return Object.freeze({
        ...base,
        effectiveAmount: null,
        fxTranslation: null,
        sourceBases: Object.freeze([]),
        sourceEventIds: Object.freeze([]),
        unresolvedReason: 'no_exact_economic_event',
      });
    }
    throw new Error(`economic request event ${sourceId} has no effective charge projection`);
  }
  const fxTranslation = options.targetUnit === undefined
    ? null
    : ledger.effectiveFxChargeFromHistoricalRates(sourceId, options.targetUnit, options.effectiveAt, effectiveAsOf);
  return Object.freeze({
    ...base,
    effectiveAmount: effective.amount,
    fxTranslation,
    sourceBases: Object.freeze([...effective.sourceBases]),
    sourceEventIds: Object.freeze([...effective.eventIds]),
    unresolvedReason: null,
  });
}

/** Build the exact request read model without changing legacy request rows. */
export function effectiveRequestRows(
  rows: readonly RequestRow[],
  ledger: EconomicLedger,
  options: EffectiveRequestOptions = {},
): EffectiveRequestRow[] {
  if (!Array.isArray(rows)) throw new Error('economic request rows must be an array');
  return rows.map((row) => effectiveRequestRow(row, ledger, options));
}

/** Group exact request rows by session while preserving compatibility totals. */
export function groupEconomicSessions(rows: readonly EffectiveRequestRow[], proposalSessionIds: ReadonlySet<string>): EconomicSessionUnit[] {
  const grouped = new Map<string, EffectiveRequestRow[]>();
  for (const row of rows) {
    if (row.sessionId === null) continue;
    const bucket = grouped.get(row.sessionId);
    if (bucket === undefined) grouped.set(row.sessionId, [row]);
    else bucket.push(row);
  }
  return [...grouped.entries()]
    .map(([sessionId, sessionRows]) => {
      const economic = economicAttributionFromRows(sessionRows);
      const compatibility = sessionRows.reduce((sum, row) => sum + row.compatibilityCostUsd, 0);
      return Object.freeze({
        sessionId,
        costUsd: economicAttributionNumber(economic, compatibility),
        requests: sessionRows.length,
        hasProposals: proposalSessionIds.has(sessionId),
        economic,
      });
    })
    .sort((a, b) => b.costUsd - a.costUsd || a.sessionId.localeCompare(b.sessionId));
}

/** Group exact request rows by (session,user), retaining the existing user split. */
export function groupEconomicSessionUsers(rows: readonly EffectiveRequestRow[]): EconomicSessionUserUnit[] {
  const grouped = new Map<string, EffectiveRequestRow[]>();
  for (const row of rows) {
    if (row.sessionId === null) continue;
    const user = row.user ?? 'unassigned';
    const key = `${row.sessionId}\u0000${user}`;
    const bucket = grouped.get(key);
    if (bucket === undefined) grouped.set(key, [row]);
    else bucket.push(row);
  }
  return [...grouped.values()]
    .map((sessionRows) => {
      const first = sessionRows[0]!;
      const user = first.user ?? 'unassigned';
      const economic = economicAttributionFromRows(sessionRows);
      const compatibility = sessionRows.reduce((sum, row) => sum + row.compatibilityCostUsd, 0);
      return Object.freeze({
        sessionId: first.sessionId!,
        user,
        costUsd: economicAttributionNumber(economic, compatibility),
        requests: sessionRows.length,
        economic,
      });
    })
    .sort((a, b) => b.costUsd - a.costUsd || a.sessionId.localeCompare(b.sessionId) || a.user.localeCompare(b.user));
}

/** Group exact request rows by provider/model for model-trial comparisons. */
export function groupEconomicModels(rows: readonly EffectiveRequestRow[]): EconomicModelUnit[] {
  const grouped = new Map<string, EffectiveRequestRow[]>();
  for (const row of rows) {
    const key = `${row.provider}\u0000${row.model}`;
    const bucket = grouped.get(key);
    if (bucket === undefined) grouped.set(key, [row]);
    else bucket.push(row);
  }
  return [...grouped.values()]
    .map((modelRows) => {
      const first = modelRows[0]!;
      const economic = economicAttributionFromRows(modelRows);
      const compatibility = modelRows.reduce((sum, row) => sum + row.compatibilityCostUsd, 0);
      return Object.freeze({
        provider: first.provider,
        model: first.model,
        costUsd: economicAttributionNumber(economic, compatibility),
        requests: modelRows.length,
        economic,
      });
    })
    .sort((a, b) => b.costUsd - a.costUsd || a.provider.localeCompare(b.provider) || a.model.localeCompare(b.model));
}

function exactRatio(numerator: Money, denominator: Money): number | null {
  if (numerator.currency !== denominator.currency || numerator.basis !== denominator.basis || denominator.coefficient <= 0n) return null;
  const scale = Math.max(numerator.scale, denominator.scale);
  const n = numerator.coefficient * (10n ** BigInt(scale - numerator.scale));
  const d = denominator.coefficient * (10n ** BigInt(scale - denominator.scale));
  if (n <= 0n) return 0;
  if (n >= d) return 1;
  // Keep the division exact until the final UI-compatible projection. The
  // scaled quotient is <= 1e18, so Number conversion cannot overflow even when
  // the original exact amounts have thousands of decimal digits.
  const scaled = (n * 1_000_000_000_000_000_000n) / d;
  const ratio = Number(scaled) / 1_000_000_000_000_000_000;
  return Number.isFinite(ratio) ? Math.min(1, Math.max(0, ratio)) : null;
}

function boundedNumericAmount(value: EconomicAttribution): number | null {
  const projected = Number(value.amountText);
  return Number.isFinite(projected) && Math.abs(projected) <= Number.MAX_SAFE_INTEGER ? projected : null;
}

/**
 * Rank provider/model groups from one effective request-row snapshot. Exact
 * Money is compared before any numeric compatibility projection; deterministic
 * provider/model ordering resolves exact ties. Partial/legacy windows expose
 * their groups and coverage but deliberately have no dominant winner.
 */
export function canonicalModelAttribution(rows: readonly EffectiveRequestRow[]): CanonicalModelAttribution {
  if (!Array.isArray(rows)) throw new Error('canonical model attribution rows must be an array');
  const groups = groupEconomicModels(rows);
  const total = economicAttributionFromRows(rows);
  const coverage: EconomicModelCoverage = rows.length === 0 || total.unresolvedRequests === rows.length
    ? 'legacy_unknown'
    : total.unresolvedRequests > 0
      ? 'partial'
      : 'exact';
  if (coverage !== 'exact' || groups.length === 0) {
    return { groups, coverage, total, dominant: null, dominantShare: null, dominantCostUsd: null };
  }

  const ranked = [...groups].sort((left, right) => {
    const byAmount = compareMoney(moneyFromJson(left.economic.amount), moneyFromJson(right.economic.amount));
    if (byAmount !== 0) return byAmount === 1 ? -1 : 1;
    return left.provider.localeCompare(right.provider) || left.model.localeCompare(right.model);
  });
  const dominant = ranked[0]!;
  return {
    groups: ranked,
    coverage,
    total,
    dominant,
    dominantShare: exactRatio(moneyFromJson(dominant.economic.amount), moneyFromJson(total.amount)),
    dominantCostUsd: boundedNumericAmount(dominant.economic),
  };
}

/** Group exact request rows into deterministic fixed-width time buckets. */
export function groupEconomicSeries(rows: readonly EffectiveRequestRow[], bucketMs: number): EconomicSeriesPoint[] {
  if (!Number.isSafeInteger(bucketMs) || bucketMs <= 0) throw new Error('economic series bucket must be a positive safe integer');
  const grouped = new Map<number, EffectiveRequestRow[]>();
  for (const row of rows) {
    const bucket = Math.floor(row.tsEpochMs / bucketMs) * bucketMs;
    const current = grouped.get(bucket);
    if (current === undefined) grouped.set(bucket, [row]);
    else current.push(row);
  }
  return [...grouped.entries()]
    .sort(([a], [b]) => a - b)
    .map(([bucketMsValue, bucketRows]) => {
      const economic = economicAttributionFromRows(bucketRows);
      const compatibility = bucketRows.reduce((sum, row) => sum + row.compatibilityCostUsd, 0);
      return Object.freeze({
        bucketMs: bucketMsValue,
        costUsd: economicAttributionNumber(economic, compatibility),
        requests: bucketRows.length,
        economic,
      });
    });
}
