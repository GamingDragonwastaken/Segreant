/**
 * The shared transaction primitive: nested writers become savepoints, and an
 * import batch groups commits without letting one failed row take others with it.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { transact, writeBatch } from '../src/util/transaction.ts';

function db(): DatabaseSync {
  const d = new DatabaseSync(':memory:');
  d.exec('CREATE TABLE t (k TEXT PRIMARY KEY)');
  return d;
}
const keys = (d: DatabaseSync) => (d.prepare('SELECT k FROM t ORDER BY k').all() as Array<{ k: string }>).map((r) => r.k);

test('outside a transaction, transact commits or rolls back as a unit', () => {
  const d = db();
  transact(d, () => d.prepare("INSERT INTO t VALUES ('a')").run());
  assert.throws(() => transact(d, () => {
    d.prepare("INSERT INTO t VALUES ('b')").run();
    throw new Error('boom');
  }));
  assert.deepEqual(keys(d), ['a']);
  assert.equal(d.isTransaction, false);
});

test('inside a batch, a failed write rolls back alone and the batch keeps the rest', () => {
  const d = db();
  const batch = writeBatch(d, { maxRows: 1000, maxMs: 60_000 });
  try {
    transact(d, () => d.prepare("INSERT INTO t VALUES ('a')").run());
    assert.throws(() => transact(d, () => {
      d.prepare("INSERT INTO t VALUES ('b')").run();
      d.prepare("INSERT INTO t VALUES ('a')").run(); // conflict: the whole unit goes
    }));
    transact(d, () => d.prepare("INSERT INTO t VALUES ('c')").run());
    assert.equal(d.isTransaction, true, 'the batch is still open');
  } finally {
    batch.end();
  }
  assert.equal(d.isTransaction, false);
  assert.deepEqual(keys(d), ['a', 'c']);
});

test('a batch commits every maxRows writes, so another connection sees progress', () => {
  const d = db();
  const batch = writeBatch(d, { maxRows: 2, maxMs: 60_000 });
  for (const k of ['a', 'b', 'c']) {
    transact(d, () => d.prepare('INSERT INTO t VALUES (?)').run(k));
    batch.tick();
  }
  // Two ticks committed a and b; c is in the reopened batch.
  assert.equal(d.isTransaction, true);
  d.exec('ROLLBACK');
  assert.deepEqual(keys(d), ['a', 'b']);
  batch.end(); // nothing pending: ending is safe
  assert.equal(d.isTransaction, false);
});

test('a batch opened inside someone else\'s transaction owns nothing', () => {
  const d = db();
  d.exec('BEGIN');
  const batch = writeBatch(d);
  batch.tick();
  batch.end();
  assert.equal(d.isTransaction, true, 'the outer transaction is untouched');
  d.exec('COMMIT');
});
