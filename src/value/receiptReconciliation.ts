/**
 * Reconcile a value receipt against the economic ledger it summarises (D-231).
 *
 * A v2 receipt carries the exact lineage it was signed over: the source and
 * correction event ids the effective projection retained, the effective
 * amount, and the source bases. This asks the ledger — now, or as of an
 * instant — whether it still says the same, and keeps four answers apart:
 *
 * - `agrees`: every named event is in the ledger, and the effective projection
 *   over the receipt's sources yields the same amount through the same lineage.
 * - `ledger_moved`: the sources resolve and everything the receipt names is
 *   still there, but the ledger has since retained corrections the receipt
 *   never saw, and the effective amount differs. The receipt was true when it
 *   was signed; the ledger has moved on. A read as of the signing instant
 *   should return `agrees`.
 * - `disagrees`: a source the receipt names is gone, or the lineage is exactly
 *   the receipt's and the amount still differs — nothing later explains it.
 * - `not_reconcilable`: a v1 receipt carries no lineage; a receipt whose
 *   events this ledger has NONE of was signed over some other ledger.
 *
 * What is not checked is said in `notChecked`: `requestCount` (a receipt has
 * no window, so the ledger cannot count its rows) and the signature (that is
 * `verifyReceipt`'s job; this function takes a body and trusts nothing about
 * who signed it).
 */

import type { EconomicLedger } from '../economics/ledger.ts';
import { addMoney, compareMoney, formatMoneyAmount, money, moneyFromJson } from '../economics/money.ts';
import { economicEventRole } from '../economics/events.ts';
import type { Instant } from '../epistemic/time.ts';
import type { ReceiptBody } from './receipt.ts';

export type ReceiptReconciliationStatus = 'agrees' | 'ledger_moved' | 'disagrees' | 'not_reconcilable';

export interface ReceiptReconciliation {
  readonly status: ReceiptReconciliationStatus;
  /** The receipt's effective amount, canonical decimal; `null` for a v1 body. */
  readonly receiptAmountText: string | null;
  /** The ledger's effective amount over the receipt's resolvable sources; `null` when none resolve. */
  readonly ledgerAmountText: string | null;
  /** Event ids the receipt names that this ledger does not hold at the boundary. */
  readonly missingEventIds: readonly string[];
  /** Event ids in the ledger's effective lineage that the receipt never named. */
  readonly unseenEventIds: readonly string[];
  readonly reasons: readonly string[];
  readonly notChecked: readonly string[];
  /** The knowledge boundary the ledger was read at; `null` is a live read. */
  readonly asOf: Instant | null;
}

const NOT_CHECKED = Object.freeze([
  'requestCount: a receipt carries no attribution window, so the ledger cannot count the rows the unit had',
  'signature: reconciliation reads a body; verifyReceipt establishes integrity and authenticity',
]);

function result(partial: Omit<ReceiptReconciliation, 'notChecked'>): ReceiptReconciliation {
  return Object.freeze({ ...partial, notChecked: NOT_CHECKED });
}

export function reconcileReceiptWithLedger(body: ReceiptBody, ledger: EconomicLedger, asOf?: Instant): ReceiptReconciliation {
  const boundary = asOf ?? null;
  if (body.v !== 2) {
    return result({
      status: 'not_reconcilable', receiptAmountText: null, ledgerAmountText: null, missingEventIds: [], unseenEventIds: [],
      reasons: ['a v1 receipt carries a compatibility float and no exact lineage; there is nothing to reconcile against the ledger'], asOf: boundary,
    });
  }
  const receiptAmount = moneyFromJson(body.economic.amount);
  const receiptAmountText = formatMoneyAmount(receiptAmount);
  const named = [...new Set(body.economic.eventIds)].sort();

  // Which of the named events does the ledger hold at the boundary, and
  // which of those are charge sources the effective projection starts from?
  const missing: string[] = [];
  const sourceIds: string[] = [];
  const boundaryMs = boundary === null ? null : Date.parse(boundary);
  for (const id of named) {
    const event = ledger.read(id);
    if (event === null || (boundaryMs !== null && Date.parse(event.recordedAt) > boundaryMs)) {
      missing.push(id);
      continue;
    }
    if (economicEventRole(event.kind) === 'charge' && event.amount !== null) sourceIds.push(id);
  }

  if (missing.length === named.length) {
    return result({
      status: 'not_reconcilable', receiptAmountText, ledgerAmountText: null, missingEventIds: missing, unseenEventIds: [],
      reasons: [`none of the ${named.length} events the receipt names is in this ledger${boundary === null ? '' : ` as of ${boundary}`}; it was signed over a different ledger, or before any of them was recorded`],
      asOf: boundary,
    });
  }

  const charges = ledger.effectiveChargesFor(sourceIds, asOf);
  let ledgerAmount = money('0', receiptAmount.currency, 'effective');
  const lineage = new Set<string>();
  for (const id of sourceIds) {
    const charge = charges.get(id);
    if (charge === undefined) { missing.push(id); continue; }
    ledgerAmount = addMoney(ledgerAmount, charge.amount);
    for (const eventId of charge.eventIds) lineage.add(eventId);
  }
  missing.sort();
  const namedSet = new Set(named);
  const unseen = [...lineage].filter((id) => !namedSet.has(id)).sort();
  const ledgerAmountText = formatMoneyAmount(ledgerAmount);
  const sameAmount = compareMoney(ledgerAmount, receiptAmount) === 0;
  const reasons: string[] = [];

  let status: ReceiptReconciliationStatus;
  if (missing.length > 0) {
    status = 'disagrees';
    reasons.push(`${missing.length} event(s) the receipt names are not in this ledger${boundary === null ? '' : ` as of ${boundary}`}: ${missing.join(', ')}`);
  } else if (sameAmount && unseen.length === 0) {
    status = 'agrees';
  } else if (unseen.length > 0) {
    status = 'ledger_moved';
    reasons.push(`the ledger retains ${unseen.length} correction(s) the receipt never saw: ${unseen.join(', ')}`);
    if (!sameAmount) reasons.push(`effective amount is ${ledgerAmountText} in the ledger and ${receiptAmountText} on the receipt`);
  } else {
    status = 'disagrees';
    reasons.push(`the lineage is exactly the receipt's and the effective amount still differs: ledger ${ledgerAmountText}, receipt ${receiptAmountText}`);
  }
  return result({ status, receiptAmountText, ledgerAmountText, missingEventIds: missing, unseenEventIds: unseen, reasons, asOf: boundary });
}
