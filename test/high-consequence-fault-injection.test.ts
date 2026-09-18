/**
 * WP-H03 fault-injection coverage for SQLite/kernel write boundaries.
 *
 * Faults are induced through the raw test-only SQLite handle or a delegating
 * database wrapper. No production API accepts a fault flag: the tests break
 * the same write seams that a trigger, disk error, or commit interruption can
 * break and assert the only safe outcome is refusal with no partial record.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { EpistemicLedger } from '../src/epistemic/ledger.ts';
import { economicEvent } from '../src/economics/events.ts';
import { money } from '../src/economics/money.ts';
import { Store, type RequestRow, type VerifiedGateEvidenceInput } from '../src/store/db.ts';
import { assertDatabaseIntegrity } from '../src/store/schema.ts';

function tableCount(store: Store, table: string): number {
  const row = store.raw().prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number };
  return Number(row.count);
}

function injectedEvent(): ReturnType<typeof economicEvent> {
  return economicEvent({
    id: 'economic:fault-injection:event',
    kind: 'charge_estimated',
    subject: 'request:fault-injection',
    occurredAt: '2026-09-01T00:00:00.000Z',
    recordedAt: '2026-09-01T00:00:01.000Z',
    amount: money('1.25', 'USD', 'list'),
    sourceEventIds: [],
    reversalOf: null,
    metadata: { requestId: 'fault-injection' },
    schemaVersion: 1,
  });
}

function requestWithExactAmount(): RequestRow {
  return {
    requestId: 'request:fault-injection',
    sessionId: null,
    tsEpochMs: 1_000,
    provider: 'openai',
    model: 'gpt-fault-test',
    project: 'h03',
    taskWeight: 1,
    inputTokens: 10,
    outputTokens: 10,
    cacheWriteTokens: 0,
    cacheReadTokens: 0,
    reasoningTokens: 0,
    costUsd: 1.25,
    economicAmount: money('1.25', 'USD', 'list'),
    estimated: true,
    streamed: false,
    statusCode: 200,
    durationMs: 1,
  };
}

function gateEvidenceInput(): VerifiedGateEvidenceInput {
  return {
    eventId: 'gate:fault-injection:event',
    source: 'github-actions',
    evidenceClass: 'signed-ci',
    commitHash: 'a'.repeat(40),
    repositoryId: 'GamingDragonwastaken/Fiscus',
    policyId: 'ci-hardening-v1',
    bodyHash: 'sha256:fault-injection',
    signerKeyId: 'ci-key-1',
    envelopeJson: JSON.stringify({ eventId: 'gate:fault-injection:event', verdict: 'pass' }),
    verifiedAtMs: 1_000,
    signal: {
      kind: 'tests',
      project: 'h03',
      tsEpochMs: 1_000,
      verdict: 'pass',
      detail: 'synthetic fault-injection fixture',
    },
  };
}

function appendOnlyTriggerNames(store: Store): string[] {
  return (store.raw().prepare(
    "SELECT name FROM sqlite_master WHERE type = 'trigger' AND name LIKE '%append_only%' ORDER BY name",
  ).all() as Array<{ name: string }>).map((row) => row.name);
}

test('every declared append-only trigger is a live fail-closed integrity boundary', () => {
  const baseline = new Store(':memory:');
  let names: string[];
  try {
    names = appendOnlyTriggerNames(baseline);
    assert.ok(names.length >= 30, `expected a non-trivial trigger surface, found ${names.length}`);
    assert.ok(names.includes('epistemic_nodes_append_only_update'));
    assert.ok(names.includes('economic_events_append_only_delete'));
    assert.ok(names.includes('economic_allocation_lineage_append_only_insert'));
  } finally {
    baseline.close();
  }

  for (const triggerName of names!) {
    const store = new Store(':memory:');
    try {
      store.raw().prepare(`DROP TRIGGER ${triggerName}`).run();
      assert.throws(
        () => assertDatabaseIntegrity(store.raw(), { appendOnlyTriggers: true }),
        /append-only|integrity/i,
        `${triggerName} removal must be refused before a repaired or copied database is trusted`,
      );
    } finally {
      store.close();
    }
  }
});

test('economic append fault rolls back the event instead of publishing a partial charge', () => {
  const store = new Store(':memory:');
  try {
    store.raw().prepare(
      "CREATE TRIGGER injected_economic_failure AFTER INSERT ON economic_events BEGIN SELECT RAISE(ABORT, 'injected economic write failure'); END",
    ).run();
    assert.throws(() => store.economic().append(injectedEvent()), /injected economic write failure/);
    assert.equal(store.economic().read('economic:fault-injection:event'), null);
    assert.equal(store.economic().events().length, 0);
  } finally {
    store.close();
  }
});

test('exact request plus economic event fault rolls back both sides of the accounting boundary', () => {
  const store = new Store(':memory:');
  try {
    store.raw().prepare(
      "CREATE TRIGGER injected_request_economic_failure AFTER INSERT ON economic_events BEGIN SELECT RAISE(ABORT, 'injected request-economic failure'); END",
    ).run();
    assert.throws(() => store.insertRequest(requestWithExactAmount()), /injected request-economic failure/);
    assert.equal(store.requestsInRange(0, 2_000).length, 0, 'the numeric compatibility row must roll back');
    assert.equal(store.economic().events().length, 0, 'the exact charge must roll back');
  } finally {
    store.close();
  }
});

test('verified gate evidence fault rolls back evidence and its signal together', () => {
  const store = new Store(':memory:');
  try {
    store.raw().prepare(
      "CREATE TRIGGER injected_gate_signal_failure AFTER INSERT ON gate_signals BEGIN SELECT RAISE(ABORT, 'injected gate signal failure'); END",
    ).run();
    assert.throws(
      () => store.insertVerifiedGateEvidence(gateEvidenceInput()),
      /injected gate signal failure/,
    );
    assert.equal(tableCount(store, 'gate_evidence'), 0, 'the verified envelope must not survive without its signal');
    assert.equal(tableCount(store, 'gate_signals'), 0, 'the signal must not survive a failed evidence write');
  } finally {
    store.close();
  }
});

test('kernel commit fault rolls back an in-flight append and preserves the error', () => {
  const raw = new DatabaseSync(':memory:');
  let failCommit = false;
  const injected = {
    exec(sql: string): unknown {
      if (failCommit && sql.trim().toUpperCase() === 'COMMIT') {
        failCommit = false;
        throw new Error('injected kernel commit failure');
      }
      return raw.exec(sql);
    },
    prepare(sql: string) {
      return raw.prepare(sql);
    },
  } as unknown as DatabaseSync;
  const ledger = new EpistemicLedger(injected);
  failCommit = true;
  try {
    assert.throws(
      () => ledger.appendNode({
        id: 'decision:fault-injection',
        kind: 'decision',
        availableAt: '2026-09-01T00:00:00.000Z',
        epistemic: 'supported',
      }),
      /injected kernel commit failure/,
    );
    assert.deepEqual(ledger.graph().nodes, [], 'a failed kernel commit must publish no node');
    assert.deepEqual(ledger.graph().edges, [], 'a failed kernel commit must publish no edges');
  } finally {
    raw.close();
  }
});
