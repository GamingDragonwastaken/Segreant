/**
 * A cap enforced against a figure the ledger has already superseded (WP-B01).
 *
 * THE DEFECT. `BudgetGuard.evaluate` asks the Store for an exact economic
 * projection and then throws it away whole:
 *
 *   const daySpend = exactDay !== null && exactDay.unresolvedRequests === 0
 *     ? exactNumber(exactDay.amount)
 *     : this.store.spendBetween(dayStart, dayEnd, liveOnly);
 *
 * One unresolved request in the window — a request in flight, a model with no
 * rate-card match, a row whose charge event has not been written yet — reverts
 * the whole day to `SUM(cost_usd)` off the requests table. Those are not two
 * spellings of one number. The exact projection sums EFFECTIVE economic charges,
 * so it carries every correction the economic ledger has recorded; the float
 * column carries the estimate written when the request was logged and is never
 * revised. Reprice a day upward and the two disagree by exactly the correction.
 *
 * So the cap can be evaded, and in the direction that matters. With $30 of
 * resolved effective charges against a $25 cap, one unpriced request drops the
 * guard back to a stale $10 and it returns `allow` — while Fiscus's own ledger,
 * in the same call, has already resolved more than the cap. That is
 * enforcement failing OPEN, which is the one direction hard rule 5 forbids.
 *
 * WHAT REPLACES IT. A partial projection is not a reason to disbelieve the part
 * that resolved: unresolved requests can only ADD spend, so the resolved sum is
 * a lower bound on the window. Neither figure dominates the other — the float
 * covers every request at rate-card estimate, the exact covers some requests at
 * corrected value — so when the projection is incomplete the guard enforces
 * against the larger of the two, which is the fail-closed reading, and says so.
 * When the projection IS complete it stays authoritative on its own, because
 * over-blocking on a stale float would be its own defect.
 *
 * AND THE FIGURE NOW CARRIES ITS BASIS. `GuardDecision` reported
 * `daySpendUsd: number` whichever projection produced it, and the 429 body the
 * developer's tool receives said `$30.00 of $25.00 cap` with no basis at all.
 * This is the boundary where a spend figure becomes a control action that stops
 * work, and the product's first rule is that a figure states where it came from.
 * Recorded at D-107.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BudgetGuard } from '../src/budget/guard.ts';
import { money } from '../src/economics/money.ts';
import { DEFAULT_CONFIG, type BudgetConfig } from '../src/config.ts';
import { Store, type ExactSpendProjection } from '../src/store/db.ts';
import { buildOverview } from '../src/dashboard/routes.ts';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function projection(amountUsd: string, unresolved: number, requests: number): ExactSpendProjection {
  return {
    amount: money(amountUsd, 'USD', 'effective'),
    eventIds: ['event:1'],
    sourceBases: ['list'],
    requestCount: requests,
    unresolvedRequests: unresolved,
  };
}

/** Only what the guard actually calls. Float and exact are set independently, which is the point. */
function stubStore(opts: {
  exactDay: ExactSpendProjection | null;
  floatDay: number;
  exactWindow?: ExactSpendProjection | null;
  floatWindow?: number;
}): Store {
  return {
    exactSpendBetween: () => opts.exactDay,
    spendBetween: () => opts.floatDay,
    exactSpendInWindow: () => opts.exactWindow ?? projection('0', 0, 0),
    spendInWindow: () => ({ costUsd: opts.floatWindow ?? 0, requests: 0 }),
    spendForSession: () => 0,
  } as unknown as Store;
}

function budget(over: Partial<BudgetConfig>): BudgetConfig {
  return { ...structuredClone(DEFAULT_CONFIG).budget, ...over };
}

test('a single unpriced request cannot revert the cap to a figure the ledger has superseded', () => {
  // $30 of resolved effective charges, one request still unpriced, and a stale
  // float of $10. The old guard returned `allow` on the $10.
  const guard = new BudgetGuard(
    stubStore({ exactDay: projection('30.00', 1, 4), floatDay: 10 }),
    budget({ dailyUsd: 25 }),
  );
  const decision = guard.evaluate({ nowMs: Date.parse('2026-08-02T12:00:00.000Z') });
  assert.equal(decision.action, 'block', 'resolved charges already exceed the cap; allowing is failing open');
  assert.equal(decision.daySpendUsd, 30);
});

test('the enforced figure says which projection produced it and how complete it was', () => {
  const guard = new BudgetGuard(
    stubStore({ exactDay: projection('30.00', 1, 4), floatDay: 10 }),
    budget({ dailyUsd: 25 }),
  );
  const basis = guard.evaluate({ nowMs: Date.parse('2026-08-02T12:00:00.000Z') }).dayBasis;
  assert.equal(basis.enforcedAgainst, 'exact_effective');
  assert.equal(basis.complete, false);
  assert.equal(basis.exactResolvedUsd, 30);
  assert.equal(basis.floatUsd, 10);
  assert.equal(basis.unresolvedRequests, 1);
  assert.deepEqual(basis.sourceBases, ['list']);
});

test('the block a developer receives names the basis, not just the number', () => {
  const guard = new BudgetGuard(
    stubStore({ exactDay: projection('30.00', 1, 4), floatDay: 10 }),
    budget({ dailyUsd: 25 }),
  );
  const reason = guard.evaluate({ nowMs: Date.parse('2026-08-02T12:00:00.000Z') }).reason ?? '';
  assert.match(reason, /\$30\.00 of \$25\.00/);
  assert.match(reason, /lower bound|at least|1 request/i, 'an incomplete figure must say it is incomplete');
});

test('a complete exact projection stays authoritative and is NOT raised by a stale float', () => {
  // THE GUARD-RAIL IN THE OTHER DIRECTION. Taking the maximum unconditionally
  // would let a superseded rate-card estimate over-block a day the economic
  // ledger has already corrected DOWNWARD — a refund, a repricing, a corrected
  // charge. Completeness is what makes the exact figure authoritative.
  const guard = new BudgetGuard(
    stubStore({ exactDay: projection('10.00', 0, 4), floatDay: 30 }),
    budget({ dailyUsd: 25 }),
  );
  const decision = guard.evaluate({ nowMs: Date.parse('2026-08-02T12:00:00.000Z') });
  assert.equal(decision.action, 'allow', 'a complete exact projection is the answer, not an input to a maximum');
  assert.equal(decision.daySpendUsd, 10);
  assert.equal(decision.dayBasis.enforcedAgainst, 'exact_effective');
  assert.equal(decision.dayBasis.complete, true);
});

test('a Store with no exact projection at all still enforces, and says the basis is unverified', () => {
  // THE OTHER GUARD-RAIL. `exactSpendBetween` is an optional Store method and
  // the fallback must keep working rather than becoming an unmetered path.
  const guard = new BudgetGuard(
    { spendBetween: () => 30, spendInWindow: () => ({ costUsd: 0, requests: 0 }), spendForSession: () => 0 } as unknown as Store,
    budget({ dailyUsd: 25 }),
  );
  const decision = guard.evaluate({ nowMs: Date.parse('2026-08-02T12:00:00.000Z') });
  assert.equal(decision.action, 'block');
  assert.equal(decision.dayBasis.enforcedAgainst, 'rate_card_float');
  assert.equal(decision.dayBasis.exactResolvedUsd, null);
  assert.deepEqual(decision.dayBasis.sourceBases, []);
});

test('the dashboard budget bar agrees with the blocker, because it resolves the figure the same way', () => {
  // `buildOverview` carries the comment "a bar that disagrees with the blocker
  // is a lie" directly above the line that read the raw float while the guard
  // read the exact projection. The invariant was stated and then not held: with
  // $30 resolved against a $25 cap, the panel showed $10 spent and $15 remaining
  // while the guard blocked.
  // A real empty Store supplies every other accessor the overview needs; only
  // the two spend readings are planted, which is the whole of the case.
  const dir = mkdtempSync(join(tmpdir(), 'fiscus-budget-bar-'));
  const real = new Store(join(dir, 'bar.db'));
  try {
    const store: Store = Object.create(real, {
      exactSpendBetween: { value: () => projection('30.00', 1, 4) },
      spendBetween: { value: () => 10 },
    });
    const config = structuredClone(DEFAULT_CONFIG);
    config.budget = budget({ dailyUsd: 25 });
    const overview = buildOverview(store, config, 'today');
    assert.equal(overview.budget.todaySpendUsd, 30);
    assert.equal(overview.budget.remainingDailyUsd, 0);
    assert.equal(overview.budget.todaySpendBasis.enforcedAgainst, 'exact_effective');
    assert.equal(overview.budget.todaySpendBasis.complete, false);

    const guard = new BudgetGuard(store, config.budget);
    assert.equal(guard.evaluate().daySpendUsd, overview.budget.todaySpendUsd, 'the bar and the blocker must read one figure');
  } finally {
    real.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
