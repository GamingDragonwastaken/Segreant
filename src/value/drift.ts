/**
 * The rate-drift alarm — an anytime-valid test that a rate is NOT CONSTANT.
 * (docs/RETURN-ON-INTELLIGENCE.md §11.)
 *
 * What it tests is exactly that and nothing more: the null is "one constant
 * Bernoulli rate generated this stream", and the alarm rejects it. It is named
 * for what it observes, because the thing it is most useful for is something it
 * cannot itself establish.
 *
 * THE MOTIVATING HYPOTHESIS (which this alarm does not confirm). Goodhart's law
 * is the fate of every metric: once a number is a target, people optimize the
 * number, not the value it stood for. A gamed metric doesn't announce itself —
 * it shows up as the rate drifting (acceptance creeping up while nothing else
 * improves; realization sagging as easy wins are cherry-picked). So drift is a
 * NECESSARY signature of that story, which makes this alarm worth having. It is
 * not a sufficient one: calling a detected movement "Goodhart" would assert an
 * incentive mechanism the 0/1 stream carries no evidence about. Establishing
 * that requires evidence that a proxy was under optimization pressure and that
 * the target construct diverged — neither of which is in this data.
 *
 * The alarm carries the same anytime-valid guarantee as §10 — it may be watched
 * continuously — and reads no content: drift is visible in the 0/1 stream
 * alone.
 *
 * THE CONSTRUCTION (universal inference / running-MLE e-process). The null is
 * composite: "the stream is i.i.d. Bernoulli(p) for SOME constant p". Race two
 * forecasters over the observed stream x₁..xₙ:
 *
 *   numerator    Π qᵢ₋₁(xᵢ)   — a PREDICTIVE alternative: a Krichevsky–Trofimov
 *                               estimator over a trailing window, which adapts
 *                               when the rate moves (it only sees the past —
 *                               one step ahead, never the answer);
 *   denominator  sup_p p^k(1−p)^{n−k} — the best CONSTANT rate in hindsight
 *                               (the null's maximum likelihood, refit at each n).
 *
 *   Eₙ = numerator / denominator
 *
 * VALIDITY (why the alarm can be trusted): for any fixed p₀ in the null,
 * Mₙ(p₀) = Π qᵢ₋₁(xᵢ)/p₀(xᵢ) is a nonnegative martingale under p₀ — each factor
 * has conditional expectation Σₓ q(x) = 1. The reported Eₙ replaces the p₀
 * likelihood with the SUP over the null, which can only be larger, so
 * Eₙ ≤ Mₙ(p₀) pathwise. Ville's inequality then gives, for EVERY p₀ at once:
 *
 *   P( ∃n : Eₙ ≥ 1/α ) ≤ P( ∃n : Mₙ(p₀) ≥ 1/α ) ≤ α
 *
 * So under a genuinely stable rate the alarm fires with probability ≤ α over
 * ALL of time — deterministic, no randomization, composite-null-safe. Under
 * drift, the windowed predictor tracks the new rate while the constant-rate
 * hindsight fit is torn between regimes, and Eₙ grows without bound.
 *
 * HONEST FRAMING (travels with the output): the alarm detects that the rate
 * MOVED, not why. Bending-toward-the-metric and a real regime change (new model,
 * new team, new workflow) both trip it, and this test cannot separate them. Its
 * job is to force the question — "did the work change, or did the measuring get
 * gamed?" — which no dashboard today even asks. The answer comes from evidence
 * outside this stream.
 */

import type { FunnelOutcome, Gate } from './gates.ts';

export interface DriftReport {
  n: number;
  /** log Eₙ at the end of the stream. */
  logE: number;
  /** max over time of log Eₙ — the alarm is a crossing event, and e-processes remember crossings. */
  maxLogE: number;
  /** true iff Eₙ ever reached 1/α — anytime-valid at level α. */
  alarm: boolean;
  alpha: number;
  /** trailing-window rate (what the adaptive side currently believes). */
  recentRate: number | null;
  /** whole-stream rate (what the constant-rate story claims). */
  overallRate: number | null;
  window: number;
}

/** Krichevsky–Trofimov predictive probability of a success given windowed counts. */
function ktProb(successes: number, total: number): number {
  return (successes + 0.5) / (total + 1);
}

/**
 * Run the drift e-process over an ordered 0/1 outcome stream (oldest first).
 * Pure and deterministic: same stream, same verdict.
 */
export function driftEProcess(
  stream: ReadonlyArray<0 | 1 | boolean>,
  opts: { alpha?: number; window?: number } = {},
): DriftReport {
  const alpha = opts.alpha ?? 0.05;
  const window = Math.max(5, opts.window ?? 20);
  const threshold = Math.log(1 / alpha);

  const xs = stream.map((v) => (v ? 1 : 0));
  const n = xs.length;
  if (n === 0) {
    return { n: 0, logE: 0, maxLogE: 0, alarm: false, alpha, recentRate: null, overallRate: null, window };
  }

  let logNum = 0;
  let maxLogE = -Infinity;
  let k = 0; // total successes so far
  let winK = 0; // successes inside the trailing window
  for (let i = 0; i < n; i++) {
    const winStart = Math.max(0, i - window);
    const winTotal = i - winStart;
    // Predict xᵢ from the trailing window BEFORE seeing it (one step ahead).
    const p1 = ktProb(winK, winTotal);
    logNum += Math.log(xs[i] === 1 ? p1 : 1 - p1);
    // Observe.
    k += xs[i]!;
    winK += xs[i]!;
    if (i >= window) winK -= xs[i - window]!; // drop the element leaving the trailing window
    // Hindsight-best constant rate on x₁..xᵢ₊₁ (0·log0 = 0 convention).
    const m = i + 1;
    const pHat = k / m;
    const logDen = (k > 0 ? k * Math.log(pHat) : 0) + (m - k > 0 ? (m - k) * Math.log(1 - pHat) : 0);
    const logE = logNum - logDen;
    if (logE > maxLogE) maxLogE = logE;
  }

  const tail = xs.slice(Math.max(0, n - window));
  const recentRate = tail.length > 0 ? tail.reduce((s: number, v) => s + v, 0) / tail.length : null;

  const finalPHat = k / n;
  const finalLogDen = (k > 0 ? k * Math.log(finalPHat) : 0) + (n - k > 0 ? (n - k) * Math.log(1 - finalPHat) : 0);

  return {
    n,
    logE: logNum - finalLogDen,
    maxLogE,
    alarm: maxLogE >= threshold,
    alpha,
    recentRate,
    overallRate: finalPHat,
    window,
  };
}

// ---- The multi-stream drift watch ------------------------------------------
//
// One drifting rate forces one question; the PATTERN across streams is more
// suggestive, though still not proof of an incentive mechanism. Acceptance creeping up while realization stagnates is the
// signature of proposal-inflation gaming; hard-gate unknowns climbing while
// the headline holds is coverage suppression (measure less, look better).
// Each stream gets its own e-process — the same anytime-valid guarantee —
// and each alarm names what its movement typically means. Detection is the
// SECOND line of defense; the structural defenses (ex-ante weights, gates
// that cannot be silently un-wired, baselines from fixed histories) come
// first. This just makes sure bending the metric leaves a visible mark.

/** The funnel gates whose *absence of observation* is itself worth watching. */
const HARD_GATES: readonly Gate[] = ['tested', 'merged', 'shipped'] as const;

export interface NamedDriftReport {
  stream: 'realization' | 'acceptance' | 'hard-gate-coverage';
  /** What a movement in this stream typically means — travels with the alarm. */
  reading: string;
  report: DriftReport;
}

/**
 * Run the drift e-process over the three gaming-sensitive 0/1 streams derivable
 * from funnel outcomes (oldest first). Streams shorter than `minN` observed
 * points are omitted — an alarm needs a stream to say anything, honestly.
 *
 * Each `reading` names what a movement in that stream would mean IF the metric
 * were being bent. That is a hypothesis worth checking, never a conclusion this
 * function has reached.
 */
export function rateDriftStreams(
  outcomes: ReadonlyArray<FunnelOutcome>,
  opts: { alpha?: number; window?: number; minN?: number } = {},
): NamedDriftReport[] {
  const minN = opts.minN ?? 10;
  const out: NamedDriftReport[] = [];

  const realization = outcomes.map((o) => (o.realized ? 1 : 0) as 0 | 1);
  if (realization.length >= minN) {
    out.push({
      stream: 'realization',
      reading: 'the outcome rate moved — did the work change (new model/workflow → re-baseline), or is the metric being gamed?',
      report: driftEProcess(realization, opts),
    });
  }

  // Acceptance stream: the accepted-gate verdict where it was observed.
  // Rising acceptance with flat realization is the proposal-inflation signature.
  const acceptance = outcomes
    .map((o) => o.results.find((r) => r.gate === 'accepted')?.verdict)
    .filter((v): v is 'pass' | 'fail' => v === 'pass' || v === 'fail')
    .map((v) => (v === 'pass' ? 1 : 0) as 0 | 1);
  if (acceptance.length >= minN) {
    out.push({
      stream: 'acceptance',
      reading: 'first-pass acceptance moved — if realization did NOT move with it, suspect trivially-acceptable proposals inflating the collaboration lens',
      report: driftEProcess(acceptance, opts),
    });
  }

  // Coverage stream: 1 when any hard gate went UNOBSERVED. A rising rate means
  // the measuring is being turned off — the quietest way to bend a metric that
  // treats unknown as neutral.
  const unknownHard = outcomes.map(
    (o) => (o.results.some((r) => HARD_GATES.includes(r.gate) && r.verdict === 'unknown') ? 1 : 0) as 0 | 1,
  );
  if (unknownHard.length >= minN) {
    out.push({
      stream: 'hard-gate-coverage',
      reading: 'the share of units with unobserved hard gates moved — a RISING rate is coverage suppression (measure less, look better); wire the gates back',
      report: driftEProcess(unknownHard, opts),
    });
  }

  return out;
}
