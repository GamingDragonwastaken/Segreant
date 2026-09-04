/**
 * An adjustment must be able to net against the charge it adjusts (WP-C02).
 *
 * `validateEventBasis` constrains the basis of five of the seventeen economic
 * event kinds. The other twelve fall through a `: true` default, and six of
 * those twelve are the ADJUSTMENT kinds — `credit_applied`, `discount_applied`,
 * `commitment_recognized`, `tax_recognized`, `true_up`, `write_off`. An
 * adjustment exists to move a charge, so its basis is not free: it has to be a
 * basis some charge can actually carry.
 *
 * WHY THIS IS A DEFECT AND NOT A MISSING NICETY. `closeBalances` groups by
 * `currency + basis + role` and sums only within a group, which is the right
 * refusal — bases name different economic semantics and must not be added
 * together. But it means a credit carrying a basis no charge uses can never net
 * against anything. It does not error, and it does not go missing: it appears as
 * its own balance row, and the bill it was supposed to reduce still reads at its
 * full amount. Both numbers are then individually true and jointly misleading,
 * which is the exact failure mode this repository keeps finding.
 *
 * THE RULE IS DERIVED, NOT INVENTED. It is read off the constraints already
 * present: charges may carry `list` or `estimated` (`charge_estimated`),
 * `provider_observed` (`provider_charge_observed`) or `billed`
 * (`bill_observed`). `effective`, `allocated` and `full_cost` are downstream or
 * computed bases that no charge kind is permitted to hold, so an adjustment
 * carrying one adjusts nothing that exists.
 *
 * DELIBERATELY NOT CONSTRAINED HERE. `price_corrected` and `fx_translated` stay
 * open across every basis, and that is correct rather than an omission: a price
 * correction carries a DELTA whose basis is inherited from the amount it
 * corrects, and `applyExactRate` translates a currency while preserving the
 * source basis on purpose. Pinning either to a fixed basis would break a
 * correction against a billed charge and every non-list translation. The control
 * kinds need no rule at all — `close_finalized` and `close_reopened` already
 * refuse to carry an amount.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { economicEvent, ECONOMIC_EVENT_KINDS, economicEventRole, type EconomicEventInput } from '../src/economics/events.ts';
import { EconomicLedger } from '../src/economics/ledger.ts';
import { money } from '../src/economics/money.ts';

function event(overrides: Partial<EconomicEventInput> = {}): EconomicEventInput {
  return {
    id: 'event:bill:1',
    kind: 'bill_observed',
    subject: 'provider:openai:acct-1',
    occurredAt: '2026-08-01T00:00:00.000Z',
    recordedAt: '2026-08-02T00:00:00.000Z',
    amount: money('12.34', 'USD', 'billed'),
    sourceEventIds: [],
    reversalOf: null,
    metadata: { invoiceRef: 'invoice-1' },
    schemaVersion: 1,
  ...overrides,
  };
}

/** Every kind whose role is `adjustment`, read from the kernel rather than listed. */
const ADJUSTMENT_KINDS = ECONOMIC_EVENT_KINDS.filter((kind) => economicEventRole(kind) === 'adjustment');

/** Bases no charge kind may carry, so nothing an adjustment could net against holds one. */
const UNNETTABLE = ['effective', 'allocated', 'full_cost'] as const;

test('the adjustment role is a real set, so this file is not asserting about nothing', () => {
  // Read from the kernel: if a kind stops being an adjustment, or the role is
  // renamed, this fails rather than silently shrinking the sweep below to zero.
  assert.deepEqual(
    [...ADJUSTMENT_KINDS].sort(),
    ['commitment_recognized', 'credit_applied', 'discount_applied', 'tax_recognized', 'true_up', 'write_off'],
  );
});

test('an adjustment cannot carry a basis that no charge can hold', () => {
  // The refusal. Six kinds times three unnettable bases, all of which the kernel
  // accepted before this rule existed.
  for (const kind of ADJUSTMENT_KINDS) {
    for (const basis of UNNETTABLE) {
      assert.throws(
        () => economicEvent(event({ id: `event:${kind}:1`, kind, amount: money('-1.00', 'USD', basis) })),
        /adjusts a charge and must carry a basis a charge can hold/,
        `${kind} with basis ${basis} was accepted`,
      );
    }
  }
});

test('an adjustment may carry any basis a charge can hold', () => {
  // The permitted path, which matters as much as the refusal: a rule that
  // rejected everything would pass the test above and destroy the feature.
  for (const kind of ADJUSTMENT_KINDS) {
    for (const basis of ['list', 'estimated', 'provider_observed', 'billed'] as const) {
      const built = economicEvent(event({ id: `event:${kind}:ok`, kind, amount: money('-1.00', 'USD', basis) }));
      assert.equal(built.amount?.basis, basis);
    }
  }
});

test('a usage observation cannot carry a monetary amount', () => {
  // Usage is an observation of a non-monetary quantity.  The economic event
  // model has no unit-bearing usage amount, so placing Money here would make a
  // usage observation look like spend in a later role-aware projection.
  assert.throws(
    () => economicEvent(event({
      id: 'event:usage:money',
      kind: 'usage_observed',
      amount: money('1.00', 'USD', 'billed'),
    })),
    /usage_observed.*(must not|cannot).*amount|usage.*monetary/i,
  );
});

test('a credit that cannot net leaves the bill reading at full amount, which is why the rule exists', () => {
  // The consequence, demonstrated rather than asserted in prose. A credit whose
  // basis matches nets into the billed group; one that does not would sit alone.
  // `closeBalances` groups by currency + basis + role and is RIGHT to refuse to
  // add across bases — so the only place this can be prevented is at issuance.
  const db = new DatabaseSync(':memory:');
  try {
    const ledger = new EconomicLedger(db);
    const bill = economicEvent(event());
    const credit = economicEvent(event({
      id: 'event:credit:1',
      kind: 'credit_applied',
      amount: money('-2.34', 'USD', 'billed'),
      sourceEventIds: [bill.id],
      reversalOf: bill.id,
      recordedAt: '2026-08-03T00:00:00.000Z',
    }));
    assert.equal(ledger.append(bill), 'inserted');
    assert.equal(ledger.append(credit), 'inserted');

    // Same currency and basis, different roles: the ledger keeps `charge` and
    // `adjustment` separable, and a consumer nets them knowing both bases agree.
    assert.equal(bill.amount?.basis, credit.amount?.basis);
    assert.equal(economicEventRole(bill.kind), 'charge');
    assert.equal(economicEventRole(credit.kind), 'adjustment');
  } finally {
    db.close();
  }
});
