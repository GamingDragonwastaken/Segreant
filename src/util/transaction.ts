/**
 * One transaction primitive for every writer on a node:sqlite connection.
 *
 * Outside a transaction it opens `BEGIN IMMEDIATE`, as every writer here always
 * has. Inside one (an import batch, or a writer calling another writer) it uses
 * a SAVEPOINT instead, so the inner work still commits or rolls back as a unit
 * without ending the outer transaction. That is what lets an importer group
 * thousands of row writes into one commit while a single conflicting row still
 * rolls back alone.
 */
import type { DatabaseSync } from 'node:sqlite';
import { prepared } from './statements.ts';

let savepointSeq = 0;

export function transact<T>(db: DatabaseSync, work: () => T): T {
  if (!db.isTransaction) {
    prepared(db, 'BEGIN IMMEDIATE').run();
    try {
      const result = work();
      prepared(db, 'COMMIT').run();
      return result;
    } catch (error) {
      try { prepared(db, 'ROLLBACK').run(); } catch { /* preserve original failure */ }
      throw error;
    }
  }
  const name = `sp_${(savepointSeq = (savepointSeq + 1) % 1_000_000)}`;
  db.exec(`SAVEPOINT ${name}`);
  try {
    const result = work();
    db.exec(`RELEASE ${name}`);
    return result;
  } catch (error) {
    try {
      db.exec(`ROLLBACK TO ${name}`);
      db.exec(`RELEASE ${name}`);
    } catch { /* preserve original failure */ }
    throw error;
  }
}

/**
 * A write batch for bulk imports: one outer transaction, committed every
 * `maxRows` writes or `maxMs` milliseconds, whichever comes first. Committing
 * often matters because a live proxy may be writing to the same ledger from
 * another process; it waits on SQLite's busy timeout (5 s) for at most one
 * batch interval, never for the whole import.
 */
export interface WriteBatch {
  /** Count one write; commits and reopens the batch when a limit is reached. */
  tick(): void;
  /** Commit what is pending and close the batch. Safe to call twice. */
  end(): void;
}

export function writeBatch(db: DatabaseSync, opts: { maxRows?: number; maxMs?: number } = {}): WriteBatch {
  const maxRows = opts.maxRows ?? 2000;
  const maxMs = opts.maxMs ?? 200;
  // Already inside someone else's transaction: nest nothing, own nothing.
  if (db.isTransaction) return { tick() {}, end() {} };
  let open = true;
  let rows = 0;
  let since = Date.now();
  prepared(db, 'BEGIN IMMEDIATE').run();
  const commit = () => {
    if (db.isTransaction) prepared(db, 'COMMIT').run();
  };
  return {
    tick() {
      if (!open) return;
      rows += 1;
      if (rows >= maxRows || Date.now() - since >= maxMs) {
        commit();
        prepared(db, 'BEGIN IMMEDIATE').run();
        rows = 0;
        since = Date.now();
      }
    },
    end() {
      if (!open) return;
      open = false;
      commit();
    },
  };
}
