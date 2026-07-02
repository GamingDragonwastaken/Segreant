/**
 * The Shadow Price of Intelligence — what one more dollar of AI budget is worth,
 * optimally deployed, right now. (docs/RETURN-ON-INTELLIGENCE.md §9.)
 *
 * Every FinOps tool tells you where the money WENT. None tells you where the next
 * dollar SHOULD go, or whether it's worth spending at all. That is a constrained
 * optimization, and its solution carries a single, decision-grade number.
 *
 * Model each context's realized value as a concave (diminishing-returns) function
 * of the spend routed to it:
 *
 *      Vᵢ(s) = aᵢ · s^β ,      0 < β < 1
 *
 * Concavity is the honest default: the tenth dollar on a context returns less than
 * the first (easy wins land first; the context saturates). β is the elasticity of
 * value w.r.t. spend — disclosed, not forced (default 0.5 = strong diminishing
 * returns, the conservative planning choice), exactly like the Index's weights/θ.
 * We fit aᵢ from each context's observed (spend sᵢ, realized value Vᵢ): aᵢ = Vᵢ/sᵢ^β.
 *
 * Maximizing total realized value Σ Vᵢ(sᵢ) subject to a fixed budget Σ sᵢ = B is a
 * classic water-filling problem. Its Lagrangian ℒ = Σ aᵢsᵢ^β − μ(Σsᵢ − B) has the
 * first-order condition Vᵢ′(sᵢ) = aᵢβsᵢ^{β−1} = μ for every funded context — i.e.
 * **at the optimum every dollar earns the same marginal return μ**, the Lagrange
 * multiplier. Because the objective is homogeneous of degree β, Euler's theorem
 * gives the whole thing in closed form:
 *
 *      optimal split   sᵢ* = B · wᵢ / Σⱼ wⱼ ,     wᵢ = aᵢ^{1/(1−β)}
 *      shadow price    μ  = β · V*(B) / B        (V* = total value at the optimum)
 *
 * **μ is the headline.** μ ≥ 1 ⟺ the next AI dollar returns more than a dollar of
 * realized value — you are under-invested. μ < 1 ⟺ the next dollar returns less —
 * you are past the point of positive marginal return and should cut, not grow. And
 * because the split follows aᵢ^{1/(1−β)} rather than aᵢ itself, concavity forbids
 * winner-take-all: a great context gets more budget, never all of it — the honest
 * antidote to "pour everything into the one model that scored highest."
 *
 * PURE (no store/git). Assumes the fitted concave form holds at the margin — a
 * planning estimate under "the shape persists", never a guarantee; the assumption
 * travels with the output.
 */

export interface MarginalContext {
  key: string;
  costUsd: number; // current spend routed to this context
  realizedValueUsd: number; // realized value it returned (net of rework upstream)
}

export interface OptimalSpend {
  key: string;
  currentUsd: number;
  optimalUsd: number;
  deltaUsd: number; // optimalUsd − currentUsd
  marginalReturn: number; // Vᵢ′ at current spend — the return on this context's NEXT dollar
}

export interface ShadowPriceReport {
  budgetUsd: number; // B — the total held fixed
  beta: number; // the disclosed diminishing-returns elasticity used
  shadowPriceUsd: number; // μ — realized value per marginal AI dollar at the optimum
  currentValueUsd: number; // V0 — realized value under the current split
  optimalValueUsd: number; // V* — realized value if the SAME budget were split optimally
  upliftUsd: number; // V* − V0 — free value from reallocating, no new spend
  paysAtMargin: boolean; // μ ≥ 1
  items: OptimalSpend[];
  assumptions: string[];
}

/** Marginal return of Vᵢ(s)=aᵢs^β at spend s: aᵢβs^{β−1} = β·Vᵢ/sᵢ evaluated at sᵢ. */
function marginalAt(costUsd: number, realizedValueUsd: number, beta: number): number {
  if (costUsd <= 0) return 0;
  return (beta * realizedValueUsd) / costUsd;
}

/**
 * Solve the water-filling optimum and report the shadow price. Contexts with no
 * spend or no realized value contribute no weight (they get nothing until they
 * show a return). Falls back to the status quo when there is nothing to optimize.
 */
export function shadowPriceOfIntelligence(
  contexts: MarginalContext[],
  opts: { beta?: number } = {},
): ShadowPriceReport {
  const beta = Math.min(0.95, Math.max(0.05, opts.beta ?? 0.5));
  const budgetUsd = contexts.reduce((s, c) => s + Math.max(0, c.costUsd), 0);
  const currentValueUsd = contexts.reduce((s, c) => s + Math.max(0, c.realizedValueUsd), 0);

  const assumptions = [
    `Value is modeled as concave in spend, Vᵢ(s)=aᵢ·s^${beta} (β=${beta}, disclosed) — diminishing returns fit from each context's observed spend and realized value.`,
    'The shape is assumed to hold at the margin — a planning estimate, not a guarantee. Re-measure after reallocating.',
  ];

  // weight wᵢ = aᵢ^{1/(1−β)} = (Vᵢ / sᵢ^β)^{1/(1−β)} for contexts that have both spend and value.
  const exp = 1 / (1 - beta);
  const weighted = contexts.map((c) => {
    const s = Math.max(0, c.costUsd);
    const v = Math.max(0, c.realizedValueUsd);
    const a = s > 0 && v > 0 ? v / s ** beta : 0;
    return { c, w: a > 0 ? a ** exp : 0, a };
  });
  const wSum = weighted.reduce((acc, x) => acc + x.w, 0);

  if (budgetUsd <= 0 || wSum <= 0) {
    return {
      budgetUsd,
      beta,
      shadowPriceUsd: 0,
      currentValueUsd,
      optimalValueUsd: currentValueUsd,
      upliftUsd: 0,
      paysAtMargin: false,
      items: contexts.map((c) => ({ key: c.key, currentUsd: c.costUsd, optimalUsd: c.costUsd, deltaUsd: 0, marginalReturn: 0 })),
      assumptions,
    };
  }

  const items: OptimalSpend[] = weighted.map(({ c, w }) => {
    const optimalUsd = (budgetUsd * w) / wSum;
    return {
      key: c.key,
      currentUsd: c.costUsd,
      optimalUsd,
      deltaUsd: optimalUsd - c.costUsd,
      marginalReturn: marginalAt(c.costUsd, c.realizedValueUsd, beta),
    };
  });

  // V* = Σ aᵢ (sᵢ*)^β  ;  shadow price μ = β·V*/B (Euler, homogeneous degree β).
  const optimalValueUsd = weighted.reduce((acc, x) => acc + (x.a > 0 ? x.a * ((budgetUsd * x.w) / wSum) ** beta : 0), 0);
  const shadowPriceUsd = (beta * optimalValueUsd) / budgetUsd;

  return {
    budgetUsd,
    beta,
    shadowPriceUsd,
    currentValueUsd,
    optimalValueUsd,
    upliftUsd: optimalValueUsd - currentValueUsd,
    paysAtMargin: shadowPriceUsd >= 1,
    items,
    assumptions,
  };
}
