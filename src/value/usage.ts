/**
 * Cross-modality RoI — value from NON-coding AI usage (chat, research, drafting).
 *
 * A non-coding unit is a session. Its outcome semantics are intentionally NOT
 * the coding eight-gate lifecycle: a reported use/resolution/publication is a
 * modality-specific outcome observation, not a fake commit/test/merge/deploy.
 * The adapter therefore maps explicit positive/negative reports into a single
 * `reported_outcome` epistemic predicate and evaluates that predicate through a
 * domain-neutral OutcomeContract.
 *
 * DEPTH (not just realized/not): a reported outcome is also a direct Impact
 * observation for this non-coding adapter — `used`/`accepted` = kept,
 * `resolved` = task-level reach, `published`/`shipped` = external reach. Impact
 * is averaged CONDITIONALLY over confirmed reported outcomes, so the realization
 * rate is not counted twice. The grade is exactly what the operator reported,
 * never inferred from text.
 *
 * No prompt text is read or stored, so Fiscus never classifies the content.
 */

import type { Store } from '../store/db.ts';
import type { EpistemicState } from '../epistemic/state.ts';
import { evaluateOutcomeContract } from '../outcomes/contract.ts';
import { computeReturnOnIntelligence, type RoIResult } from './lenses.ts';
import { timeWithAiMinutes } from './lift.ts';
import type { Gate } from './gates.ts';
import { economicAttributionFromAttributions, economicAttributionNumber, type EconomicAttribution } from '../economics/attribution.ts';

const POSITIVE_OUTCOMES = new Set(['used', 'resolved', 'published', 'shipped', 'accepted']);
const NEGATIVE_OUTCOMES = new Set(['incident', 'redone', 'discarded']);
const NON_CODING_OUTCOME_CONTRACT = Object.freeze({ id: 'non_coding_reported_outcome', requiredPredicates: ['reported_outcome'] as const });

/** How far a reported non-coding outcome reached — the Impact ladder, non-coding side. */
export type Reach = 'shipped' | 'merged' | 'kept';

/** The strongest reach implied by a session's reported positive outcomes (null = none). */
function strongestReach(kinds: Set<string>): Reach | null {
  if (kinds.has('published') || kinds.has('shipped')) return 'shipped';
  if (kinds.has('resolved')) return 'merged';
  if (kinds.has('used') || kinds.has('accepted')) return 'kept';
  return null;
}

export interface SessionOutcome {
  reach: Reach | null;
  positive: boolean;
  negative: boolean;
  state: EpistemicState;
  realized: boolean;
}

/**
 * Classify explicit session reports without borrowing coding lifecycle gates.
 * Positive + negative reports are contradictory evidence (`conflicted`), not a
 * last-write-wins boolean. A purely negative report refutes the outcome; no
 * report is unknown.
 */
export function classifySession(signals: Array<{ kind: string; verdict: string }>): SessionOutcome {
  const posKinds = new Set(signals.filter((x) => POSITIVE_OUTCOMES.has(x.kind) && x.verdict !== 'fail').map((x) => x.kind));
  const reach = strongestReach(posKinds);
  const positive = reach !== null;
  const negative = signals.some((x) => NEGATIVE_OUTCOMES.has(x.kind) || x.verdict === 'fail');
  const state: EpistemicState = positive ? (negative ? 'conflicted' : 'supported') : negative ? 'refuted' : 'unknown';
  const evaluation = evaluateOutcomeContract(NON_CODING_OUTCOME_CONTRACT, () => state);
  return { reach, positive, negative, state, realized: evaluation.status === 'confirmed' };
}

export interface UsageUnit {
  sessionId: string;
  costUsd: number;
  requests: number;
  /** Exact effective session economics; numeric costUsd is compatibility-only. */
  economic?: EconomicAttribution;
  maturing: boolean;
  acceptance: number | null;
  reach: Reach | null;
  realized: boolean;
}

export interface UsageReport {
  units: UsageUnit[];
  realizedUnits: number;
  totalCostUsd: number;
  outcomeMix: { published: number; resolved: number; used: number; none: number };
  money: { priced: boolean; grossRealizedValueUsd: number | null; supervisionMinutes: number | null };
  roi: RoIResult;
  /** Exact effective usage coverage, separate from the legacy numeric ROI input. */
  economic?: UsageEconomicRollup;
}

export interface UsageEconomicRollup {
  coverage: 'exact' | 'partial' | 'legacy_unknown';
  total: EconomicAttribution | null;
  realized: EconomicAttribution | null;
}

export interface UsageMoneyOptions {
  outcomeBaselineMinutes: Record<string, number>;
  laborRatePerHour: number | null;
}

function reachName(reach: Reach): 'published' | 'resolved' | 'used' {
  return reach === 'shipped' ? 'published' : reach === 'merged' ? 'resolved' : 'used';
}

export function computeUsageRoI(store: Store, opts: { startMs: number; endMs: number; money?: UsageMoneyOptions }): UsageReport {
  const sessions = store.economicSessionUnits(opts.startMs, opts.endMs).filter((s) => !s.hasProposals);

  // The legacy lens layer currently needs only `funnel.realized` plus an array of
  // gate-shaped observations for Impact compatibility. Non-coding has no coding
  // gates, so the array is deliberately empty rather than populated with fake
  // unknown/pass lifecycle states. This adapter disappears when lenses migrate
  // fully to OutcomeContract evidence.
  const lensUnits: Array<{
    maturing: boolean;
    acceptance: number | null;
    funnel: { realized: boolean; results: Array<{ gate: Gate; verdict: 'pass' | 'fail' | 'unknown' }> };
  }> = [];
  const units: UsageUnit[] = [];
  const outcomeMix = { published: 0, resolved: 0, used: 0, none: 0 };

  for (const s of sessions) {
    const signals = store.signalsForCommit(s.sessionId);
    const outcome = classifySession(signals);

    outcomeMix[outcome.reach === null ? 'none' : reachName(outcome.reach)] += 1;

    units.push({
      sessionId: s.sessionId,
      costUsd: economicAttributionNumber(s.economic, s.costUsd),
      requests: s.requests,
      economic: s.economic,
      maturing: false,
      acceptance: null,
      reach: outcome.reach,
      realized: outcome.realized,
    });
    lensUnits.push({ maturing: false, acceptance: null, funnel: { realized: outcome.realized, results: [] } });
  }

  const realized = units.filter((u) => u.realized);
  const totalCostUsd = units.reduce((s, u) => s + u.costUsd, 0);
  const realizedValueUsd = realized.reduce((s, u) => s + u.costUsd, 0);

  const exactValues = units.flatMap((unit) => unit.economic === undefined ? [] : [unit.economic]);
  const realizedExactValues = realized.flatMap((unit) => unit.economic === undefined ? [] : [unit.economic]);
  const economic: UsageEconomicRollup = {
    coverage: exactValues.length === 0
      ? 'legacy_unknown'
      : exactValues.length === units.length && economicAttributionFromAttributions(exactValues).complete
        ? 'exact'
        : 'partial',
    total: exactValues.length === 0 ? null : economicAttributionFromAttributions(exactValues),
    realized: exactValues.length === 0 ? null : economicAttributionFromAttributions(realizedExactValues),
  };

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

  const realizedImpact = realized.length === 0
    ? null
    : realized.reduce((sum, u) => sum + (u.reach === 'shipped' ? 1 : u.reach === 'merged' ? 0.75 : 0.5), 0) / realized.length;

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
    {
      ...(money.priced
        ? { laborRatePerHour: rate, grossRealizedValueUsd: money.grossRealizedValueUsd, supervisionMinutes: money.supervisionMinutes }
        : {}),
      ...(realizedImpact === null
        ? {}
        : { impact: realizedImpact, impactHow: 'operator-reported outcome reach, conditional on confirmed reported-outcome sessions' }),
    },
  );

  return { units, realizedUnits: realized.length, totalCostUsd, outcomeMix, money, roi, economic };
}
