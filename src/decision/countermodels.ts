/** Decision-domain countermodels for interval-certificate assumptions (WP-B04). */

import {
  certifyDecision,
  type ActionUtilityInterval,
  type DecisionCertificate,
} from './engine.ts';
import {
  countermodel,
  minimalInvalidatingAssumptionSets,
  type CertificationStructure,
  type Countermodel,
  type InvalidatingSetOptions,
  type MinimalInvalidatingSets,
} from '../epistemic/countermodel.ts';

function comparisonWorld(certificate: DecisionCertificate): string {
  const uncertain = certificate.comparisons
    .filter((comparison) => comparison.margin === null || comparison.margin <= 0)
    .map((comparison) => comparison.action);
  if (uncertain.length > 0) {
    return `The admissible utility intervals for ${uncertain.join(', ')} overlap a rival interval, so the strict lower-bound separation is not observed.`;
  }
  return 'A future admissible world changes an interval endpoint enough to remove the strict lower-bound separation from the strongest rival.';
}

/**
 * Generate explicit, actionable witnesses for every assumption named by the
 * interval decision certificate. These are live countermodels, not evidence
 * that the decision is wrong; each names the observation that could exclude it.
 */
export function decisionCountermodels(
  actions: ReadonlyArray<ActionUtilityInterval>,
): readonly Countermodel[] {
  const certificate = certifyDecision(actions);
  const firstComparison = certificate.comparisons[0];
  if (firstComparison === undefined) throw new Error('decision certificate has no comparisons');
  const selectedAction = certificate.action ?? firstComparison.action;

  return Object.freeze(certificate.assumptions.map((assumption, index) => {
    let world: string;
    let claimBecomes: string;
    let excludedBy: string;

    if (index === 0) {
      world = 'The true utility of at least one action lies outside its supplied interval, so the interval is not a bound over every admissible world.';
      claimBecomes = 'The decision is not certified because the interval evidence cannot support the dominance claim.';
      excludedBy = 'An independently validated utility-bound witness for every action.';
    } else if (index === 1) {
      world = 'Action utilities are jointly constrained rather than independently variable, so a rectangular uncertainty world is not jointly admissible.';
      claimBecomes = 'The decision is not certified by rectangular interval reasoning because the declared joint uncertainty model is unsupported.';
      excludedBy = 'A documented joint uncertainty model that establishes the rectangular assumption.';
    } else if (index === 2) {
      world = comparisonWorld(certificate);
      claimBecomes = `The decision is not certified as strictly dominant: ${selectedAction} does not have a positive lower-bound margin over every rival.`;
      excludedBy = 'A bounded utility observation that establishes a positive lower-bound margin over every rival.';
    } else {
      throw new Error(`no decision countermodel template exists for assumption ${index}`);
    }

    return countermodel({
      id: `countermodel:decision:${index + 1}`,
      violates: assumption,
      world,
      claimBecomes,
      excludedBy,
      status: 'live',
    });
  }));
}

/**
 * The support structure of a strict-interval-dominance certificate.
 *
 * WHICH OF THE THREE ASSUMPTIONS ARE LOAD-BEARING, AND WHY IT IS TWO. There is
 * one way this certificate is carried, so there is one support, and it contains
 * the two assumptions `certifyDecision` actually uses:
 *
 *   [0] the interval bound. Without it `low` and `high` are not bounds over the
 *       admissible worlds, and the margin arithmetic compares two numbers that
 *       bound nothing.
 *   [2] the strict-dominance criterion. It IS the rule the certificate applies;
 *       withdraw it and a positive margin certifies nothing.
 *
 * [1] — rectangular interval uncertainty — is not in the support, and this is a
 * substantive claim rather than an oversight. `certifyDecision` compares one
 * action's `low` against the largest rival `high`. Both are guaranteed by [0]
 * alone in every admissible world, whatever the joint structure of the
 * uncertainty set: strict interval dominance never needs the actions to vary
 * independently. Rectangularity is a REGRET assumption, and `minimaxRegret` is
 * where it does work. So its failure leaves this certificate exactly where it
 * was, and the result reports it as inert.
 *
 * THIS DOES NOT CONTRADICT `decisionCountermodels`. That function's second
 * world says the decision "is not certified BY RECTANGULAR INTERVAL REASONING",
 * which is a statement about a route that becomes unavailable, not about this
 * certificate falling. The two are saying different things about the same
 * assumption and both are narrow; they are recorded together here so that a
 * later reader does not have to reconstruct which is which.
 */
export function decisionCertificationStructure(
  certificate: DecisionCertificate,
): CertificationStructure {
  const assumptions = [...certificate.assumptions];
  const bound = assumptions[0];
  const criterion = assumptions[2];
  if (bound === undefined || criterion === undefined) {
    throw new Error('decision certificate does not state the assumptions this structure is written against');
  }
  return Object.freeze({
    assumptions: Object.freeze(assumptions),
    certified: certificate.status === 'proven_dominant',
    supports: Object.freeze([Object.freeze([bound, criterion])]),
  });
}

/**
 * The decision domain's adapter for the dossier's
 * `minimalInvalidatingAssumptionSets(decision)`.
 *
 * NOT REACHED BY ANY PRODUCT SURFACE, and deliberately left that way. Nothing
 * outside `src/decision/` imports this module or `./engine.ts`; the boundaries
 * `decision.certificate` and `decision.certificate.issuance` are both classified
 * `unreached` in `src/epistemic/issuance-map.ts`, and that classification is
 * correct as of this commit. So this is a mechanism built and not wired: the
 * only domain that can currently put a "why is this not certified?" witness in
 * front of an operator is the reconciliation domain, through
 * `src/billing/countermodels.ts` and `fiscus billing reconcile`. The value
 * domain emits no countermodels at all — `src/value/` does not import
 * `countermodel.ts` — so it cannot produce such a witness either.
 *
 * Wiring this into a surface is an architecture and product-behaviour change
 * that the owner has not weighed in on, and it is not made here.
 */
export function decisionInvalidatingAssumptionSets(
  actions: ReadonlyArray<ActionUtilityInterval>,
  options?: InvalidatingSetOptions,
): MinimalInvalidatingSets {
  return minimalInvalidatingAssumptionSets(decisionCertificationStructure(certifyDecision(actions)), options);
}
