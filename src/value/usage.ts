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
 * DEPTH (not just realized/not): a reported outcome is GRADED onto the same reach
 * ladder the Impact lens uses for code — `used`/`accepted` = kept, `resolved` =
 * merged-level, `published`/`shipped` = shipped-level. So a published deliverable
 * counts for more Impact than a one-off answer, without inventing anything: the
 * grade is exactly what the user reported, never inferred from prompt content.
 *
 * No prompt text is read or stored, so we never classify by content. Acceptance
 * (edit-distance) and survival-over-time don't apply to a one-shot answer, so they
 * stay `unknown` — never faked.
 */

import type { Store } from '../store/db.ts';
import { scoreFunnel, type Gate, type GateResult, type Verdict } from './gates.ts';
import { computeReturnOnIntelligence, type RoIResult } from './lenses.ts';
import { timeWithAiMinutes } from './lift.ts';

const POSITIVE_OUTCOMES = new Set(['used', 'resolved', 'published', 'shipped', 'accepted']);
const NEGATIVE_OUTCOMES = new Set(['incident', 'redone', 'discarded']);

/** How far a reported non-coding outcome reached — the Impact ladder, non-coding side. */
export type Reach = 'shipped' | 'merged' | 'kept';

/** The strongest reach implied by a session's reported positive outcomes (null = none). */
function strongestReach(kinds: Set<string>): Reach | null {
  if (kinds.has('published') || kinds.has('shipped')) return 'shipped'; // reached an external audience
  if (kinds.has('resolved')) return 'merged'; // closed a task/ticket
  if (kinds.has('used') || kinds.has('accepted')) return 'kept'; // used, but internal
  return null;
}

export interface SessionOutcome {
  reach: Reach | null; // graded strongest reported outcome; null = nothing reported
  positive: boolean; // any positive, non-failed outcome
  negative: boolean; // any incident/redone/discarded or failed verdict
  realized: boolean; // positive and not negative — the honest "it mattered" bar
}

/**
 * Classify a session's reported signals into a graded outcome. This is the ONE
 * source of truth for "did this non-git session realize, and how far did it
 * reach" — reused by both the cross-modality report and per-user value so they
 * can never drift apart.
 */
export function classifySession(signals: Array<{ kind: string; verdict: string }>): SessionOutcome {
  const posKinds = new Set(signals.filter((x) => POSITIVE_OUTCOMES.has(x.kind) && x.verdict !== 'fail').map((x) => x.kind));
  const reach = strongestReach(posKinds);
  const positive = reach !== null;
  const negative = signals.some((x) => NEGATIVE_OUTCOMES.has(x.kind) || x.verdict === 'fail');
  return { reach, positive, negative, realized: positive && !negative };
}

function gate(g: Gate, verdict: Verdict, detail: string): GateResult {
  return { gate: g, verdict, detail };
}

export interface UsageUnit {
  sessionId: string;
  costUsd: number;
  requests: number;
  maturing: boolean;
  acceptance: number | null;
  reach: Reach | null; // graded from the reported outcome; null = no outcome reported
  realized: boolean;
}

export interface UsageReport {
  units: UsageUnit[];
  realizedUnits: number;
  totalCostUsd: number;
  /** How reported outcomes broke down by reach — the richer non-coding picture. */
  outcomeMix: { published: number; resolved: number; used: number; none: number };
  /** The money face's inputs, when priced (org-disclosed outcome baselines + labor rate). */
  money: { priced: boolean; grossRealizedValueUsd: number | null; supervisionMinutes: number | null };
  roi: RoIResult;
}

export interface UsageMoneyOptions {
  /** Manual-equivalent minutes per realized outcome, by reach name (used/resolved/published). Org input, disclosed. */
  outcomeBaselineMinutes: Record<string, number>;
  laborRatePerHour: number | null;
}

/** The outcomeMix name a graded reach prices under (same mapping the breakdown uses). */
function reachName(reach: Reach): 'published' | 'resolved' | 'used' {
  return reach === 'shipped' ? 'published' : reach === 'merged' ? 'resolved' : 'used';
}

export function computeUsageRoI(store: Store, opts: { startMs: number; endMs: number; money?: UsageMoneyOptions }): UsageReport {
  // Non-coding usage = sessions that produced no code proposals.
  const sessions = store.sessionUnits(opts.startMs, opts.endMs).filter((s) => !s.hasProposals);

  const lensUnits: Array<{ maturing: boolean; acceptance: number | null; funnel: ReturnType<typeof scoreFunnel> }> = [];
  const units: UsageUnit[] = [];
  const outcomeMix = { published: 0, resolved: 0, used: 0, none: 0 };

  for (const s of sessions) {
    const signals = store.signalsForCommit(s.sessionId); // commit_hash column reused as a generic ref
    const { reach, positive, negative } = classifySession(signals);

    // Map the reported outcome onto the shared ladder, GRADED by reach so Impact
    // differentiates a published deliverable from a one-off answer. Code-only gates
    // (committed/tested) and unobservable ones (accepted/survival-over-time) stay
    // `unknown` — never faked. "survived" here means "kept for the period", the
    // reported analog of durability.
    const verdicts: Record<Gate, GateResult> = {
      proposed: gate('proposed', 'pass', 'AI produced output'),
      accepted: gate('accepted', 'unknown', 'no diff to compare for non-code'),
      committed: gate('committed', 'unknown', 'n/a for non-code usage'),
      tested: gate('tested', 'unknown', 'n/a for non-code usage'),
      merged: gate(
        'merged',
        reach === 'merged' || reach === 'shipped' ? 'pass' : 'unknown',
        reach === 'merged' ? 'reported resolved' : reach === 'shipped' ? 'resolved en route to published' : 'no resolution reported',
      ),
      shipped: gate('shipped', reach === 'shipped' ? 'pass' : 'unknown', reach === 'shipped' ? 'reported published/shipped' : 'not reported as published'),
      survived: gate('survived', positive ? 'pass' : 'unknown', positive ? 'kept for the period' : 'no outcome reported'),
      clean: gate('clean', negative ? 'fail' : positive ? 'pass' : 'unknown', negative ? 'reported incident/redone' : positive ? 'no incident' : 'no outcome reported'),
    };
    const funnel = scoreFunnel(verdicts);

    outcomeMix[reach === null ? 'none' : reachName(reach)] += 1;

    units.push({
      sessionId: s.sessionId,
      costUsd: s.costUsd,
      requests: s.requests,
      maturing: false, // a non-coding outcome is the reported signal, not survival-over-time
      acceptance: null,
      reach,
      realized: funnel.realized,
    });
    lensUnits.push({ maturing: false, acceptance: null, funnel });
  }

  const realized = units.filter((u) => u.realized);
  const totalCostUsd = units.reduce((s, u) => s + u.costUsd, 0);
  // The efficiency lens keeps the honest FLOOR (realized value = the spend that
  // realized), so it stays a 0..1 share regardless of pricing below.
  const realizedValueUsd = realized.reduce((s, u) => s + u.costUsd, 0);

  // The MONEY face (RoI Return): price realized outcomes by the org's disclosed
  // manual-equivalent baselines — the exact pattern coding uses (baselineMinutes).
  // Supervision time is measured the same way too: 10-min concurrency windowing
  // over these sessions' own requests. Without baselines + a rate, the dollar
  // stays honestly un-priced; nothing here feeds the Index or the lenses.
  const money: UsageReport['money'] = { priced: false, grossRealizedValueUsd: null, supervisionMinutes: null };
  const rate = opts.money?.laborRatePerHour ?? null;
  if (opts.money && rate !== null && rate > 0) {
    let gross = 0;
    let pricedUnits = 0;
    for (const u of realized) {
      if (u.reach === null) continue;
      const minutes = opts.money.outcomeBaselineMinutes[reachName(u.reach)];
      if (typeof minutes === 'number' && minutes > 0) {
        gross += (minutes / 60) * rate;
        pricedUnits += 1;
      }
    }
    if (pricedUnits > 0) {
      const ids = new Set(units.map((u) => u.sessionId));
      const events = store
        .requestsInRange(opts.startMs, opts.endMs)
        .filter((r) => r.sessionId !== null && ids.has(r.sessionId))
        .map((r) => ({ sessionId: r.sessionId!, tsEpochMs: r.tsEpochMs }));
      const supMin = timeWithAiMinutes(events).totalMin;
      money.priced = true;
      money.grossRealizedValueUsd = gross;
      money.supervisionMinutes = supMin > 0 ? supMin : null;
    }
  }

  const roi = computeReturnOnIntelligence(
    {
      firstPassAcceptance: null,
      units: lensUnits,
      matured: {
        realizationRate: units.length > 0 ? realized.length / units.length : 0,
        totalCostUsd,
        realizedValueUsd,
      },
    },
    money.priced
      ? { laborRatePerHour: rate, grossRealizedValueUsd: money.grossRealizedValueUsd, supervisionMinutes: money.supervisionMinutes }
      : {},
  );

  return { units, realizedUnits: realized.length, totalCostUsd, outcomeMix, money, roi };
}
