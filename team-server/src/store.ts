/**
 * Storage interface for the team server, plus its real Postgres-backed
 * implementation. Kept as an interface — not just a class — so the HTTP layer
 * (server.ts) can be exercised in tests against an in-memory fake instead of
 * a live Postgres (see test/fakeStore.ts). Same "test through a real
 * interface boundary" instinct as the rest of Fiscus: mock HTTP servers
 * stand in for upstream/judge endpoints elsewhere; here, a fake store stands
 * in for Postgres so auth/verification/routing logic is provable without an
 * external database in CI.
 */

import pg from 'pg';
const { Pool } = pg;
import { combineRollupCoverage, normalizeRollupCoverage, type RollupCoverage, type SignedRollup, type RollupBody } from '../../src/team/rollup.ts';

export interface RegisteredDeveloper {
  keyId: string;
  publicKey: string;
  label: string | null;
  registeredAt: string;
}

export interface StoredRollup {
  id: string;
  keyId: string;
  generatedAt: string;
  periodFrom: string;
  periodTo: string;
  receivedAt: string;
  body: RollupBody;
}

/**
 * Result of accepting a signed rollup.
 *
 * A client may retry after losing a response.  The database's
 * `(key_id, body_hash)` uniqueness makes that exact retry idempotent: it
 * returns the original immutable record rather than creating a fresh snapshot
 * with a new `received_at` timestamp.
 */
export interface InsertRollupResult {
  rollup: StoredRollup;
  replayed: boolean;
}

/** Optional window over `rollups.period_from`/`period_to` (interval overlap, not containment). Omitted bounds are open-ended. */
export interface PeriodFilter {
  periodFrom?: string;
  periodTo?: string;
}

/**
 * Team-wide totals for one project, summed across every contributing
 * developer's rollups. `realizationRate` and `avgRoiIndex` are deliberately
 * NOT plain averages of each rollup's own value — see aggregate.ts's header
 * comment for why naive averaging would silently redefine what these numbers
 * mean relative to the single-machine dashboard.
 */
/**
 * One distinct observation window among the rollups that fed an aggregate.
 *
 * WHY THIS EXISTS SEPARATELY FROM THE TOTALS. A rollup's window is chosen by
 * whoever pushed it — `fiscus team push --window D` defaults to 30 and takes
 * anything — so the snapshots summed into one team total need not cover the
 * same period at all. The server already refuses to filter a snapshot by a
 * partial window, on the stated grounds that it "would present its whole total
 * as though it belonged to that partial window", and then summed windows that
 * disagree with each other into a figure that named no period. This is the
 * evidence a reader needs to see that the sum is not one period. Recorded at
 * D-102.
 */
export interface ObservationWindow {
  periodFrom: string;
  periodTo: string;
  developerCount: number;
  coverage: RollupCoverage;
}

export interface ProjectTotals {
  project: string;
  developerCount: number;
  rollupCount: number;
  totalUnits: number;
  totalCostUsd: number;
  totalSpendOnRealizedUnitsUsd: number;
  totalAcceptanceWeightedSpendUsd: number;
  /** Denominator-weighted across rollups: SUM(realizedUnits)/SUM(units) — same "unit-count" metric as ProjectValue.realizationRate, not a dollar ratio. Null when totalUnits is 0. */
  realizationRate: number | null;
  /** Dollar-weighted: totalSpendOnRealizedUnitsUsd/totalCostUsd. Null when totalCostUsd is 0. */
  realizedSpendShare: number | null;
  /** Cost-weighted average RoI Index over rows that have one. Null when no contributing row has a roiIndex. */
  avgRoiIndex: number | null;
}

/** Raw (identified) per-developer totals — privacy gating happens in aggregate.ts, not here. */
export interface DeveloperTotals {
  keyId: string;
  label: string | null;
  rollupCount: number;
  totalCostUsd: number;
  totalSpendOnRealizedUnitsUsd: number;
  realizedSpendShare: number | null;
  lastPushedAt: string;
}

export interface RollupStore {
  registerDeveloper(keyId: string, publicKey: string, label: string | null): Promise<void>;
  findDeveloper(keyId: string): Promise<RegisteredDeveloper | null>;
  insertRollup(signed: SignedRollup): Promise<InsertRollupResult>;
  listRollups(opts?: { keyId?: string; limit?: number }): Promise<StoredRollup[]>;
  aggregateProjects(filter?: PeriodFilter): Promise<ProjectTotals[]>;
  aggregateDevelopers(filter?: PeriodFilter): Promise<DeveloperTotals[]>;
  /** The distinct windows of the rollups that `aggregateProjects` would sum. */
  observationWindows(filter?: PeriodFilter): Promise<ObservationWindow[]>;
  close(): Promise<void>;
}

interface DeveloperRow {
  key_id: string;
  public_key: string;
  label: string | null;
  registered_at: Date;
}

interface RollupInsertRow {
  id: string;
  received_at: Date;
}

interface RollupRow {
  id: string;
  key_id: string;
  generated_at: Date;
  period_from: Date;
  period_to: Date;
  received_at: Date;
  body: RollupBody;
}

interface ProjectTotalsRow {
  project: string;
  developer_count: number;
  rollup_count: number;
  total_units: number;
  total_cost_usd: number;
  total_spend_on_realized_units_usd: number;
  total_acceptance_weighted_spend_usd: number;
  realization_rate: number | null;
  realized_spend_share: number | null;
  avg_roi_index: number | null;
}

interface DeveloperTotalsRow {
  key_id: string;
  label: string | null;
  rollup_count: number;
  total_cost_usd: number;
  total_spend_on_realized_units_usd: number;
  realized_spend_share: number | null;
  last_pushed_at: Date;
}

export class PgRollupStore implements RollupStore {
  private readonly pool: InstanceType<typeof Pool>;

  constructor(databaseUrl: string) {
    this.pool = new Pool({ connectionString: databaseUrl });
  }

  /** Idempotent (schema.sql is all IF NOT EXISTS) — safe to call on every boot. */
  async applySchema(schemaSql: string): Promise<void> {
    await this.pool.query(schemaSql);
  }

  async registerDeveloper(keyId: string, publicKey: string, label: string | null): Promise<void> {
    await this.pool.query(
      `INSERT INTO developers (key_id, public_key, label) VALUES ($1, $2, $3)
       ON CONFLICT (key_id) DO UPDATE SET public_key = EXCLUDED.public_key, label = EXCLUDED.label`,
      [keyId, publicKey, label],
    );
  }

  async findDeveloper(keyId: string): Promise<RegisteredDeveloper | null> {
    const res = await this.pool.query<DeveloperRow>(
      `SELECT key_id, public_key, label, registered_at FROM developers WHERE key_id = $1`,
      [keyId],
    );
    const row = res.rows[0];
    if (!row) return null;
    return { keyId: row.key_id, publicKey: row.public_key, label: row.label, registeredAt: row.registered_at.toISOString() };
  }

  private asStoredRollup(row: RollupRow): StoredRollup {
    return {
      id: row.id,
      keyId: row.key_id,
      generatedAt: row.generated_at.toISOString(),
      periodFrom: row.period_from.toISOString(),
      periodTo: row.period_to.toISOString(),
      receivedAt: row.received_at.toISOString(),
      body: row.body,
    };
  }

  async insertRollup(signed: SignedRollup): Promise<InsertRollupResult> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const res = await client.query<RollupInsertRow>(
        `INSERT INTO rollups (key_id, generated_at, period_from, period_to, body_hash, body)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (key_id, body_hash) DO NOTHING
         RETURNING id, received_at`,
        [signed.keyId, signed.body.generatedAt, signed.body.period.from, signed.body.period.to, signed.bodyHash, JSON.stringify(signed.body)],
      );
      const inserted = res.rows[0];
      if (!inserted) {
        // A client can receive a network failure after the server committed a
        // valid rollup and retry it.  Return the exact old row, including its
        // original receipt time; never turn a retry into a newer snapshot.
        const existingResult = await client.query<RollupRow>(
          `SELECT id, key_id, generated_at, period_from, period_to, received_at, body
           FROM rollups
           WHERE key_id = $1 AND body_hash = $2`,
          [signed.keyId, signed.bodyHash],
        );
        const existing = existingResult.rows[0];
        if (!existing) throw new Error('rollup replay conflict did not return the existing row');
        await client.query('COMMIT');
        return { rollup: this.asStoredRollup(existing), replayed: true };
      }
      for (const p of signed.body.projects) {
        await client.query(
          `INSERT INTO rollup_projects
             (rollup_id, project, units, cost_usd, realization_rate, spend_on_realized_units_usd, acceptance_weighted_spend_usd, roi_index, sources, economic_json)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
          [inserted.id, p.project, p.units, p.costUsd, p.realizationRate, p.spendOnRealizedUnitsUsd, p.acceptanceWeightedSpendUsd, p.roiIndex, JSON.stringify(p.sources), p.economic === undefined ? null : JSON.stringify(p.economic)],
        );
      }
      await client.query('COMMIT');
      return {
        rollup: {
          id: inserted.id,
          keyId: signed.keyId,
          generatedAt: signed.body.generatedAt,
          periodFrom: signed.body.period.from,
          periodTo: signed.body.period.to,
          receivedAt: inserted.received_at.toISOString(),
          body: signed.body,
        },
        replayed: false,
      };
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  async listRollups(opts: { keyId?: string; limit?: number } = {}): Promise<StoredRollup[]> {
    const limit = opts.limit ?? 50;
    const res = opts.keyId
      ? await this.pool.query<RollupRow>(
          `SELECT id, key_id, generated_at, period_from, period_to, received_at, body FROM rollups
           WHERE key_id = $1 ORDER BY received_at DESC LIMIT $2`,
          [opts.keyId, limit],
        )
      : await this.pool.query<RollupRow>(
          `SELECT id, key_id, generated_at, period_from, period_to, received_at, body FROM rollups
           ORDER BY received_at DESC LIMIT $1`,
          [limit],
        );
    return res.rows.map((row) => this.asStoredRollup(row));
  }

  /**
   * Every aggregate expression is cast to ::float8 explicitly. Two node-postgres
   * gotchas otherwise bite here: COUNT(...) returns BIGINT, and SUM() over an
   * INTEGER column also promotes to BIGINT per the SQL standard — and `pg`
   * returns BIGINT as a STRING by default (it can exceed Number.MAX_SAFE_INTEGER
   * in general), which would silently hand callers `"3"` instead of `3`. Casting
   * every aggregate to float8 sidesteps that uniformly; realistic rollup/unit
   * counts are nowhere near double's exact-integer range (2^53).
   */
  /**
   * The same `latest_rollup_per_dev` population the aggregates use, grouped by
   * the window each of those rollups declared. Deliberately a separate query
   * rather than another column on the totals: the totals are per project and a
   * window is per developer, so folding one into the other would either
   * duplicate windows per project row or silently pick one of them.
   */
  async observationWindows(filter: PeriodFilter = {}): Promise<ObservationWindow[]> {
    const res = await this.pool.query<{
      period_from: Date;
      period_to: Date;
      developer_count: string | number;
      coverages: string[];
    }>(
      `WITH latest_rollup_per_dev AS (
         SELECT DISTINCT ON (r.key_id) r.id, r.key_id, r.period_from, r.period_to,
                COALESCE(r.body->>'coverage', 'unknown') AS coverage
         FROM rollups r
         WHERE ($1::timestamptz IS NULL OR r.period_to > $1::timestamptz)
           AND ($2::timestamptz IS NULL OR r.period_from < $2::timestamptz)
         ORDER BY r.key_id, r.received_at DESC, r.id DESC
       )
       SELECT lr.period_from AS period_from, lr.period_to AS period_to,
              COUNT(DISTINCT lr.key_id)::float8 AS developer_count,
              ARRAY_AGG(DISTINCT lr.coverage) AS coverages
       FROM latest_rollup_per_dev lr
       GROUP BY lr.period_from, lr.period_to
       ORDER BY lr.period_from ASC, lr.period_to ASC`,
      [filter.periodFrom ?? null, filter.periodTo ?? null],
    );
    return res.rows.map((row) => ({
      periodFrom: row.period_from.toISOString(),
      periodTo: row.period_to.toISOString(),
      developerCount: Number(row.developer_count),
      coverage: combineRollupCoverage(row.coverages.map((value) => normalizeRollupCoverage({
        v: 1,
        keyId: 'coverage-only',
        generatedAt: '1970-01-01T00:00:00.000Z',
        period: { from: '1970-01-01T00:00:00.000Z', to: '1970-01-02T00:00:00.000Z' },
        projects: [],
        coverage: value as RollupCoverage,
      }))),
    }));
  }

  async aggregateProjects(filter: PeriodFilter = {}): Promise<ProjectTotals[]> {
    const res = await this.pool.query<ProjectTotalsRow>(
      `WITH latest_rollup_per_dev AS (
         SELECT DISTINCT ON (r.key_id) r.id
         FROM rollups r
         WHERE ($1::timestamptz IS NULL OR r.period_to > $1::timestamptz)
           AND ($2::timestamptz IS NULL OR r.period_from < $2::timestamptz)
         ORDER BY r.key_id, r.received_at DESC, r.id DESC
       )
       SELECT
         rp.project AS project,
         COUNT(DISTINCT r.key_id)::float8 AS developer_count,
         COUNT(DISTINCT r.id)::float8 AS rollup_count,
         COALESCE(SUM(rp.units), 0)::float8 AS total_units,
         COALESCE(SUM(rp.cost_usd), 0)::float8 AS total_cost_usd,
         COALESCE(SUM(rp.spend_on_realized_units_usd), 0)::float8 AS total_spend_on_realized_units_usd,
         COALESCE(SUM(rp.acceptance_weighted_spend_usd), 0)::float8 AS total_acceptance_weighted_spend_usd,
         (SUM(rp.realization_rate * rp.units) / NULLIF(SUM(rp.units), 0))::float8 AS realization_rate,
         (SUM(rp.spend_on_realized_units_usd) / NULLIF(SUM(rp.cost_usd), 0))::float8 AS realized_spend_share,
         (SUM(CASE WHEN rp.roi_index IS NOT NULL THEN rp.roi_index * rp.cost_usd ELSE 0 END)
            / NULLIF(SUM(CASE WHEN rp.roi_index IS NOT NULL THEN rp.cost_usd ELSE 0 END), 0))::float8 AS avg_roi_index
       FROM rollup_projects rp
       JOIN rollups r ON r.id = rp.rollup_id
       WHERE r.id IN (SELECT id FROM latest_rollup_per_dev)
       GROUP BY rp.project
       ORDER BY total_cost_usd DESC`,
      [filter.periodFrom ?? null, filter.periodTo ?? null],
    );
    return res.rows.map((row) => ({
      project: row.project,
      developerCount: row.developer_count,
      rollupCount: row.rollup_count,
      totalUnits: row.total_units,
      totalCostUsd: row.total_cost_usd,
      totalSpendOnRealizedUnitsUsd: row.total_spend_on_realized_units_usd,
      totalAcceptanceWeightedSpendUsd: row.total_acceptance_weighted_spend_usd,
      realizationRate: row.realization_rate,
      realizedSpendShare: row.realized_spend_share,
      avgRoiIndex: row.avg_roi_index,
    }));
  }

  async aggregateDevelopers(filter: PeriodFilter = {}): Promise<DeveloperTotals[]> {
    const res = await this.pool.query<DeveloperTotalsRow>(
      `WITH latest_rollup_per_dev AS (
         SELECT DISTINCT ON (r.key_id) r.id, r.key_id, r.received_at
         FROM rollups r
         WHERE ($1::timestamptz IS NULL OR r.period_to > $1::timestamptz)
           AND ($2::timestamptz IS NULL OR r.period_from < $2::timestamptz)
         ORDER BY r.key_id, r.received_at DESC, r.id DESC
       )
       SELECT
         d.key_id AS key_id,
         d.label AS label,
         COUNT(DISTINCT lr.id)::float8 AS rollup_count,
         COALESCE(SUM(rp.cost_usd), 0)::float8 AS total_cost_usd,
         COALESCE(SUM(rp.spend_on_realized_units_usd), 0)::float8 AS total_spend_on_realized_units_usd,
         (SUM(rp.spend_on_realized_units_usd) / NULLIF(SUM(rp.cost_usd), 0))::float8 AS realized_spend_share,
         MAX(lr.received_at) AS last_pushed_at
       FROM developers d
       JOIN latest_rollup_per_dev lr ON lr.key_id = d.key_id
       LEFT JOIN rollup_projects rp ON rp.rollup_id = lr.id
       GROUP BY d.key_id, d.label
       ORDER BY total_cost_usd DESC`,
      [filter.periodFrom ?? null, filter.periodTo ?? null],
    );
    return res.rows.map((row) => ({
      keyId: row.key_id,
      label: row.label,
      rollupCount: row.rollup_count,
      totalCostUsd: row.total_cost_usd,
      totalSpendOnRealizedUnitsUsd: row.total_spend_on_realized_units_usd,
      realizedSpendShare: row.realized_spend_share,
      lastPushedAt: row.last_pushed_at.toISOString(),
    }));
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}
