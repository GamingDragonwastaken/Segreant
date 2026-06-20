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

export interface AiEvent {
  sessionId: string;
  tsEpochMs: number;
}

/**
 * METR 10-minute concurrency windowing → minutes of human "time with AI".
 * A window with n concurrently-active sessions charges each session 10/n minutes.
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
  // Index. The counterfactual is partially identified (Manski), so this is a real
  // interval, never a false point. lensLow ≤ lensScore ≤ lensHigh.
  lensLow: number | null;
  lensHigh: number | null;
  notes: string[];
}

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
    return { tsfUpperBound: null, point: null, low: null, high: null, lensScore: null, lensLow: null, lensHigh: null, notes };
  }
  const d = inp.discounts ?? {};
  const sel = d.selection ?? 0.5;
  const sub = d.substitution ?? 0.65;
  const con = d.concurrency ?? 0.8;

  const point = tsf * sel * sub * con; // discounted toward value uplift
  const high = tsf; // ceiling = new-task uplift (the inequality's upper bound)
  const low = inp.oldTaskLift ?? Math.max(0, point * 0.7); // floor
  // Saturating map multiplier → lens score in [0,1): 1×→0.5, 2×→0.67, 0.81×→0.45.
  const sat = (v: number) => v / (v + 1);
  const lensScore = sat(point);
  const lensLow = sat(low);
  const lensHigh = sat(high);

  notes.push(
    `Lift ≈ ${point.toFixed(2)}×, bounded [${low.toFixed(2)}×, ${high.toFixed(2)}×] ` +
      `(TSF upper bound ${tsf.toFixed(2)}×, discounted for selection/substitution/concurrency per METR).`,
  );
  return { tsfUpperBound: tsf, point, low, high, lensScore, lensLow, lensHigh, notes };
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
