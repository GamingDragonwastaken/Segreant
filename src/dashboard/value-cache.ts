/**
 * In-memory cache for the `/api/value` payload.
 *
 * Why it exists: with no stored realization (the user has not run `scan`), the
 * value report re-runs git realization for the start folder on every load —
 * 24.7 s, then 13.2 s again, with nothing changed. This cache answers repeat
 * loads from memory. It never writes the realization to the ledger: dashboard
 * reads are read-only by default, and persisting is an explicit `--apply`.
 *
 * Correctness rules:
 * - The key covers every input the report reads: the query string, the repo
 *   path and its HEAD commit, a hash of the whole config, and change marks on
 *   each ledger table the report depends on (max rowid plus exact row count).
 *   An append, a price change, a gate signal, a stored realization or a config
 *   edit therefore misses the cache.
 * - Entries live at most `ttlMs` from the start of their computation, whatever
 *   the key, because realization units mature with wall-clock time.
 * - The payload is cached whole, so its own `generatedAt` keeps the ORIGINAL
 *   compute time; nothing rewrites it on a hit.
 * - Concurrent identical requests share one in-flight computation.
 * - Bounded: at most `maxEntries` payloads, least recently used evicted first.
 *
 * A cache is owned per Store (see `valueReadCacheFor` in routes.ts), so a fresh
 * Store, as in each test, starts with an empty cache.
 */
import { createHash } from 'node:crypto';

export const VALUE_CACHE_MAX_ENTRIES = 8;
export const VALUE_CACHE_TTL_MS = 10 * 60_000;

export interface ValueReadCacheOptions {
  maxEntries?: number;
  ttlMs?: number;
  /** Injectable clock, so tests can advance time deterministically. */
  now?: () => number;
}

/** Diagnostics only; never sent on the wire. */
export interface ValueReadCacheStats {
  /** Computations started. */
  computes: number;
  /** Requests answered from a stored entry. */
  hits: number;
  /** Requests that joined a computation already in flight. */
  shared: number;
}

export interface LedgerMark {
  rowid: number;
  count: number;
}

export class ValueReadCache<T> {
  readonly stats: ValueReadCacheStats = { computes: 0, hits: 0, shared: 0 };
  private readonly entries = new Map<string, { value: T; startedAtMs: number }>();
  private readonly inflight = new Map<string, Promise<T>>();
  private readonly maxEntries: number;
  private readonly ttlMs: number;
  private readonly now: () => number;

  constructor(opts: ValueReadCacheOptions = {}) {
    this.maxEntries = Math.max(1, Math.floor(opts.maxEntries ?? VALUE_CACHE_MAX_ENTRIES));
    this.ttlMs = opts.ttlMs ?? VALUE_CACHE_TTL_MS;
    this.now = opts.now ?? Date.now;
  }

  /** Return the stored value for `key`, or run `compute` once and store its result. */
  get(key: string, compute: () => Promise<T>): Promise<T> {
    const nowMs = this.now();
    const stored = this.entries.get(key);
    if (stored !== undefined) {
      const age = nowMs - stored.startedAtMs;
      if (age >= 0 && age < this.ttlMs) {
        // Re-insert to mark it most recently used.
        this.entries.delete(key);
        this.entries.set(key, stored);
        this.stats.hits += 1;
        return Promise.resolve(stored.value);
      }
      this.entries.delete(key);
    }
    const running = this.inflight.get(key);
    if (running !== undefined) {
      this.stats.shared += 1;
      return running;
    }
    this.stats.computes += 1;
    const started = Promise.resolve()
      .then(compute)
      .then(
        (value) => {
          this.inflight.delete(key);
          this.store(key, value, nowMs);
          return value;
        },
        (err: unknown) => {
          this.inflight.delete(key);
          throw err;
        },
      );
    this.inflight.set(key, started);
    return started;
  }

  private store(key: string, value: T, startedAtMs: number): void {
    this.entries.delete(key);
    this.entries.set(key, { value, startedAtMs });
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
  }

  /** Number of stored entries (expired ones included until next touched). */
  get size(): number {
    return this.entries.size;
  }
}

export interface ValueCacheKeyInput {
  /** The request's query string, all parameters. */
  params: URLSearchParams;
  /** The repo path the report is computed for. */
  repo: string;
  /** `git rev-parse HEAD` for that repo, or null when it is not a git repo. */
  head: string | null;
  /** The whole config the report reads; only its hash enters the key. */
  config: unknown;
  /** Change marks for each ledger table the report depends on. */
  marks: Record<string, LedgerMark>;
}

export function valueCacheKey(input: ValueCacheKeyInput): string {
  const params = [...input.params.entries()].sort(([ak, av], [bk, bv]) => {
    if (ak !== bk) return ak < bk ? -1 : 1;
    if (av === bv) return 0;
    return av < bv ? -1 : 1;
  });
  return JSON.stringify({
    params,
    repo: input.repo,
    head: input.head ?? 'no-git',
    config: createHash('sha256').update(JSON.stringify(input.config) ?? 'null').digest('hex'),
    marks: input.marks,
  });
}
