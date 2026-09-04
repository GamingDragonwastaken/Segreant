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
import { adaptOutcome, createWorkUnit, type OutcomeAdapter, type WorkUnit } from '../outcomes/work-unit.ts';
import { computeReturnOnIntelligence, type RoIResult } from './lenses.ts';
import { timeWithAiMinutes } from './lift.ts';
import type { Gate } from './gates.ts';
import { economicAttributionFromAttributions, economicAttributionNumber, type EconomicAttribution } from '../economics/attribution.ts';

const POSITIVE_OUTCOMES = new Set(['used', 'resolved', 'published', 'shipped', 'accepted']);
const NEGATIVE_OUTCOMES = new Set(['incident', 'redone', 'discarded']);
const NON_CODING_OUTCOME_CONTRACT = Object.freeze({ id: 'non_coding_reported_outcome', requiredPredicates: ['reported_outcome'] as const });

export interface SessionSignal {
  readonly kind: string;
  readonly verdict: string;
}

function sessionSignalsFromUnit(unit: WorkUnit): SessionSignal[] {
  const raw = unit.context.signals;
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((value) => {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return [];
    const signal = value as { kind?: unknown; verdict?: unknown };
    return typeof signal.kind === 'string' && typeof signal.verdict === 'string'
      ? [{ kind: signal.kind, verdict: signal.verdict }]
      : [];
  });
}

function sessionState(signals: readonly SessionSignal[]): EpistemicState {
  const positive = signals.some((signal) => POSITIVE_OUTCOMES.has(signal.kind) && signal.verdict !== 'fail');
  const negative = signals.some((signal) => NEGATIVE_OUTCOMES.has(signal.kind) || signal.verdict === 'fail');
  return positive ? (negative ? 'conflicted' : 'supported') : negative ? 'refuted' : 'unknown';
}

/** Canonical adapter for explicit non-coding reported-outcome evidence. */
export const NON_CODING_OUTCOME_ADAPTER: OutcomeAdapter = Object.freeze({
  id: 'non-coding-reported-outcome-v1',
  contract: NON_CODING_OUTCOME_CONTRACT,
  resolve: (_predicate: string, unit: WorkUnit) => sessionState(sessionSignalsFromUnit(unit)),
});

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
export function classifySession(signals: readonly SessionSignal[]): SessionOutcome {
  const posKinds = new Set(signals.filter((x) => POSITIVE_OUTCOMES.has(x.kind) && x.verdict !== 'fail').map((x) => x.kind));
  const reach = strongestReach(posKinds);
  const positive = reach !== null;
  const negative = signals.some((x) => NEGATIVE_OUTCOMES.has(x.kind) || x.verdict === 'fail');
  const unit = createWorkUnit({
    id: 'non-coding-session-classification',
    kind: 'non_coding_session',
    startedAtMs: 0,
    endedAtMs: 0,
    context: { signals: signals.map((signal) => ({ kind: signal.kind, verdict: signal.verdict })) },
  });
  const adapted = adaptOutcome(unit, NON_CODING_OUTCOME_ADAPTER);
  const state: EpistemicState = adapted.evaluation.status === 'confirmed'
    ? 'supported'
    : adapted.evaluation.status === 'failed'
      ? 'refuted'
      : adapted.evaluation.status === 'conflicted'
        ? 'conflicted'
        : 'unknown';
  return { reach, positive, negative, state, realized: adapted.evaluation.status === 'confirmed' };
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

/**
 * The DECLARED utility assigned to each reach category, for the Impact lens.
 *
 * Reach is an ordinal descriptor: published reached further than resolved,
 * which reached further than used. Nothing observed says how much further, and
 * the Impact lens needs a number in [0,1] to enter the composite. These three
 * values are therefore a stated PREFERENCE about how much further each step
 * counts — an outcome/utility model this project declares, never a measurement
 * and never a universal cardinal scale. AII-011 exists because the previous
 * inline `1 / 0.75 / 0.5` made that assignment invisible at the call site, so a
 * workflow label arrived in the composite looking like an observation.
 *
 * An operator whose `published` work is worth far more than its `resolved` work
 * should say so here; the Index will legitimately differ, and `impactHow` will
 * carry the model that produced it.
 */
export const DECLARED_REACH_UTILITY: Readonly<Record<Reach, number>> = {
  shipped: 1,
  merged: 0.75,
  kept: 0.5,
} as const;

function describeReachUtility(model: Readonly<Record<Reach, number>>): string {
  const parts = (Object.keys(DECLARED_REACH_UTILITY) as Reach[])
    .map((reach) => `${reachName(reach)}=${model[reach]}`)
    .join(', ');
  return `operator-reported outcome reach, conditional on confirmed reported-outcome sessions, scored by the DECLARED reach-utility model (${parts}) — a stated preference, not a measured cardinal impact`;
}

export function computeUsageRoI(
  store: Store,
  opts: { startMs: number; endMs: number; money?: UsageMoneyOptions; reachUtility?: Readonly<Record<Reach, number>> },
): UsageReport {
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
  const spendOnRealizedUnitsUsd = realized.reduce((s, u) => s + u.costUsd, 0);

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

  // Ordinal reach becomes a cardinal lens value only through the declared model
  // above. Keeping the mapping named (rather than inline) is what stops a
  // workflow label from entering the composite as if it were an observation.
  const reachUtility = opts.reachUtility ?? DECLARED_REACH_UTILITY;
  const realizedImpact = realized.length === 0
    ? null
    : realized.reduce((sum, u) => sum + (u.reach === null ? 0 : reachUtility[u.reach]), 0) / realized.length;

  const roi = computeReturnOnIntelligence(
    {
      firstPassAcceptance: null,
      units: lensUnits,
      matured: {
        realizationRate: units.length > 0 ? realized.length / units.length : 0,
        totalCostUsd,
        spendOnRealizedUnitsUsd,
      },
    },
    {
      ...(money.priced
        ? { laborRatePerHour: rate, grossRealizedValueUsd: money.grossRealizedValueUsd, supervisionMinutes: money.supervisionMinutes }
        : {}),
      ...(realizedImpact === null
        ? {}
        : { impact: realizedImpact, impactHow: describeReachUtility(reachUtility) }),
    },
  );

  return { units, realizedUnits: realized.length, totalCostUsd, outcomeMix, money, roi, economic };
}
