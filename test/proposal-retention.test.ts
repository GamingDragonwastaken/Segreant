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
