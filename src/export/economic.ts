/** Exact economic request export; legacy numeric cost is compatibility-only. */

import { canonicalJson } from '../epistemic/serialization.ts';
import type { EconomicLedger, EffectiveEconomicCharge } from '../economics/ledger.ts';
import { formatMoneyAmount, moneyToJson, type EconomicBasis, type MoneyJson } from '../economics/money.ts';
import type { RequestRow } from '../store/db.ts';
import { requestEconomicEventId } from '../economics/request.ts';
import { toCsv } from './csv.ts';

export type EconomicExportCoverage = 'exact' | 'legacy_unknown';

export interface EconomicRequestExportRow {
  readonly requestId: string;
  readonly tsIso: string;
  readonly tsEpochMs: number;
  readonly provider: string;
  readonly model: string;
  readonly project: string;
  readonly projectCanonical: string;
  readonly sessionId: string | null;
  readonly via: 'proxy' | 'import';
  /** Compatibility projection only; never the exact accounting authority. */
  readonly compatibilityCostUsd: number;
  readonly coverage: EconomicExportCoverage;
  readonly sourceMoney: MoneyJson | null;
  readonly sourceAmount: string | null;
  readonly sourceCurrency: string | null;
  readonly sourceBasis: EconomicBasis | null;
  readonly effectiveMoney: MoneyJson | null;
  readonly effectiveAmount: string | null;
  readonly effectiveCurrency: string | null;
  readonly effectiveBasis: 'effective' | null;
  readonly sourceBases: readonly EconomicBasis[];
  readonly sourceEventIds: readonly string[];
  readonly correctionEventIds: readonly string[];
  readonly unresolvedReason: 'no_exact_economic_event' | null;
}

function exportRow(request: RequestRow, effective: EffectiveEconomicCharge | null): EconomicRequestExportRow {
  const sourceMoney = effective === null ? null : { ...moneyToJson(effective.sourceAmount) };
  const effectiveMoney = effective === null ? null : { ...moneyToJson(effective.amount) };
  const sourceEventIds = effective?.eventIds ?? [];
  return Object.freeze({
    requestId: request.requestId,
    tsIso: new Date(request.tsEpochMs).toISOString(),
    tsEpochMs: request.tsEpochMs,
    provider: request.provider,
    model: request.model,
    project: request.project,
    projectCanonical: request.projectCanonical ?? request.project,
    sessionId: request.sessionId,
    via: request.via ?? 'proxy',
    compatibilityCostUsd: request.costUsd,
    coverage: effective === null ? 'legacy_unknown' : 'exact',
    sourceMoney,
    sourceAmount: effective === null ? null : formatMoneyAmount(effective.sourceAmount),
    sourceCurrency: effective?.sourceAmount.currency ?? null,
    sourceBasis: effective?.sourceAmount.basis ?? null,
    effectiveMoney,
    effectiveAmount: effective === null ? null : formatMoneyAmount(effective.amount),
    effectiveCurrency: effective?.amount.currency ?? null,
    effectiveBasis: effective === null ? null : 'effective',
    sourceBases: effective?.sourceBases ?? [],
    sourceEventIds: Object.freeze([...sourceEventIds]),
    correctionEventIds: Object.freeze(effective === null ? [] : sourceEventIds.slice(1)),
    unresolvedReason: effective === null ? 'no_exact_economic_event' : null,
  });
}

/** Build exact-safe export rows from request rows and the canonical ledger. */
export function buildEconomicRequestExportRows(rows: readonly RequestRow[], ledger: EconomicLedger): EconomicRequestExportRow[] {
  if (!Array.isArray(rows)) throw new Error('economic export request rows must be an array');
  return rows.map((request) => exportRow(request, ledger.effectiveChargeFor(requestEconomicEventId(request.requestId))));
}

const ECONOMIC_COLUMNS = [
  'requestId', 'tsIso', 'tsEpochMs', 'provider', 'model', 'project', 'projectCanonical', 'sessionId', 'via',
  'compatibilityCostUsd', 'coverage', 'sourceAmount', 'sourceCurrency', 'sourceBasis', 'effectiveAmount',
  'effectiveCurrency', 'effectiveBasis', 'sourceBases', 'sourceEventIds', 'correctionEventIds', 'unresolvedReason',
] as const;

/** JSON-safe exact export. Money objects retain coefficient/scale/currency/basis. */
export function economicRequestsToJson(rows: readonly EconomicRequestExportRow[]): string {
  if (!Array.isArray(rows)) throw new Error('economic export rows must be an array');
  return `${canonicalJson(rows.map((row) => ({
    ...row,
    sourceMoney: row.sourceMoney === null ? null : { ...row.sourceMoney },
    effectiveMoney: row.effectiveMoney === null ? null : { ...row.effectiveMoney },
    sourceBases: [...row.sourceBases],
    sourceEventIds: [...row.sourceEventIds],
    correctionEventIds: [...row.correctionEventIds],
  })) as never)}\n`;
}

/** CSV exact export with compatibility dollars explicitly labelled as such. */
export function economicRequestsToCsv(rows: readonly EconomicRequestExportRow[]): string {
  if (!Array.isArray(rows)) throw new Error('economic export rows must be an array');
  return toCsv([...ECONOMIC_COLUMNS], rows.map((row) => [
    row.requestId, row.tsIso, row.tsEpochMs, row.provider, row.model, row.project, row.projectCanonical,
    row.sessionId ?? '', row.via, row.compatibilityCostUsd, row.coverage, row.sourceAmount ?? '',
    row.sourceCurrency ?? '', row.sourceBasis ?? '', row.effectiveAmount ?? '', row.effectiveCurrency ?? '',
    row.effectiveBasis ?? '', JSON.stringify(row.sourceBases), JSON.stringify(row.sourceEventIds),
    JSON.stringify(row.correctionEventIds), row.unresolvedReason ?? '',
  ]));
}
