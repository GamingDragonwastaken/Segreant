/**
 * The guard that stops work must compare exactly (WP-C01 remainder / AII-017).
 *
 * `BudgetGuard` reads an EXACT `Money` projection out of the economic ledger,
 * reports its basis honestly in `SpendBasis`, and then — to decide — projects
 * that exact value onto a JS double (`exactNumber`) and compares the double
 * against a double cap from configuration. So the guard's RECORD of what it
 * enforced against was more precise than the ACT of enforcing. This is the one
 * decision path in the money layer with a control action attached: a cap is the
 * thing that stops a developer's work.
 *
 * These tests pin the COMPARISON, not the policy. Which caps exist, their
 * precedence, and what happens on a breach are all unchanged.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BudgetGuard, resolveEnforcedSpend } from '../src/budget/guard.ts';
import { addMoney, formatMoneyAmount, money, type Money } from '../src/economics/money.ts';
import { DEFAULT_CONFIG, type BudgetConfig } from '../src/config.ts';
import type { ExactSpendProjection, Store } from '../src/store/db.ts';

const NOON = Date.parse('2026-08-02T12:00:00.000Z');

function projection(amount: Money | string, unresolved: number, requests: number): ExactSpendProjection {
  return {
    amount: typeof amount === 'string' ? money(amount, 'USD', 'effective') : amount,
    eventIds: ['event:1'],
    sourceBases: ['list'],
    requestCount: requests,
    unresolvedRequests: unresolved,
  };
}

/** Only what the guard actually calls; exact and float projections are set independently. */
function stubStore(opts: {
  exactDay?: ExactSpendProjection | null;
  floatDay?: number;
  exactWindow?: ExactSpendProjection | null;
  floatWindow?: number;
  exactSession?: ExactSpendProjection | null;
  floatSession?: number;
}): Store {
  return {
    exactSpendBetween: () => opts.exactDay ?? projection('0', 0, 0),
    spendBetween: () => opts.floatDay ?? 0,
    exactSpendInWindow: () => opts.exactWindow ?? projection('0', 0, 0),
    spendInWindow: () => ({ costUsd: opts.floatWindow ?? 0, requests: 0 }),
    exactSpendForSession: () => opts.exactSession ?? projection('0', 0, 0),
    spendForSession: () => opts.floatSession ?? 0,
    upsertSession: () => undefined,
  } as unknown as Store;
}

function budget(over: Partial<BudgetConfig>): BudgetConfig {
  return { ...structuredClone(DEFAULT_CONFIG).budget, ...over };
}

/**
 * A day of charges whose EXACT total is a hair under the cap.
 *
 * Three requests, each charged one third of a $25 batch at the ledger's own
 * scale: $8.333333333333333. Their exact sum is $24.999999999999999 — one part
 * in 10^15 short of $25, which is a real remainder, not a rounding artefact.
 *
 * What makes the two projections disagree is the spacing of binary doubles at
 * that magnitude. Adjacent doubles near 25 are 2^-48 apart (~3.55e-15), so
 * $24.999999999999999 is nearer to 25.0 than to the double below it and
 * `Number('24.999999999999999')` is EXACTLY 25. Compared as floats, a day the
 * ledger says is under the cap reads as having reached it.
 */
function threeThirdsOfTwentyFive(): { exact: Money; floatSum: number } {
  const third = money('8.333333333333333', 'USD', 'effective');
  const exact = addMoney(addMoney(third, third), third);
  const floatSum = 8.333333333333333 + 8.333333333333333 + 8.333333333333333;
  return { exact, floatSum };
}

test('exact comparison: the ledger sum, not its float projection, decides a day below the cap', () => {
  const { exact, floatSum } = threeThirdsOfTwentyFive();
  assert.equal(formatMoneyAmount(exact), '24.999999999999999');
  assert.equal(Number(formatMoneyAmount(exact)), 25, 'precondition: the float projection reaches the cap');

  const guard = new BudgetGuard(
    stubStore({ exactDay: projection(exact, 0, 3), floatDay: floatSum }),
    budget({ dailyUsd: 25, dailySoftUsd: null, sessionUsd: null, runawayMaxUsd: null }),
  );
  const decision = guard.evaluate({ nowMs: NOON });
  assert.equal(
    decision.action,
    'allow',
    'the exact charges total $24.999999999999999, which is below the $25 cap; only the float projection reaches it',
  );
});

test('exact comparison: the same day one thousandth of a cent over the cap still blocks', () => {
  // The mirror of the case above, and the one that must never regress. Its exact
  // total is strictly ABOVE the cap while its float projection lands exactly ON
  // the cap: `Number('25.000000000000001')` is 25.
  //
  // Worth stating plainly: this direction is not currently reachable as a
  // fail-OPEN. `Number()` rounds to nearest, rounding to nearest is monotone,
  // and the cap is read through its own shortest round-trip decimal — so an
  // exact value at or above the cap can never project onto a double below the
  // cap's double. The float comparison could only ever over-block. The test pins
  // the direction anyway: a future conversion that truncated instead of rounding
  // would open it, and this is the guard whose failure mode must be closed.
  assert.equal(Number('25.000000000000001'), 25);
  const guard = new BudgetGuard(
    stubStore({ exactDay: projection('25.000000000000001', 0, 3), floatDay: 25 }),
    budget({ dailyUsd: 25, dailySoftUsd: null, sessionUsd: null, runawayMaxUsd: null }),
  );
  assert.equal(guard.evaluate({ nowMs: NOON }).action, 'block');
});

test('exact comparison: a spend exactly equal to the cap trips every one of the four thresholds', () => {
  // $0.1 is not representable in binary; the point here is that exactness must
  // not quietly turn `>=` into `>` at the boundary on any threshold.
  const daily = new BudgetGuard(
    stubStore({ exactDay: projection('0.1', 0, 1), floatDay: 0.1 }),
    budget({ dailyUsd: 0.1, dailySoftUsd: null, sessionUsd: null, runawayMaxUsd: null }),
  ).evaluate({ nowMs: NOON });
  assert.equal(daily.action, 'block');
  assert.match(daily.reason ?? '', /Daily budget reached/);

  const session = new BudgetGuard(
    stubStore({ exactSession: projection('0.1', 0, 1), floatSession: 0.1 }),
    budget({ dailyUsd: null, dailySoftUsd: null, sessionUsd: 0.1, runawayMaxUsd: null }),
  ).evaluate({ nowMs: NOON, sessionId: 's-1' });
  assert.equal(session.action, 'block');
  assert.match(session.reason ?? '', /Session budget reached/);

  const runaway = new BudgetGuard(
    stubStore({ exactWindow: projection('0.1', 0, 1), floatWindow: 0.1 }),
    budget({ dailyUsd: null, dailySoftUsd: null, sessionUsd: null, runawayMaxUsd: 0.1 }),
  ).evaluate({ nowMs: NOON });
  assert.equal(runaway.action, 'block');
  assert.match(runaway.reason ?? '', /Runaway loop guard/);

  const soft = new BudgetGuard(
    stubStore({ exactDay: projection('0.1', 0, 1), floatDay: 0.1 }),
    budget({ dailyUsd: null, dailySoftUsd: 0.1, sessionUsd: null, runawayMaxUsd: null }),
  ).evaluate({ nowMs: NOON });
  assert.equal(soft.action, 'warn');
  assert.equal(soft.softTripped, true);
});

test('exact comparison: a cap that cannot be read as exact money BLOCKS, it does not become "no limit"', () => {
  // Hard rule 5. `validateBudgetConfig` rejects these at the persistence and
  // load boundaries, but `BudgetGuard` also accepts a `BudgetConfig` handed to
  // it directly, and a configuration that reached the guard unvalidated must
  // stop provider forwarding rather than silently become an unmetered path.
  //
  // The guard's fail-closed contract is to THROW: `handle()` in
  // src/proxy/server.ts catches anything out of `guard.evaluate()`, latches
  // `state.accountingFailure`, and answers 503 `budget_enforcement_unavailable`
  // without forwarding. Returning `allow` is the one outcome that must be
  // impossible.
  const unreadable: Array<[string, Partial<BudgetConfig>]> = [
    ['daily cap NaN', { dailyUsd: Number.NaN }],
    ['daily cap Infinity', { dailyUsd: Number.POSITIVE_INFINITY }],
    ['soft threshold NaN', { dailySoftUsd: Number.NaN }],
    ['session cap NaN', { sessionUsd: Number.NaN }],
    ['runaway cap NaN', { runawayMaxUsd: Number.NaN }],
    ['daily cap is a string', { dailyUsd: '25' as unknown as number }],
  ];
  for (const [label, over] of unreadable) {
    const guard = new BudgetGuard(
      stubStore({ exactDay: projection('1000', 0, 1), floatDay: 1000 }),
      budget({ dailyUsd: null, dailySoftUsd: null, sessionUsd: null, runawayMaxUsd: null, ...over }),
    );
    let action: string | null = null;
    try {
      action = guard.evaluate({ nowMs: NOON, sessionId: 's-1' }).action;
    } catch {
      action = 'threw';
    }
    assert.equal(action, 'threw', `${label}: an unreadable cap must fail closed, never allow`);
  }
});

test('exact comparison: the incomplete-coverage maximum of two floors is unchanged', () => {
  // The rule at resolveEnforcedSpend: unresolved requests can only ADD spend, so
  // each figure is a lower bound and the guard takes the larger. Only the
  // comparison becomes exact; the rule and `enforcedAgainst` do not move.
  const exactWins = resolveEnforcedSpend(projection('30.00', 1, 4), 10);
  assert.equal(exactWins.usd, 30);
  assert.equal(exactWins.basis.enforcedAgainst, 'exact_effective');
  assert.equal(exactWins.basis.complete, false);

  const floatWins = resolveEnforcedSpend(projection('5.00', 1, 4), 10);
  assert.equal(floatWins.usd, 10);
  assert.equal(floatWins.basis.enforcedAgainst, 'rate_card_float');
  assert.equal(floatWins.basis.complete, false);

  const tie = resolveEnforcedSpend(projection('10.00', 1, 4), 10);
  assert.equal(tie.usd, 10);
  assert.equal(tie.basis.enforcedAgainst, 'exact_effective');

  const complete = resolveEnforcedSpend(projection('5.00', 0, 4), 10);
  assert.equal(complete.usd, 5);
  assert.equal(complete.basis.enforcedAgainst, 'exact_effective');
  assert.equal(complete.basis.complete, true);

  const none = resolveEnforcedSpend(null, 10);
  assert.equal(none.usd, 10);
  assert.equal(none.basis.enforcedAgainst, 'rate_card_float');
  assert.equal(none.basis.exactResolvedUsd, null);
});

test('exact comparison: enforcedAgainst names the side that actually bound the decision', () => {
  // $0.29999999999999999 of resolved effective charges against a rate-card float
  // of $0.30, with one request still unpriced. The exact floor is STRICTLY
  // SMALLER than the float floor, so the float is what bounds the window and
  // `enforcedAgainst` must say `rate_card_float`.
  //
  // Projected onto doubles the two are indistinguishable —
  // `Number('0.29999999999999999') === 0.3` — so the float comparison took the
  // equality branch and reported `exact_effective`: the guard claimed to have
  // enforced against the economic ledger when the ledger's own figure was
  // lower than the number it enforced. That is `SpendBasis` telling the
  // operator something untrue about which evidence stopped their work.
  assert.equal(Number('0.29999999999999999'), 0.3, 'precondition: the two floors collapse onto one double');

  const resolved = resolveEnforcedSpend(projection('0.29999999999999999', 1, 4), 0.3);
  assert.equal(resolved.basis.enforcedAgainst, 'rate_card_float');
  assert.equal(resolved.usd, 0.3);
});
