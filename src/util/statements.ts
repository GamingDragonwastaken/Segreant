/**
 * Compiled-statement cache for node:sqlite.
 *
 * `db.prepare(sql)` compiles the SQL on every call. On the proxy's per-request
 * path (budget check, ledger write, charge projection) the same few statements
 * run thousands of times, and compiling each one cost about six times as much
 * as running it. A statement compiled once per connection is reused instead.
 *
 * Safe to share because callers only use run/get/all, which bind fresh
 * parameters and finish before returning; nothing here holds an iterator open
 * across a nested call, and no caller changes statement settings. SQLite
 * re-prepares a cached statement itself if the schema changes under it. The
 * cache is bounded, so SQL built with a variable number of placeholders cannot
 * grow it without limit.
 */
import type { DatabaseSync, StatementSync } from 'node:sqlite';

const MAX_STATEMENTS_PER_CONNECTION = 512;
const caches = new WeakMap<DatabaseSync, Map<string, StatementSync>>();

export function prepared(db: DatabaseSync, sql: string): StatementSync {
  let cache = caches.get(db);
  if (cache === undefined) {
    cache = new Map();
    caches.set(db, cache);
  }
  const hit = cache.get(sql);
  if (hit !== undefined) return hit;
  const statement = db.prepare(sql);
  if (cache.size >= MAX_STATEMENTS_PER_CONNECTION) cache.delete(cache.keys().next().value!);
  cache.set(sql, statement);
  return statement;
}

/** How long a full row count is reused before it is taken again. */
export const FULL_COUNT_REUSE_MS = 1_000;

/**
 * "Has anything been appended to, or removed from, this table?" in O(1).
 *
 * Cache invalidation used MAX(rowid) with COUNT(*), and COUNT(*) walks the
 * whole table: on a year of ledger it cost milliseconds on every proxied
 * request, twice. The full count is now taken at most once per
 * FULL_COUNT_REUSE_MS; in between, the rows appended since that count are
 * counted by rowid range, which is cheap. An append is therefore seen at once.
 * The full count is taken again at once when another connection has committed
 * (PRAGMA data_version, e.g. a prune from the CLI while the proxy runs) or when
 * the highest rowid fell (a VACUUM renumbered rows). A deletion made through
 * this same connection is seen when that code calls reset(), which prune does,
 * or at the next full count. Removing rows only lowers spend, so a figure that
 * missed one for up to a second overstates spend: the safe side for a cap.
 */
export class AppendMark {
  private base: { rowid: number; count: number; atMs: number; dataVersion: number } | null = null;
  private readonly db: DatabaseSync;
  private readonly table: string;

  constructor(db: DatabaseSync, table: string) {
    this.db = db;
    this.table = table;
  }

  read(nowMs = Date.now()): { rowid: number; count: number } {
    const dataVersion = Number((prepared(this.db, 'PRAGMA data_version').get() as { data_version: number }).data_version);
    const max = Number((prepared(this.db, `SELECT COALESCE(MAX(rowid), 0) AS rowid FROM ${this.table}`).get() as { rowid: number }).rowid);
    const base = this.base;
    if (base === null || nowMs - base.atMs >= FULL_COUNT_REUSE_MS || nowMs < base.atMs
        || dataVersion !== base.dataVersion || max < base.rowid) {
      const full = prepared(this.db, `SELECT COALESCE(MAX(rowid), 0) AS rowid, COUNT(*) AS count FROM ${this.table}`)
        .get() as { rowid: number; count: number };
      this.base = { rowid: Number(full.rowid), count: Number(full.count), atMs: nowMs, dataVersion };
      return { rowid: this.base.rowid, count: this.base.count };
    }
    const since = prepared(this.db, `SELECT COUNT(*) AS count FROM ${this.table} WHERE rowid > ?`)
      .get(base.rowid) as { count: number };
    return { rowid: max, count: base.count + Number(since.count) };
  }

  reset(): void {
    this.base = null;
  }
}
