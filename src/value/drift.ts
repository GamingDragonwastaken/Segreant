/**
 * The Goodhart drift alarm — an anytime-valid test that a rate is being BENT.
 * (docs/RETURN-ON-INTELLIGENCE.md §11.)
 *
 * Goodhart's law is the fate of every metric: once a number is a target, people
 * optimize the number, not the value it stood for. A gamed metric doesn't
 * announce itself — it shows up as the rate DRIFTING (acceptance creeping up
 * while nothing else improves; realization sagging as easy wins are cherry-
 * picked). The alarm below detects exactly that, with the same anytime-valid
 * guarantee as §10 — it may be watched continuously — and WITHOUT reading any
 * content: drift is visible in the 0/1 stream alone.
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
 * MOVED, not why. Bending-toward-the-metric (Goodhart) and a real regime change
 * (new model, new team, new workflow) both trip it. Its job is to force the
 * question — "did the work change, or did the measuring get gamed?" — which no
 * dashboard today even asks.
 */

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
