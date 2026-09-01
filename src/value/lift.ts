/**
 * Lift — the counterfactual lens, built on METR's transcript-analysis method.
 *
 * METR (arXiv:2507.09089 RCT; 2026 transcript analysis) established two things we
 * honor here:
 *
 *  1. A transcript-derived Time-Savings Factor (TSF) is a SOFT UPPER BOUND on the
 *     value uplift, because of task-selection, task-substitution, and concurrency
 *     biases. The ordering inequality is:
 *         Lift_old_tasks  ≤  Lift_value  ≤  Lift_new_tasks ≈ TSF_transcript
 *     So we never report TSF as "the" lift — we discount it toward value and
 *     report a RANGE, never a false-precision point.
 *
 *  2. "Time with AI" can be estimated from session timestamps with a 10-minute
 *     concurrency-windowing method: a window is active if it has user activity,
 *     and if n sessions are concurrently active in a window each is charged
 *     10/n minutes. We implement that here from request events we already store.
 *
 * Self-reported lift is excluded by design: METR found a 43-point gap between
 * perceived (+24%) and actual (−19%) on mature codebases. Lift is behavioral or
 * it is `uninstrumented` — never surveyed.
 */

import { sessionEfficiencySignal } from './liftEfficiency.ts';

export interface AiEvent {
  sessionId: string;
  tsEpochMs: number;
}

/**
 * METR 10-minute concurrency windowing → minutes of human "time with AI".
 * A window with n concurrently-active sessions charges each session 10/n minutes.
 *
 * Gaming note (worth stating because a supervision-time denominator invites
 * it): the TOTAL is invariant to session count — n sessions in one window sum
 * to exactly the window's minutes (n × 10/n = 10) — so opening dummy parallel
 * sessions neither shrinks nor inflates the total supervision time the RoI
 * denominator prices. Only the per-session split moves. Idle sessions charge
 * nothing at all: a window counts only when it contains real request events.
 */
export function timeWithAiMinutes(
  events: AiEvent[],
  windowMin = 10,
): { perSessionMin: Map<string, number>; totalMin: number } {
  const wsize = windowMin * 60_000;
  const winSessions = new Map<number, Set<string>>();
  const sessionWins = new Map<string, Set<number>>();
  for (const e of events) {
    const w = Math.floor(e.tsEpochMs / wsize);
    (winSessions.get(w) ?? winSessions.set(w, new Set()).get(w)!).add(e.sessionId);
    (sessionWins.get(e.sessionId) ?? sessionWins.set(e.sessionId, new Set()).get(e.sessionId)!).add(w);
  }
  const perSessionMin = new Map<string, number>();
  let totalMin = 0;
  for (const [s, wins] of sessionWins) {
    let m = 0;
    for (const w of wins) m += windowMin / winSessions.get(w)!.size;
    perSessionMin.set(s, m);
    totalMin += m;
  }
  return { perSessionMin, totalMin };
}

export interface LiftDiscounts {
  selection?: number; // transcript corpus is AI-amenable tasks (0.3–0.7)
  substitution?: number; // marginal AI-unlocked tasks worth less (0.5–0.8)
  concurrency?: number; // non-AI parallel work inflates TSF (0.6–0.9)
  // How cleanly the AI-assisted time itself was used (0.85–1.15, 1 = no signal).
  // See liftEfficiency.ts — content-free, reuses Acceptance-lens data. Unlike the
  // other three discounts (fixed METR-derived constants), this one is COMPUTED
  // per Lift calculation from real local data, not a hand-picked range.
  efficiency?: number;
}

export interface LiftInputs {
  tsfUpperBound?: number | null; // from a transcript judge or an A/B measurement
  oldTaskLift?: number | null; // measured uplift on a fixed task set (the floor)
  discounts?: LiftDiscounts;
}

export interface LiftEstimate {
  tsfUpperBound: number | null;
  point: number | null; // discounted value-uplift estimate (a multiplier)
  low: number | null;
  high: number | null;
  lensScore: number | null; // 0..1 for the composite (0.5 = break-even, 1× speed)
  // The bound in LENS-SCORE units (0..1), so the interval propagates into the RoI
  // Index. lensLow ≤ lensScore ≤ lensHigh.
  lensLow: number | null;
  lensHigh: number | null;
  /**
   * Where each endpoint came from. AII-010: a numerically cautious number is not
   * an identified bound. Only `observed_old_task_lift` gives the floor an
   * empirical source; `declared_fallback_fraction` means no observation
   * constrained it and the endpoint is a disclosed scenario floor. The interval
   * is a partially identified set ONLY when `lowBasis` is not the fallback.
   */
  lowBasis: 'observed_old_task_lift' | 'declared_fallback_fraction' | null;
  /** The ceiling is the design's stated TSF upper bound in both cases. */
  highBasis: 'tsf_upper_bound' | null;
  notes: string[];
}

/**
 * The floor used when no old-task lift was observed, as a fraction of the
 * discounted point estimate.
 *
 * This is a DECLARED scenario floor, not an identified lower bound. Nothing
 * observed rules out a smaller effect — the true counterfactual may be zero or
 * negative — and the interval carrying this endpoint must not be described as a
 * partially identified set. It exists so a display has a defensible band to draw
 * rather than a false point, and `lowBasis` records that this is what happened.
 */
export const DECLARED_LIFT_FLOOR_FRACTION = 0.7;

/**
 * Turn a TSF upper bound into a discounted, bounded value-uplift estimate.
 * Returns `uninstrumented` (all null) when no behavioral baseline is supplied —
 * we will not invent a counterfactual.
 */
export function boundedLift(inp: LiftInputs): LiftEstimate {
  const notes: string[] = [];
  const tsf = inp.tsfUpperBound ?? null;
  if (tsf === null || !(tsf > 0)) {
    notes.push('Lift uninstrumented: supply a behavioral TSF (transcript judge or A/B), never self-report.');
    return { tsfUpperBound: null, point: null, low: null, high: null, lensScore: null, lensLow: null, lensHigh: null, lowBasis: null, highBasis: null, notes };
  }
  const d = inp.discounts ?? {};
  const sel = d.selection ?? 0.5;
  const sub = d.substitution ?? 0.65;
  const con = d.concurrency ?? 0.8;
  const eff = d.efficiency ?? 1; // neutral unless a real signal (liftEfficiency.ts) supplied one

  const point = tsf * sel * sub * con * eff; // discounted toward value uplift
  const high = tsf; // ceiling = new-task uplift (the inequality's upper bound)
  // Two very different floors. An observed old-task lift constrains the
  // counterfactual from below; the fallback does not constrain anything, it just
  // keeps the band from collapsing onto the point. They are never conflated.
  const observedFloor = inp.oldTaskLift ?? null;
  const lowBasis = observedFloor !== null ? 'observed_old_task_lift' as const : 'declared_fallback_fraction' as const;
  const low = observedFloor ?? Math.max(0, point * DECLARED_LIFT_FLOOR_FRACTION);
  // Saturating map multiplier → lens score in [0,1): 1×→0.5, 2×→0.67, 0.81×→0.45.
  const sat = (v: number) => v / (v + 1);
  const lensScore = sat(point);
  const lensLow = sat(low);
  const lensHigh = sat(high);

  notes.push(
    `Lift ≈ ${point.toFixed(2)}×, ranged [${low.toFixed(2)}×, ${high.toFixed(2)}×] ` +
      `(TSF upper bound ${tsf.toFixed(2)}×, discounted for selection/substitution/concurrency per METR).`,
  );
  notes.push(
    lowBasis === 'observed_old_task_lift'
      ? 'Lower endpoint is an OBSERVED old-task lift, so the range is a partially identified set under the stated design.'
      : `Lower endpoint is a DECLARED floor at ${DECLARED_LIFT_FLOOR_FRACTION}× the discounted estimate — nothing observed rules out a smaller or negative effect, so this range is a disclosed scenario band, not an identified set.`,
  );
  return { tsfUpperBound: tsf, point, low, high, lensScore, lensLow, lensHigh, lowBasis, highBasis: 'tsf_upper_bound', notes };
}

export interface BreakEven {
  valueUsd: number;
  costUsd: number;
  ratio: number; // value ÷ cost ; ≥1 means the AI returned more than it cost
  passes: boolean;
}

/**
 * The break-even constraint: did the time the AI saved (priced at labor rate)
 * exceed what it cost (tokens + effort)? VpT < 1 means the tool consumed more
 * value in spend than it returned in lift.
 */
export function breakEven(timeSavedHours: number, laborRatePerHour: number, costUsd: number): BreakEven {
  const valueUsd = Math.max(0, timeSavedHours) * laborRatePerHour;
  const ratio = costUsd > 0 ? valueUsd / costUsd : Infinity;
  return { valueUsd, costUsd, ratio, passes: ratio >= 1 };
}

export interface WorkItemForLift {
  taskType: string;
  realized: boolean;
  // Optional: this unit's Acceptance rate (WorkUnit.acceptance), feeding the
  // efficiency discount below. Absent/null units are simply excluded from that
  // signal's pool — never treated as a zero.
  acceptance?: number | null;
}

export interface DataLiftInputs {
  units: WorkItemForLift[]; // matured work units (task-type + whether it realized)
  events: AiEvent[]; // request events for the measured "time with AI" denominator
  baselineMinutes: Record<string, number>; // task-type → estimated manual minutes
  // The baseline as an interval (liftBaseline.ts's identification band). The TSF
  // is MOST sensitive exactly where it matters most — dL/dB = T/B² flips the
  // sign near break-even on small baseline errors — so when the baseline is an
  // estimate its width must reach the lens interval, not vanish into a point.
  // Absent (or equal to the point) → no extra width, exactly today's behavior.
  baselineMinutesLow?: Record<string, number>;
  baselineMinutesHigh?: Record<string, number>;
  discounts?: LiftDiscounts;
  // This ledger's own overall first-pass acceptance (RealizationReport.
  // firstPassAcceptance) — the shrink-toward prior for the efficiency signal.
  // Omitted/null → the signal stays honestly uninstrumented (multiplier 1, no
  // invented population figure). See liftEfficiency.ts.
  ledgerAcceptance?: number | null;
}

export interface DataLiftResult {
  lift: number | null; // lens score (0..1) for computeReturnOnIntelligence({lift})
  liftRange: { low: number | null; high: number | null };
  tsf: number | null; // pooled time-savings factor = manualMinutes / aiMinutes
  // TSF at the baseline band's endpoints (null when the baseline carried no
  // width) — how much of liftRange's width is baseline uncertainty, disclosed.
  tsfRange: { low: number; high: number } | null;
  estimatedManualMinutes: number;
  measuredAiMinutes: number;
  coveredUnits: number; // realized units that had a configured baseline
  notes: string[];
}

/**
 * A REAL, zero-API Lift, computed from data already on the machine:
 *
 *   TSF = (estimated manual minutes of REALIZED work) ÷ (measured "time with AI")
 *
 * The denominator is fully behavioral — METR's 10-minute concurrency windowing over
 * real request timestamps. The numerator credits only output that actually realized,
 * priced by per-task-type baselines (an auditable org input, exactly like the labor
 * rate — never a self-reported speedup). Because only realized work enters the
 * numerator while ALL measured AI time enters the denominator, time burned on work
 * that never realized pulls the TSF DOWN: you cannot inflate Lift by spending more.
 * The pooled TSF feeds the same METR-discounted `boundedLift`. The result is a
 * disclosed range rather than a false point; whether that range is a partially
 * identified SET depends on `lowBasis` — a declared fallback floor is not an
 * identified bound however cautious the number looks. Returns
 * uninstrumented (null) when there's no baselined realized work or no measured AI
 * time — we never invent a counterfactual.
 */
export function liftFromData(inp: DataLiftInputs): DataLiftResult {
  let estimatedManualMinutes = 0;
  let manualMinutesLow = 0;
  let manualMinutesHigh = 0;
  let coveredUnits = 0;
  const coveredAcceptance: Array<number | null | undefined> = [];
  for (const u of inp.units) {
    if (!u.realized) continue;
    const b = inp.baselineMinutes[u.taskType];
    if (typeof b === 'number' && b > 0) {
      estimatedManualMinutes += b;
      // Endpoint tables fall back to the point per-key, so a partially-banded
      // table still yields a well-formed (possibly degenerate) interval.
      manualMinutesLow += inp.baselineMinutesLow?.[u.taskType] ?? b;
      manualMinutesHigh += inp.baselineMinutesHigh?.[u.taskType] ?? b;
      coveredUnits += 1;
      coveredAcceptance.push(u.acceptance);
    }
  }
  const measuredAiMinutes = timeWithAiMinutes(inp.events).totalMin;
  if (coveredUnits === 0 || !(measuredAiMinutes > 0)) {
    return {
      lift: null,
      liftRange: { low: null, high: null },
      tsf: null,
      tsfRange: null,
      estimatedManualMinutes,
      measuredAiMinutes,
      coveredUnits,
      notes: ['Lift uninstrumented: needs realized work with a configured task baseline AND measured AI time (proxy traffic).'],
    };
  }
  const tsf = estimatedManualMinutes / measuredAiMinutes;
  const efficiency = sessionEfficiencySignal({
    unitAcceptance: coveredAcceptance,
    ledgerAcceptance: inp.ledgerAcceptance ?? null,
  });
  const discounts = { ...inp.discounts, efficiency: efficiency.multiplier };
  const est = boundedLift({ tsfUpperBound: tsf, discounts });

  // Baseline-uncertainty propagation: re-run the SAME discount pipeline at the
  // baseline band's endpoints (boundedLift is monotone in its TSF input, so the
  // endpoint runs bracket the point run) and widen the lens interval to cover
  // them. dL/dB = T/B²: near break-even this width is where sign flips live —
  // hiding it inside a point is exactly the false precision the interval exists
  // to prevent.
  let tsfRange: { low: number; high: number } | null = null;
  let lensLow = est.lensLow;
  let lensHigh = est.lensHigh;
  const notes: string[] = [
    `Lift from measured data: ${coveredUnits} realized unit(s) ≈ ${Math.round(estimatedManualMinutes)} manual min vs ${Math.round(measuredAiMinutes)} measured AI min → TSF ${tsf.toFixed(2)}×. Baseline-estimated (not a controlled A/B); tighten with --tsf from a transcript judge or RCT.`,
  ];
  if (manualMinutesHigh > manualMinutesLow) {
    const tsfLow = manualMinutesLow / measuredAiMinutes;
    const tsfHigh = manualMinutesHigh / measuredAiMinutes;
    tsfRange = { low: tsfLow, high: tsfHigh };
    const atLow = boundedLift({ tsfUpperBound: tsfLow, discounts });
    const atHigh = boundedLift({ tsfUpperBound: tsfHigh, discounts });
    if (atLow.lensLow !== null) lensLow = lensLow === null ? atLow.lensLow : Math.min(lensLow, atLow.lensLow);
    if (atHigh.lensHigh !== null) lensHigh = lensHigh === null ? atHigh.lensHigh : Math.max(lensHigh, atHigh.lensHigh);
    notes.push(
      `Baseline uncertainty propagated: manual-minutes band [${Math.round(manualMinutesLow)}, ${Math.round(manualMinutesHigh)}] → TSF [${tsfLow.toFixed(2)}×, ${tsfHigh.toFixed(2)}×] — the lens interval covers both endpoints (dL/dB = T/B²: near break-even, baseline error flips the sign).`,
    );
  }
  notes.push(...efficiency.notes, ...est.notes);

  return {
    lift: est.lensScore,
    liftRange: { low: lensLow, high: lensHigh },
    tsf,
    tsfRange,
    estimatedManualMinutes,
    measuredAiMinutes,
    coveredUnits,
    notes,
  };
}
