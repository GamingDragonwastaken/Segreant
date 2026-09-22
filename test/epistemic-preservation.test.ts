import { test } from 'node:test';
import assert from 'node:assert/strict';
import { claimProfile, type ClaimProfile, type ClaimProfileInput } from '../src/epistemic/profile.ts';
import { grain } from '../src/epistemic/grain.ts';
import { scope } from '../src/epistemic/scope.ts';
import { coordinateWitness } from '../src/epistemic/derivation.ts';
import {
  assessPreservation,
  type CitedEvidenceAbstract,
  type PreservationReasonCode,
  type PreservationAbstract,
} from '../src/epistemic/preservation.ts';

const strong: ClaimProfileInput = {
  epistemic: 'supported',
  integrity: 'verified',
  authenticity: 'provider_authenticated',
  scope: 'established',
  coverage: 'complete',
  measurement: 'validated',
  causality: 'observational',
  monetaryBasis: 'billed',
  finality: 'final',
  decisionFitness: 'sufficient',
};

const weak: ClaimProfileInput = {
  epistemic: 'unknown',
  integrity: 'unverifiable',
  authenticity: 'self_asserted',
  scope: 'conditional',
  coverage: 'partial',
  measurement: 'proxy_unvalidated',
  causality: 'none',
  monetaryBasis: 'billed',
  finality: 'provisional',
  decisionFitness: 'insufficient',
};

function abstract(
  profile: ClaimProfile,
  dimensions: readonly string[] = ['day'],
  scopeValues: Readonly<Record<string, string>> = { organization: 'acme' },
): PreservationAbstract {
  return { profile, coordinates: { grain: grain(dimensions), scope: scope(scopeValues) } };
}

function cited(
  id: string,
  profile: ClaimProfile,
  dimensions: readonly string[] = ['day'],
  scopeValues: Readonly<Record<string, string>> = { organization: 'acme' },
): CitedEvidenceAbstract {
  return { id, ...abstract(profile, dimensions, scopeValues) };
}

test('equal and weaker profiles are allowed without becoming a truth proof', () => {
  const source = cited('evidence:strong', claimProfile(strong));
  const equal = assessPreservation({
    proposed: abstract(claimProfile(strong)),
    citedEvidence: [source],
  });
  const weaker = assessPreservation({
    proposed: abstract(claimProfile(weak)),
    citedEvidence: [source],
  });

  assert.equal(equal.allowed, true);
  assert.equal(equal.verdict, 'allowed');
  assert.deepEqual(equal.missingReasons, []);
  assert.equal(equal.isProofOfTruth, false);
  assert.equal(weaker.allowed, true);
  assert.equal(weaker.verdict, 'allowed');
  assert.deepEqual(weaker.missingReasons, []);
});

test('integrity, authenticity, and coverage escalation are independently refused', () => {
  const source = cited('evidence:weak', claimProfile(weak));
  const escalations: ReadonlyArray<readonly [string, ClaimProfileInput, PreservationReasonCode]> = [
    ['integrity', { ...weak, integrity: 'verified' }, 'integrity_escalation'],
    ['authenticity', { ...weak, authenticity: 'provider_authenticated' }, 'authenticity_escalation'],
    ['coverage', { ...weak, coverage: 'complete' }, 'coverage_escalation'],
  ];

  for (const [axis, input, reason] of escalations) {
    const result = assessPreservation({
      proposed: abstract(claimProfile(input)),
      citedEvidence: [source],
    });
    assert.equal(result.allowed, false, `${axis} escalation was allowed`);
    assert.equal(result.verdict, 'refused');
    assert.ok(result.missingReasons.includes(reason), `missing reason for ${axis}`);
  }
});

test('monetary basis changes are refused as incomparable rather than ranked', () => {
  const source = cited('evidence:billed', claimProfile(strong));
  for (const monetaryBasis of ['allocated', 'effective'] as const) {
    const result = assessPreservation({
      proposed: abstract(claimProfile({ ...strong, monetaryBasis })),
      citedEvidence: [source],
    });
    assert.equal(result.allowed, false, `${monetaryBasis} was treated as a weaker basis`);
    assert.ok(result.missingReasons.includes('monetary_basis_incomparable'));
    assert.equal(result.reasons.some((reason) => reason.axis === 'monetaryBasis'), true);
  }
});

test('narrowing scope or inventing grain is refused until an exact typed relation is supplied', () => {
  const source = cited('evidence:coarse', claimProfile(strong), ['day']);
  const proposed = abstract(claimProfile(strong), ['day', 'project'], { organization: 'acme', project: 'atlas' });
  const refused = assessPreservation({ proposed, citedEvidence: [source] });

  assert.equal(refused.allowed, false);
  assert.ok(refused.missingReasons.includes('grain_relation_missing'));
  assert.ok(refused.missingReasons.includes('scope_relation_missing'));
  assert.ok(refused.missingWitnesses.includes('grain_refinement'));
  assert.ok(refused.missingWitnesses.includes('scope_filter'));

  const grainRefinement = coordinateWitness({
    id: 'witness:grain-refinement',
    kind: 'grain_refinement',
    from: source.coordinates,
    to: proposed.coordinates,
  });
  const scopeFilter = coordinateWitness({
    id: 'witness:scope-filter',
    kind: 'scope_filter',
    from: source.coordinates,
    to: proposed.coordinates,
  });
  const allowed = assessPreservation({
    proposed,
    citedEvidence: [source],
    coordinateWitnesses: [grainRefinement, scopeFilter],
  });

  assert.equal(allowed.allowed, true);
  assert.deepEqual(allowed.missingReasons, []);
});

test('declared directed grain rollups remain usable while undeclared dimensions remain refused', () => {
  const source = cited('evidence:billing-record', claimProfile(strong), ['billing_record']);
  const rollup = assessPreservation({
    proposed: abstract(claimProfile(strong), ['billing_period']),
    citedEvidence: [source],
  });
  const invented = assessPreservation({
    proposed: abstract(claimProfile(strong), ['model']),
    citedEvidence: [cited('evidence:day', claimProfile(strong), ['day'])],
  });

  assert.equal(rollup.allowed, true);
  assert.equal(invented.allowed, false);
  assert.ok(invented.missingReasons.includes('grain_relation_missing'));
  assert.ok(invented.missingWitnesses.includes('grain_bridge'));
});

test('four-valued conflict is retained and cannot be silently collapsed', () => {
  const source = cited('evidence:conflicted', claimProfile({ ...strong, epistemic: 'conflicted' }));
  const retained = assessPreservation({
    proposed: abstract(claimProfile({ ...strong, epistemic: 'conflicted' })),
    citedEvidence: [source],
  });
  assert.equal(retained.allowed, true);
  assert.equal(retained.preservedEpistemicState, 'conflicted');

  for (const collapsed of ['unknown', 'supported', 'refuted'] as const) {
    const result = assessPreservation({
      proposed: abstract(claimProfile({ ...strong, epistemic: collapsed })),
      citedEvidence: [source],
    });
    assert.equal(result.allowed, false, `conflict collapsed to ${collapsed}`);
    assert.ok(result.missingReasons.includes('epistemic_conflict_not_retained'));
  }
});

test('an absent citation is a structured refusal, not an exception', () => {
  const result = assessPreservation({
    proposed: abstract(claimProfile(strong)),
    citedEvidence: [],
  });
  assert.equal(result.allowed, false);
  assert.equal(result.verdict, 'refused');
  assert.deepEqual(result.missingReasons, ['no_cited_evidence']);
});