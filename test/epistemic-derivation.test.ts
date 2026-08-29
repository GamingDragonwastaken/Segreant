import { test } from 'node:test';
import assert from 'node:assert/strict';
import { grain } from '../src/epistemic/grain.ts';
import { scope } from '../src/epistemic/scope.ts';
import { interval } from '../src/epistemic/time.ts';
import {
  validateDerivation,
  type ClaimDescriptor,
  type DerivationWitness,
  type WitnessKind,
} from '../src/epistemic/derivation.ts';

const VALID_TIME = interval('2026-08-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z');

function claim(overrides: Partial<ClaimDescriptor> = {}): ClaimDescriptor {
  return {
    id: 'claim:input',
    construct: 'provider_cost',
    grain: grain(['project', 'day']),
    scope: scope({ organization: 'acme', project: 'atlas' }),
    validTime: VALID_TIME,
    evidenceIds: ['e:1'],
    witnessIds: [],
    requiredWitnessKinds: [],
    ...overrides,
  };
}

function witness(
  id: string,
  kind: WitnessKind,
  sourceEvidenceIds: readonly string[] = ['e:1'],
): DerivationWitness {
  return {
    id,
    kind,
    sourceEvidenceIds,
    statement: `${kind} justified by retained evidence`,
  };
}

function codes(result: ReturnType<typeof validateDerivation>): string[] {
  return result.map((violation) => violation.code);
}

test('identity derivation preserves coordinates without inventing a witness requirement', () => {
  const input = claim();
  const output = claim({ id: 'claim:output' });
  assert.deepEqual(validateDerivation([input], output, []), []);
});

test('finer grain requires an explicit granularity-refinement witness', () => {
  const input = claim();
  const output = claim({ id: 'claim:request-cost', grain: grain(['project', 'day', 'request']) });

  assert.ok(codes(validateDerivation([input], output, [])).includes('GRAIN_REFINEMENT_WITNESS_REQUIRED'));

  const w = witness('w:grain', 'granularity_refinement');
  const witnessed = { ...output, witnessIds: [w.id] };
  assert.equal(codes(validateDerivation([input], witnessed, [w])).includes('GRAIN_REFINEMENT_WITNESS_REQUIRED'), false);
});

test('coarser grain still requires an aggregation witness', () => {
  const input = claim({ grain: grain(['project', 'day', 'request']) });
  const output = claim({ id: 'claim:project-day-cost', grain: grain(['project', 'day']) });

  assert.ok(codes(validateDerivation([input], output, [])).includes('AGGREGATION_WITNESS_REQUIRED'));

  const w = witness('w:aggregate', 'aggregation');
  assert.equal(
    codes(validateDerivation([input], { ...output, witnessIds: [w.id] }, [w])).includes('AGGREGATION_WITNESS_REQUIRED'),
    false,
  );
});

test('incomparable grains cannot be silently translated', () => {
  const input = claim({ grain: grain(['project', 'day']) });
  const output = claim({ id: 'claim:model-day', grain: grain(['model', 'day']) });

  assert.ok(codes(validateDerivation([input], output, [])).includes('GRAIN_TRANSFORM_WITNESS_REQUIRED'));
});

test('scope changes require an explicit scope-transform witness', () => {
  const input = claim({ scope: scope({ organization: 'acme' }) });
  const output = claim({ id: 'claim:atlas', scope: scope({ organization: 'acme', project: 'atlas' }) });

  assert.ok(codes(validateDerivation([input], output, [])).includes('SCOPE_TRANSFORM_WITNESS_REQUIRED'));

  const w = witness('w:scope', 'scope_transform');
  assert.equal(
    codes(validateDerivation([input], { ...output, witnessIds: [w.id] }, [w])).includes('SCOPE_TRANSFORM_WITNESS_REQUIRED'),
    false,
  );
});

test('construct changes require measurement-validity evidence instead of proxy renaming', () => {
  const input = claim({ construct: 'line_persistence' });
  const output = claim({ id: 'claim:quality', construct: 'software_quality' });

  assert.ok(codes(validateDerivation([input], output, [])).includes('MEASUREMENT_VALIDITY_WITNESS_REQUIRED'));

  const w = witness('w:measurement', 'measurement_validity');
  assert.equal(
    codes(validateDerivation([input], { ...output, witnessIds: [w.id] }, [w])).includes('MEASUREMENT_VALIDITY_WITNESS_REQUIRED'),
    false,
  );
});

test('valid-time transformations require an explicit temporal witness', () => {
  const input = claim();
  const output = claim({
    id: 'claim:quarter',
    validTime: interval('2026-07-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z'),
  });

  assert.ok(codes(validateDerivation([input], output, [])).includes('TEMPORAL_TRANSFORM_WITNESS_REQUIRED'));

  const w = witness('w:time', 'temporal_transform');
  assert.equal(
    codes(validateDerivation([input], { ...output, witnessIds: [w.id] }, [w])).includes('TEMPORAL_TRANSFORM_WITNESS_REQUIRED'),
    false,
  );
});

test('domain-required completeness cannot be satisfied by event absence alone', () => {
  const input = claim();
  const output = claim({ id: 'claim:no-incidents', requiredWitnessKinds: ['completeness'] });

  assert.ok(codes(validateDerivation([input], output, [])).includes('REQUIRED_WITNESS_MISSING'));

  const w = witness('w:complete', 'completeness');
  assert.equal(
    codes(validateDerivation([input], { ...output, witnessIds: [w.id] }, [w])).includes('REQUIRED_WITNESS_MISSING'),
    false,
  );
});

test('a claim cannot cite an unknown witness id', () => {
  const input = claim();
  const output = claim({ id: 'claim:output', witnessIds: ['w:missing'] });
  assert.ok(codes(validateDerivation([input], output, [])).includes('UNKNOWN_WITNESS'));
});

test('a witness must be grounded in evidence retained by the derivation inputs', () => {
  const input = claim();
  const w = witness('w:grain', 'granularity_refinement', ['e:not-an-input']);
  const output = claim({
    id: 'claim:request-cost',
    grain: grain(['project', 'day', 'request']),
    witnessIds: [w.id],
  });

  assert.ok(codes(validateDerivation([input], output, [w])).includes('WITNESS_SOURCE_NOT_IN_INPUT'));
});

test('duplicate witness ids fail closed instead of making witness lookup ambiguous', () => {
  const input = claim();
  const a = witness('w:duplicate', 'completeness');
  const b = witness('w:duplicate', 'measurement_validity');
  const output = claim({ id: 'claim:output', witnessIds: ['w:duplicate'] });

  assert.ok(codes(validateDerivation([input], output, [a, b])).includes('DUPLICATE_WITNESS_ID'));
});
