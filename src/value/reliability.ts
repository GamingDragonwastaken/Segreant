/**
 * Reliability — empirical-Bayes shrinkage so a context's return is trusted in
 * proportion to how much evidence backs it. (docs/RETURN-ON-INTELLIGENCE.md §8.)
 *
 * The flaw it fixes: a raw realization rate of 2/2 = 100% and 140/200 = 70% are
 * NOT equally trustworthy, yet a raw ranking treats them so — and the noisy small
 * cell then captures budget and "best model" recommendations. This is the classic
 * small-sample trap (the batting-average / hot-hand fallacy). Stein's result: an
 * estimator that shrinks each rate toward the population mean strictly beats the
 * raw rate in total squared error once there are ≥3 cells.
 *
 * The model is Beta–Binomial. Each context's realized/total is k of n Bernoulli
 * trials with its own success probability drawn from a shared Beta(α, β) prior.
 * Pool every context to estimate that prior — its mean μ = α/(α+β) and its
 * strength κ = α+β (in pseudo-observations) — then each context's RELIABLE rate is
 * the posterior mean
 *
 *      ρ̂ = (k + κ·μ) / (n + κ).
 *
 * A cell with little data is pulled to μ; a cell with lots of data barely moves.
 * κ is not hand-tuned — it is estimated from the dispersion of the cells (the
 * "empirical" in empirical Bayes): tightly-clustered cell rates ⟹ their spread is
 * noise ⟹ large κ ⟹ heavy shrinkage; widely-spread rates ⟹ real differences ⟹
 * small κ ⟹ light shrinkage. This module is PURE (no store, no git) so it composes
 * with the frontier + allocation and is property-testable.
 */

export interface BetaPrior {
  mean: number; // μ = α/(α+β), the population realization rate
  strength: number; // κ = α+β, in pseudo-observations (higher = shrink harder)
}

export interface Observation {
  k: number; // successes (realized units)
  n: number; // trials (matured units)
}

/**
 * Estimate the shared Beta prior from all contexts by method of moments on the
 * beta-binomial's extra-binomial variation (Williams 1982). With per-cell counts
 * (kᵢ, nᵢ), the marginal variance of kᵢ is nᵢμ(1−μ)[1 + (nᵢ−1)·ρ], where the
 * intraclass correlation ρ = 1/(κ+1). Matching the observed dispersion
 * X = Σ(kᵢ − nᵢμ)² to its expectation solves for ρ, hence κ.
 *
 *   ρ̂ = ( X/[μ(1−μ)] − N ) / Σ nᵢ(nᵢ−1),   κ = 1/ρ̂ − 1.
 *
 * Degenerate inputs (fewer than 2 cells, μ at a boundary, no over-dispersion)
 * carry no information to separate signal from noise, so we fall back to a strong
 * prior (heavy shrinkage) — the conservative choice, never an invented spread.
 */
export function estimateBetaPrior(
  obs: Observation[],
  opts: { minStrength?: number; maxStrength?: number } = {},
): BetaPrior {
  const minK = opts.minStrength ?? 1;
  const maxK = opts.maxStrength ?? 1000;
  const cells = obs.filter((o) => o.n > 0);
  const N = cells.reduce((s, o) => s + o.n, 0);
  const K = cells.reduce((s, o) => s + o.k, 0);
  const mean = N > 0 ? K / N : 0;

  if (cells.length < 2 || mean <= 0 || mean >= 1) return { mean, strength: maxK };

  const varTerm = mean * (1 - mean);
  const X = cells.reduce((s, o) => s + (o.k - o.n * mean) ** 2, 0);
  const sumNN1 = cells.reduce((s, o) => s + o.n * (o.n - 1), 0);
  if (sumNN1 <= 0) return { mean, strength: maxK };

  const icc = (X / varTerm - N) / sumNN1; // ρ = 1/(κ+1)
  if (!(icc > 0)) return { mean, strength: maxK }; // under-dispersed ⟹ spread is pure noise ⟹ shrink hard
  const strength = Math.min(maxK, Math.max(minK, 1 / icc - 1));
  return { mean, strength };
}

/** Posterior-mean (shrunken) rate for one context. Pulls toward prior.mean by κ. */
export function shrinkRate(k: number, n: number, prior: BetaPrior): number {
  const denom = n + prior.strength;
  return denom > 0 ? (k + prior.strength * prior.mean) / denom : prior.mean;
}

/**
 * How much of a context's own data we trust: n/(n+κ) ∈ [0,1]. 0 = the number is
 * entirely the population prior (no evidence); 1 = fully its own (abundant data).
 * A plain-language "confidence" for display next to any shrunken figure.
 */
export function reliability(n: number, prior: BetaPrior): number {
  const denom = n + prior.strength;
  return denom > 0 ? n / denom : 0;
}
