import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyExactAllocation, type ExactAllocatableRow } from '../src/alloc/exact.ts';
import type { AllocationRule, CostCentre } from '../src/alloc/rules.ts';
import { formatMoneyAmount, money } from '../src/economics/money.ts';
import { deserializeExactAllocationRun, serializeExactAllocationRun } from '../src/alloc/exact.ts';
import { Store, type RequestRow } from '../src/store/db.ts';

const centre = (costCentreId: string): CostCentre => ({ costCentreId, name: costCentreId, owner: null, createdAtMs: 0, archivedAtMs: null });

function row(overrides: Partial<ExactAllocatableRow> = {}): ExactAllocatableRow {
  return {
    sourceEventIds: ['economic:allocation:source'],
    amount: money('1', 'USD', 'list'),
    project: 'api',
    provider: 'anthropic',
    model: 'claude-opus-4-8',
    source: null,
    user: null,
    tsEpochMs: 0,
    ...overrides,
  };
}

function rule(overrides: Partial<AllocationRule> = {}): AllocationRule {
  return {
    ruleId: 'api',
    version: 1,
    method: 'direct',
    match: { project: 'api' },
    targets: [{ costCentreId: 'eng', ratio: 1 }],
    priority: 1,
    effectiveFromMs: 0,
    effectiveToMs: null,
    revokedAtMs: null,
    owner: null,
    note: null,
    createdAtMs: 0,
    ...overrides,
  };
}

function run(rows: readonly ExactAllocatableRow[], rules: readonly AllocationRule[] = [rule()]): ReturnType<typeof applyExactAllocation> {
  return applyExactAllocation({
    rows,
    rules,
    costCentres: [centre('eng'), centre('platform'), centre('data')],
    periodStartMs: 0,
    periodEndMs: 100,
    runAtMs: 100,
  });
}

test('exact allocation preserves sub-micro Money and source-event lineage', () => {
  const result = run([row({ amount: money('0.0000004', 'USD', 'list'), sourceEventIds: ['economic:source:tiny'] })]);
  assert.equal(result.complete, true);
  assert.deepEqual(result.totalByIdentity.map((item) => formatMoneyAmount(item.amount)), ['0.0000004']);
  assert.deepEqual(result.allocatedByIdentity.map((item) => formatMoneyAmount(item.amount)), ['0.0000004']);
  assert.equal(formatMoneyAmount(result.lines[0]!.amount), '0.0000004');
  assert.deepEqual(result.lines[0]!.sourceEventIds, ['economic:source:tiny']);
  assert.equal(result.conserves, true);
});

test('exact fixed splits use the declared ratio without floating-point rounding', () => {
  const result = run([row({ amount: money('1', 'USD', 'list') })], [rule({
    method: 'fixed_split',
    targets: [
      { costCentreId: 'eng', ratio: 0.333333 },
      { costCentreId: 'platform', ratio: 0.333333 },
      { costCentreId: 'data', ratio: 0.333334 },
    ],
  })]);
  assert.deepEqual(
    result.lines.map((line) => formatMoneyAmount(line.amount)).sort(),
    ['0.333333', '0.333333', '0.333334'],
  );
  assert.deepEqual(result.allocatedByIdentity.map((item) => formatMoneyAmount(item.amount)), ['1']);
  assert.equal(result.conserves, true);
});

test('exact allocation partitions currencies and bases instead of collapsing unlike money', () => {
  const result = run([
    row({ sourceEventIds: ['economic:usd'], amount: money('1', 'USD', 'list'), project: 'api' }),
    row({ sourceEventIds: ['economic:eur'], amount: money('2', 'EUR', 'list'), project: 'api' }),
    row({ sourceEventIds: ['economic:estimated'], amount: money('3', 'USD', 'estimated'), project: 'api' }),
  ]);
  assert.deepEqual(result.totalByIdentity.map((item) => `${item.currency}/${item.basis}:${formatMoneyAmount(item.amount)}`), [
    'EUR/list:2',
    'USD/estimated:3',
    'USD/list:1',
  ]);
  assert.deepEqual(result.allocatedByIdentity.map((item) => `${item.currency}/${item.basis}:${formatMoneyAmount(item.amount)}`), [
    'EUR/list:2',
    'USD/estimated:3',
    'USD/list:1',
  ]);
  assert.equal(result.lines.length, 3);
  assert.equal(result.conserves, true);
});

test('exact proportional allocation refuses a non-terminating share instead of inventing quantization', () => {
  const rules: AllocationRule[] = [
    rule({ ruleId: 'a', match: { project: 'a' }, targets: [{ costCentreId: 'eng', ratio: 1 }] }),
    rule({ ruleId: 'b', match: { project: 'b' }, targets: [{ costCentreId: 'platform', ratio: 1 }] }),
    rule({ ruleId: 'c', match: { project: 'c' }, targets: [{ costCentreId: 'data', ratio: 1 }] }),
    rule({ ruleId: 'pool', method: 'proportional_to_direct', match: { project: 'pool' }, targets: [
      { costCentreId: 'eng', ratio: 0 },
      { costCentreId: 'platform', ratio: 0 },
      { costCentreId: 'data', ratio: 0 },
    ], priority: 10 }),
  ];
  assert.throws(
    () => run([
      row({ project: 'a', sourceEventIds: ['economic:a'] }),
      row({ project: 'b', sourceEventIds: ['economic:b'] }),
      row({ project: 'c', sourceEventIds: ['economic:c'] }),
      row({ project: 'pool', sourceEventIds: ['economic:pool'] }),
    ], rules),
    /non-terminating|quantiz/i,
  );
});

test('exact proportional pools ignore archived placeholder targets and follow open direct drivers', () => {
  const result = applyExactAllocation({
    rows: [
      row({ project: 'direct', sourceEventIds: ['economic:direct'], amount: money('1', 'USD', 'list') }),
      row({ project: 'pool', sourceEventIds: ['economic:pool'], amount: money('1', 'USD', 'list') }),
    ],
    rules: [
      rule({ ruleId: 'direct', match: { project: 'direct' }, targets: [{ costCentreId: 'platform', ratio: 1 }] }),
      rule({ ruleId: 'pool', priority: 2, method: 'proportional_to_direct', match: { project: 'pool' }, targets: [
        { costCentreId: 'eng', ratio: 0 },
        { costCentreId: 'platform', ratio: 0 },
      ] }),
    ],
    costCentres: [centre('platform'), { ...centre('eng'), archivedAtMs: 1 }],
    periodStartMs: 0,
    periodEndMs: 100,
    runAtMs: 100,
  });
  assert.equal(result.unallocated.length, 0);
  assert.deepEqual(result.lines.filter((line) => line.ruleId === 'pool').map((line) => [line.costCentreId, formatMoneyAmount(line.amount)]), [['platform', '1']]);
});

test('exact allocation canonical result ordering is independent of input row order', () => {
  const rules = [
    rule({ ruleId: 'pool-a', match: { project: 'pool-a' }, method: 'proportional_to_direct', targets: [{ costCentreId: 'eng', ratio: 0 }] }),
    rule({ ruleId: 'pool-b', match: { project: 'pool-b' }, method: 'proportional_to_direct', targets: [{ costCentreId: 'eng', ratio: 0 }] }),
  ];
  const rows = [
    row({ project: 'pool-a', amount: money('1', 'USD', 'list'), sourceEventIds: ['economic:pool-a'] }),
    row({ project: 'pool-b', amount: money('2', 'USD', 'list'), sourceEventIds: ['economic:pool-b'] }),
  ];
  const first = run(rows, rules);
  const second = run([...rows].reverse(), rules);
  assert.equal(serializeExactAllocationRun(first).body, serializeExactAllocationRun(second).body);
});

test('exact allocation replay rejects an unknown envelope field and a non-conserving result', () => {
  const result = run([row({ sourceEventIds: ['economic:serialization'] })]);
  const serialized = serializeExactAllocationRun(result);
  assert.throws(() => deserializeExactAllocationRun({ ...serialized, extra: true } as never), /unknown.*envelope|envelope.*field/i);
  assert.throws(() => serializeExactAllocationRun({ ...result, totalByIdentity: [] }), /conserv|identity|lineage/i);
});

test('Store exact allocation uses effective charges and discloses unresolved legacy coverage', () => {
  const store = new Store(':memory:');
  try {
    const exact: RequestRow = {
      requestId: 'request:exact-allocation', sessionId: null, tsEpochMs: 0,
      provider: 'anthropic', model: 'claude-opus-4-8', project: 'api', taskWeight: 1,
      inputTokens: 1, outputTokens: 1, cacheWriteTokens: 0, cacheReadTokens: 0, reasoningTokens: 0,
      costUsd: 0.0000004, economicAmount: money('0.0000004', 'USD', 'list'), estimated: false,
      streamed: false, statusCode: 200, durationMs: 1, via: 'proxy',
    };
    const legacy: RequestRow = { ...exact, requestId: 'request:legacy-allocation', costUsd: 1, economicAmount: undefined };
    store.insertRequest(exact);
    store.insertRequest(legacy);
    store.upsertCostCentre({ costCentreId: 'eng', name: 'Engineering' });
    store.saveAllocationRule({
      ruleId: 'api', method: 'direct', match: { project: 'api' },
      targets: [{ costCentreId: 'eng', ratio: 1 }], priority: 1,
      effectiveFromMs: 0, effectiveToMs: null, revokedAtMs: null, owner: null, note: null,
    });
    const result = store.allocatePeriodExact(0, 1, 1);
    assert.equal(result.complete, false);
    assert.deepEqual(result.unresolvedRequestIds, ['request:legacy-allocation']);
    assert.deepEqual(result.totalByIdentity.map((item) => formatMoneyAmount(item.amount)), ['0.0000004']);
    assert.deepEqual(result.lines[0]!.sourceEventIds, ['economic:request:request:exact-allocation:charge']);
    assert.equal(result.conserves, true);
    const runId = store.saveExactAllocationRun(result, 2);
    assert.match(runId, /^economic:allocation:/);
    assert.deepEqual(store.exactAllocationRun(runId)?.result, result);
    assert.equal(store.saveExactAllocationRun(result, 3), runId, 'the same canonical result is idempotent');
    const lineage = store.raw().prepare('SELECT item_kind AS itemKind, item_index AS itemIndex, source_event_id AS sourceEventId FROM economic_allocation_lineage WHERE allocation_run_id = ? ORDER BY item_kind, item_index, source_event_id').all(runId) as Array<{ itemKind: string; itemIndex: number; sourceEventId: string }>;
    assert.deepEqual(lineage.map((item) => ({ ...item })), [{ itemKind: 'line', itemIndex: 0, sourceEventId: 'economic:request:request:exact-allocation:charge' }]);
    assert.throws(() => store.raw().prepare('UPDATE economic_allocation_runs SET result_json = ? WHERE allocation_run_id = ?').run('{}', runId), /append-only/i);
    assert.throws(() => store.raw().prepare('DELETE FROM economic_allocation_lineage WHERE allocation_run_id = ?').run(runId), /append-only/i);
    assert.throws(() => store.raw().prepare('INSERT OR REPLACE INTO economic_allocation_runs (allocation_run_id, period_start_ms, period_end_ms, run_at_ms, computed_at_ms, complete, conserves, result_json, result_digest) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run(runId, 0, 1, 1, 4, 1, 1, '{}', 'sha256:' + '0'.repeat(64)), /append-only/i);
  } finally {
    store.close();
  }
});
