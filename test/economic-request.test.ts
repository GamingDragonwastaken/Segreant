import { test } from 'node:test';
import assert from 'node:assert/strict';
import { requestEconomicEvent, requestEconomicEventId } from '../src/economics/request.ts';
import { formatMoneyAmount, money } from '../src/economics/money.ts';
import { Store, type RequestRow } from '../src/store/db.ts';

function request(overrides: Partial<RequestRow> = {}): RequestRow {
  return {
    requestId: 'request:1',
    sessionId: 'session:1',
    tsEpochMs: Date.parse('2026-08-01T00:00:00.000Z'),
    provider: 'anthropic',
    model: 'claude-opus-4-8',
    project: 'fiscus',
    taskWeight: 1,
    inputTokens: 100,
    outputTokens: 20,
    cacheWriteTokens: 0,
    cacheReadTokens: 0,
    reasoningTokens: 0,
    costUsd: 0.0005,
    estimated: false,
    streamed: true,
    statusCode: 200,
    durationMs: 12,
    via: 'proxy',
    economicAmount: money('0.0005', 'USD', 'list'),
    ...overrides,
  };
}

function economicInput(input: RequestRow, amount = input.economicAmount!): Parameters<typeof requestEconomicEvent>[0] {
  return {
    requestId: input.requestId,
    sessionId: input.sessionId,
    tsEpochMs: input.tsEpochMs,
    provider: input.provider,
    model: input.model,
    project: input.project,
    amount,
    recordedAt: '2026-08-02T00:00:00.000Z',
  };
}

test('request economic events use one deterministic charge identity and explicit basis kind', () => {
  const input = request();
  const value = requestEconomicEvent(economicInput(input));
  assert.equal(value.id, requestEconomicEventId(input.requestId));
  assert.equal(value.kind, 'charge_estimated');
  assert.equal(value.subject, 'request:request:1');
  assert.equal(value.occurredAt, '2026-08-01T00:00:00.000Z');
  assert.equal(value.recordedAt, '2026-08-02T00:00:00.000Z');
  assert.equal(formatMoneyAmount(value.amount!), '0.0005');
  assert.deepEqual(value.sourceEventIds, []);
});

test('request economic events preserve provider-observed and billed distinctions', () => {
  const input = request();
  assert.equal(requestEconomicEvent(economicInput(input, money('1', 'USD', 'provider_observed'))).kind, 'provider_charge_observed');
  assert.equal(requestEconomicEvent(economicInput(input, money('1', 'USD', 'billed'))).kind, 'bill_observed');
  assert.throws(
    () => requestEconomicEvent(economicInput(input, money('1', 'USD', 'allocated'))),
    /unsupported request economic basis|basis/i,
  );
  assert.throws(
    () => requestEconomicEvent(economicInput(input, money('1', 'EUR', 'billed'))),
    /USD|currency/i,
  );
});

test('Store atomically persists an exact request charge and replays it idempotently', () => {
  const store = new Store(':memory:');
  try {
    const input = request();
    store.insertRequest(input);
    const eventId = requestEconomicEventId(input.requestId);
    const event = store.economic().read(eventId);
    assert.ok(event);
    assert.equal(event.kind, 'charge_estimated');
    assert.equal(formatMoneyAmount(event.amount!), '0.0005');
    assert.equal(store.economicAmountForRequest(input.requestId)?.basis, 'list');
    assert.equal(store.insertRequestIfNew(input), false);
    assert.equal(store.economic().events().filter((item) => item.id === eventId).length, 1);

    const legacy = request({ requestId: 'request:legacy', economicAmount: undefined, costUsd: 2 });
    store.insertRequest(legacy);
    assert.equal(store.economicAmountForRequest(legacy.requestId), null);
  } finally {
    store.close();
  }
});

test('Store rolls back a request when its exact economic event conflicts', () => {
  const store = new Store(':memory:');
  try {
    const input = request();
    const conflicting = requestEconomicEvent(economicInput(input, money('0.0006', 'USD', 'list')));
    assert.equal(store.economic().append(conflicting), 'inserted');
    assert.throws(() => store.insertRequest(input), /different economic event|conflict/i);
    assert.equal(store.recent(10).some((row) => row.requestId === input.requestId), false);
  } finally {
    store.close();
  }
});
