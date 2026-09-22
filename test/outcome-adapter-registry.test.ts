import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createOutcomeAdapterRegistry,
  serializeOutcomeAdapter,
} from '../src/outcomes/registry.ts';
import {
  adaptOutcome,
  createWorkUnit,
  type OutcomeAdapter,
} from '../src/outcomes/work-unit.ts';
import { CODING_OUTCOME_ADAPTER } from '../src/value/gates.ts';
import { NON_CODING_OUTCOME_ADAPTER } from '../src/value/usage.ts';

const OTHER_ADAPTER: OutcomeAdapter = Object.freeze({
  id: 'document-accepted-v1',
  contract: Object.freeze({ id: 'document-accepted', requiredPredicates: ['accepted'] }),
  resolve: () => 'supported',
});

function registry() {
  return createOutcomeAdapterRegistry([
    CODING_OUTCOME_ADAPTER.id,
    NON_CODING_OUTCOME_ADAPTER.id,
  ]);
}

test('adapter registry requires explicit allowlisted registration and refuses duplicates', () => {
  const value = registry();

  assert.deepEqual(value.allowlistedAdapterIds, [
    'coding-gate-lifecycle-v1',
    'non-coding-reported-outcome-v1',
  ]);
  assert.equal(Object.isFrozen(value.allowlistedAdapterIds), true);
  assert.throws(() => value.register(OTHER_ADAPTER), /not allowlisted/i);

  value.register(CODING_OUTCOME_ADAPTER);
  assert.deepEqual(value.registeredAdapterIds(), ['coding-gate-lifecycle-v1']);
  assert.throws(() => value.register(CODING_OUTCOME_ADAPTER), /already registered/i);
  assert.equal(value.get('document-accepted-v1'), undefined);
});

test('registered coding and non-coding adapters round-trip without changing outcome semantics', () => {
  const value = registry();
  value.register(CODING_OUTCOME_ADAPTER);
  value.register(NON_CODING_OUTCOME_ADAPTER);

  const codingRecord = value.serialize(CODING_OUTCOME_ADAPTER.id);
  const nonCodingRecord = value.serialize(NON_CODING_OUTCOME_ADAPTER.id);

  assert.deepEqual(codingRecord, serializeOutcomeAdapter(CODING_OUTCOME_ADAPTER));
  assert.deepEqual(nonCodingRecord, serializeOutcomeAdapter(NON_CODING_OUTCOME_ADAPTER));
  assert.match(codingRecord.digest, /^sha256:[a-f0-9]{64}$/);
  assert.equal(codingRecord.kind, 'outcome_adapter');
  assert.equal(codingRecord.schemaVersion, 1);
  assert.equal(value.deserialize(codingRecord), CODING_OUTCOME_ADAPTER);
  assert.equal(value.deserialize(nonCodingRecord), NON_CODING_OUTCOME_ADAPTER);

  const codingUnit = createWorkUnit({
    id: 'registry-coding-unit',
    kind: 'coding_commit',
    startedAtMs: 0,
    endedAtMs: 1,
    context: { gateStates: Object.fromEntries(CODING_OUTCOME_ADAPTER.contract.requiredPredicates.map((predicate) => [predicate, 'supported'])) },
  });
  assert.equal(adaptOutcome(codingUnit, value.deserialize(codingRecord)).evaluation.status, 'confirmed');

  const nonCodingUnit = createWorkUnit({
    id: 'registry-session-unit',
    kind: 'non_coding_session',
    startedAtMs: 0,
    endedAtMs: 1,
    context: { signals: [{ kind: 'used', verdict: 'pass' }, { kind: 'incident', verdict: 'fail' }] },
  });
  assert.equal(adaptOutcome(nonCodingUnit, value.deserialize(nonCodingRecord)).evaluation.status, 'conflicted');
});

test('adapter deserialization verifies exact canonical bytes, digest, identity, and registered contract', () => {
  const value = registry();
  value.register(CODING_OUTCOME_ADAPTER);
  const record = value.serialize(CODING_OUTCOME_ADAPTER.id);

  assert.throws(
    () => value.deserialize({ ...record, body: record.body.replace('coding-gate-lifecycle', 'tampered') }),
    /digest/i,
  );
  assert.throws(
    () => value.deserialize({ ...record, digest: `sha256:${'0'.repeat(64)}` }),
    /digest/i,
  );
  assert.throws(
    () => value.deserialize({ ...record, schemaVersion: 2 }),
    /schemaVersion/i,
  );
  assert.throws(
    () => value.deserialize({ ...record, id: 'non-coding-reported-outcome-v1' }),
    /identity|id/i,
  );
  assert.throws(
    () => value.deserialize({ ...record, extra: true } as never),
    /unknown|exact/i,
  );

  const forged: OutcomeAdapter = Object.freeze({
    ...CODING_OUTCOME_ADAPTER,
    contract: Object.freeze({ id: 'coding-gate-lifecycle', requiredPredicates: ['forged'] }),
  });
  const forgedRecord = serializeOutcomeAdapter(forged);
  assert.throws(
    () => value.deserialize(forgedRecord),
    /registered adapter|contract|descriptor/i,
  );
});

test('deserialization refuses a valid adapter envelope without an explicitly registered implementation', () => {
  const source = registry();
  source.register(CODING_OUTCOME_ADAPTER);
  const record = source.serialize(CODING_OUTCOME_ADAPTER.id);

  const target = createOutcomeAdapterRegistry([CODING_OUTCOME_ADAPTER.id]);
  assert.throws(() => target.deserialize(record), /registered|allowlist/i);

  const disallowed = createOutcomeAdapterRegistry([NON_CODING_OUTCOME_ADAPTER.id]);
  assert.throws(() => disallowed.deserialize(record), /allowlisted|registered/i);
});

test('adapter serialization rejects malformed callbacks and contract descriptors', () => {
  assert.throws(
    () => serializeOutcomeAdapter({
      id: 'bad-adapter-v1',
      contract: { id: 'bad', requiredPredicates: ['accepted'] },
    } as never),
    /resolve/i,
  );
  assert.throws(
    () => serializeOutcomeAdapter({
      id: 'bad-adapter-v1',
      contract: { id: 'bad', requiredPredicates: [] },
      resolve: () => 'unknown',
    } as never),
    /at least one|required predicate/i,
  );
  assert.throws(
    () => createOutcomeAdapterRegistry(['coding-gate-lifecycle-v1', 'coding-gate-lifecycle-v1']),
    /duplicate/i,
  );
});
