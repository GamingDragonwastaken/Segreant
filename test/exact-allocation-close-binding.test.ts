import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyExactAllocation, type ExactAllocatableRow } from '../src/alloc/exact.ts';
import type { AllocationRule, CostCentre } from '../src/alloc/rules.ts';
import { economicEvent } from '../src/economics/events.ts';
import { money } from '../src/economics/money.ts';
import { Store } from '../src/store/db.ts';

const START = 0;
const END = 100;
const CENTRE: CostCentre = { costCentreId: 'eng', name: 'Engineering', owner: null, createdAtMs: 0, archivedAtMs: null };
const RULE: AllocationRule = {
  ruleId: 'api', version: 1, method: 'direct', match: { project: 'api' }, targets: [{ costCentreId: 'eng', ratio: 1 }], priority: 1,
  effectiveFromMs: 0, effectiveToMs: null, revokedAtMs: null, owner: null, note: null, createdAtMs: 0,
};

function seedSource(store: Store, id: string, occurredAt = at(10), recordedAt = at(20)): string {
  store.economic().append(economicEvent({
    id,
    kind: 'charge_estimated',
    subject: `request:${id}`,
    occurredAt,
    recordedAt,
    amount: money('1', 'USD', 'list'),
    sourceEventIds: [],
    reversalOf: null,
    metadata: null,
    schemaVersion: 1,
  }));
  return id;
}

function result(sourceId: string, runAtMs = 100): ReturnType<typeof applyExactAllocation> {
  return applyExactAllocation({
    rows: [{ sourceEventIds: [sourceId], amount: money('1', 'USD', 'list'), project: 'api', provider: 'anthropic', model: 'claude-opus-4-8', source: null, user: null, tsEpochMs: 10 }],
    rules: [RULE],
    costCentres: [CENTRE],
    periodStartMs: START,
    periodEndMs: END,
    runAtMs,
  });
}

function at(ms: number): string {
  return new Date(ms).toISOString();
}

test('exact allocation persistence requires a finalized matching economic close', () => {
  const store = new Store(':memory:');
  try {
    const sourceId = seedSource(store, 'economic:allocation-close:open');
    assert.throws(
      () => store.saveExactAllocationRun(result(sourceId), 200),
      /close|finaliz|period/i,
    );
    assert.equal(store.exactAllocationRuns().length, 0, 'an open-period allocation must not persist');

    const close = store.finalizeEconomicPeriod({ periodStartMs: START, periodEndMs: END, recordedAt: at(200) });
    const runId = store.saveExactAllocationRun(result(sourceId), 201);
    const record = store.exactAllocationRun(runId)!;
    assert.deepEqual(record.closeBinding, {
      periodStartMs: START,
      periodEndMs: END,
      finalizationId: close.eventId,
      projectionDigest: close.projectionDigest,
      eventCount: close.eventCount,
    });
    assert.throws(
      () => store.raw().prepare('UPDATE economic_allocation_close_bindings SET projection_digest = ? WHERE allocation_run_id = ?').run('0'.repeat(64), runId),
      /append-only/i,
    );
    assert.throws(
      () => store.raw().prepare('DELETE FROM economic_allocation_close_bindings WHERE allocation_run_id = ?').run(runId),
      /append-only/i,
    );
    assert.equal(store.saveExactAllocationRun(result(sourceId), 202), runId, 'the close binding remains idempotent');
  } finally {
    store.close();
  }
});

test('a reopened period refuses a new exact allocation run instead of silently using an old close', () => {
  const store = new Store(':memory:');
  try {
    const sourceId = seedSource(store, 'economic:allocation-close:reopened');
    const close = store.finalizeEconomicPeriod({ periodStartMs: START, periodEndMs: END, recordedAt: at(200) });
    const firstId = store.saveExactAllocationRun(result(sourceId, 100), 201);
    assert.ok(store.exactAllocationRun(firstId)?.closeBinding.finalizationId === close.eventId);
    store.reopenEconomicPeriod({ periodStartMs: START, periodEndMs: END, recordedAt: at(300), reason: 'late economic evidence' });

    assert.throws(
      () => store.saveExactAllocationRun(result(sourceId, 101), 301),
      /close|reopen|finaliz/i,
    );
    assert.ok(store.exactAllocationRun(firstId), 'the historical run remains bound to its immutable close');
    assert.equal(store.saveExactAllocationRun(result(sourceId, 100), 302), firstId, 'historical idempotence does not require the close to remain active');
  } finally {
    store.close();
  }
});

test('exact allocation does not borrow a finalized close from another period', () => {
  const store = new Store(':memory:');
  try {
    const sourceId = seedSource(store, 'economic:allocation-close:mismatched-period');
    store.finalizeEconomicPeriod({ periodStartMs: 100, periodEndMs: 200, recordedAt: at(300) });
    assert.throws(
      () => store.saveExactAllocationRun(result(sourceId), 301),
      /close|finaliz|period/i,
    );
    assert.equal(store.exactAllocationRuns().length, 0);
  } finally {
    store.close();
  }
});

test('a conflicted period refuses exact allocation instead of selecting a close winner', () => {
  const store = new Store(':memory:');
  try {
    const sourceId = seedSource(store, 'economic:allocation-close:conflicted');
    const first = store.finalizeEconomicPeriod({ periodStartMs: START, periodEndMs: END, recordedAt: at(200) });
    store.economic().append(economicEvent({
      id: 'economic:allocation-close:competing',
      kind: 'close_finalized',
      subject: `economic-period:${START}:${END}`,
      occurredAt: at(END),
      recordedAt: at(201),
      amount: null,
      sourceEventIds: [sourceId],
      reversalOf: null,
      metadata: {
        closeSchemaVersion: 1,
        periodStartMs: START,
        periodEndMs: END,
        projectionDigest: first.projectionDigest,
        eventCount: first.eventCount,
      },
      schemaVersion: 1,
    }));
    assert.equal(store.economicPeriodCloseStatus(START, END).status, 'conflicted');
    assert.throws(
      () => store.saveExactAllocationRun(result(sourceId), 301),
      /close|conflict|finaliz/i,
    );
    assert.equal(store.exactAllocationRuns().length, 0);
  } finally {
    store.close();
  }
});

test('exact allocation refuses a source that was not in the finalized close snapshot', () => {
  const store = new Store(':memory:');
  try {
    store.finalizeEconomicPeriod({ periodStartMs: START, periodEndMs: END, recordedAt: at(200) });
    const sourceId = seedSource(store, 'economic:allocation-close:outside-snapshot', at(200), at(201));
    assert.throws(
      () => store.saveExactAllocationRun(result(sourceId), 301),
      /close|snapshot|included/i,
    );
    assert.equal(store.exactAllocationRuns().length, 0);
  } finally {
    store.close();
  }
});
