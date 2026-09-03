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
import type { BudgetConfig } from '../config.ts';
import { formatMoneyAmount, type EconomicBasis, type Money } from '../economics/money.ts';

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
): { usd: number; basis: SpendBasis } {
  if (exact === null) return { usd: floatUsd, basis: unverifiedBasis(floatUsd) };
  const exactUsd = exactNumber(exact.amount);
  const shared = {
    exactResolvedUsd: exactUsd,
    floatUsd,
    unresolvedRequests: exact.unresolvedRequests,
    requestCount: exact.requestCount,
    sourceBases: exact.sourceBases,
  };
  if (exact.unresolvedRequests === 0) {
    return { usd: exactUsd, basis: { ...shared, enforcedAgainst: 'exact_effective', complete: true } };
  }
  const enforced = Math.max(exactUsd, floatUsd);
  return {
    usd: enforced,
    basis: {
      ...shared,
      enforcedAgainst: enforced > floatUsd || exactUsd === floatUsd ? 'exact_effective' : 'rate_card_float',
      complete: false,
    },
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
    const remainingDaily = dailyLimit === null ? null : Math.max(0, dailyLimit - daySpend);

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
      cfg.runawayMaxUsd !== null && window.costUsd >= cfg.runawayMaxUsd;

    const softTripped =
      cfg.dailySoftUsd !== null && daySpend >= cfg.dailySoftUsd;

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

    // Hard blocks first — precedence matters.
    if (dailyLimit !== null && daySpend >= dailyLimit) {
      return {
        ...base,
        action: 'block',
        reason:
          `Daily budget reached: $${daySpend.toFixed(2)} of $${dailyLimit.toFixed(2)} cap` +
          (liveOnly ? ' (live proxy spend; imported spend excluded). ' : ' (includes imported spend). ') +
          describeSpendBasis(day.basis),
      };
    }
    if (cfg.sessionUsd !== null && sessionSpend !== null && sessionSpend >= cfg.sessionUsd) {
      return {
        ...base,
        action: 'block',
        reason: `Session budget reached: $${sessionSpend.toFixed(2)} of $${cfg.sessionUsd.toFixed(2)} cap. `
          + describeSpendBasis(session!.basis),
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
