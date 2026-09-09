/**
 * The bars themselves (WP-B05 remainder).
 *
 * `test/claim-uses.test.ts` checks the MACHINERY: that a minimum cannot be
 * stated on an unordered axis, that an unstated requirement admits nothing, that
 * two claims satisfying different things are incomparable. It says nothing about
 * whether the registry has anything to say, and three of the five doors were
 * declared with `requires: []` and one placeholder sentence shared between them.
 *
 * A shared placeholder is the tell. A reason that is genuinely about `roi` cannot
 * also be the reason about `model_recommendations`; identical prose across two
 * entries means the prose is about neither. So the gate below is: no two uses may
 * give the same reason. That fails loudly while a placeholder is doing duty for
 * three doors, and it keeps failing if the placeholder is copied under a new
 * name.
 *
 * WHAT THIS FILE DELIBERATELY DOES NOT ASSERT. That every door has a bar.
 * Leaving one unstated is a legitimate outcome — `admits` reports it as
 * `stated: false`, which means unexamined rather than passed — and the thing
 * worth checking about an unstated door is that somebody looked and said what
 * would have to be true, not that the field was filled in.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { admits } from '../src/epistemic/admissibility.ts';
import { CLAIM_USES, STATED_USES, USE_REQUIREMENTS, type ClaimUse } from '../src/epistemic/claim-uses.ts';
import { claimProfile, type ClaimProfile } from '../src/epistemic/profile.ts';

// ---------------------------------------------------------------------------
// The gate
// ---------------------------------------------------------------------------

test('no door is left with a bar nobody stated AND a reason nobody wrote', () => {
  // Two independent readings of "generic", because either alone is escapable.
  //
  // SHARED PROSE. A reason held by more than one use is not a reason about
  // either of them. This is what catches the original placeholder: one sentence,
  // three doors.
  const byReason = new Map<string, ClaimUse[]>();
  for (const use of CLAIM_USES) {
    const reason = USE_REQUIREMENTS[use].because;
    (byReason.get(reason) ?? byReason.set(reason, []).get(reason)!).push(use);
  }
  const shared = [...byReason.values()].filter((uses) => uses.length > 1).flat();

  // THE PLACEHOLDER'S OWN SIGNATURE, so copying it under three names does not
  // pass the check above.
  const placeholder = CLAIM_USES.filter(
    (use) => USE_REQUIREMENTS[use].because.includes('until the requirement is written here that list is the authority'),
  );

  const unexamined = [...new Set([...shared, ...placeholder])]
    .filter((use) => USE_REQUIREMENTS[use].requires.length === 0)
    .sort();

  assert.deepEqual(
    unexamined,
    [],
    `these uses state no bar and give no reason of their own: ${unexamined.join(', ')}`,
  );
});

test('a door left unstated says what would have to be true to state it', () => {
  // The escape hatch has to cost something, or it is the placeholder again with
  // better manners. An unstated door must name the specific obstacle — for `roi`,
  // that one profile cannot carry two deliberately different monetary bases.
  for (const use of CLAIM_USES) {
    const requirement = USE_REQUIREMENTS[use];
    if (requirement.requires.length > 0) continue;
    assert.match(
      requirement.because,
      /monetaryBasis|numerator|denominator|mixed/,
      `${use} is unstated without naming the axis that blocks stating it`,
    );
  }
});

// ---------------------------------------------------------------------------
// Fixtures: the profiles this repository actually issues
// ---------------------------------------------------------------------------

/**
 * `claim:value:realization:*` — `src/value/epistemic.ts`. The repository's only
 * outcome attribution, and the reason the bar below has no causality rung.
 */
const REALIZATION: ClaimProfile = claimProfile({
  epistemic: 'supported', integrity: 'verified', authenticity: 'self_asserted', scope: 'conditional',
  coverage: 'complete', measurement: 'proxy_unvalidated', causality: 'none', monetaryBasis: 'effective',
  finality: 'provisional', decisionFitness: 'not_assessed',
});

/** `claim:decision:*` at `decision.fitness_sufficient` — `src/decision/epistemic.ts`. */
const PROVEN_DOMINANT: ClaimProfile = claimProfile({
  epistemic: 'supported', integrity: 'verified', authenticity: 'self_asserted', scope: 'conditional',
  coverage: 'complete', measurement: 'proxy_unvalidated', causality: 'none', monetaryBasis: 'none',
  finality: 'provisional', decisionFitness: 'sufficient',
});

/** `claim:causal:effect:*` — `src/causal/epistemic.ts`, on a pre-registered surrogate. */
const RANDOMIZED_EFFECT: ClaimProfile = claimProfile({
  ...PROVEN_DOMINANT, measurement: 'proxy_validated', causality: 'randomized', decisionFitness: 'not_assessed',
});

// ---------------------------------------------------------------------------
// outcome_attribution
// ---------------------------------------------------------------------------

test('outcome attribution is admissible with no causal identification at all', () => {
  // THE ANSWER THE BAR HAD TO GIVE EXPLICITLY. Attribution is a claim over a
  // scope — this outcome fell inside this bounded unit of work — and causation is
  // a claim about what produced it. The repository's only outcome attribution,
  // `value.realization_recorded`, is issued at `causality: 'none'` with an
  // assumption saying in words that it is not a causal claim. A causality rung
  // here would bar the realization ledger from the use it exists for, and would
  // quietly redefine attribution as causation.
  assert.equal(REALIZATION.causality, 'none');
  const verdict = admits(REALIZATION, USE_REQUIREMENTS.outcome_attribution);
  assert.equal(verdict.stated, true);
  assert.equal(verdict.admitted, true);
  assert.deepEqual([...verdict.unmet], []);
});

test('outcome attribution refuses an absence nobody established', () => {
  // `src/measurement/completeness.ts`: absence in an observation stream is not
  // evidence of absence without positive evidence that the source was complete.
  // Half of "this work realized" is the negative half — not reverted, no linked
  // incident — so on partial coverage "no revert was observed" becomes "no revert
  // occurred", and the outcome may already have been undone.
  const partial = claimProfile({ ...REALIZATION, coverage: 'partial' });
  const verdict = admits(partial, USE_REQUIREMENTS.outcome_attribution);
  assert.equal(verdict.admitted, false);
  assert.deepEqual([...verdict.unmet], [{ axis: 'coverage', needed: 'at least complete', actual: 'partial' }]);
});

test('outcome attribution refuses a contradicted outcome and an unnamed population', () => {
  // `src/outcomes/CONTEXT.md`: unknown evidence never becomes confirmation and
  // conflict never becomes confirmation. Attribution is the step that turns an
  // outcome into credit, so it inherits that invariant rather than restating it.
  const conflicted = claimProfile({ ...REALIZATION, epistemic: 'conflicted' });
  assert.deepEqual(
    [...admits(conflicted, USE_REQUIREMENTS.outcome_attribution).unmet],
    [{ axis: 'epistemic', needed: 'one of supported', actual: 'conflicted' }],
  );

  // An attribution whose scope is unknown attributes to nothing in particular;
  // one whose scope is known to be missing members may be crediting a member the
  // scope does not contain.
  const unscoped = claimProfile({ ...REALIZATION, scope: 'incomplete' });
  assert.deepEqual(
    [...admits(unscoped, USE_REQUIREMENTS.outcome_attribution).unmet],
    [{ axis: 'scope', needed: 'at least conditional', actual: 'incomplete' }],
  );
});

// ---------------------------------------------------------------------------
// model_recommendations
// ---------------------------------------------------------------------------

test('a model recommendation needs a proven decision AND a surrogate that was bridged', () => {
  // Two axes that cannot substitute for one another, which is the founding rule
  // of `admissibility.ts` applied to the one use that spends money on being
  // wrong.
  //
  //   decisionFitness — `sufficient` is issued in exactly one place, on a
  //   certificate proving strict interval dominance over every rival action.
  //   `insufficient` means the intervals were checked and overlapped;
  //   recommending on an overlap is recommending noise.
  //
  //   measurement — dominance ON A SURROGATE is dominance on the surrogate.
  //   `src/measurement/surrogate.ts` exists to say when a surrogate may be read
  //   as its target, and a recommendation to move work to another model acts on
  //   that reading with future spend behind it.
  const atBar = claimProfile({ ...PROVEN_DOMINANT, measurement: 'proxy_validated' });
  assert.equal(admits(atBar, USE_REQUIREMENTS.model_recommendations).admitted, true);

  // Each real claim in the tree clears one half and not the other, which is what
  // makes the pair a requirement rather than a restatement.
  assert.deepEqual(
    [...admits(PROVEN_DOMINANT, USE_REQUIREMENTS.model_recommendations).unmet],
    [{ axis: 'measurement', needed: 'at least proxy_validated', actual: 'proxy_unvalidated' }],
  );
  assert.deepEqual(
    [...admits(RANDOMIZED_EFFECT, USE_REQUIREMENTS.model_recommendations).unmet],
    [{ axis: 'decisionFitness', needed: 'at least sufficient', actual: 'not_assessed' }],
  );
});

test('a model recommendation states no monetary basis, and that is the finding', () => {
  // The one claim that can reach `decisionFitness: sufficient` carries
  // `monetaryBasis: 'none'` — the dominance is over declared utility intervals,
  // not over a dollar figure. A membership bar on the monetary axis would refuse
  // the only claim shape capable of clearing this door, so the four hand-written
  // exclusion lists that bar allocated, billed and provider-observed figures from
  // model recommendations remain the authority on that axis.
  assert.equal(PROVEN_DOMINANT.monetaryBasis, 'none');
  const axes = USE_REQUIREMENTS.model_recommendations.requires.map((part) => part.axis).sort();
  assert.deepEqual(axes, ['decisionFitness', 'measurement']);
});

// ---------------------------------------------------------------------------
// roi
// ---------------------------------------------------------------------------

test('roi is still unexamined, and reports itself as unexamined rather than passed', () => {
  // Not an oversight and not a failure. `roi` divides a value claim by a cost
  // claim, and `admits` tests ONE profile — so the requirement that decides the
  // use, that the two sides be the quantities they are supposed to be, has no
  // form in this vocabulary. See the reason recorded on the entry.
  const verdict = admits(REALIZATION, USE_REQUIREMENTS.roi);
  assert.equal(verdict.stated, false);
  assert.equal(verdict.admitted, false, 'an unasked question is not a passed test');
  assert.deepEqual([...verdict.unmet], []);
  assert.equal(STATED_USES.includes('roi'), false);

  // And the two examined this round are reported as examined, so the flag above
  // is a finding rather than this registry's only output.
  assert.deepEqual(
    [...STATED_USES].sort(),
    ['budget_enforcement', 'model_recommendations', 'outcome_attribution', 'request_metered_spend'],
  );
});
