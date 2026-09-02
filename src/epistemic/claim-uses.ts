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
 * MOST OF THESE HAVE NO STATED REQUIREMENT, AND THAT IS RECORDED RATHER THAN
 * FILLED IN. Only two bars below are grounded in something this repository
 * already establishes. The other three are real doors with no stated lock:
 * inventing thresholds for them would be asserting product policy as though it
 * were derived, which is the precise move the whole epistemic standard here
 * exists to prevent. `admits` reports them as `stated: false`, which means
 * unexamined, not passed — and the hand-written lists remain authoritative for
 * them until someone states the bar.
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

const UNSTATED = 'No bar has been stated for this use. The surfaces that bar figures from it do so by '
  + 'hand-written list, and until the requirement is written here that list is the authority — an '
  + 'unstated requirement is not a satisfied one.';

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
  outcome_attribution: useRequirement({ id: 'outcome_attribution', requires: [], because: UNSTATED }),
  roi: useRequirement({ id: 'roi', requires: [], because: UNSTATED }),
  model_recommendations: useRequirement({ id: 'model_recommendations', requires: [], because: UNSTATED }),
});

/** Uses for which a bar has actually been written. */
export const STATED_USES: readonly ClaimUse[] = Object.freeze(
  CLAIM_USES.filter((use) => USE_REQUIREMENTS[use].requires.length > 0),
);

/** Is this one of the declared uses? Used to catch a name no registry knows. */
export function isClaimUse(value: string): value is ClaimUse {
  return (CLAIM_USES as readonly string[]).includes(value);
}
