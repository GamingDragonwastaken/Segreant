/**
 * A deletion and the record of it were three separate statements.
 *
 * D-170 built `retention_prunes` for one reason: a deleted history and a
 * history that never happened are the same thing to every later reader unless
 * the boundary is on record. Every packet in this program's retention sweep
 * (D-171, D-173, D-176, D-182, D-183, D-185, D-186) reads that record and is
 * worth exactly what it is worth.
 *
 * And `prune` wrote it in three unprotected statements: `DELETE FROM requests`,
 * then `recordPrune`, then `VACUUM`. Nothing binds the first two together. If
 * the insert fails -- a disk error, a schema the process cannot write, a
 * constraint, a crash between them -- the rows are gone and the boundary is
 * not on record, which is the D-170 defect reconstructed by a failure path
 * rather than by an absent table. `pruneProposals` and `clearProposals` had the
 * same shape, and `clearProposals` is the most total erasure Fiscus offers.
 *
 * HOW THE FAILURE IS INDUCED. A trigger that raises ABORT on any insert into
 * `retention_prunes`, installed through the raw `DatabaseSync` handle. Reaching
 * past `private db` is deliberate: the point is to break a step that has no
 * public seam, and any public API for injecting a failure into the store's own
 * bookkeeping would be a worse thing to ship than a cast in one test file.
 *
 * WHY THE ASSERTION IS "ROWS SURVIVE" AND NOT "BOUNDARY IS WRITTEN". There are
 * only two honest outcomes when the record cannot be written: delete nothing,
 * or delete and lose the boundary. The second is the state this program refuses
 * -- unknown must stay unknown, and a ledger that cannot say what it deleted
 * cannot say anything else either. So the deletion is what gives way. An
 * operator whose prune failed still has their data and a legible error; an
 * operator whose record failed silently has neither.
 *
 * VACUUM STAYS OUTSIDE. SQLite refuses to VACUUM inside a transaction, so the
 * atomic unit is DELETE + record, and compaction runs after the commit. That is
 * the correct boundary anyway: a failed VACUUM leaves a larger file, not a
 * missing record, and the file size is not a claim about anything.
 *
 * WHAT THIS DOES NOT ESTABLISH. That a mid-transaction process kill is
 * survivable -- that is SQLite's journal and not this code, and it is not
 * tested here. That other multi-statement store writes are atomic: only the
 * three deletion paths were swept, and `DELETE FROM project_aliases` and
 * `DELETE FROM active_provider_scope_routes` (D-187) are single statements with
 * no companion record and are therefore out of this class. Nor anything about
 * what the deleted rows contained, which is gone either way.
 *
 * Recorded at D-189.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';
import { Store, type RequestRow, type ProposalRow } from '../src/store/db.ts';

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2025, 0, 20, 12, 0, 0);

function request(id: string, tsEpochMs: number): RequestRow {
  return {
    requestId: id, sessionId: null, tsEpochMs, provider: 'openai', model: 'gpt-5',
    project: 'prune-atomicity', taskWeight: 1, inputTokens: 10, outputTokens: 10,
    cacheWriteTokens: 0, cacheReadTokens: 0, reasoningTokens: 0, costUsd: 1.5,
    estimated: false, streamed: false, statusCode: 200, durationMs: 1,
  };
}

function proposal(id: string, tsEpochMs: number): ProposalRow {
  return {
    proposalId: id, requestId: 'r-old', sessionId: null, tsEpochMs,
    provider: 'openai', model: 'gpt-5', project: 'prune-atomicity',
    files: [{ path: 'app.ts', addedLines: ['const x = 1;'] }], captureCoverage: 'complete',
  };
}

/**
 * The raw handle. `db` is private for good reasons; this test exists precisely
 * to break the store's internal bookkeeping step, which has no public seam and
 * should not acquire one.
 */
function handle(store: Store): DatabaseSync {
  return (store as unknown as { db: DatabaseSync }).db;
}

/** Make every write to the prune record fail, deterministically. */
function refuseTheRecord(store: Store): void {
  handle(store).prepare(
    `CREATE TRIGGER block_prune BEFORE INSERT ON retention_prunes
     BEGIN SELECT RAISE(ABORT, 'record refused'); END;`,
  ).run();
}

function requestCount(store: Store): number {
  const row = handle(store).prepare('SELECT COUNT(*) AS n FROM requests').get() as { n: number };
  return Number(row.n);
}

function proposalCount(store: Store): number {
  const row = handle(store).prepare('SELECT COUNT(*) AS n FROM proposals').get() as { n: number };
  return Number(row.n);
}

test('a request prune whose record cannot be written deletes nothing', () => {
  const store = new Store(':memory:');
  try {
    store.insertRequest(request('r-old-1', NOW - 90 * DAY));
    store.insertRequest(request('r-old-2', NOW - 60 * DAY));
    store.insertRequest(request('r-recent', NOW - DAY));
    refuseTheRecord(store);

    assert.throws(() => store.prune(NOW - 30 * DAY), /record refused/);

    assert.equal(requestCount(store), 3, 'the rows the record could not describe must still be there');
    assert.equal(
      store.retentionFloor().requestsPrunedBeforeMs, null,
      'and no boundary is on record, because nothing was deleted',
    );
    assert.equal(store.retentionFloor().requestsRowsRemoved, 0);
  } finally {
    store.close();
  }
});

test('a proposal prune whose record cannot be written deletes nothing', () => {
  const store = new Store(':memory:');
  try {
    store.insertProposal(proposal('p-old', NOW - 90 * DAY));
    store.insertProposal(proposal('p-recent', NOW - DAY));
    refuseTheRecord(store);

    assert.throws(() => store.pruneProposals(NOW - 30 * DAY), /record refused/);

    assert.equal(proposalCount(store), 2, 'the AI\'s proposed code is still stored, which is the honest state');
    assert.equal(store.retentionFloor().proposalsPrunedBeforeMs, null);
    assert.equal(store.retentionFloor().proposalsRowsRemoved, 0);
  } finally {
    store.close();
  }
});

test('the total proposal erasure deletes nothing when its record cannot be written', () => {
  // clearProposals is the most total deletion Fiscus offers and the one D-179
  // made recordable. An unrecorded total erasure is the exact state that made
  // the Acceptance lens tell operators their proposals were never captured.
  const store = new Store(':memory:');
  try {
    store.insertProposal(proposal('p-1', NOW - 90 * DAY));
    store.insertProposal(proposal('p-2', NOW - DAY));
    refuseTheRecord(store);

    assert.throws(() => store.clearProposals(), /record refused/);

    assert.equal(proposalCount(store), 2, 'nothing was erased, so nothing needs a boundary');
    assert.equal(store.retentionFloor().proposalsPrunedBeforeMs, null);
  } finally {
    store.close();
  }
});

test('an ordinary prune still deletes and still records', () => {
  // The guard. Making the deletion conditional on the record is only correct if
  // the ordinary path is unchanged, so this asserts the pre-existing behaviour
  // in full: rows go, the boundary is written, and the count is exact.
  const store = new Store(':memory:');
  try {
    store.insertRequest(request('r-old-1', NOW - 90 * DAY));
    store.insertRequest(request('r-old-2', NOW - 60 * DAY));
    store.insertRequest(request('r-recent', NOW - DAY));
    store.insertProposal(proposal('p-old', NOW - 90 * DAY));
    store.insertProposal(proposal('p-recent', NOW - DAY));

    const boundary = NOW - 30 * DAY;
    assert.equal(store.prune(boundary), 2);
    assert.equal(requestCount(store), 1);
    assert.equal(store.retentionFloor().requestsPrunedBeforeMs, boundary);
    assert.equal(store.retentionFloor().requestsRowsRemoved, 2);

    assert.equal(store.pruneProposals(boundary), 1);
    assert.equal(proposalCount(store), 1);
    assert.equal(store.retentionFloor().proposalsPrunedBeforeMs, boundary);
    assert.equal(store.retentionFloor().proposalsRowsRemoved, 1);

    assert.equal(store.clearProposals(), 1);
    assert.equal(proposalCount(store), 0);
    assert.equal(store.retentionFloor().proposalsPrunes, 2, 'both proposal deletions are on record');
  } finally {
    store.close();
  }
});

test('a prune that removes no rows still records its boundary', () => {
  // D-170's rule, asserted here so the transaction change cannot quietly turn a
  // zero-row prune into a no-op: the boundary was applied whether or not it
  // caught anything, and a later reader needs to know it was.
  const store = new Store(':memory:');
  try {
    store.insertRequest(request('r-recent', NOW - DAY));
    const boundary = NOW - 30 * DAY;
    assert.equal(store.prune(boundary), 0);
    assert.equal(store.retentionFloor().requestsPrunedBeforeMs, boundary, 'the boundary was applied and is on record');
    assert.equal(store.retentionFloor().requestsRowsRemoved, 0);
  } finally {
    store.close();
  }
});
