import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store/db.ts';

test('proposal retention: prune removes expired proposed code without touching the request ledger', () => {
  const store = new Store(':memory:');
  try {
    const now = Date.now();
    store.insertRequest({
      requestId: 'retained-request',
      sessionId: null,
      tsEpochMs: now - 90 * 24 * 60 * 60 * 1000,
      provider: 'anthropic',
      model: 'claude-test',
      project: 'retention-test',
      taskWeight: 1,
      inputTokens: 1,
      outputTokens: 1,
      cacheWriteTokens: 0,
      cacheReadTokens: 0,
      reasoningTokens: 0,
      costUsd: 0.01,
      estimated: false,
      streamed: false,
      statusCode: 200,
      durationMs: 1,
    });
    store.insertProposal({
      proposalId: 'expired-proposal',
      requestId: 'retained-request',
      sessionId: null,
      tsEpochMs: now - 31 * 24 * 60 * 60 * 1000,
      provider: 'anthropic',
      model: 'claude-test',
      project: 'retention-test',
      files: [{ path: 'app.ts', addedLines: ['secret suggestion'] }],
    });
    store.insertProposal({
      proposalId: 'current-proposal',
      requestId: 'retained-request',
      sessionId: null,
      tsEpochMs: now - 2 * 24 * 60 * 60 * 1000,
      provider: 'anthropic',
      model: 'claude-test',
      project: 'retention-test',
      files: [{ path: 'app.ts', addedLines: ['current suggestion'] }],
    });

    assert.equal(store.pruneProposals(now - 30 * 24 * 60 * 60 * 1000), 1);
    assert.equal(store.proposalsInWindow('retention-test', 0, now + 1).length, 1);
    assert.equal(store.requestsInRange(0, now + 1).length, 1, 'proposal cleanup does not delete metering history');
  } finally {
    store.close();
  }
});

test('proposal capture coverage preserves explicit unknown instead of upgrading it to complete', () => {
  const store = new Store(':memory:');
  try {
    store.insertProposal({
      proposalId: 'unknown-capture', requestId: null, sessionId: null, tsEpochMs: Date.now(),
      provider: 'anthropic', model: 'claude', project: 'coverage-test', files: [], captureCoverage: 'unknown',
    });
    const row = store.proposalsInWindow('coverage-test', 0, Date.now() + 1000)[0];
    assert.equal(row?.captureCoverage, 'unknown');
  } finally {
    store.close();
  }
});

test('proposal storage rejects oversized or partial file payloads before SQLite persistence', () => {
  const store = new Store(':memory:');
  try {
    assert.throws(() => store.insertProposal({
      proposalId: 'too-many-lines', requestId: null, sessionId: null, tsEpochMs: Date.now(),
      provider: 'anthropic', model: 'claude', project: 'coverage-test',
      files: [{ path: 'x.ts', addedLines: Array.from({ length: 200_001 }, () => 'x') }],
    }), /line count|resource limit/);
    assert.throws(() => store.insertProposal({
      proposalId: 'partial-with-files', requestId: null, sessionId: null, tsEpochMs: Date.now(),
      provider: 'anthropic', model: 'claude', project: 'coverage-test',
      files: [{ path: 'x.ts', addedLines: ['x'] }], captureCoverage: 'truncated',
    }), /truncated/);
  } finally {
    store.close();
  }
});
