import { test } from 'node:test';
import assert from 'node:assert/strict';
import { claim, type ClaimInput } from '../src/epistemic/claim.ts';
import {
  assessDerivationLegality,
  coordinateWitness,
  derivation,
  type DerivationInput,
} from '../src/epistemic/derivation.ts';
import { claimProfile } from '../src/epistemic/profile.ts';
import { grain } from '../src/epistemic/grain.ts';
import { interval } from '../src/epistemic/time.ts';
import { scope } from '../src/epistemic/scope.ts';

const coarseGrain = grain(['day', 'project']);
const fineGrain = grain(['day', 'project', 'request']);
const broadScope = scope({ organization: 'acme' });
const narrowScope = scope({ organization: 'acme', project: 'atlas' });

function profile(overrides: Partial<Parameters<typeof claimProfile>[0]> = {}) {
  return claimProfile({
    epistemic: 'supported',
    integrity: 'verified',
    authenticity: 'provider_authenticated',
    scope: 'established',
    coverage: 'complete',
    measurement: 'proxy_unvalidated',
    causality: 'none',
    monetaryBasis: 'none',
    finality: 'unknown',
    decisionFitness: 'not_assessed',
    ...overrides,
  });
}

function claimInput(overrides: Partial<ClaimInput> = {}): ClaimInput {
  return {
    id: 'claim:source',
    proposition: { predicate: 'work.observed', value: { count: 1 } },
    subject: 'project:atlas',
    scope: broadScope,
    grain: coarseGrain,
    time: {
      validTime: interval('2026-08-01T00:00:00.000Z', '2026-08-02T00:00:00.000Z'),
      asOf: '2026-08-02T01:00:00.000Z',
    },
    epistemic: 'supported',
    profile: profile(),
    measurementModelRef: null,
    evidenceIds: ['evidence:source'],
    derivationRule: 'source.observation.v1',
    derivationVersion: 1,
    assumptions: [],
    uncertainty: null,
    causalStatus: 'none',
    issuedAt: '2026-08-02T01:00:00.000Z',
    supersedes: [],
    supersededBy: null,
    revocation: null,
    decisionCertificateIds: [],
    schemaVersion: 1,
    ...overrides,
  };
}

function makeDerivation(sourceId: string, outputId: string, overrides: Partial<DerivationInput> = {}): DerivationInput {
  return {
    id: 'derivation:1',
    inputEvidenceIds: ['evidence:source'],
    inputClaimIds: [sourceId],
    transformation: 'identity projection',
    outputClaimId: outputId,
    outputProposition: { predicate: 'work.observed', value: { count: 1 } },
    coordinateChange: { from: { grain: coarseGrain, scope: broadScope }, to: { grain: coarseGrain, scope: broadScope } },
    witnesses: [],
    assumptions: [],
    uncertaintyTransformation: null,
    version: 1,
    reproducibilityHash: 'sha256:derivation-1',
    ...overrides,
  };
}

test('equal-coordinate derivation binds immutable inputs and is legal without strengthening witnesses', () => {
  const source = claim(claimInput());
  const output = claim(claimInput({ id: 'claim:output' }));
  const item = derivation(makeDerivation(source.id, output.id));
  const assessment = assessDerivationLegality(source, output, item);

  assert.equal(item.outputClaimId, output.id);
  assert.equal(item.outputProposition.predicate, output.proposition.predicate);
  assert.equal(assessment.allowed, true);
  assert.deepEqual(assessment.missingWitnesses, []);
  assert.equal(Object.isFrozen(item), true);
  assert.equal(Object.isFrozen(item.outputProposition), true);
  assert.equal(Object.isFrozen(item.coordinateChange), true);
  assert.equal(Object.isFrozen(item.coordinateChange.from), true);
  assert.equal(Object.hasOwn(item, 'trusted'), false);
});

test('finer grain and broader scope require exact coordinate witnesses', () => {
  const source = claim(claimInput());
  const output = claim(claimInput({
    id: 'claim:finer',
    grain: fineGrain,
    scope: narrowScope,
  }));
  const noWitness = derivation(makeDerivation(source.id, output.id, {
    coordinateChange: {
      from: { grain: source.grain, scope: source.scope },
      to: { grain: output.grain, scope: output.scope },
    },
  }));
  const blocked = assessDerivationLegality(source, output, noWitness);
  assert.equal(blocked.allowed, false);
  assert.ok(blocked.missingWitnesses.includes('grain_refinement'));
  assert.ok(blocked.missingWitnesses.includes('scope_filter'));

  const witness = coordinateWitness({
    id: 'coordinate:refine-filter',
    kind: 'grain_refinement',
    from: { grain: source.grain, scope: source.scope },
    to: { grain: output.grain, scope: output.scope },
  });
  const withOnlyGrainWitness = derivation(makeDerivation(source.id, output.id, {
    coordinateChange: {
      from: { grain: source.grain, scope: source.scope },
      to: { grain: output.grain, scope: output.scope },
    },
    witnesses: [witness],
  }));
  assert.equal(assessDerivationLegality(source, output, withOnlyGrainWitness).allowed, false);
});

test('construct, causal, monetary, and trust strengthening each require their own witness', () => {
  const source = claim(claimInput({
    profile: profile({ measurement: 'proxy_unvalidated', causality: 'observational', integrity: 'unverifiable', authenticity: 'self_asserted', monetaryBasis: 'billed', finality: 'provisional' }),
    measurementModelRef: null,
    causalStatus: 'observational',
  }));
  const output = claim(claimInput({
    id: 'claim:stronger',
    profile: profile({ measurement: 'validated', causality: 'randomized', integrity: 'verified', authenticity: 'provider_authenticated', monetaryBasis: 'billed', finality: 'final' }),
    measurementModelRef: 'measurement:validated:v1',
    causalStatus: 'randomized',
  }));
  const item = derivation(makeDerivation(source.id, output.id, {
    coordinateChange: { from: { grain: source.grain, scope: source.scope }, to: { grain: output.grain, scope: output.scope } },
  }));
  const blocked = assessDerivationLegality(source, output, item);
  assert.equal(blocked.allowed, false);
  assert.ok(blocked.missingWitnesses.includes('measurement_validation'));
  assert.ok(blocked.missingWitnesses.includes('causal_identification'));
  assert.ok(blocked.missingWitnesses.includes('monetary_finality'));
  assert.ok(blocked.missingWitnesses.includes('integrity_attestation'));
  assert.ok(blocked.missingWitnesses.includes('authenticity_attestation'));

  const witnessKinds = [
    'measurement_validation', 'causal_identification', 'monetary_finality',
    'integrity_attestation', 'authenticity_attestation',
  ] as const;
  const witnessed = derivation(makeDerivation(source.id, output.id, {
    coordinateChange: { from: { grain: source.grain, scope: source.scope }, to: { grain: output.grain, scope: output.scope } },
    witnesses: witnessKinds.map((kind, index) => ({ id: `witness:${index}`, kind })),
  }));
  assert.equal(assessDerivationLegality(source, output, witnessed).allowed, true);
});

test('epistemic conflict cannot disappear without an explicit resolution witness', () => {
  const source = claim(claimInput({
    epistemic: 'conflicted',
    profile: profile({ epistemic: 'conflicted' }),
  }));
  const output = claim(claimInput({ id: 'claim:resolved' }));
  const item = derivation(makeDerivation(source.id, output.id));
  const blocked = assessDerivationLegality(source, output, item);
  assert.equal(blocked.allowed, false);
  assert.ok(blocked.missingWitnesses.includes('epistemic_resolution'));

  const resolved = derivation(makeDerivation(source.id, output.id, {
    witnesses: [{ id: 'witness:resolution', kind: 'epistemic_resolution' }],
  }));
  assert.equal(assessDerivationLegality(source, output, resolved).allowed, true);
});

test('derivation refuses malformed roots, mismatched bindings, duplicate witnesses, and invalid versions', () => {
  const source = claim(claimInput());
  const output = claim(claimInput({ id: 'claim:output' }));
  assert.throws(() => derivation(makeDerivation(source.id, output.id, { transformation: ' ' })), /non-empty/);
  assert.throws(() => derivation(makeDerivation(source.id, output.id, { inputEvidenceIds: [], inputClaimIds: [] })), /at least one input/);
  assert.throws(() => derivation(makeDerivation(source.id, output.id, { witnesses: [{ id: 'w', kind: 'epistemic_resolution' }, { id: 'w', kind: 'epistemic_resolution' }] })), /duplicate witness/);
  assert.throws(() => derivation(makeDerivation(source.id, output.id, { version: 0 })), /version/);
  assert.throws(() => derivation(makeDerivation(source.id, output.id, { reproducibilityHash: ' ' })), /non-empty/);
  assert.throws(() => assessDerivationLegality(source, output, derivation(makeDerivation('claim:other', output.id))), /input claim/);
});
