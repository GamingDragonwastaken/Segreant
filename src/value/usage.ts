/**
 * Cross-modality RoI — value from NON-coding AI usage (chat, research, drafting).
 *
 * The universal spine (intent → output → acceptance → outcome) is modality-
 * agnostic, so the same RoI lenses apply. What changes is the outcome source:
 * coding uses git; non-coding uses *reported* outcomes (`aegisflow report
 * --session <id> --kind used|resolved|published`). A non-coding unit is a
 * session; it "realizes" when it has a positive, no-incident outcome — the
 * direct analog of shipped+survived+clean for code.
 *
 * No prompt text is read or stored, so we never classify by content. Acceptance
 * (edit-distance) and survival don't apply, so they stay `unknown` — never faked.
 */

import type { Store } from '../store/db.ts';
import { scoreFunnel, type Gate, type GateResult, type Verdict } from './gates.ts';
import { computeReturnOnIntelligence, type RoIResult } from './lenses.ts';

const POSITIVE_OUTCOMES = new Set(['used', 'resolved', 'published', 'shipped', 'accepted']);
const NEGATIVE_OUTCOMES = new Set(['incident', 'redone', 'discarded']);

function gate(g: Gate, verdict: Verdict, detail: string): GateResult {
  return { gate: g, verdict, detail };
}

export interface UsageUnit {
  sessionId: string;
  costUsd: number;
  requests: number;
  maturing: boolean;
  acceptance: number | null;
  linesAdded: number;
  realized: boolean;
}

export interface UsageReport {
  units: UsageUnit[];
  realizedUnits: number;
  totalCostUsd: number;
  roi: RoIResult;
}

export function computeUsageRoI(store: Store, opts: { startMs: number; endMs: number }): UsageReport {
  // Non-coding usage = sessions that produced no code proposals.
  const sessions = store.sessionUnits(opts.startMs, opts.endMs).filter((s) => !s.hasProposals);

  const lensUnits: Array<{ maturing: boolean; acceptance: number | null; linesAdded: number; funnel: ReturnType<typeof scoreFunnel> }> = [];
  const units: UsageUnit[] = [];

  for (const s of sessions) {
    const signals = store.signalsForCommit(s.sessionId); // commit_hash column reused as a generic ref
    const positive = signals.some((x) => POSITIVE_OUTCOMES.has(x.kind) && x.verdict !== 'fail');
    const negative = signals.some((x) => NEGATIVE_OUTCOMES.has(x.kind) || x.verdict === 'fail');

    // Map non-coding outcomes onto the shared ladder. Inapplicable code gates
    // (committed/tested/merged) stay `unknown`; acceptance/survival can't be
    // observed for chat, so they're `unknown` unless a positive outcome implies
    // the answer was kept for the period.
    const verdicts: Record<Gate, GateResult> = {
      proposed: gate('proposed', 'pass', 'AI produced output'),
      accepted: gate('accepted', 'unknown', 'no diff to compare for non-code'),
      committed: gate('committed', 'unknown', 'n/a for non-code usage'),
      tested: gate('tested', 'unknown', 'n/a for non-code usage'),
      merged: gate('merged', 'unknown', 'n/a for non-code usage'),
      shipped: gate('shipped', positive ? 'pass' : 'unknown', positive ? 'reported used/resolved/published' : 'no outcome reported'),
      survived: gate('survived', positive ? 'pass' : 'unknown', positive ? 'kept for the period' : 'no outcome reported'),
      clean: gate('clean', negative ? 'fail' : positive ? 'pass' : 'unknown', negative ? 'reported incident/redone' : positive ? 'no incident' : 'no outcome reported'),
    };
    const funnel = scoreFunnel(verdicts);

    units.push({
      sessionId: s.sessionId,
      costUsd: s.costUsd,
      requests: s.requests,
      maturing: false, // a non-coding outcome is the reported signal, not survival-over-time
      acceptance: null,
      linesAdded: 0,
      realized: funnel.realized,
    });
    lensUnits.push({ maturing: false, acceptance: null, linesAdded: 0, funnel });
  }

  const realized = units.filter((u) => u.realized);
  const totalCostUsd = units.reduce((s, u) => s + u.costUsd, 0);
  const realizedValueUsd = realized.reduce((s, u) => s + u.costUsd, 0);

  const roi = computeReturnOnIntelligence({
    firstPassAcceptance: null,
    units: lensUnits,
    matured: {
      realizationRate: units.length > 0 ? realized.length / units.length : 0,
      totalCostUsd,
      realizedValueUsd,
    },
  });

  return { units, realizedUnits: realized.length, totalCostUsd, roi };
}
