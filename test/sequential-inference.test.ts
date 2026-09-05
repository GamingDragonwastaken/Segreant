import { createHash } from 'node:crypto';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  analyzeSequentialRate,
  canonicalSequentialJson,
  commitSequentialProtocol,
  sequentialProtocolHash,
  validateSequentialProtocol,
  verifyCommittedSequentialProtocol,
  verifySequentialInferenceResult,
  type SequentialObservation,
  type SequentialProtocolDraft,
} from '../src/causal/sequential.ts';

const D = (char: string): string => 'sha256:' + char.repeat(64);

function draft(overrides: Partial<SequentialProtocolDraft> = {}): SequentialProtocolDraft {
  return {
    type: 'fiscus.sequential-inference',
    version: 1,
    protocolId: 'protocol:rate-study',
    createdAtMs: 1_700_000_000_000,
    estimand: 'bernoulli_rate',
    outcome: { definitionDigest: D('a') },
    data: { mode: 'accumulated', observationUnit: 'independent' },
    errorControl: { method: 'anytime_confidence_sequence', confidenceLevel: 0.95 },
    looks: [
      { lookId: 'look:one', sampleSize: 4 },
      { lookId: 'look:two', sampleSize: 8 },
    ],
    stopping: { kind: 'registered_look_schedule', allowEarlyStop: true },
    multiplicity: { method: 'single_endpoint', familySize: 1 },
    assumptions: {
      sampling: 'independent_bernoulli',
      outcome: 'fixed_binary_definition',
      cluster: 'no_clustering',
      assignment: 'fixed',
      selection: 'no_post_selection',
    },
    adaptation: { assignment: 'none', outcome: 'none', modelSelection: 'none' },
    provenance: { sourceId: 'source:local-study', sourceDigest: D('b') },
    ...overrides,
  };
}

function observations(count = 8): SequentialObservation[] {
  return Array.from({ length: count }, (_, index) => ({
    observationId: `observation:${index + 1}`,
    sequence: index + 1,
    outcome: index % 3 === 0 ? 1 : 0,
    observedAtMs: 1_700_000_001_000 + index * 1_000,
    sourceDigest: D('c'),
  }));
}

function analysisRequest(lookId: string, observedAtMs = 1_700_000_010_000) {
  return {
    asOfMs: observedAtMs,
    stop: {
      lookId,
      reason: lookId === 'look:two' ? 'planned_completion' as const : 'pre_registered_early_stop' as const,
      observedAtMs,
    },
  };
}

test('sequential protocol commits explicit looks, assumptions, and an immutable provenance hash', () => {
  const uncommitted = draft();
  assert.deepEqual(validateSequentialProtocol(uncommitted), []);
  const committed = commitSequentialProtocol(uncommitted, 1_700_000_000_500);

  assert.equal(committed.protocolHash, sequentialProtocolHash(uncommitted));
  assert.ok(Object.isFrozen(committed));
  assert.ok(Object.isFrozen(committed.looks));
  assert.ok(Object.isFrozen(committed.assumptions));
  assert.deepEqual(verifyCommittedSequentialProtocol(committed), []);

  const changedLook = { ...uncommitted, looks: [{ lookId: 'look:one', sampleSize: 5 }, ...uncommitted.looks.slice(1)] };
  assert.notEqual(sequentialProtocolHash(changedLook), committed.protocolHash);
  assert.ok(verifyCommittedSequentialProtocol({ ...committed, looks: changedLook.looks }).some((error) => /hash/i.test(error)));
});

test('unregistered stopping and optional peeking fail closed instead of borrowing anytime validity', () => {
  const committed = commitSequentialProtocol(draft(), 1_700_000_000_500);
  const result = analyzeSequentialRate(committed, observations(5), analysisRequest('look:one'));

  assert.equal(result.ok, false);
  assert.ok(result.errors.some((error) => /registered look|optional stopping|sample size/i.test(error)));
  assert.equal(result.interval, null);
  assert.equal(result.validity.status, 'not_established');
});

test('a registered early look is valid only in the accumulated independent Bernoulli domain', () => {
  const committed = commitSequentialProtocol(draft(), 1_700_000_000_500);
  const result = analyzeSequentialRate(committed, observations(4), analysisRequest('look:one'));

  assert.equal(result.ok, true);
  assert.equal(result.looks.length, 1);
  assert.equal(result.looks[0]!.lookId, 'look:one');
  assert.equal(result.looks[0]!.sampleSize, 4);
  assert.equal(result.interval?.n, 4);
  assert.equal(result.validity.status, 'valid');
  assert.equal(result.validity.domain.data, 'accumulated');
  assert.equal(result.validity.domain.sampling, 'independent_bernoulli');
  assert.equal(result.validity.domain.selection, 'none');
  assert.equal(result.stopping.registeredLookId, 'look:one');
  assert.equal(result.stopping.reason, 'pre_registered_early_stop');
  assert.equal(result.provenance.protocolHash, committed.protocolHash);
  assert.match(result.provenance.observationDigest ?? '', /^sha256:[a-f0-9]{64}$/);
  assert.match(result.resultHash ?? '', /^sha256:[a-f0-9]{64}$/);
  assert.deepEqual(verifySequentialInferenceResult(result), []);
});

test('unregistered adaptation, post-selection, sliding data, clustering, and multiplicity cannot be laundered as one valid result', () => {
  const cases: Array<[string, Partial<SequentialProtocolDraft>]> = [
    ['adaptive assignment', { adaptation: { assignment: 'adaptive' as never, outcome: 'none', modelSelection: 'none' } }],
    ['post-selection', { adaptation: { assignment: 'none', outcome: 'none', modelSelection: 'post_hoc' as never } }],
    ['sliding data', { data: { mode: 'sliding' as never, observationUnit: 'independent' } }],
    ['clustered data', { assumptions: { ...draft().assumptions, cluster: 'clustered' as never } }],
    ['unregistered multiplicity', { multiplicity: { method: 'single_endpoint', familySize: 2 } }],
  ];

  for (const [name, overrides] of cases) {
    const candidate = draft(overrides);
    const errors = validateSequentialProtocol(candidate);
    assert.ok(errors.length > 0, name + ' must be rejected');
    assert.throws(() => commitSequentialProtocol(candidate, 1_700_000_000_500), /cannot commit sequential protocol/i, name);
  }
});

test('committed protocol, observations, stop event, and result are digest-bound and tamper-evident', () => {
  const committed = commitSequentialProtocol(draft(), 1_700_000_000_500);
  const result = analyzeSequentialRate(committed, observations(), analysisRequest('look:two'));
  assert.equal(result.ok, true);

  const tampered = structuredClone(result) as typeof result;
  tampered.looks[0]!.successes += 1;
  assert.ok(verifySequentialInferenceResult(tampered).some((error) => /hash|digest|interval/i.test(error)));

  const tamperedProtocol = structuredClone(committed) as typeof committed;
  tamperedProtocol.adaptation.assignment = 'adaptive' as never;
  const refused = analyzeSequentialRate(tamperedProtocol, observations(), analysisRequest('look:two'));
  assert.equal(refused.ok, false);
  assert.ok(refused.errors.some((error) => /protocol|adaptation|integrity/i.test(error)));
});

test('a protocol that disallows early stopping cannot be stopped at an intermediate registered look', () => {
  const committed = commitSequentialProtocol(
    draft({ stopping: { kind: 'registered_look_schedule', allowEarlyStop: false } }),
    1_700_000_000_500,
  );
  const result = analyzeSequentialRate(committed, observations(4), analysisRequest('look:one'));

  assert.equal(result.ok, false);
  assert.ok(result.errors.some((error) => /early stop|final look/i.test(error)));
  assert.equal(result.interval, null);
});

test('result verification rejects semantically invalid fields even when an attacker recomputes the result hash', () => {
  const committed = commitSequentialProtocol(draft(), 1_700_000_000_500);
  const result = analyzeSequentialRate(committed, observations(), analysisRequest('look:two'));
  assert.equal(result.ok, true);

  const tampered = structuredClone(result) as typeof result;
  tampered.validity.status = 'not_established';
  const { resultHash: _resultHash, ...material } = tampered;
  tampered.resultHash = 'sha256:' + createHash('sha256').update(canonicalSequentialJson(material)).digest('hex');

  assert.ok(verifySequentialInferenceResult(tampered).some((error) => /validity|domain|status/i.test(error)));

  const forgedInterval = structuredClone(result) as typeof result;
  forgedInterval.interval!.low = 0;
  const { resultHash: _forgedHash, ...forgedMaterial } = forgedInterval;
  forgedInterval.resultHash = 'sha256:' + createHash('sha256').update(canonicalSequentialJson(forgedMaterial)).digest('hex');
  assert.ok(verifySequentialInferenceResult(forgedInterval).some((error) => /interval/i.test(error)));
});

test('result verification fails closed instead of throwing on unsupported nested provenance values', () => {
  const committed = commitSequentialProtocol(draft(), 1_700_000_000_500);
  const result = analyzeSequentialRate(committed, observations(), analysisRequest('look:two'));
  assert.equal(result.ok, true);
  const malformed = {
    ...result,
    provenance: { ...result.provenance, lookIds: [() => 'unsupported'] },
  } as unknown as typeof result;
  let errors: string[] = [];
  assert.doesNotThrow(() => { errors = verifySequentialInferenceResult(malformed); });
  assert.ok(errors.length > 0);
});
