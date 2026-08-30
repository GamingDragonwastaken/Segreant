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

import type { Store } from '../store/db.ts';
import type { BudgetConfig } from '../config.ts';
import { formatMoneyAmount, type Money } from '../economics/money.ts';

export type GuardAction = 'allow' | 'warn' | 'block';

export interface GuardDecision {
  action: GuardAction;
  reason: string | null;
  daySpendUsd: number;
  dailyLimitUsd: number | null;
  remainingDailyUsd: number | null;
  sessionSpendUsd: number | null;
  softTripped: boolean;
  runaway: { tripped: boolean; windowCostUsd: number; windowSec: number };
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
    const daySpend = exactDay !== null && exactDay.unresolvedRequests === 0
      ? exactNumber(exactDay.amount)
      : this.store.spendBetween(dayStart, dayEnd, liveOnly);

    const dailyLimit = cfg.dailyUsd;
    const remainingDaily = dailyLimit === null ? null : Math.max(0, dailyLimit - daySpend);

    const exactSession = opts.sessionId && typeof this.store.exactSpendForSession === 'function'
      ? this.store.exactSpendForSession(opts.sessionId, liveOnly)
      : null;
    const sessionSpend = opts.sessionId
      ? exactSession !== null && exactSession.unresolvedRequests === 0
        ? exactNumber(exactSession.amount)
        : this.store.spendForSession(opts.sessionId, liveOnly)
      : null;

    const windowMs = cfg.runawayWindowSec * 1000;
    const exactWindow = typeof this.store.exactSpendInWindow === 'function'
      ? this.store.exactSpendInWindow(now, windowMs, liveOnly)
      : null;
    const window = exactWindow !== null && exactWindow.unresolvedRequests === 0
      ? { costUsd: exactNumber(exactWindow.amount), requests: exactWindow.requestCount }
      : this.store.spendInWindow(now, windowMs, liveOnly);
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
    };

    // Hard blocks first — precedence matters.
    if (dailyLimit !== null && daySpend >= dailyLimit) {
      return {
        ...base,
        action: 'block',
        reason:
          `Daily budget reached: $${daySpend.toFixed(2)} of $${dailyLimit.toFixed(2)} cap` +
          (liveOnly ? ' (live proxy spend; imported spend excluded).' : ' (includes imported spend).'),
      };
    }
    if (cfg.sessionUsd !== null && sessionSpend !== null && sessionSpend >= cfg.sessionUsd) {
      return {
        ...base,
        action: 'block',
        reason: `Session budget reached: $${sessionSpend.toFixed(2)} of $${cfg.sessionUsd.toFixed(2)} cap.`,
      };
    }
    if (runawayTripped) {
      return {
        ...base,
        action: 'block',
        reason: `Runaway loop guard: $${window.costUsd.toFixed(2)} spent in the last ${cfg.runawayWindowSec}s exceeds the $${cfg.runawayMaxUsd!.toFixed(2)} threshold.`,
      };
    }
    if (softTripped) {
      return {
        ...base,
        action: 'warn',
        reason: `Soft daily threshold passed: $${daySpend.toFixed(2)} of $${cfg.dailySoftUsd!.toFixed(2)}.`,
      };
    }
    return { ...base, action: 'allow', reason: null };
  }
}
