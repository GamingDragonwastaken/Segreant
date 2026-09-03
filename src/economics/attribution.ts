/** JSON-safe exact economic coverage attached to a value attribution window. */

import { addMoney, ECONOMIC_BASES, formatMoneyAmount, money, moneyFromJson, moneyToJson, type EconomicBasis, type Money, type MoneyJson } from './money.ts';

export interface EconomicAttribution {
  /** Effective amount of the exact rows resolved in this window. */
  amount: MoneyJson;
  /** Canonical decimal rendering of `amount`; never a JavaScript number. */
  amountText: string;
  /** Source and correction events retained by the effective projection. */
  eventIds: readonly string[];
  /** Original price bases represented by those source events. */
  sourceBases: readonly EconomicBasis[];
  /** All request rows in the attribution window. */
  requestCount: number;
  /** Rows with no exact economic charge event, never silently coerced. */
  unresolvedRequests: number;
  /** True only when every request in the window has exact effective evidence. */
  complete: boolean;
}

/**
 * Project an exact decimal into a legacy numeric field only when the exact
 * window is complete and the projection is finite. Incomplete or oversized
 * windows keep their caller-supplied compatibility value and remain disclosed
 * through the exact coverage object.
 */
export function economicAttributionNumber(value: EconomicAttribution | undefined, compatibilityValue: number): number {
  if (value === undefined || !value.complete) return compatibilityValue;
  const projected = Number(value.amountText);
  return Number.isFinite(projected) ? projected : compatibilityValue;
}

/**
 * Convert the Store's exact projection into a persistence-safe value object.
 * Keeping this adapter free of Store imports prevents the accounting view from
 * acquiring a second query implementation or a BigInt-bearing JSON boundary.
 */
export function economicAttributionView(projection: {
  amount: Parameters<typeof moneyToJson>[0];
  eventIds: readonly string[];
  sourceBases: readonly EconomicBasis[];
  requestCount: number;
  unresolvedRequests: number;
}): EconomicAttribution {
  const amount = moneyToJson(projection.amount);
  return Object.freeze({
    amount,
    amountText: formatMoneyAmount(projection.amount),
    eventIds: Object.freeze([...projection.eventIds]),
    sourceBases: Object.freeze([...projection.sourceBases]),
    requestCount: projection.requestCount,
    unresolvedRequests: projection.unresolvedRequests,
    complete: projection.unresolvedRequests === 0,
  });
}

/**
 * Validate and canonicalize an untrusted JSON-safe attribution object. This is
 * shared by signed receipts and team rollups so both artifact protocols apply
 * the same exact-money and coverage invariants.
 */
export function canonicalEconomicAttribution(value: unknown): EconomicAttribution {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('economic attribution must be an object');
  const record = value as Record<string, unknown>;
  const expected = ['amount', 'amountText', 'complete', 'eventIds', 'requestCount', 'sourceBases', 'unresolvedRequests'].sort();
  if (Object.keys(record).sort().join('\u0000') !== expected.join('\u0000')) throw new Error('economic attribution has unknown or missing fields');
  const eventIds = record.eventIds;
  if (!Array.isArray(eventIds) || eventIds.some((id) => typeof id !== 'string' || id.length === 0)) throw new Error('economic attribution eventIds are invalid');
  if (new Set(eventIds).size !== eventIds.length || eventIds.some((id, index) => index > 0 && id < eventIds[index - 1]!)) throw new Error('economic attribution eventIds must be unique and sorted');
  const sourceBases = record.sourceBases;
  if (!Array.isArray(sourceBases) || sourceBases.some((basis) => !ECONOMIC_BASES.includes(basis as EconomicBasis))) throw new Error('economic attribution sourceBases are invalid');
  if (new Set(sourceBases).size !== sourceBases.length || sourceBases.some((basis, index) => index > 0 && basis < sourceBases[index - 1]!)) throw new Error('economic attribution sourceBases must be unique and sorted');
  if (!Number.isSafeInteger(record.requestCount) || (record.requestCount as number) < 0 || !Number.isSafeInteger(record.unresolvedRequests) || (record.unresolvedRequests as number) < 0) throw new Error('economic attribution coverage counts are invalid');
  if (typeof record.complete !== 'boolean' || typeof record.amountText !== 'string') throw new Error('economic attribution status/rendering is invalid');
  const amount = moneyFromJson(record.amount as MoneyJson);
  if (amount.basis !== 'effective' || formatMoneyAmount(amount) !== record.amountText) throw new Error('economic attribution amount is not canonical effective Money');
  const canonical = economicAttributionView({
    amount,
    eventIds: eventIds as string[],
    sourceBases: sourceBases as EconomicBasis[],
    requestCount: record.requestCount as number,
    unresolvedRequests: record.unresolvedRequests as number,
  });
  if (canonical.complete !== record.complete) throw new Error('economic attribution completeness is inconsistent');
  return canonical;
}

/**
 * Reconcile an exact attribution against the USD-named float beside it.
 *
 * FOUR PLACES DID THIS AND ONLY ONE CHECKED THE CURRENCY (WP-C06 / WP-R06).
 * `src/team/rollup.ts`, `buildEconomicReceiptBody` and `receiptSemanticError`
 * each compared `Math.abs(costUsd - Number(amountText))` against a tolerance and
 * stopped there. `canonicalEconomicAttribution` validates that the basis is
 * `effective` and never looks at the unit, and `moneyFromJson` accepts any
 * three-letter code — so an exact EUR 100.00 "agreed with" `costUsd: 100`, the
 * receipt verified, the rollup was accepted, and the team server summed it into
 * a column its own schema names `total_cost_usd`.
 *
 * The magnitude comparison LOOKS like a conservation check, and against a float
 * projection of the same amount it is one. What it cannot see is that a number
 * is not a quantity: 100 EUR and 100 USD have equal magnitude and are not the
 * same money. `src/value/epistemic.ts` already refused this for coding
 * realization ("supports USD effective spend only"); this is the same rule
 * reaching the three siblings that were written without it.
 *
 * THE RULE IS NOT "AMOUNTS MUST BE USD". An exact amount in another currency is
 * a legitimate object and `canonicalEconomicAttribution` still accepts one. What
 * is refused is RECONCILING it against a field whose name asserts a unit it does
 * not carry. The honest repair for that field is to carry its unit on the wire
 * rather than in its name, which this does not attempt.
 */
export function assertAgreesWithUsdCompatibility(
  attribution: EconomicAttribution,
  costUsd: number,
  subject: string,
): void {
  if (!Number.isFinite(costUsd) || costUsd < 0) {
    throw new Error(`${subject} compatibility cost must be finite and non-negative`);
  }
  if (attribution.amount.currency !== 'USD') {
    throw new Error(
      `${subject} compatibility cost is named in USD and cannot agree with an exact `
      + `${attribution.amount.currency} amount`,
    );
  }
  const projected = Number(attribution.amountText);
  if (!Number.isFinite(projected) || Math.abs(costUsd - projected) > Math.max(1e-12, Math.abs(projected) * 1e-12)) {
    throw new Error(`${subject} compatibility cost disagrees with exact amount`);
  }
}

/** Aggregate exact request rows without converting the effective basis to a float. */
export function economicAttributionFromRows(rows: ReadonlyArray<{
  effectiveAmount: Money | null;
  sourceEventIds: readonly string[];
  sourceBases: readonly EconomicBasis[];
  unresolvedReason: string | null;
}>): EconomicAttribution {
  if (!Array.isArray(rows)) throw new Error('economic attribution rows must be an array');
  let amount = money('0', 'USD', 'effective');
  const eventIds: string[] = [];
  const sourceBases = new Set<EconomicBasis>();
  let unresolvedRequests = 0;
  for (const row of rows) {
    if (row.effectiveAmount === null || row.unresolvedReason !== null) {
      unresolvedRequests += 1;
      continue;
    }
    if (row.effectiveAmount.basis !== 'effective') throw new Error('economic attribution amount must use the effective basis');
    amount = addMoney(amount, row.effectiveAmount);
    eventIds.push(...row.sourceEventIds);
    for (const basis of row.sourceBases) sourceBases.add(basis);
  }
  return economicAttributionView({
    amount,
    eventIds: eventIds.sort(),
    sourceBases: [...sourceBases].sort(),
    requestCount: rows.length,
    unresolvedRequests,
  });
}

/** Aggregate already-built attribution windows without losing coverage state. */
export function economicAttributionFromAttributions(values: ReadonlyArray<EconomicAttribution>): EconomicAttribution {
  if (!Array.isArray(values)) throw new Error('economic attributions must be an array');
  let amount = money('0', 'USD', 'effective');
  const eventIds: string[] = [];
  const sourceBases = new Set<EconomicBasis>();
  let requestCount = 0;
  let unresolvedRequests = 0;
  for (const value of values) {
    amount = addMoney(amount, moneyFromJson(value.amount));
    eventIds.push(...value.eventIds);
    for (const basis of value.sourceBases) sourceBases.add(basis);
    requestCount += value.requestCount;
    unresolvedRequests += value.unresolvedRequests;
  }
  return economicAttributionView({
    amount,
    eventIds: eventIds.sort(),
    sourceBases: [...sourceBases].sort(),
    requestCount,
    unresolvedRequests,
  });
}
