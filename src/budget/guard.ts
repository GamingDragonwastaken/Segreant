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

export class BudgetGuard {
  private readonly store: Store;
  private readonly cfg: BudgetConfig;

  constructor(store: Store, cfg: BudgetConfig) {
    this.store = store;
    this.cfg = cfg;
  }

  evaluate(opts: { sessionId?: string | null; nowMs?: number } = {}): GuardDecision {
    const now = opts.nowMs ?? Date.now();
    const dayStart = startOfLocalDay(now);
    const dayEnd = endOfLocalDay(now);
    // Enforcement basis: by default only LIVE proxy spend counts — a cap can only
    // block live traffic, and imported subscription spend tripping it froze a
    // proxy that had spent almost nothing (dogfood). capIncludesImported opts
    // into governing total observed spend instead.
    const liveOnly = !this.cfg.capIncludesImported;
    const daySpend = this.store.spendBetween(dayStart, dayEnd, liveOnly);

    const dailyLimit = this.cfg.dailyUsd;
    const remainingDaily = dailyLimit === null ? null : Math.max(0, dailyLimit - daySpend);

    const sessionSpend = opts.sessionId ? this.store.spendForSession(opts.sessionId, liveOnly) : null;

    const windowMs = this.cfg.runawayWindowSec * 1000;
    const window = this.store.spendInWindow(now, windowMs, liveOnly);
    const runawayTripped =
      this.cfg.runawayMaxUsd !== null && window.costUsd >= this.cfg.runawayMaxUsd;

    const softTripped =
      this.cfg.dailySoftUsd !== null && daySpend >= this.cfg.dailySoftUsd;

    const base = {
      daySpendUsd: daySpend,
      dailyLimitUsd: dailyLimit,
      remainingDailyUsd: remainingDaily,
      sessionSpendUsd: sessionSpend,
      softTripped,
      runaway: { tripped: runawayTripped, windowCostUsd: window.costUsd, windowSec: this.cfg.runawayWindowSec },
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
    if (this.cfg.sessionUsd !== null && sessionSpend !== null && sessionSpend >= this.cfg.sessionUsd) {
      return {
        ...base,
        action: 'block',
        reason: `Session budget reached: $${sessionSpend.toFixed(2)} of $${this.cfg.sessionUsd.toFixed(2)} cap.`,
      };
    }
    if (runawayTripped) {
      return {
        ...base,
        action: 'block',
        reason: `Runaway loop guard: $${window.costUsd.toFixed(2)} spent in the last ${this.cfg.runawayWindowSec}s exceeds the $${this.cfg.runawayMaxUsd!.toFixed(2)} threshold.`,
      };
    }
    if (softTripped) {
      return {
        ...base,
        action: 'warn',
        reason: `Soft daily threshold passed: $${daySpend.toFixed(2)} of $${this.cfg.dailySoftUsd!.toFixed(2)}.`,
      };
    }
    return { ...base, action: 'allow', reason: null };
  }
}
