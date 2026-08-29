import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  grain,
  grainRelation,
  sameGrain,
  type Grain,
} from '../src/epistemic/grain.ts';
import {
  scope,
  scopeRelation,
  sameScope,
} from '../src/epistemic/scope.ts';
import {
  instant,
  interval,
  intervalContains,
  intervalRelation,
  type BitemporalCoordinates,
} from '../src/epistemic/time.ts';

test('grain canonicalization is order-independent and rejects duplicate/empty dimensions', () => {
  const a = grain(['project', 'day', 'request']);
  const b = grain(['request', 'project', 'day']);
  assert.deepEqual(a, b);
  assert.deepEqual(a.dimensions, ['day', 'project', 'request']);
  assert.equal(sameGrain(a, b), true);
  assert.throws(() => grain(['project', 'project']), /duplicate grain dimension/);
  assert.throws(() => grain(['project', '']), /non-empty/);
});

test('grain relation distinguishes equal, finer, coarser, and incomparable grains', () => {
  const projectDay = grain(['project', 'day']);
  const request = grain(['project', 'day', 'request']);
  const modelDay = grain(['model', 'day']);

  assert.equal(grainRelation(projectDay, projectDay), 'equal');
  assert.equal(grainRelation(request, projectDay), 'finer');
  assert.equal(grainRelation(projectDay, request), 'coarser');
  assert.equal(grainRelation(projectDay, modelDay), 'incomparable');
});

test('scope canonicalization preserves explicit constraints and relation never invents broader coverage', () => {
  const org = scope({ organization: 'acme' });
  const project = scope({ project: 'atlas', organization: 'acme' });
  const other = scope({ organization: 'other' });

  assert.equal(sameScope(scope({ organization: 'acme' }), org), true);
  assert.equal(scopeRelation(project, org), 'narrower');
  assert.equal(scopeRelation(org, project), 'broader');
  assert.equal(scopeRelation(org, other), 'disjoint');
  assert.throws(() => scope({ organization: '' }), /non-empty/);
});

test('time intervals are canonical half-open intervals with containment relations', () => {
  const day = interval('2026-08-29T00:00:00.000Z', '2026-08-30T00:00:00.000Z');
  const hour = interval('2026-08-29T10:00:00.000Z', '2026-08-29T11:00:00.000Z');
  const later = interval('2026-08-30T00:00:00.000Z', '2026-08-31T00:00:00.000Z');

  assert.equal(intervalContains(day, instant('2026-08-29T10:30:00.000Z')), true);
  assert.equal(intervalContains(day, instant('2026-08-30T00:00:00.000Z')), false, 'end is exclusive');
  assert.equal(intervalRelation(day, hour), 'contains');
  assert.equal(intervalRelation(hour, day), 'within');
  assert.equal(intervalRelation(day, later), 'disjoint');
  assert.throws(() => interval(day.to, day.from), /start must be before end/);
});

test('bitemporal coordinates keep valid time separate from observation time', () => {
  const coords: BitemporalCoordinates = {
    validTime: interval('2026-07-01T00:00:00.000Z', '2026-08-01T00:00:00.000Z'),
    observedAt: instant('2026-08-15T12:00:00.000Z'),
  };

  assert.equal(coords.validTime.from, '2026-07-01T00:00:00.000Z');
  assert.equal(coords.observedAt, '2026-08-15T12:00:00.000Z');
});

// Compile-time contract: Grain is immutable/canonical and consumers cannot rely on caller ordering.
const _grainTypeWitness: Grain = grain(['provider']);
void _grainTypeWitness;
