/**
 * The uses a figure can be put to in this product, in one vocabulary (WP-B05).
 *
 * NOT A MAPPED BOUNDARY. Like `admissibility.ts` and `countermodel.ts` it sits
 * inside the kernel and issues nothing; it names the doors and, where the
 * repository has actually stated one, the bar for getting through.
 *
 * WHY THIS EXISTS. Four surfaces bar a figure from downstream uses, each with a
 * hand-written array literal, and they did not agree:
 *
 *   `src/alloc/exact.ts`, `src/billing/reconcile.ts`, `src/billing/openaiCosts.ts`
 *       four names, and in the allocation case a validator rejecting any others
 *   `src/billing/mapping.ts`          three
 *   `src/dashboard/routes.ts`         five, twice — `outcome_attribution`
 *                                     appeared nowhere else under `src/`
 *
 * Three vocabularies for one question. Each was pinned by a passing test and
 * nothing compared them, so the disagreement was asserted twice and detected
 * never — including a case where the dashboard displayed a recorded
 * reconciliation run and printed an exclusion list beside it that contradicted
 * the one the record carried, under a comment explaining that this route reads
 * records precisely so the page cannot disagree with them.
 *
 * A DOOR WITH NO STATED LOCK IS RECORDED AS ONE, NEVER FILLED IN. Inventing a
 * threshold would be asserting product policy as though it were derived, which
 * is the precise move the whole epistemic standard here exists to prevent.
 * `admits` reports an unstated bar as `stated: false`, which means unexamined,
 * not passed — and the hand-written lists remain authoritative for it.
 *
 * ONE OF THE FIVE IS STILL UNSTATED, AND THE REASON IS STRUCTURAL RATHER THAN
 * PENDING. `roi` divides a value claim by a cost claim. `admits` tests ONE
 * profile, and `monetaryBasis` collapses any disagreement to `mixed`, so the
 * requirement that actually decides the use — that the numerator and the
 * denominator are each the quantity they are supposed to be — has no form in
 * this vocabulary. Stating the axes that DO fit would report `stated: true` for
 * a question nobody answered, and would start ordering billed against metered
 * `compareForUse` on axes the use does not turn on. See the entry.
 */

import { useRequirement, type UseRequirement } from './admissibility.ts';

/**
 * Every use any surface in this repository bars a figure from. The union of the
 * three vocabularies, so adopting it loses nothing that was being said.
 */
export const CLAIM_USES = [
  'request_metered_spend',
  'budget_enforcement',
  'outcome_attribution',
  'roi',
  'model_recommendations',
] as const;

export type ClaimUse = (typeof CLAIM_USES)[number];

/**
 * What a profile must reach to be admitted, per use.
 *
 * The `Record` is exhaustive by type, so a use added above without an entry
 * fails to compile.
 */
export const USE_REQUIREMENTS: Readonly<Record<ClaimUse, UseRequirement>> = Object.freeze({
  request_metered_spend: useRequirement({
    id: 'request_metered_spend',
    // Definitional rather than policy: this use IS the metered figure. The only
    // builder in `src/dashboard/claim-support.ts` producing `list` or `mixed` is
    // the metered one — `list` when every request was priced from the rate card
    // and `mixed` when some were estimated — and a billed, allocated or
    // provider-observed total is a different economic quantity wearing the same
    // dollar sign.
    requires: [{ axis: 'monetaryBasis', oneOf: ['list', 'mixed'] }],
    because:
      'The metered spend figure is the local rate-card read of requests Fiscus routed. A provider-billed, '
      + 'allocated or provider-observed total is a different quantity, and substituting one silently '
      + 'redefines the number rather than improving it.',
  }),
  budget_enforcement: useRequirement({
    id: 'budget_enforcement',
    // Two parts, both already stated elsewhere. The basis is the same
    // definitional point as above — enforcement gates the traffic Fiscus routes,
    // which is exactly the metered population. The epistemic membership is the
    // fail-closed rule in CLAUDE.md: `conflicted` is what `billedClaimSupport`
    // returns when snapshots disagree, and a figure whose own sources contradict
    // each other must not be the thing that decides whether a request proceeds.
    requires: [
      { axis: 'monetaryBasis', oneOf: ['list', 'mixed'] },
      { axis: 'epistemic', oneOf: ['supported'] },
    ],
    because:
      'Enforcement gates the traffic Fiscus can see and stop, which is the metered population, and it '
      + 'fails closed: a figure that is unknown, refuted or self-contradictory must not be the one '
      + 'deciding whether a request proceeds.',
  }),
  outcome_attribution: useRequirement({
    id: 'outcome_attribution',
    // THE AXIS THIS BAR DELIBERATELY DOES NOT NAME IS `causality`, and saying so
    // is most of the point. Attribution is a claim OVER A SCOPE — this outcome
    // fell inside this bounded unit of work — and causation is a claim about
    // what produced it. The repository's only outcome attribution,
    // `claim:value:realization:*` in `src/value/epistemic.ts`, is issued at
    // `causality: 'none'` carrying an assumption that says in words it is not a
    // causal claim. A causality rung here would bar the realization ledger from
    // the use it exists for, and would redefine attribution as causation in the
    // one place nobody would look for that.
    //
    // `measurement` is left out for the same kind of reason and the opposite
    // conclusion from `model_recommendations` below: the realization funnel is
    // `proxy_unvalidated` and it ships as this product's attribution surface, so
    // requiring a bridged surrogate would bar the thing the door is for. What
    // separates the two is what the consumer DOES — a report of what happened
    // against a recommendation to spend differently.
    requires: [
      { axis: 'epistemic', oneOf: ['supported'] },
      { axis: 'scope', atLeast: 'conditional' },
      { axis: 'coverage', atLeast: 'complete' },
    ],
    because:
      'Attributing an outcome to work is a claim over a named population, not a causal claim, so no causal '
      + 'identification is required and a claim at causality "none" is admissible. What is required is that '
      + 'the population be named at all, that the outcome not be contradicted — unknown evidence never '
      + 'becomes confirmation and conflict never becomes confirmation — and that the evidence cover the '
      + 'scope completely, because half of "this work realized" is a negative claim, and on partial coverage '
      + '"no revert was observed" silently becomes "no revert occurred".',
  }),
  roi: useRequirement({
    id: 'roi',
    // UNSTATED, AND NOT FOR WANT OF LOOKING. Four shipped surfaces already bar
    // allocated, billed, provider-observed and operator-declared figures from
    // this use, so there is no shortage of material — the problem is that none
    // of it fits the shape a `UseRequirement` can take.
    requires: [],
    because:
      'RoI is a ratio of a realized-value claim to a cost claim, and the two are deliberately different '
      + 'quantities: the value side is issued at monetaryBasis "estimated" and the cost side at "list", '
      + '"estimated" or "effective". A UseRequirement bars ONE profile, and merging the two sides collapses '
      + 'monetaryBasis to "mixed" — the same sentinel a metered figure carries when some requests were '
      + 'estimated, and the same one a metered figure would carry if a billed total had been folded into it. '
      + 'So a membership bar admitting "mixed" admits the contamination it exists to catch, and one refusing '
      + '"mixed" refuses the ordinary case. To state this bar, either a requirement would have to range over '
      + 'a numerator and a denominator by name, or a profile would have to carry its constituent bases '
      + 'instead of collapsing them. Until then the hand-written exclusion lists are the authority, and '
      + 'stating the axes that do fit would report this door as examined when its deciding axis is not — and '
      + 'an unstated requirement is not a satisfied one.',
  }),
  model_recommendations: useRequirement({
    id: 'model_recommendations',
    // TWO AXES THAT CANNOT SUBSTITUTE FOR ONE ANOTHER, which is this module's
    // founding rule applied to the one use that spends money on being wrong.
    //
    //   decisionFitness — `sufficient` is issued in exactly one place,
    //   `src/decision/epistemic.ts`, on a certificate proving strict interval
    //   dominance over every rival action. `insufficient` means the intervals
    //   were checked and overlapped, and `not_assessed` means nobody asked;
    //   recommending on either is recommending noise with future spend behind
    //   it.
    //
    //   measurement — dominance ON A SURROGATE is dominance on the surrogate.
    //   `src/measurement/surrogate.ts` exists precisely to say when a surrogate
    //   may be read as its target, and it tops out at `proxy_validated`, so this
    //   rung is the strongest a surrogate can reach rather than an impossible
    //   one. Without it, "model B leads on realization rate" becomes "use model
    //   B", which is Goodhart with a routing change attached.
    //
    // NO MONETARY BAR, and that is a finding rather than an omission. The only
    // claim that reaches `decisionFitness: 'sufficient'` carries
    // `monetaryBasis: 'none'` — its dominance is over declared utility
    // intervals, not over a dollar figure — so a membership bar on that axis
    // would refuse the only claim shape capable of clearing this door. The four
    // hand-written lists barring allocated, billed and provider-observed figures
    // remain the authority there.
    requires: [
      { axis: 'measurement', atLeast: 'proxy_validated' },
      { axis: 'decisionFitness', atLeast: 'sufficient' },
    ],
    because:
      'A model recommendation is acted on: it moves future work, and therefore future spend, to a different '
      + 'model. So it needs a decision that was proven rather than assessed — strict interval dominance over '
      + 'every rival, not an overlap someone read a winner out of — and it needs the surrogate that decided '
      + 'it to have a stated relationship to the thing being optimised. Neither substitutes for the other: '
      + 'dominance on an unbridged proxy is dominance on the proxy. This is why the local model comparison in '
      + 'src/value/frontier.ts is review-only and never changes provider routing.',
  }),
});

/** Uses for which a bar has actually been written. */
export const STATED_USES: readonly ClaimUse[] = Object.freeze(
  CLAIM_USES.filter((use) => USE_REQUIREMENTS[use].requires.length > 0),
);

/** Is this one of the declared uses? Used to catch a name no registry knows. */
export function isClaimUse(value: string): value is ClaimUse {
  return (CLAIM_USES as readonly string[]).includes(value);
}
