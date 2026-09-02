/**
 * The reconciliation residual's countermodels (WP-B04).
 *
 * ISSUANCE CLASS: kernel_primitive — see `src/epistemic/issuance-map.ts`.
 *
 * `ReconciliationRun.conditions` lists five permanent limits of the result, and
 * `describeOffPathBound` states in one sentence what the residual licenses. Both
 * are true and neither is actionable, because a condition tells a reader that
 * the conclusion depends on something without telling them what the world looks
 * like when it does not hold, or whether anything they have could tell them
 * apart. This file writes those worlds down.
 *
 * THE ALGEBRA THEY ATTACH TO, restated so the worlds below are checkable rather
 * than atmospheric. With P the provider's reported total on the declared scope,
 * L what Fiscus metered on it, T the true billed cost of on-path traffic and O
 * the true billed cost of off-path traffic:
 *
 *     P = T + O        R = P - L = O + (T - L)        so   O <= R  iff  L <= T
 *
 * Every countermodel here is a way for one of those identities to hold with
 * different quantities than the reader assumes.
 *
 * FOUR OF THE FIVE CANNOT BE EXCLUDED BY ANYTHING FISCUS HAS, and that is the
 * finding rather than a gap in the file. They carry `excludedBy: null`, which
 * makes the residual PERMANENTLY conditional rather than pending a check an
 * operator could go and do. The fifth — whether a person handed Fiscus the
 * provider's numbers — names a real discriminator, so it is the one an operator
 * can actually close, by pointing Fiscus at the provider instead.
 *
 * ONE OF THEM IS NOT MERELY LIVE. When the residual is negative, `L > P >= T`,
 * which REFUTES `L <= T` outright: the rate-card over-pricing world is not an
 * unexcluded possibility, it is established. That is `realized`, and it is the
 * D-068 finding — a residual at or below zero bounds nothing — stated as a
 * property of the claim's assumptions rather than as a sentence beneath the
 * number. `claimHoldsAsStated` goes false with it.
 */

import { countermodel, type Countermodel } from '../epistemic/countermodel.ts';
import type { ReconciliationCondition, ReconciliationRun } from './reconcile.ts';

/**
 * One countermodel per condition, keyed by the condition itself so the two
 * cannot drift: a condition added to `ReconciliationCondition` without a world
 * here fails to type-check.
 */
const WORLDS: Readonly<Record<ReconciliationCondition, {
  readonly world: string;
  readonly claimBecomes: string;
  readonly excludedBy: string | null;
}>> = Object.freeze({
  local_route_scope_is_not_provider_verified: {
    world:
      'The declared route scope does not match the set of traffic the provider actually billed to this project — the provider is billing usage from a key or route the declaration does not name, or is excluding usage it does name.',
    claimBecomes:
      'P and L are totals over DIFFERENT populations, so R is not a residual over one scope and bounds nothing. The figure is a difference between two unrelated sums.',
    // Deciding this needs the provider to attest which traffic it billed to the
    // scope. No provider surface Fiscus reads does that, and a local
    // declaration cannot verify itself.
    excludedBy: null,
  },
  off_path_provider_usage_is_not_observable: {
    world:
      'Some traffic on this scope never passed through Fiscus at all, so O > 0 by an amount nothing local observed.',
    claimBecomes:
      'The claim was never that O is zero, and remains an upper bound. What changes is that a small R stops being reassuring: it is consistent with a large O offset by an equally large local over-estimate.',
    // This is the condition the residual exists to bound rather than to answer,
    // and no local observation can see traffic that did not pass through.
    excludedBy: null,
  },
  provider_line_items_do_not_join_to_requests_or_models: {
    world:
      'The provider report and the local ledger agree on the period total while disagreeing about every request inside it — the same sum reached from a different composition.',
    claimBecomes:
      'A residual near zero stops implying agreement about anything but the total. Per-model and per-request conclusions drawn from the two sides cannot be reconciled, because there is no key on which to reconcile them.',
    // The join key does not exist in the provider's data. Nothing Fiscus does
    // locally creates one.
    excludedBy: null,
  },
  local_request_amounts_are_rate_card_estimates: {
    world:
      'The rate card over-prices on-path traffic, so L > T — discounts, committed-use pricing, a stale card, or a tier the matcher did not model.',
    claimBecomes:
      'The condition `L <= T` fails, so `O <= R` fails with it. The residual understates off-path spend by exactly the amount of the over-estimate, and R can be small or negative while O is large.',
    // A provider line-item join priced at billed rates would settle it, and the
    // condition above says that join does not exist. This is the interaction the
    // conditions list cannot express as a flat list.
    excludedBy: null,
  },
  provider_report_is_operator_supplied_and_unverified: {
    world:
      'The provider totals were pasted in by a person and do not match what the provider would report — a wrong period, a wrong project, a stale export, or a transcription error.',
    claimBecomes:
      'P is not the provider’s figure, so R is a comparison between the local ledger and a document of unknown provenance. Nothing about the provider follows from it.',
    excludedBy:
      'Fiscus fetching the report from the provider itself, which is recorded on the run as its provider source kind.',
  },
});

/**
 * Build the countermodels for one reconciliation run.
 *
 * Status comes from evidence on the run, never from judgement, and exactly one
 * of these is evidence-driven: the rate-card world is `realized` when the
 * residual is negative, because `R < 0` establishes `L > T` rather than leaving
 * it open. The rest are `live` — nothing on the run decides them.
 *
 * A condition absent from the run yields no countermodel. The fifth condition
 * appears only when the report WAS operator-supplied, so on a fetched run there
 * is no such assumption to violate, and emitting a world for it would assess an
 * assumption the claim does not make — which `assessAssumptionFragility`
 * rejects, correctly. Nothing here is ever `excluded`, and the file should not
 * pretend otherwise: a condition Fiscus can rule out does not survive as a
 * condition in the first place.
 */
export function reconciliationCountermodels(run: ReconciliationRun): readonly Countermodel[] {
  const overEstimated = run.offPathBound === 'none_local_estimate_exceeds_provider';
  return Object.freeze(run.conditions.map((condition) => {
    const shape = WORLDS[condition];
    const realized = condition === 'local_request_amounts_are_rate_card_estimates' && overEstimated;
    return countermodel({
      id: `countermodel:billing:${condition}`,
      violates: condition,
      world: shape.world,
      claimBecomes: shape.claimBecomes,
      excludedBy: shape.excludedBy,
      status: realized ? 'realized' : 'live',
    });
  }));
}
