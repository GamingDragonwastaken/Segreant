/** Decision-domain countermodels for interval-certificate assumptions (WP-B04). */

import {
  certifyDecision,
  type ActionUtilityInterval,
  type DecisionCertificate,
} from './engine.ts';
import { countermodel, type Countermodel } from '../epistemic/countermodel.ts';

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
