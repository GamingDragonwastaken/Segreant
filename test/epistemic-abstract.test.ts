/**
 * What a derivation CHAIN can establish, as opposed to what one step may do.
 *
 * THE COUNTEREXAMPLE, MEASURED. `assessDerivationLegality` requires a witness
 * for every axis a derivation strengthens — but it iterates `PROFILE_STRENGTH_AXES`,
 * and `monetaryBasis` is not in that list. It cannot be: the axis has no ladder,
 * so there is no `stronger()` comparison to make. The consequence is that the
 * rule places no constraint on it at all. Running it on a derivation whose input
 * claim carries `monetaryBasis: 'estimated'` and whose output carries `'billed'`:
 *
 *   input  monetaryBasis : estimated
 *   output monetaryBasis : billed
 *   allowed              : true
 *   requiredWitnesses    : []
 *   missingWitnesses     : []
 *
 * Zero required witnesses. And `EpistemicLedger.appendDerivationWithinTransaction`
 * checks every input claim — its own comment says so — against a rule that never
 * looks at the money axis, so the kernel stores it.
 *
 * THAT IS THE DISTINCTION THE WHOLE PRODUCT RESTS ON. `metered usage !=
 * provider-billed cost`. A local rate-card estimate re-declared as a
 * provider-billed amount, by a derivation the kernel accepts without complaint,
 * is that collapse performed inside the component that exists to prevent it.
 *
 * THE SECOND GAP IS STRUCTURAL RATHER THAN AXIS-SPECIFIC. `assessDerivationLegality`
 * checks one step against one input claim, and `assessPreservation` checks one
 * claim against its cited evidence. Nothing bounds what a whole chain licenses,
 * so a conclusion several merges downstream of its leaves was compared with its
 * immediate predecessors and with nothing else.
 *
 * `src/epistemic/abstract.ts` is the abstract interpretation: the domain is the
 * axis lattice, the transfer function is the derivation rule, and soundness is
 * "the concrete result is below the abstract bound". Recorded at D-151.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { claim, type Claim } from '../src/epistemic/claim.ts';
import { derivation, assessDerivationLegality, type Derivation } from '../src/epistemic/derivation.ts';
import { claimProfile, type ClaimProfile, type MonetaryBasisStatus } from '../src/epistemic/profile.ts';
import { scope } from '../src/epistemic/scope.ts';
import { grain } from '../src/epistemic/grain.ts';
import type { EpistemicState } from '../src/epistemic/state.ts';
import {
  analyzeDerivationChain,
  boundViolations,
  claimBound,
  derivedBound,
  meetClaimBounds,
  BASIS_DERIVATIONS,
  BOTTOM_BOUND,
  TOP_BOUND,
} from '../src/epistemic/abstract.ts';

const at = '2026-09-08T00:00:00.000Z';
const validTime = { from: '2026-09-01T00:00:00.000Z', to: '2026-09-07T00:00:00.000Z' };
const SCOPE = scope({ ledger: 'abstract-test' });
const GRAIN = grain(['request']);
const COORDINATE = { grain: GRAIN, scope: SCOPE };

function profile(overrides: Partial<ClaimProfile> = {}): ClaimProfile {
  return claimProfile({
    epistemic: 'supported',
    integrity: 'verified',
    authenticity: 'self_asserted',
    scope: 'conditional',
    coverage: 'complete',
    measurement: 'proxy_unvalidated',
    causality: 'none',
    monetaryBasis: 'estimated',
    finality: 'provisional',
    decisionFitness: 'not_assessed',
    ...overrides,
  });
}

function mk(id: string, overrides: Partial<ClaimProfile> = {}): Claim {
  const p = profile(overrides);
  return claim({
    id,
    proposition: { predicate: 'cost.amount', value: { id } as never },
    subject: 'abstract-test',
    scope: SCOPE,
    grain: GRAIN,
    time: { validTime, asOf: at },
    epistemic: p.epistemic,
    profile: p,
    measurementModelRef: p.measurement === 'proxy_unvalidated' ? null : `model:${id}`,
    evidenceIds: ['evidence:abstract-test'],
    derivationRule: 'abstract.test.v1',
    derivationVersion: 1,
    assumptions: [],
    uncertainty: { kind: 'qualitative', description: 'test fixture' },
    causalStatus: p.causality,
    monetaryBasis: p.monetaryBasis,
    finality: p.finality,
    issuedAt: at,
    supersedes: [],
    supersededBy: null,
    revocation: null,
    decisionCertificateIds: [],
    schemaVersion: 1,
  });
}

function step(id: string, inputs: readonly Claim[], output: Claim, witnesses: Derivation['witnesses'] = []): Derivation {
  return derivation({
    id,
    inputClaimIds: inputs.map((item) => item.id),
    inputEvidenceIds: ['evidence:abstract-test'],
    transformation: 'abstract.test.step.v1',
    outputClaimId: output.id,
    outputProposition: output.proposition,
    coordinateChange: { from: COORDINATE, to: COORDINATE },
    witnesses,
    assumptions: [],
    uncertaintyTransformation: 'none',
    version: 1,
    reproducibilityHash: `hash:${id}`,
  });
}

// ---------------------------------------------------------------------------
// THE COUNTEREXAMPLE.
// ---------------------------------------------------------------------------

test('the per-step rule places no constraint on the money axis, and this pins that', () => {
  // Not a regression guard on the abstraction — a record of the hole it exists
  // to cover. If `assessDerivationLegality` ever DOES require a witness here,
  // this assertion fails and the reason for `abstract.ts` has changed.
  const estimated = mk('claim:estimated', { monetaryBasis: 'estimated' });
  const billed = mk('claim:billed', { monetaryBasis: 'billed' });
  const rebase = step('derivation:rebase', [estimated], billed);

  const legality = assessDerivationLegality(estimated, billed, rebase);
  assert.equal(legality.allowed, true, 'measured: estimated -> billed is allowed today');
  assert.deepEqual(legality.requiredWitnesses, [], 'and requires no witness at all');
});

test('the abstraction refuses the re-basing the per-step rule allows', () => {
  const estimated = mk('claim:estimated', { monetaryBasis: 'estimated' });
  const billed = mk('claim:billed', { monetaryBasis: 'billed' });

  const bound = derivedBound([claimBound(estimated.profile)], []);
  const violations = boundViolations(billed.profile, bound);

  assert.equal(violations.length, 1);
  assert.equal(violations[0]?.axis, 'monetaryBasis');
  assert.match(violations[0]!.message, /billed is not supported by its chain/);
  // `none` is always available because dropping the economic quantity is a
  // weakening; acquiring one is not.
  assert.deepEqual([...bound.monetaryBasis].sort(), ['estimated', 'none']);
});

test('an undeclared re-basing stays undeclared, and the register is empty on purpose', () => {
  // An empty register means "nobody has declared one", not "none exist". A
  // default filled in to make the bound look useful would be the exact
  // inflation this module refuses.
  assert.deepEqual(BASIS_DERIVATIONS, []);

  const estimated = mk('claim:estimated', { monetaryBasis: 'estimated' });
  const allocated = mk('claim:allocated', { monetaryBasis: 'allocated' });
  const declared: ReadonlyArray<readonly [MonetaryBasisStatus, MonetaryBasisStatus]> = [['estimated', 'allocated']];

  const without = derivedBound([claimBound(estimated.profile)], []);
  assert.equal(boundViolations(allocated.profile, without).length, 1);

  const with_ = derivedBound([claimBound(estimated.profile)], [], { licensedBasisTransitions: declared });
  assert.deepEqual(boundViolations(allocated.profile, with_), [], 'a caller may declare its own re-basing');

  // And the declaration is directional: allocated does not run back to estimated.
  const back = derivedBound([claimBound(allocated.profile)], [], { licensedBasisTransitions: declared });
  assert.equal(boundViolations(estimated.profile, back).length, 1);
});

// ---------------------------------------------------------------------------
// The abstraction itself: which direction it errs in, and why that is the safe
// one. Every case below narrows rather than widens.
// ---------------------------------------------------------------------------

test('no inputs is BOTTOM, not TOP', () => {
  // The alternative reading — "unconstrained" — is how an empty requirement
  // becomes a passed one.
  assert.deepEqual(derivedBound([], []), BOTTOM_BOUND);
  const anything = mk('claim:anything');
  assert.ok(boundViolations(anything.profile, BOTTOM_BOUND).length > 0);
  assert.deepEqual(boundViolations(anything.profile, TOP_BOUND), []);
});

test('two inputs meet at the weaker of them, so one strong input cannot launder the other', () => {
  const strong = mk('claim:strong', { measurement: 'validated', integrity: 'verified' });
  const weak = mk('claim:weak', { measurement: 'proxy_unvalidated', integrity: 'unverifiable' });
  const bound = meetClaimBounds(claimBound(strong.profile), claimBound(weak.profile));

  assert.equal(bound.measurement, 'proxy_unvalidated');
  assert.equal(bound.integrity, 'unverifiable');
});

test('disagreeing monetary bases become mixed, and mixed is never a rung above billed', () => {
  const billed = mk('claim:billed', { monetaryBasis: 'billed' });
  const estimated = mk('claim:estimated', { monetaryBasis: 'estimated' });
  const bound = meetClaimBounds(claimBound(billed.profile), claimBound(estimated.profile));

  assert.deepEqual([...bound.monetaryBasis].sort(), ['mixed', 'none']);
  // The stronger-looking input does not survive the merge.
  assert.equal(bound.monetaryBasis.includes('billed'), false);
  assert.equal(bound.monetaryBasis.includes('estimated'), false);
});

test('a claim asserting no economic quantity has nothing to disagree with', () => {
  const none = mk('claim:none', { monetaryBasis: 'none' });
  const billed = mk('claim:billed', { monetaryBasis: 'billed' });
  const bound = meetClaimBounds(claimBound(none.profile), claimBound(billed.profile));
  assert.deepEqual([...bound.monetaryBasis].sort(), ['billed', 'none']);
});

test('a conflicted join admits only conflicted, never a collapse to supported', () => {
  const supported = mk('claim:supported', { epistemic: 'supported' });
  const refuted = mk('claim:refuted', { epistemic: 'refuted' });
  const bound = meetClaimBounds(claimBound(supported.profile), claimBound(refuted.profile));

  assert.deepEqual(bound.epistemic, ['conflicted' as EpistemicState]);
  assert.equal(boundViolations(supported.profile, bound).length, 1);
  assert.equal(boundViolations(refuted.profile, bound).length, 1);
});

test('a witness lifts its own axis and no other', () => {
  const weak = mk('claim:weak', { measurement: 'proxy_unvalidated', causality: 'none' });
  const lifted = derivedBound([claimBound(weak.profile)], ['measurement_validation']);
  assert.equal(lifted.measurement, 'validated');
  assert.equal(lifted.causality, 'none', 'a measurement witness does not license a causal claim');
});

// ---------------------------------------------------------------------------
// Chains. This is what nothing in `src/` did before.
// ---------------------------------------------------------------------------

test('a conclusion three steps downstream is checked against its leaves, not its neighbour', () => {
  const leaf = mk('claim:leaf', { measurement: 'proxy_unvalidated' });
  const mid = mk('claim:mid', { measurement: 'proxy_unvalidated' });
  const end = mk('claim:end', { measurement: 'validated' });

  const analysis = analyzeDerivationChain({
    claims: [leaf, mid, end],
    derivations: [step('d1', [leaf], mid), step('d2', [mid], end)],
  });

  assert.equal(analysis.withinBound, false);
  assert.deepEqual(analysis.leaves, ['claim:leaf']);
  const found = analysis.violations.find((item) => item.claimId === 'claim:end');
  assert.ok(found, 'the conclusion is the one that violates');
  assert.ok(found!.violations.some((item) => item.axis === 'measurement'));
  assert.equal(analysis.isProofOfTruth, false);
});

test('an input claim the caller did not supply bounds its conclusion at nothing', () => {
  // Unknown stays unknown. An absent input read as unconstrained is how a
  // missing prerequisite becomes a satisfied one.
  const end = mk('claim:end');
  const analysis = analyzeDerivationChain({
    claims: [end],
    derivations: [derivation({
      id: 'd:orphan',
      inputClaimIds: ['claim:absent'],
      inputEvidenceIds: ['evidence:abstract-test'],
      transformation: 'abstract.test.step.v1',
      outputClaimId: end.id,
      outputProposition: end.proposition,
      coordinateChange: { from: COORDINATE, to: COORDINATE },
      witnesses: [],
      assumptions: [],
      uncertaintyTransformation: 'none',
      version: 1,
      reproducibilityHash: 'hash:orphan',
    })],
  });

  assert.deepEqual(analysis.unresolvedInputs, ['claim:absent']);
  assert.equal(analysis.withinBound, false);
});

test('a chain whose every step is licensed reports no violation', () => {
  // A bound that refused everything would satisfy every assertion above while
  // making the analysis useless, and withholding a conclusion the chain does
  // support is its own epistemic failure.
  const leaf = mk('claim:leaf', { measurement: 'validated', monetaryBasis: 'billed' });
  const end = mk('claim:end', { measurement: 'validated', monetaryBasis: 'billed' });
  const analysis = analyzeDerivationChain({
    claims: [leaf, end],
    derivations: [step('d1', [leaf], end)],
  });

  assert.deepEqual(analysis.violations, []);
  assert.equal(analysis.withinBound, true);
  assert.equal(analysis.bounds.get('claim:end')?.measurement, 'validated');
});

test('a cyclic chain is refused rather than resolved', () => {
  const a = mk('claim:a');
  const b = mk('claim:b');
  assert.throws(
    () => analyzeDerivationChain({ claims: [a, b], derivations: [step('d1', [b], a), step('d2', [a], b)] }),
    /cyclic/,
  );
});

test('a derivation producing a claim outside the chain is refused, not ignored', () => {
  const a = mk('claim:a');
  const outside = mk('claim:outside');
  assert.throws(
    () => analyzeDerivationChain({ claims: [a], derivations: [step('d1', [a], outside)] }),
    /which is not in the chain/,
  );
});
