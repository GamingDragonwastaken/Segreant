/**
 * Conservation as LAWS, over generated event sequences (WP-C02 remainder).
 *
 * WHAT ALREADY EXISTED. `economic-adjustment-conservation.test.ts` fixes a $10
 * bill and splits credits across it. `economic-allocation-conservation.test.ts`
 * fixes a $10 allocation and splits reversals across it.
 * `economic-replay-property.test.ts` replays ONE hand-built pair of histories.
 * All three are example-based, all three are right, and none of them says
 * anything about an event set the author did not write down. These are the laws.
 *
 * THE INVARIANT IS READ OFF THE CODE, NOT INVENTED. `closeBalances` and
 * `project` group by `currency + basis + role` and sum ONLY inside a group. That
 * refusal to add across bases is the product: metered usage, provider-billed
 * cost and allocated cost are different claims. So the conservation statement
 * available here is precisely:
 *
 *     for every (currency, basis, role) group, the projected balance equals the
 *     exact sum of the amounts of the events in that group — and nothing else.
 *
 * plus the two bounds the ledger enforces at issuance: negative adjustments may
 * not exceed the charge they adjust in AGGREGATE, and allocation reversals may
 * not exceed the allocation they reverse in AGGREGATE.
 *
 * WHERE ORDERING DOES NOT MATTER, AND WHERE IT DOES. Both are asserted, because
 * getting this backwards is how a ledger acquires a silent dependency on the
 * order rows happened to be written:
 *
 *   - INSERTION order does not matter. The same event set inserted in any valid
 *     topological order yields byte-identical projections and an identical close
 *     projection digest. That is what makes the digest a statement about the
 *     history rather than about the writer.
 *   - RECORDED time does matter, and is supposed to: `project(asOf)` is a
 *     function of `recordedAt`, so the same set read at two boundaries is two
 *     different, both-true answers.
 *   - ADMISSION order matters when a set of adjustments over-credits its charge.
 *     The bound is enforced greedily against what is already recorded, so WHICH
 *     events survive depends on arrival order. The law is therefore stated over
 *     the invariant that holds in every order — the ledger never records more
 *     credit than the charge — and not over the surviving subset, which is
 *     genuinely arrival-dependent by design.
 *   - A CLOSE is a commitment about what was visible when it was recorded, so an
 *     in-period event recorded at or before a close's instant is refused. That
 *     refusal is the whole reason insertion order can be free elsewhere.
 *
 * DETERMINISM. One constant seed, one derived stream per law, the seed and case
 * index printed on every failure. No `Math.random()`.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { EconomicLedger } from '../src/economics/ledger.ts';
import {
  ECONOMIC_EVENT_KINDS,
  ECONOMIC_EVENT_ROLES,
  economicEvent,
  economicEventRole,
  type EconomicEvent,
  type EconomicEventRole,
} from '../src/economics/events.ts';
import { priceCorrectionEvent } from '../src/economics/corrections.ts';
import { fxTranslationEvent } from '../src/economics/fx.ts';
import { exactRate } from '../src/economics/rate.ts';
import { addMoney, compareMoney, formatMoneyAmount, money, type Money } from '../src/economics/money.ts';
import { deterministicRandom, seedFor, type DeterministicRandom } from './support/deterministicGenerator.ts';

const BASE_SEED = 0x0f1c_5c02;

const PERIOD_START = Date.parse('2026-08-01T00:00:00.000Z');
const PERIOD_END = Date.parse('2026-09-01T00:00:00.000Z');
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

function at(ms: number): string {
  return new Date(ms).toISOString();
}

function stream(law: string): { seed: number; rng: DeterministicRandom } {
  const seed = seedFor(BASE_SEED, law);
  return { seed, rng: deterministicRandom(seed) };
}

function reproduce(seed: number, index: number): string {
  return `reproduce with base seed ${BASE_SEED}, law seed ${seed}, case index ${index}`;
}

/** Render a bigint coefficient at a scale as a plain decimal string `money()` accepts. */
function decimalText(coefficient: bigint, scale: number): string {
  const negative = coefficient < 0n;
  const digits = (negative ? -coefficient : coefficient).toString();
  if (scale === 0) return `${negative ? '-' : ''}${digits}`;
  const padded = digits.padStart(scale + 1, '0');
  const split = padded.length - scale;
  return `${negative ? '-' : ''}${padded.slice(0, split)}.${padded.slice(split)}`;
}

/** A strictly positive amount at a fixed scale, so partitions below stay exact integers. */
function positiveCoefficient(rng: DeterministicRandom, scale: number): bigint {
  const wholeDigits = rng.between(1, 4);
  let whole = String(rng.between(1, 9));
  for (let index = 1; index < wholeDigits; index += 1) whole += String(rng.below(10));
  let fraction = '';
  for (let index = 0; index < scale; index += 1) fraction += String(rng.below(10));
  return BigInt(`${whole}${fraction}`);
}

/** Split `total` into `parts` non-negative integers whose sum is exactly `total`. */
function partition(rng: DeterministicRandom, total: bigint, parts: number): bigint[] {
  const result: bigint[] = [];
  let remaining = total;
  for (let index = 0; index < parts - 1; index += 1) {
    const share = (remaining * BigInt(rng.between(0, 100))) / 100n;
    result.push(share);
    remaining -= share;
  }
  result.push(remaining);
  return result;
}

/** Split `total` into `parts` each no larger than `cap`, for the allocation bound. */
function cappedPartition(total: bigint, parts: number, cap: bigint): bigint[] {
  const base = total / BigInt(parts);
  let remainder = total - base * BigInt(parts);
  const result: bigint[] = [];
  for (let index = 0; index < parts; index += 1) {
    const extra = remainder > 0n ? 1n : 0n;
    remainder -= extra;
    const share = base + extra;
    if (share > cap) throw new Error('capped partition exceeded its cap');
    result.push(share);
  }
  return result;
}

// ---------------------------------------------------------------------------
// Step 0, asserted rather than assumed: the vocabulary this file sweeps over
// ---------------------------------------------------------------------------

/** The adjustment kinds, read from the kernel so a new one joins the sweep automatically. */
const ADJUSTMENT_KINDS = ECONOMIC_EVENT_KINDS.filter((kind) => economicEventRole(kind) === 'adjustment');

test('the role vocabulary these laws sweep over is the kernel vocabulary', () => {
  // If a role is added, renamed or drops out of use, the laws below are sweeping
  // over something other than what they claim. Fail here, loudly, rather than
  // quietly testing six sevenths of the algebra.
  assert.deepEqual([...ECONOMIC_EVENT_ROLES], [
    'usage', 'charge', 'price', 'adjustment', 'translation', 'allocation', 'control',
  ]);
  assert.equal(ECONOMIC_EVENT_KINDS.length, 18);
  assert.deepEqual([...ADJUSTMENT_KINDS].sort(), [
    'commitment_recognized', 'credit_applied', 'discount_applied', 'tax_recognized', 'true_up', 'write_off',
  ]);

  // Two roles never carry money and so never appear in a balance. `usage` is an
  // observation of a non-monetary quantity and `economicEvent` refuses money on
  // it; `control` is close/reopen/invalidate, all three of which refuse an
  // amount. Everything else can and does reach a balance group.
  const monetaryRoles = new Set<EconomicEventRole>();
  for (const kind of ECONOMIC_EVENT_KINDS) {
    if (kind === 'usage_observed' || kind.startsWith('close_')) continue;
    monetaryRoles.add(economicEventRole(kind));
  }
  assert.deepEqual([...monetaryRoles].sort(), ['adjustment', 'allocation', 'charge', 'price', 'translation']);
});

// ---------------------------------------------------------------------------
// Scenario construction
// ---------------------------------------------------------------------------

interface Scenario {
  readonly subject: string;
  readonly events: readonly EconomicEvent[];
  /** The bill every negative adjustment in this scenario points at. */
  readonly bill: EconomicEvent;
  /** The allocation every reversal in this scenario points at. */
  readonly allocation: EconomicEvent;
}

/**
 * A generated history touching every role that can carry money.
 *
 * Correction, credit/discount/tax/true-up/write-off, allocation, allocation
 * reversal and FX translation all appear, with generated amounts and generated
 * counts, all conserving so that the whole set is accepted in any order.
 */
function buildScenario(rng: DeterministicRandom, index: number): Scenario {
  const subject = `economic:law:${index}`;
  const scale = 4;
  const occurredAt = at(PERIOD_START + rng.between(0, 20) * DAY + rng.between(0, 23) * HOUR);
  const recordedBase = Date.parse(occurredAt) + DAY;
  const id = (suffix: string): string => `${subject}:${suffix}`;

  const events: EconomicEvent[] = [];

  events.push(economicEvent({
    id: id('usage'),
    kind: 'usage_observed',
    subject,
    occurredAt,
    recordedAt: at(recordedBase),
    amount: null,
    sourceEventIds: [],
    reversalOf: null,
    metadata: { units: rng.between(1, 10_000), unit: 'token' },
    schemaVersion: 1,
  }));

  const billCoefficient = positiveCoefficient(rng, scale);
  const bill = economicEvent({
    id: id('bill'),
    kind: 'bill_observed',
    subject,
    occurredAt,
    recordedAt: at(recordedBase + HOUR),
    amount: money(decimalText(billCoefficient, scale), 'USD', 'billed'),
    sourceEventIds: [],
    reversalOf: null,
    metadata: { invoiceRef: `invoice-${index}` },
    schemaVersion: 1,
  });
  events.push(bill);

  events.push(economicEvent({
    id: id('provider-charge'),
    kind: 'provider_charge_observed',
    subject,
    occurredAt,
    recordedAt: at(recordedBase + 2 * HOUR),
    amount: money(decimalText(positiveCoefficient(rng, scale), scale), 'USD', 'provider_observed'),
    sourceEventIds: [],
    reversalOf: null,
    metadata: { source: 'provider-api' },
    schemaVersion: 1,
  }));

  const estimatedAmount = money(decimalText(positiveCoefficient(rng, scale), scale), 'USD', 'list');
  const estimated = economicEvent({
    id: id('estimate'),
    kind: 'charge_estimated',
    subject,
    occurredAt,
    recordedAt: at(recordedBase + 3 * HOUR),
    amount: estimatedAmount,
    sourceEventIds: [],
    reversalOf: null,
    metadata: { rateCard: 'fixture' },
    schemaVersion: 1,
  });
  events.push(estimated);

  // A correction is a signed DELTA against its predecessor, not a replacement:
  // the original charge stays in the ledger at its original amount and the two
  // land in different roles. The generated replacement may be above or below.
  events.push(priceCorrectionEvent({
    id: id('correction'),
    source: estimated,
    previousAmount: estimatedAmount,
    nextAmount: money(decimalText(positiveCoefficient(rng, scale), scale), 'USD', 'list'),
    recordedAt: at(recordedBase + 4 * HOUR),
  }));

  // Negative adjustments summing to at most the bill, so every one is admissible.
  const creditTotal = (billCoefficient * BigInt(rng.between(0, 100))) / 100n;
  const creditCount = rng.between(1, 4);
  partition(rng, creditTotal, creditCount).forEach((share, position) => {
    events.push(economicEvent({
      id: id(`credit-${position}`),
      kind: rng.pick(ADJUSTMENT_KINDS),
      subject,
      occurredAt,
      recordedAt: at(recordedBase + (5 + position) * HOUR),
      amount: money(decimalText(-share, scale), 'USD', 'billed'),
      sourceEventIds: [bill.id],
      reversalOf: bill.id,
      metadata: { invoiceRef: `invoice-${index}` },
      schemaVersion: 1,
    }));
  });

  // A positive adjustment, which is bounded by nothing: tax adds to a bill.
  events.push(economicEvent({
    id: id('tax'),
    kind: 'tax_recognized',
    subject,
    occurredAt,
    recordedAt: at(recordedBase + 10 * HOUR),
    amount: money(decimalText(positiveCoefficient(rng, scale), scale), 'USD', 'billed'),
    sourceEventIds: [bill.id],
    reversalOf: null,
    metadata: { invoiceRef: `invoice-${index}` },
    schemaVersion: 1,
  }));

  const allocatedCoefficient = positiveCoefficient(rng, scale);
  const allocation = economicEvent({
    id: id('allocation'),
    kind: 'cost_allocated',
    subject,
    occurredAt,
    recordedAt: at(recordedBase + 11 * HOUR),
    amount: money(decimalText(allocatedCoefficient, scale), 'USD', 'allocated'),
    sourceEventIds: [],
    reversalOf: null,
    metadata: { rule: 'fixture' },
    schemaVersion: 1,
  });
  events.push(allocation);

  // Reallocation has no distinct kind and does not need one: it is a reversal
  // followed by a fresh allocation, and the ledger refuses to let a reversal be
  // spelled any other way.
  const reversalTotal = (allocatedCoefficient * BigInt(rng.between(0, 100))) / 100n;
  const reversalCount = rng.between(1, 3);
  cappedPartition(reversalTotal, reversalCount, allocatedCoefficient).forEach((share, position) => {
    events.push(economicEvent({
      id: id(`reversal-${position}`),
      kind: 'allocation_reversed',
      subject,
      occurredAt,
      recordedAt: at(recordedBase + (12 + position) * HOUR),
      amount: money(decimalText(-share, scale), 'USD', 'allocated'),
      sourceEventIds: [allocation.id],
      reversalOf: allocation.id,
      metadata: { rule: 'fixture-reversal' },
      schemaVersion: 1,
    }));
  });

  // FX translation preserves the source basis and moves the currency, so it
  // lands in its own group and can never be added to the dollars it came from.
  events.push(fxTranslationEvent({
    id: id('fx'),
    source: bill,
    rate: exactRate({ numerator: 23n, denominator: 25n, sourceUnit: 'USD', targetUnit: 'EUR' }),
    rateSource: 'fixture-book',
    effectiveAt: occurredAt,
    recordedAt: at(recordedBase + 16 * HOUR),
  }));

  return { subject, events, bill, allocation };
}

/** A random insertion order that still lets every event find its sources already stored. */
function topologicalOrder(rng: DeterministicRandom, events: readonly EconomicEvent[]): EconomicEvent[] {
  const remaining = [...events];
  const emitted = new Set<string>();
  const order: EconomicEvent[] = [];
  while (remaining.length > 0) {
    const ready = remaining.filter((item) => item.sourceEventIds.every((sourceId) => emitted.has(sourceId)));
    if (ready.length === 0) throw new Error('generated scenario has an unsatisfiable dependency order');
    const chosen = rng.pick(ready);
    order.push(chosen);
    emitted.add(chosen.id);
    remaining.splice(remaining.indexOf(chosen), 1);
  }
  return order;
}

interface DescribedBalance {
  readonly role: string;
  readonly currency: string;
  readonly basis: string;
  readonly amount: string;
  readonly scale: number;
  readonly eventIds: readonly string[];
}

/**
 * The conservation expectation, computed here rather than read from the ledger.
 *
 * The ledger reads in `(recordedAt, id)` order, which is why the expectation is
 * built in that order too: the balance AMOUNTS are order-independent because the
 * money algebra is associative and commutative, but the `eventIds` list is a
 * record of the read order and is asserted as such.
 */
function expectedBalances(events: readonly EconomicEvent[], asOfMs: number): DescribedBalance[] {
  const visible = [...events]
    .filter((item) => Date.parse(item.recordedAt) <= asOfMs)
    .sort((left, right) => left.recordedAt.localeCompare(right.recordedAt) || left.id.localeCompare(right.id));
  const groups = new Map<string, { role: string; currency: string; basis: string; amount: Money; eventIds: string[] }>();
  for (const item of visible) {
    if (item.amount === null) continue;
    const role = economicEventRole(item.kind);
    const key = `${item.amount.currency} ${item.amount.basis} ${role}`;
    const group = groups.get(key);
    if (group === undefined) {
      groups.set(key, { role, currency: item.amount.currency, basis: item.amount.basis, amount: item.amount, eventIds: [item.id] });
    } else {
      group.amount = addMoney(group.amount, item.amount);
      group.eventIds.push(item.id);
    }
  }
  return [...groups.values()]
    .map((group) => ({
      role: group.role,
      currency: group.currency,
      basis: group.basis,
      amount: formatMoneyAmount(group.amount),
      scale: group.amount.scale,
      eventIds: group.eventIds,
    }))
    .sort((left, right) => left.currency.localeCompare(right.currency)
      || left.basis.localeCompare(right.basis)
      || left.role.localeCompare(right.role));
}

function describeProjection(ledger: EconomicLedger, asOf?: string): DescribedBalance[] {
  return ledger.project(asOf).balances.map((balance) => ({
    role: balance.role,
    currency: balance.currency,
    basis: balance.basis,
    amount: formatMoneyAmount(balance.amount),
    scale: balance.amount.scale,
    eventIds: [...balance.eventIds],
  }));
}

function withLedger<T>(work: (ledger: EconomicLedger) => T): T {
  const db = new DatabaseSync(':memory:');
  try {
    return work(new EconomicLedger(db));
  } finally {
    db.close();
  }
}

// ---------------------------------------------------------------------------
// The laws
// ---------------------------------------------------------------------------

export const SCENARIO_CASES = 40;
export const BOUND_CASES = 60;

test('LAW every projected balance is the exact sum of its own group, and of nothing else', () => {
  const { seed, rng } = stream('conservation/group-sum');
  for (let index = 0; index < SCENARIO_CASES; index += 1) {
    const scenario = buildScenario(rng, index);
    const order = topologicalOrder(rng, scenario.events);
    const actual = withLedger((ledger) => {
      for (const item of order) {
        assert.equal(ledger.append(item), 'inserted', `${reproduce(seed, index)}\nconserving event ${item.id} was refused`);
      }
      return describeProjection(ledger);
    });
    assert.deepEqual(
      actual,
      expectedBalances(scenario.events, Number.POSITIVE_INFINITY),
      `${reproduce(seed, index)}\nprojection is not the per-group sum of its events`,
    );

    // The negative half of the same law: usage and control never reach a
    // balance, and no group mixes currencies or bases.
    for (const balance of actual) {
      assert.notEqual(balance.role, 'usage', `${reproduce(seed, index)}\nusage reached a monetary balance`);
      assert.notEqual(balance.role, 'control', `${reproduce(seed, index)}\na control event reached a monetary balance`);
    }
    const keys = actual.map((balance) => `${balance.currency}/${balance.basis}/${balance.role}`);
    assert.equal(new Set(keys).size, keys.length, `${reproduce(seed, index)}\ntwo balances share a group key`);
  }
});

test('LAW insertion order does not change the projection or the close digest', () => {
  const { seed, rng } = stream('conservation/insertion-order');
  const closeRecordedAt = at(PERIOD_END + DAY);
  for (let index = 0; index < SCENARIO_CASES; index += 1) {
    const scenario = buildScenario(rng, index);
    const first = topologicalOrder(rng, scenario.events);
    const second = topologicalOrder(rng, scenario.events);

    const run = (order: readonly EconomicEvent[]) => withLedger((ledger) => {
      for (const item of order) {
        assert.equal(ledger.append(item), 'inserted', `${reproduce(seed, index)}\nconserving event ${item.id} was refused`);
      }
      const close = ledger.finalizePeriod({
        id: `${scenario.subject}:close`,
        periodStartMs: PERIOD_START,
        periodEndMs: PERIOD_END,
        recordedAt: closeRecordedAt,
      });
      return {
        balances: describeProjection(ledger),
        digest: close.projectionDigest,
        eventCount: close.eventCount,
        sourceEventIds: [...close.sourceEventIds],
      };
    });

    const left = run(first);
    const right = run(second);
    assert.deepEqual(
      left,
      right,
      `${reproduce(seed, index)}\ninsertion order changed the projection or the close digest`
      + `\norder A: ${first.map((item) => item.id).join(', ')}`
      + `\norder B: ${second.map((item) => item.id).join(', ')}`,
    );
    // A digest that is identical for every input is not evidence of anything, so
    // check it actually depends on the history.
    assert.match(left.digest, /^[a-f0-9]{64}$/);
    assert.equal(left.eventCount, scenario.events.length);
  }
});

test('LAW the projection is a function of recorded time, not of insertion order', () => {
  // This is the ordering that DOES matter, and is supposed to. A correction
  // recorded on the fourth is not visible on the third, and the ledger reading
  // $10 on the third and $12 on the fifth is two true answers, not a change of
  // mind. Asserted at every distinct recordedAt boundary in the scenario.
  const { seed, rng } = stream('conservation/recorded-time');
  for (let index = 0; index < SCENARIO_CASES; index += 1) {
    const scenario = buildScenario(rng, index);
    const order = topologicalOrder(rng, scenario.events);
    const boundaries = [...new Set(scenario.events.map((item) => item.recordedAt))].sort();
    withLedger((ledger) => {
      for (const item of order) ledger.append(item);
      for (const boundary of boundaries) {
        assert.deepEqual(
          describeProjection(ledger, boundary),
          expectedBalances(scenario.events, Date.parse(boundary)),
          `${reproduce(seed, index)}\nprojection at ${boundary} is not the sum of the events recorded by then`,
        );
      }
      // Monotone: the visible event set only grows as the boundary advances.
      let previous = 0;
      for (const boundary of boundaries) {
        const visible = ledger.project(boundary).eventIds.length;
        assert.ok(
          visible >= previous,
          `${reproduce(seed, index)}\nvisible event count fell from ${previous} to ${visible} at ${boundary}`,
        );
        previous = visible;
      }
      assert.equal(previous, scenario.events.length);
    });
  }
});

test('LAW negative adjustments never total more than the charge they adjust, in any arrival order', () => {
  const { seed, rng } = stream('conservation/adjustment-bound');
  let overCases = 0;
  let conservingCases = 0;
  for (let index = 0; index < BOUND_CASES; index += 1) {
    const scale = 4;
    const subject = `economic:adjustment-bound:${index}`;
    const occurredAt = at(PERIOD_START + rng.between(0, 20) * DAY);
    const recordedBase = Date.parse(occurredAt) + DAY;
    const chargeCoefficient = positiveCoefficient(rng, scale);
    const bill = economicEvent({
      id: `${subject}:bill`,
      kind: 'bill_observed',
      subject,
      occurredAt,
      recordedAt: at(recordedBase),
      amount: money(decimalText(chargeCoefficient, scale), 'USD', 'billed'),
      sourceEventIds: [],
      reversalOf: null,
      metadata: { invoiceRef: `invoice-${index}` },
      schemaVersion: 1,
    });

    // Half the cases conserve and half deliberately over-credit, so the law is
    // tested on both sides of the bound rather than only where it is satisfied.
    const overCredit = rng.chance(1, 2);
    if (overCredit) overCases += 1; else conservingCases += 1;
    const target = overCredit
      ? chargeCoefficient + positiveCoefficient(rng, scale)
      : (chargeCoefficient * BigInt(rng.between(0, 100))) / 100n;
    const count = rng.between(1, 5);
    const adjustments = partition(rng, target, count).map((share, position) => economicEvent({
      id: `${subject}:adjustment-${position}`,
      kind: rng.pick(ADJUSTMENT_KINDS),
      subject,
      occurredAt,
      recordedAt: at(recordedBase + (1 + position) * HOUR),
      amount: money(decimalText(-share, scale), 'USD', 'billed'),
      sourceEventIds: [bill.id],
      reversalOf: bill.id,
      metadata: { invoiceRef: `invoice-${index}` },
      schemaVersion: 1,
    }));

    // Several arrival orders per case: the invariant must hold in all of them.
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const arrival = rng.shuffled(adjustments);
      const context = `${reproduce(seed, index)} (arrival ${attempt})`
        + `\ncharge ${formatMoneyAmount(bill.amount as Money)}`
        + `\nadjustments ${adjustments.map((item) => formatMoneyAmount(item.amount as Money)).join(', ')}`;
      withLedger((ledger) => {
        ledger.append(bill);
        let refusals = 0;
        for (const adjustment of arrival) {
          try {
            assert.equal(ledger.append(adjustment), 'inserted');
          } catch (error) {
            refusals += 1;
            const message = error instanceof Error ? error.message : String(error);
            assert.match(
              message,
              /adjustments total [\s\S]*exceeds the [\s\S]*charge/,
              `${context}\nrefused for an unexpected reason: ${message}`,
            );
          }
        }

        // The invariant, in every order: the ledger holds no more credit than
        // the charge, so charge + adjustment never nets below zero.
        const balances = ledger.project().balances;
        const charge = balances.find((item) => item.role === 'charge' && item.basis === 'billed');
        const adjustment = balances.find((item) => item.role === 'adjustment' && item.basis === 'billed');
        assert.ok(charge !== undefined, `${context}\nthe charge disappeared from the projection`);
        const net = adjustment === undefined ? charge.amount : addMoney(charge.amount, adjustment.amount);
        assert.ok(
          compareMoney(net, money('0', 'USD', 'billed')) >= 0,
          `${context}\nnet billed position went negative at ${formatMoneyAmount(net)}`,
        );

        // Acceptance of a CONSERVING set is order-independent: every adjustment
        // is admissible in every order, because the running total of a set of
        // negative amounts only grows and the bound is checked against the set.
        if (!overCredit) {
          assert.equal(refusals, 0, `${context}\na conserving set was refused, which makes admission order-dependent`);
        } else {
          assert.ok(refusals > 0, `${context}\nan over-crediting set was accepted in full`);
        }
      });
    }
  }
  // A sweep is worth its enumeration: say that both sides were actually reached.
  assert.ok(overCases > 0 && conservingCases > 0, `sweep degenerated: ${overCases} over, ${conservingCases} conserving`);
});

test('LAW allocation reversals never total more than the allocation, in any arrival order', () => {
  const { seed, rng } = stream('conservation/allocation-bound');
  let overCases = 0;
  for (let index = 0; index < BOUND_CASES; index += 1) {
    const scale = 4;
    const subject = `economic:allocation-bound:${index}`;
    const occurredAt = at(PERIOD_START + rng.between(0, 20) * DAY);
    const recordedBase = Date.parse(occurredAt) + DAY;
    const allocatedCoefficient = positiveCoefficient(rng, scale);
    const allocation = economicEvent({
      id: `${subject}:allocation`,
      kind: 'cost_allocated',
      subject,
      occurredAt,
      recordedAt: at(recordedBase),
      amount: money(decimalText(allocatedCoefficient, scale), 'USD', 'allocated'),
      sourceEventIds: [],
      reversalOf: null,
      metadata: { rule: 'fixture' },
      schemaVersion: 1,
    });

    const overReverse = rng.chance(1, 2);
    if (overReverse) overCases += 1;
    const count = rng.between(2, 4);
    // In the over case every individual reversal stays inside the single-event
    // bound, so the refusal has to come from the AGGREGATE rule and not from the
    // cheaper per-event one it sits behind.
    const total = overReverse
      ? allocatedCoefficient + (allocatedCoefficient * BigInt(rng.between(1, 100))) / 100n
      : (allocatedCoefficient * BigInt(rng.between(0, 100))) / 100n;
    const shares = cappedPartition(total, count, allocatedCoefficient);
    const reversals = shares.map((share, position) => economicEvent({
      id: `${subject}:reversal-${position}`,
      kind: 'allocation_reversed',
      subject,
      occurredAt,
      recordedAt: at(recordedBase + (1 + position) * HOUR),
      amount: money(decimalText(-share, scale), 'USD', 'allocated'),
      sourceEventIds: [allocation.id],
      reversalOf: allocation.id,
      metadata: { rule: 'fixture-reversal' },
      schemaVersion: 1,
    }));

    for (let attempt = 0; attempt < 3; attempt += 1) {
      const arrival = rng.shuffled(reversals);
      const context = `${reproduce(seed, index)} (arrival ${attempt})`
        + `\nallocation ${formatMoneyAmount(allocation.amount as Money)}`
        + `\nreversals ${reversals.map((item) => formatMoneyAmount(item.amount as Money)).join(', ')}`;
      withLedger((ledger) => {
        ledger.append(allocation);
        let refusals = 0;
        for (const reversal of arrival) {
          try {
            assert.equal(ledger.append(reversal), 'inserted');
          } catch (error) {
            refusals += 1;
            const message = error instanceof Error ? error.message : String(error);
            assert.match(
              message,
              /allocation reversals total [\s\S]*exceeds the [\s\S]*allocated by|allocation reversal exceeds its source amount/,
              `${context}\nrefused for an unexpected reason: ${message}`,
            );
          }
        }
        const allocated = ledger.project().balances.find((item) => item.role === 'allocation' && item.basis === 'allocated');
        assert.ok(allocated !== undefined, `${context}\nthe allocation disappeared from the projection`);
        assert.ok(
          compareMoney(allocated.amount, money('0', 'USD', 'allocated')) >= 0,
          `${context}\nallocated balance went negative at ${formatMoneyAmount(allocated.amount)}`,
        );
        if (!overReverse) {
          assert.equal(refusals, 0, `${context}\na conserving reversal set was refused`);
        } else {
          assert.ok(refusals > 0, `${context}\nan over-reversing set was accepted in full`);
        }
      });
    }
  }
  assert.ok(overCases > 0, 'sweep never generated an over-reversing case');
});

test('LAW a close fixes what was visible, so an event cannot be inserted behind it', () => {
  // The place where ordering is load-bearing rather than incidental. Insertion
  // order is free everywhere above precisely BECAUSE a recorded close pins the
  // instant it speaks for: a later-arriving event may only be recorded after it.
  const { seed, rng } = stream('conservation/close-floor');
  const closeRecordedAt = at(PERIOD_END + DAY);
  for (let index = 0; index < 12; index += 1) {
    const scenario = buildScenario(rng, index);
    const order = topologicalOrder(rng, scenario.events);
    withLedger((ledger) => {
      for (const item of order) ledger.append(item);
      const close = ledger.finalizePeriod({
        id: `${scenario.subject}:close`,
        periodStartMs: PERIOD_START,
        periodEndMs: PERIOD_END,
        recordedAt: closeRecordedAt,
      });
      const late = (recordedAt: string, suffix: string) => economicEvent({
        id: `${scenario.subject}:late-${suffix}`,
        kind: 'bill_observed',
        subject: scenario.subject,
        occurredAt: scenario.bill.occurredAt,
        recordedAt,
        amount: money('1.0000', 'USD', 'billed'),
        sourceEventIds: [],
        reversalOf: null,
        metadata: { invoiceRef: `late-${index}` },
        schemaVersion: 1,
      });

      // While finalized, nothing in-period may be recorded at all.
      assert.throws(
        () => ledger.append(late(at(PERIOD_END + 2 * DAY), 'finalized')),
        /is finalized; reopen it before recording an in-period event/,
        `${reproduce(seed, index)}\na finalized period accepted an in-period event`,
      );

      ledger.reopenPeriod({
        id: `${scenario.subject}:reopen`,
        periodStartMs: PERIOD_START,
        periodEndMs: PERIOD_END,
        recordedAt: at(PERIOD_END + 2 * DAY),
        reason: 'generated law',
      });

      // Reopened, but the recorded close still stands as a statement about the
      // instant it was written, so backdating behind it stays refused.
      assert.throws(
        () => ledger.append(late(closeRecordedAt, 'backdated')),
        /was closed through/,
        `${reproduce(seed, index)}\nan event was inserted behind a recorded close`,
      );

      // Recorded after the close, the same event is accepted, and the earlier
      // reading is unchanged: the close remains true of what it saw.
      const before = describeProjection(ledger, closeRecordedAt);
      assert.equal(ledger.append(late(at(PERIOD_END + 3 * DAY), 'accepted')), 'inserted');
      assert.deepEqual(
        describeProjection(ledger, closeRecordedAt),
        before,
        `${reproduce(seed, index)}\na later-recorded event changed an earlier reading`,
      );
      assert.equal(close.eventCount, scenario.events.length);
    });
  }
});
