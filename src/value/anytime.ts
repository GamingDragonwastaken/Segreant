/**
 * Anytime-valid inference — the rate you are allowed to watch continuously.
 * (docs/RETURN-ON-INTELLIGENCE.md §10.)
 *
 * THE FLAW THIS FIXES (which every monitoring dashboard shares): a classical
 * 95% interval is only valid if you look ONCE, at a pre-registered sample size.
 * A dashboard invites the opposite — glance at every refresh, act the moment
 * the number looks good. Under that use, the real error rate of a fixed-n
 * interval grows without bound (the optional-stopping / "peeking" problem that
 * forces clinical trials into special sequential designs). Fiscus's whole
 * brand is "never a dishonest number", so its headline rate carries an interval
 * that stays valid at EVERY glance.
 *
 * THE CONSTRUCTION (mixture e-process → confidence sequence):
 * For a realization stream x₁..xₙ ∈ {0,1} and a candidate rate p, the ratio
 *
 *      Mₙ(p) = ∫ q^k (1−q)^{n−k} dBeta(a,a)(q)  /  p^k (1−p)^{n−k}
 *
 * is a nonnegative martingale with E[M₀]=1 when p is the true rate. Ville's
 * inequality then gives P(∃n: Mₙ(p) ≥ 1/α) ≤ α — a bound over ALL n at once.
 * So CSₙ = { p : Mₙ(p) < 1/α } covers the truth simultaneously at every sample
 * size with probability ≥ 1−α: peek freely, stop whenever, still valid.
 *
 * Numerically: the Beta-function ratio is built by the exact recurrence
 * B(x+1,y) = B(x,y)·x/(x+y) from B(a,a) — no gamma function, no dependency,
 * exact in log space. log Mₙ(p) is quasi-convex in p with its minimum at k/n
 * (where Mₙ ≤ 1), so the sub-level set is an interval, found by bisection.
 *
 * The honest price: this interval is WIDER than a fixed-n interval (~1.5–2×).
 * That is not a defect — it is what "valid under continuous monitoring"
 * actually costs, stated instead of hidden.
 */

/** Mixture prior over the unknown rate. Jeffreys is the default (near-optimal width). */
export type CsPrior = 'jeffreys' | 'uniform';

/**
 * The assumptions carried by the legacy primitive. This is intentionally not a
 * universal sequential guarantee: sliding windows, clusters, changing outcome
 * definitions, adaptive assignment, and post-selection are outside this domain.
 */
export interface AnytimeValidityDomain {
  data: 'accumulated';
  sampling: 'independent_bernoulli';
  cluster: 'not_accounted';
  selection: 'none';
  adaptation: 'none';
}

export const ANYTIME_VALIDITY_DOMAIN: Readonly<AnytimeValidityDomain> = Object.freeze({
  data: 'accumulated',
  sampling: 'independent_bernoulli',
  cluster: 'not_accounted',
  selection: 'none',
  adaptation: 'none',
});

export interface AnytimeInterval {
  low: number;
  high: number;
  /** Simultaneous coverage level over ALL sample sizes, e.g. 0.95. */
  level: number;
  n: number;
  k: number;
  prior: CsPrior;
  /** Explicit domain; callers must not reuse this interval for another stream. */
  validityDomain: Readonly<AnytimeValidityDomain>;
}

/**
 * log of the mixture marginal-likelihood ratio  B(k+a, n−k+a) / B(a,a),
 * via the exact one-step recurrence (a = ½ Jeffreys, 1 uniform).
 */
function logMarginalRatio(k: number, n: number, prior: CsPrior): number {
  const a = prior === 'jeffreys' ? 0.5 : 1;
  let x = a;
  let y = a;
  let acc = 0;
  for (let i = 0; i < k; i++) {
    acc += Math.log(x / (x + y));
    x += 1;
  }
  for (let i = 0; i < n - k; i++) {
    acc += Math.log(y / (x + y));
    y += 1;
  }
  return acc;
}

/** 0·log 0 = 0 convention for the Bernoulli log-likelihood. */
function logLik(k: number, n: number, p: number): number {
  let acc = 0;
  if (k > 0) acc += k * Math.log(p); // p=0 with k>0 → -Infinity (correct: impossible)
  if (n - k > 0) acc += (n - k) * Math.log(1 - p);
  return acc;
}

/**
 * log e-value against the point null "the true rate is p", after k of n.
 * ≥ log(1/α) at ANY time ⟹ reject p at anytime-valid level α.
 */
export function logEValue(k: number, n: number, p: number, prior: CsPrior = 'jeffreys'): number {
  return logMarginalRatio(k, n, prior) - logLik(k, n, p);
}

/**
 * The anytime-valid confidence sequence for a realized/total rate: every p
 * whose e-value has not crossed 1/α. Valid simultaneously at every n — the
 * one interval a live dashboard is statistically allowed to display.
 */
export function anytimeRateInterval(
  k: number,
  n: number,
  opts: { level?: number; prior?: CsPrior } = {},
): AnytimeInterval {
  const level = opts.level ?? 0.95;
  const prior = opts.prior ?? 'jeffreys';
  if (n <= 0) return { low: 0, high: 1, level, n: 0, k: 0, prior, validityDomain: ANYTIME_VALIDITY_DOMAIN }; // no evidence → the whole interval, honestly

  const threshold = Math.log(1 / (1 - level));
  const lmr = logMarginalRatio(k, n, prior);
  const logE = (p: number): number => lmr - logLik(k, n, p);
  const pHat = k / n; // logE(pHat) ≤ 0 < threshold always: the MLE is never excluded

  // Bisect logE(p) = threshold on each side of the minimum (quasi-convexity
  // makes each side monotone). 60 halvings ⇒ ~1e-18 precision.
  const bisect = (lo: number, hi: number, risingTowardLo: boolean): number => {
    for (let i = 0; i < 60; i++) {
      const mid = (lo + hi) / 2;
      const above = logE(mid) >= threshold;
      if (above === risingTowardLo) lo = mid;
      else hi = mid;
    }
    return (lo + hi) / 2;
  };

  const eps = 1e-15;
  const low = k === 0 ? 0 : bisect(eps, pHat, true);
  const high = k === n ? 1 : bisect(pHat, 1 - eps, false);
  return { low, high, level, n, k, prior, validityDomain: ANYTIME_VALIDITY_DOMAIN };
}
