import { test } from 'node:test';
import assert from 'node:assert/strict';
import { grain } from '../src/epistemic/grain.ts';
import { scope } from '../src/epistemic/scope.ts';
import {
  assessCoordinateDerivation,
  coordinateWitness,
  type ClaimCoordinates,
} from '../src/epistemic/derivation.ts';

const coarse: ClaimCoordinates = {
  grain: grain(['project', 'day']),
  scope: scope({ organization: 'acme' }),
};
const fine: ClaimCoordinates = {
  grain: grain(['project', 'day', 'request']),
  scope: scope({ organization: 'acme', project: 'atlas' }),
};

test('equal coordinates need no witness', () => {
  const result = assessCoordinateDerivation(coarse, coarse, []);
  assert.equal(result.allowed, true);
  assert.deepEqual(result.missingWitnesses, []);
});

test('coarse evidence cannot become a finer factual claim without an exact grain-refinement witness', () => {
  const blocked = assessCoordinateDerivation(coarse, { ...coarse, grain: fine.grain }, []);
  assert.equal(blocked.allowed, false);
  assert.ok(blocked.missingWitnesses.includes('grain_refinement'));

  const wrong = coordinateWitness({ id: 'wrong', kind: 'grain_refinement', from: fine, to: coarse });
  assert.equal(assessCoordinateDerivation(coarse, { ...coarse, grain: fine.grain }, [wrong]).allowed, false);

  const right = coordinateWitness({
    id: 'right',
    kind: 'grain_refinement',
    from: coarse,
    to: { ...coarse, grain: fine.grain },
  });
  assert.equal(assessCoordinateDerivation(coarse, { ...coarse, grain: fine.grain }, [right]).allowed, true);
});

test('a narrower scope requires a bound scope-filter witness rather than silent selection', () => {
  const target = { ...coarse, scope: fine.scope };
  const blocked = assessCoordinateDerivation(coarse, target, []);
  assert.equal(blocked.allowed, false);
  assert.ok(blocked.missingWitnesses.includes('scope_filter'));

  const witness = coordinateWitness({ id: 'filter', kind: 'scope_filter', from: coarse, to: target });
  assert.equal(assessCoordinateDerivation(coarse, target, [witness]).allowed, true);
});

test('broader, disjoint, or incomparable scope/grain changes require explicit coverage/bridge witnesses', () => {
  const narrow = fine;
  assert.ok(assessCoordinateDerivation(narrow, coarse, []).missingWitnesses.includes('scope_coverage'));

  const incomparable = { ...coarse, grain: grain(['model', 'day']) };
  assert.ok(assessCoordinateDerivation(coarse, incomparable, []).missingWitnesses.includes('grain_bridge'));

  const disjoint = { ...coarse, scope: scope({ organization: 'other' }) };
  assert.ok(assessCoordinateDerivation(coarse, disjoint, []).missingWitnesses.includes('scope_bridge'));
});

test('witness identity is canonical and duplicate ids are refused', () => {
  const target = { ...coarse, grain: fine.grain };
  const witness = coordinateWitness({ id: 'w1', kind: 'grain_refinement', from: coarse, to: target });
  assert.equal(witness.id, 'w1');
  assert.throws(() => assessCoordinateDerivation(coarse, target, [witness, witness]), /duplicate witness id/);
});
