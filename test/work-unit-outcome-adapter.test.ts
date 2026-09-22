import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createWorkUnit,
  adaptOutcome,
  type OutcomeAdapter,
  type WorkUnit,
} from '../src/outcomes/work-unit.ts';

test('creates a domain-neutral work unit with stable identity and bounded context', () => {
  const unit = createWorkUnit({
    id: 'task-1',
    kind: 'support',
    startedAtMs: 100,
    endedAtMs: 200,
    context: { queue: 'billing', sensitive: false },
  });

  assert.deepEqual(unit, {
    id: 'task-1',
    kind: 'support',
    startedAtMs: 100,
    endedAtMs: 200,
    context: { queue: 'billing', sensitive: false },
  });
  assert.equal(Object.isFrozen(unit), true);
  assert.equal(Object.isFrozen(unit.context), true);
});

test('rejects an invalid work-unit interval and empty identity', () => {
  assert.throws(() => createWorkUnit({
    id: '', kind: 'coding', startedAtMs: 2, endedAtMs: 1, context: {},
  }), /work unit id must be non-empty/);
  assert.throws(() => createWorkUnit({
    id: 'task-1', kind: 'coding', startedAtMs: 2, endedAtMs: 1, context: {},
  }), /work unit interval must be finite and ordered/);
});

test('adapter evaluates required predicates without changing unresolved evidence', () => {
  const unit: WorkUnit = createWorkUnit({
    id: 'task-2', kind: 'coding', startedAtMs: 0, endedAtMs: 10, context: {},
  });
  const adapter: OutcomeAdapter = {
    id: 'coding-v1',
    contract: { id: 'coding-shipped', requiredPredicates: ['tested', 'shipped'] },
    resolve: (predicate, candidate) => predicate === 'tested' && candidate.id === unit.id ? 'supported' : 'unknown',
  };

  const result = adaptOutcome(unit, adapter);

  assert.equal(result.unitId, 'task-2');
  assert.equal(result.adapterId, 'coding-v1');
  assert.equal(result.evaluation.status, 'unresolved');
  assert.deepEqual(result.evidence, {
    outcomeName: 'coding-shipped',
    valueOrSuccessMeasure: null,
    evidenceGrade: 'unresolved',
    intervalOrBounds: null,
    observedAtMs: null,
    provenance: 'adapter:coding-v1',
    coverage: 'partial',
    assumptions: [],
  });
});

test('adapter preserves a confirmed contract and exposes optional measure', () => {
  const unit = createWorkUnit({ id: 'task-3', kind: 'document', startedAtMs: 0, endedAtMs: 1, context: {} });
  const adapter: OutcomeAdapter = {
    id: 'document-v1',
    contract: { id: 'document-accepted', requiredPredicates: ['accepted'] },
    resolve: () => 'supported',
    measure: () => ({ value: 1, intervalOrBounds: { lower: 1, upper: 1 } }),
    observedAtMs: () => 500,
  };

  const result = adaptOutcome(unit, adapter);

  assert.equal(result.evaluation.status, 'confirmed');
  assert.equal(result.evidence.evidenceGrade, 'confirmed');
  assert.equal(result.evidence.coverage, 'complete');
  assert.equal(result.evidence.valueOrSuccessMeasure, 1);
  assert.deepEqual(result.evidence.intervalOrBounds, { lower: 1, upper: 1 });
  assert.equal(result.evidence.observedAtMs, 500);
});
