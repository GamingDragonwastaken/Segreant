/**
 * Budget enforcement.
 *
 * Honest scope: a proxy cannot know a request's final cost before it runs (the
 * output token count is unknown until the model answers). So the guard enforces
 * what it genuinely can:
 *   1. Hard daily cap  — block once today's spend is already at/over the cap.
 *   2. Hard session cap — block once a session's spend is already at/over.
 *   3. Runaway velocity — block when spend inside a short sliding window spikes,
 *      which is the signature of an agent stuck in an unattended loop.
 *   4. Soft daily threshold — allow, but flag a warning the proxy surfaces in a
 *      response header so the developer sees it without being interrupted.
 *
 * Caps are opt-in (null = off) so the default install never blocks anything.
 */

import type { ExactSpendProjection, Store } from '../store/db.ts';
import { decimalStringFromNumber, exactBudgetCaps, type BudgetConfig } from '../config.ts';
import {
  compareMoney,
  formatMoneyAmount,
  money,
  subtractMoney,
  type EconomicBasis,
  type Money,
} from '../economics/money.ts';

export type GuardAction = 'allow' | 'warn' | 'block';

/** Which of the two figures the guard actually enforced against. */
export type EnforcementProjection = 'exact_effective' | 'rate_card_float';

/**
 * Where an enforced spend figure came from, carried alongside the figure.
 *
 * A cap turns a number into a control action that stops a developer's work, so
 * this is the boundary at which "every figure carries its basis" matters most.
 * The two projections are not two spellings of one number: `exact_effective`
 * sums EFFECTIVE economic charges and therefore carries every correction the
 * economic ledger has recorded, while `rate_card_float` is `SUM(cost_usd)` off
 * the requests table — the estimate written when each request was logged, and
 * never revised.
 */
export interface SpendBasis {
  readonly enforcedAgainst: EnforcementProjection;
  /** Effective economic charges for requests whose charge resolved. Null when the Store offers no exact projection. */
  readonly exactResolvedUsd: number | null;
  /** The unrevised rate-card sum over the same window. */
  readonly floatUsd: number;
  /** Requests in the window with no resolved charge; non-zero makes the exact sum a LOWER bound. Null when unknown. */
  readonly unresolvedRequests: number | null;
  /** Requests in the window. Null when unknown. */
  readonly requestCount: number | null;
  /** Economic bases contributing to the exact sum. Empty on the float path, which declares none. */
  readonly sourceBases: readonly EconomicBasis[];
  /** True only when an exact projection covered every request in the window. */
  readonly complete: boolean;
}

export interface GuardDecision {
  action: GuardAction;
  reason: string | null;
  daySpendUsd: number;
  dailyLimitUsd: number | null;
  remainingDailyUsd: number | null;
  sessionSpendUsd: number | null;
  softTripped: boolean;
  runaway: { tripped: boolean; windowCostUsd: number; windowSec: number };
  /** Basis of `daySpendUsd`. */
  dayBasis: SpendBasis;
  /** Basis of `sessionSpendUsd`, or null when no session was supplied. */
  sessionBasis: SpendBasis | null;
  /** Basis of `runaway.windowCostUsd`. */
  windowBasis: SpendBasis;
}

/**
 * A spend figure resolved for enforcement.
 *
 * `enforced` is what the caps are compared against and is exact. `usd` is the
 * same amount projected onto a double for the wire payload and the refusal text;
 * it is REPORTING, and nothing decides on it.
 */
export interface EnforcedSpend {
  readonly usd: number;
  readonly enforced: Money;
  readonly basis: SpendBasis;
}

/**
 * The economic basis of the rate-card float column.
 *
 * `requests.cost_usd` is the estimate written when the request was logged and
 * never revised, which is exactly what `estimated` denotes.
 */
const RATE_CARD_BASIS: EconomicBasis = 'estimated';

/**
 * The float column as exact `Money`.
 *
 * `cost_usd` is a binary double, so it is read as the decimal it was written to
 * mean — its shortest round-trip representation — by the same total conversion
 * the caps go through. A float column that cannot be read that way (NaN from a
 * corrupt aggregate, say) throws, and the guard fails closed with it.
 */
function rateCardMoney(floatUsd: number): Money {
  return money(decimalStringFromNumber(floatUsd, 'budget rate-card spend'), 'USD', RATE_CARD_BASIS);
}

/**
 * Order two USD figures that may carry different economic bases.
 *
 * `compareMoney` refuses a cross-basis comparison, and rightly: billed dollars
 * are not allocated dollars merely because both are USD. But enforcement has two
 * deliberate cross-basis ORDERINGS, and both were policy before this function
 * existed — the max-of-two-floors in `resolveEnforcedSpend`, and every cap
 * comparison, since a cap is a policy threshold with no economic basis of its
 * own. Ordering is not addition: nothing here produces a figure, and the value
 * that wins keeps the basis it arrived with, which `SpendBasis.enforcedAgainst`
 * then reports. So the right-hand side is re-labelled to the left-hand basis for
 * the comparison only — a lossless decimal round-trip — and `compareMoney` does
 * the arithmetic exactly.
 */
function compareEnforcedUsd(spend: Money, other: Money): -1 | 0 | 1 {
  if (spend.currency !== 'USD' || other.currency !== 'USD') {
    throw new Error(`budget enforcement compares USD only: ${spend.currency} vs ${other.currency}`);
  }
  return compareMoney(spend, money(formatMoneyAmount(other), 'USD', spend.basis));
}

/** The basis of a figure taken from the float column alone — no exact projection existed. */
export function unverifiedBasis(floatUsd: number): SpendBasis {
  return {
    enforcedAgainst: 'rate_card_float',
    exactResolvedUsd: null,
    floatUsd,
    unresolvedRequests: null,
    requestCount: null,
    sourceBases: [],
    complete: false,
  };
}

/**
 * Choose the figure a cap is enforced against, and say which it is.
 *
 * A PARTIAL PROJECTION IS NOT A REASON TO DISBELIEVE THE PART THAT RESOLVED.
 * The guard used to discard the whole exact projection whenever a single request
 * in the window was unpriced, reverting to the float. That fails OPEN: with $30
 * of resolved effective charges against a $25 cap, one unpriced request dropped
 * enforcement back to a stale $10 and the request was allowed, while the ledger
 * consulted in the same call had already resolved more than the cap. Hard rule 5
 * forbids exactly that direction.
 *
 * Unresolved requests can only ADD spend, so the resolved sum is a lower bound
 * on the window. Neither figure dominates: the float covers every request at
 * rate-card estimate, the exact covers some requests at corrected value. So when
 * the projection is incomplete the guard takes the LARGER, which is the
 * fail-closed reading of two floors.
 *
 * A COMPLETE PROJECTION IS AUTHORITATIVE ON ITS OWN, and deliberately not an
 * input to that maximum. Taking the maximum unconditionally would let a
 * superseded rate-card estimate over-block a day the economic ledger has already
 * corrected downward — a refund, a repricing — which is its own defect in the
 * other direction.
 */
export function resolveEnforcedSpend(
  exact: ExactSpendProjection | null,
  floatUsd: number,
): EnforcedSpend {
  const floatMoney = rateCardMoney(floatUsd);
  if (exact === null) {
    return { usd: floatUsd, enforced: floatMoney, basis: unverifiedBasis(floatUsd) };
  }
  const exactUsd = exactNumber(exact.amount);
  const shared = {
    exactResolvedUsd: exactUsd,
    floatUsd,
    unresolvedRequests: exact.unresolvedRequests,
    requestCount: exact.requestCount,
    sourceBases: exact.sourceBases,
  };
  if (exact.unresolvedRequests === 0) {
    return {
      usd: exactUsd,
      enforced: exact.amount,
      basis: { ...shared, enforcedAgainst: 'exact_effective', complete: true },
    };
  }
  // The larger of two floors, ordered exactly. Ties go to the exact projection:
  // the two floors are then the same amount, and the ledger is the better thing
  // to name as having bound the decision.
  const exactIsAtLeastFloat = compareEnforcedUsd(exact.amount, floatMoney) >= 0;
  return exactIsAtLeastFloat
    ? {
      usd: exactUsd,
      enforced: exact.amount,
      basis: { ...shared, enforcedAgainst: 'exact_effective', complete: false },
    }
    : {
      usd: floatUsd,
      enforced: floatMoney,
      basis: { ...shared, enforcedAgainst: 'rate_card_float', complete: false },
    };
}

/** One clause naming the basis, appended to whatever refusal or warning states the number. */
export function describeSpendBasis(basis: SpendBasis): string {
  if (basis.enforcedAgainst === 'rate_card_float' && basis.exactResolvedUsd === null) {
    return 'Basis: local rate-card estimates, with no exact economic projection available.';
  }
  const bases = basis.sourceBases.length > 0 ? basis.sourceBases.join(', ') : 'none declared';
  if (basis.complete) return `Basis: effective economic charges (${bases}), complete for this window.`;
  const which = basis.enforcedAgainst === 'exact_effective'
    ? `effective economic charges (${bases})`
    : 'local rate-card estimates';
  return `Basis: ${which}, a lower bound — ${basis.unresolvedRequests} of ${basis.requestCount} requests in this window are unpriced.`;
}

export function startOfLocalDay(now: number = Date.now()): number {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

export function endOfLocalDay(now: number = Date.now()): number {
  return startOfLocalDay(now) + 24 * 60 * 60 * 1000;
}

/**
 * Project an exact amount onto a double, for REPORTING ONLY.
 *
 * `GuardDecision` is a wire payload — the proxy puts these figures in a 429 body
 * and the dashboard reads them — and its numeric fields are part of a contract
 * this packet does not change. So the projection survives, but nothing decides
 * on its result any more: every cap comparison and the max-of-two-floors run on
 * `Money` through `compareEnforcedUsd`. It stays lossy by construction, which is
 * why it must not move back onto the decision path.
 */
function exactNumber(value: Money): number {
  if (value.currency !== 'USD') throw new Error('budget exact projection must be USD');
  const number = Number(formatMoneyAmount(value));
  if (!Number.isFinite(number)) throw new Error('budget exact projection exceeds numeric decision range');
  return number;
}

export class BudgetGuard {
  private readonly store: Store;
  private readonly getConfig: () => BudgetConfig;

  /**
   * A function keeps a long-running proxy aligned with deliberate runtime
   * settings edits. Passing a BudgetConfig directly remains supported for CLI
   * and unit callers that have an immutable configuration snapshot.
   */
  constructor(store: Store, cfg: BudgetConfig | (() => BudgetConfig)) {
    this.store = store;
    this.getConfig = typeof cfg === 'function' ? cfg : () => cfg;
  }

  evaluate(opts: { sessionId?: string | null; nowMs?: number } = {}): GuardDecision {
    const cfg = this.getConfig();
    // Before anything is read: the caps must be readable as exact money. A cap
    // that is not is a configuration failure, and it stops the request here
    // rather than being quietly dropped from the comparison.
    const caps = exactBudgetCaps(cfg);
    const now = opts.nowMs ?? Date.now();
    const dayStart = startOfLocalDay(now);
    const dayEnd = endOfLocalDay(now);
    // Enforcement basis: by default only LIVE proxy spend counts — a cap can only
    // block live traffic, and imported subscription spend tripping it froze a
    // proxy that had spent almost nothing (dogfood). capIncludesImported opts
    // into governing total observed spend instead.
    const liveOnly = !cfg.capIncludesImported;
    const exactDay = typeof this.store.exactSpendBetween === 'function'
      ? this.store.exactSpendBetween(dayStart, dayEnd, liveOnly)
      : null;
    const day = resolveEnforcedSpend(exactDay, this.store.spendBetween(dayStart, dayEnd, liveOnly));
    const daySpend = day.usd;

    const dailyLimit = cfg.dailyUsd;
    // Headroom is subtracted exactly too, then projected for the payload. It is
    // derived from the enforced figure, so computing it on floats would leave
    // exact state for a float one step after the decision refused to.
    const remainingDaily = caps.dailyUsd === null
      ? null
      : compareEnforcedUsd(day.enforced, caps.dailyUsd) >= 0
        ? 0
        : exactNumber(subtractMoney(
          money(formatMoneyAmount(caps.dailyUsd), 'USD', day.enforced.basis),
          day.enforced,
        ));

    const exactSession = opts.sessionId && typeof this.store.exactSpendForSession === 'function'
      ? this.store.exactSpendForSession(opts.sessionId, liveOnly)
      : null;
    const session = opts.sessionId
      ? resolveEnforcedSpend(exactSession, this.store.spendForSession(opts.sessionId, liveOnly))
      : null;
    const sessionSpend = session === null ? null : session.usd;

    const windowMs = cfg.runawayWindowSec * 1000;
    const exactWindow = typeof this.store.exactSpendInWindow === 'function'
      ? this.store.exactSpendInWindow(now, windowMs, liveOnly)
      : null;
    const floatWindow = this.store.spendInWindow(now, windowMs, liveOnly);
    const windowSpend = resolveEnforcedSpend(exactWindow, floatWindow.costUsd);
    const window = {
      costUsd: windowSpend.usd,
      requests: exactWindow !== null && exactWindow.unresolvedRequests === 0
        ? exactWindow.requestCount
        : floatWindow.requests,
    };
    const runawayTripped =
      caps.runawayMaxUsd !== null && compareEnforcedUsd(windowSpend.enforced, caps.runawayMaxUsd) >= 0;

    const softTripped =
      caps.dailySoftUsd !== null && compareEnforcedUsd(day.enforced, caps.dailySoftUsd) >= 0;

    const base = {
      daySpendUsd: daySpend,
      dailyLimitUsd: dailyLimit,
      remainingDailyUsd: remainingDaily,
      sessionSpendUsd: sessionSpend,
      softTripped,
      runaway: { tripped: runawayTripped, windowCostUsd: window.costUsd, windowSec: cfg.runawayWindowSec },
      dayBasis: day.basis,
      sessionBasis: session === null ? null : session.basis,
      windowBasis: windowSpend.basis,
    };

    // Hard blocks first — precedence matters. Each comparison is exact; the
    // figures in the refusal text are the projections of the same amounts.
    if (caps.dailyUsd !== null && compareEnforcedUsd(day.enforced, caps.dailyUsd) >= 0) {
      return {
        ...base,
        action: 'block',
        reason:
          `Daily budget reached: $${daySpend.toFixed(2)} of $${dailyLimit!.toFixed(2)} cap` +
          (liveOnly ? ' (live proxy spend; imported spend excluded). ' : ' (includes imported spend). ') +
          describeSpendBasis(day.basis),
      };
    }
    if (caps.sessionUsd !== null && session !== null && compareEnforcedUsd(session.enforced, caps.sessionUsd) >= 0) {
      return {
        ...base,
        action: 'block',
        reason: `Session budget reached: $${session.usd.toFixed(2)} of $${cfg.sessionUsd!.toFixed(2)} cap. `
          + describeSpendBasis(session.basis),
      };
    }
    if (runawayTripped) {
      return {
        ...base,
        action: 'block',
        reason: `Runaway loop guard: $${window.costUsd.toFixed(2)} spent in the last ${cfg.runawayWindowSec}s exceeds the $${cfg.runawayMaxUsd!.toFixed(2)} threshold. `
          + describeSpendBasis(windowSpend.basis),
      };
    }
    if (softTripped) {
      return {
        ...base,
        action: 'warn',
        reason: `Soft daily threshold passed: $${daySpend.toFixed(2)} of $${cfg.dailySoftUsd!.toFixed(2)}. `
          + describeSpendBasis(day.basis),
      };
    }
    return { ...base, action: 'allow', reason: null };
  }
}
