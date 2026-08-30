/** JSON-safe exact economic coverage attached to a value attribution window. */

import { addMoney, formatMoneyAmount, money, moneyToJson, type EconomicBasis, type Money, type MoneyJson } from './money.ts';

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
