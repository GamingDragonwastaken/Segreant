/**
 * Local persistence — built on Node's bundled SQLite (node:sqlite).
 *
 * No native module, no build step, no external service. The whole point of the
 * product is that nothing leaves the machine, so the store is a single local
 * file under ~/.aegisflow.
 *
 * Timestamps are stored twice: an ISO string for humans and an epoch-ms integer
 * for fast range/window queries. Day boundaries are computed in JS (local time)
 * and queried by epoch range, which sidesteps SQLite timezone surprises.
 */

import '../util/quiet.ts';
import { DatabaseSync } from 'node:sqlite';
import { dirname } from 'node:path';
import { existsSync, mkdirSync } from 'node:fs';

export interface RequestRow {
  requestId: string;
  sessionId: string | null;
  tsEpochMs: number;
  provider: string;
  model: string;
  project: string;
  taskWeight: number;
  inputTokens: number;
  outputTokens: number;
  cacheWriteTokens: number;
  cacheReadTokens: number;
  reasoningTokens: number;
  costUsd: number;
  estimated: boolean;
  streamed: boolean;
  statusCode: number | null;
  durationMs: number | null;
  user?: string | null; // developer/team attribution (x-aegis-user header); null = unassigned
  source?: string | null; // connected tool/feed attribution (x-aegis-source header); null = direct
}

export interface SpendBucket {
  label: string;
  costUsd: number;
  requests: number;
  inputTokens: number;
  outputTokens: number;
}

export interface ProposalRow {
  proposalId: string;
  requestId: string | null;
  sessionId: string | null;
  tsEpochMs: number;
  provider: string;
  model: string;
  project: string;
  files: Array<{ path: string | null; addedLines: string[] }>;
}

export interface GateSignalRow {
  signalId: string;
  kind: string; // 'tested' | 'merged' | 'shipped' | 'incident'
  commitHash: string | null;
  project: string;
  tsEpochMs: number;
  verdict: string; // 'pass' | 'fail'
  detail: string | null;
}

/**
 * A persisted snapshot of one computed work unit. The store keeps these so
 * realized value outlives the process (and the checkout) that produced it — the
 * full WorkUnit lives in `unitJson`; the broken-out columns are what we query on.
 */
export interface RealizationUnitRecord {
  commitHash: string;
  project: string;
  tsEpochMs: number;
  computedAtMs: number;
  attributedCostUsd: number;
  maturing: boolean;
  realized: boolean;
  unitJson: string; // serialized WorkUnit (funnel + attribution + taskType + dominantModel)
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS sessions (
  session_id TEXT PRIMARY KEY NOT NULL,
  project    TEXT NOT NULL DEFAULT 'default',
  tool       TEXT NOT NULL DEFAULT 'unknown',
  start_ms   INTEGER NOT NULL,
  end_ms     INTEGER,
  status     TEXT NOT NULL DEFAULT 'active'
);

CREATE TABLE IF NOT EXISTS requests (
  request_id        TEXT PRIMARY KEY NOT NULL,
  session_id        TEXT,
  ts_iso            TEXT NOT NULL,
  ts_epoch_ms       INTEGER NOT NULL,
  provider          TEXT NOT NULL,
  model             TEXT NOT NULL,
  project           TEXT NOT NULL DEFAULT 'default',
  task_weight       REAL NOT NULL DEFAULT 1.0,
  input_tokens      INTEGER NOT NULL DEFAULT 0,
  output_tokens     INTEGER NOT NULL DEFAULT 0,
  cache_write_tokens INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens INTEGER NOT NULL DEFAULT 0,
  reasoning_tokens  INTEGER NOT NULL DEFAULT 0,
  cost_usd          REAL NOT NULL DEFAULT 0,
  estimated         INTEGER NOT NULL DEFAULT 0,
  streamed          INTEGER NOT NULL DEFAULT 0,
  status_code       INTEGER,
  duration_ms       INTEGER,
  user              TEXT,
  source            TEXT
);

CREATE INDEX IF NOT EXISTS idx_requests_ts      ON requests(ts_epoch_ms);
CREATE INDEX IF NOT EXISTS idx_requests_session ON requests(session_id);
CREATE INDEX IF NOT EXISTS idx_requests_project ON requests(project);
CREATE INDEX IF NOT EXISTS idx_requests_model   ON requests(model);

CREATE TABLE IF NOT EXISTS git_commits (
  commit_hash  TEXT PRIMARY KEY NOT NULL,
  project      TEXT NOT NULL,
  ts_epoch_ms  INTEGER NOT NULL,
  lines_added  INTEGER NOT NULL DEFAULT 0,
  lines_deleted INTEGER NOT NULL DEFAULT 0,
  files_changed INTEGER NOT NULL DEFAULT 0,
  subject      TEXT
);

CREATE TABLE IF NOT EXISTS commit_attribution (
  commit_hash TEXT NOT NULL,
  window_start_ms INTEGER NOT NULL,
  window_end_ms   INTEGER NOT NULL,
  attributed_cost_usd REAL NOT NULL DEFAULT 0,
  attributed_requests INTEGER NOT NULL DEFAULT 0,
  attributed_output_tokens INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (commit_hash)
);

CREATE TABLE IF NOT EXISTS proposals (
  proposal_id TEXT PRIMARY KEY NOT NULL,
  request_id  TEXT,
  session_id  TEXT,
  ts_epoch_ms INTEGER NOT NULL,
  provider    TEXT NOT NULL,
  model       TEXT NOT NULL,
  project     TEXT NOT NULL DEFAULT 'default',
  files_json  TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_proposals_ts      ON proposals(ts_epoch_ms);
CREATE INDEX IF NOT EXISTS idx_proposals_project ON proposals(project);

CREATE TABLE IF NOT EXISTS gate_signals (
  signal_id   TEXT PRIMARY KEY NOT NULL,
  kind        TEXT NOT NULL,
  commit_hash TEXT,
  project     TEXT NOT NULL DEFAULT 'default',
  ts_epoch_ms INTEGER NOT NULL,
  verdict     TEXT NOT NULL,
  detail      TEXT
);

CREATE INDEX IF NOT EXISTS idx_signals_commit ON gate_signals(commit_hash);
CREATE INDEX IF NOT EXISTS idx_signals_ts     ON gate_signals(ts_epoch_ms);

CREATE TABLE IF NOT EXISTS realization_units (
  commit_hash    TEXT PRIMARY KEY NOT NULL,
  project        TEXT NOT NULL DEFAULT 'default',
  ts_epoch_ms    INTEGER NOT NULL,
  computed_at_ms INTEGER NOT NULL,
  attributed_cost_usd REAL NOT NULL DEFAULT 0,
  maturing       INTEGER NOT NULL DEFAULT 0,
  realized       INTEGER NOT NULL DEFAULT 0,
  unit_json      TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_realization_project ON realization_units(project);
CREATE INDEX IF NOT EXISTS idx_realization_ts      ON realization_units(ts_epoch_ms);

CREATE TABLE IF NOT EXISTS receipts (
  unit         TEXT PRIMARY KEY NOT NULL,
  project      TEXT NOT NULL,
  ts_epoch_ms  INTEGER NOT NULL,
  realized     INTEGER NOT NULL DEFAULT 0,
  receipt_json TEXT NOT NULL
)`;

export class Store {
  private db: DatabaseSync;

  constructor(path: string) {
    if (path !== ':memory:') {
      const dir = dirname(path);
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    }
    this.db = new DatabaseSync(path);
    // node:sqlite's DatabaseSync exposes only prepare() + a multi-statement
    // runner; we run DDL/PRAGMA as individual prepared statements so the schema
    // setup stays uniform and side-effect-free.
    this.runScript('PRAGMA journal_mode = WAL');
    this.runScript('PRAGMA synchronous = NORMAL');
    this.runScript(SCHEMA);
    this.migrate();
  }

  /** Idempotent schema migrations for DBs created before a column existed. */
  private migrate(): void {
    const cols = this.db.prepare('PRAGMA table_info(requests)').all() as Array<{ name: string }>;
    if (!cols.some((c) => c.name === 'user')) {
      this.db.prepare('ALTER TABLE requests ADD COLUMN user TEXT').run();
    }
    if (!cols.some((c) => c.name === 'source')) {
      this.db.prepare('ALTER TABLE requests ADD COLUMN source TEXT').run();
    }
    this.runScript('CREATE INDEX IF NOT EXISTS idx_requests_user ON requests(user)');
    this.runScript('CREATE INDEX IF NOT EXISTS idx_requests_source ON requests(source)');
  }

  /** Run one or more `;`-separated statements via prepared statements. */
  private runScript(sql: string): void {
    for (const part of sql.split(';')) {
      const stmt = part.trim();
      if (stmt) this.db.prepare(stmt).run();
    }
  }

  close(): void {
    this.db.close();
  }

  raw(): DatabaseSync {
    return this.db;
  }

  upsertSession(sessionId: string, project: string, tool: string, startMs: number): void {
    this.db
      .prepare(
        `INSERT INTO sessions (session_id, project, tool, start_ms)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(session_id) DO NOTHING`,
      )
      .run(sessionId, project, tool, startMs);
  }

  insertRequest(r: RequestRow): void {
    this.db
      .prepare(
        `INSERT INTO requests (
            request_id, session_id, ts_iso, ts_epoch_ms, provider, model, project,
            task_weight, input_tokens, output_tokens, cache_write_tokens, cache_read_tokens,
            reasoning_tokens, cost_usd, estimated, streamed, status_code, duration_ms, user, source
         ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        r.requestId,
        r.sessionId,
        new Date(r.tsEpochMs).toISOString(),
        r.tsEpochMs,
        r.provider,
        r.model,
        r.project,
        r.taskWeight,
        r.inputTokens,
        r.outputTokens,
        r.cacheWriteTokens,
        r.cacheReadTokens,
        r.reasoningTokens,
        r.costUsd,
        r.estimated ? 1 : 0,
        r.streamed ? 1 : 0,
        r.statusCode,
        r.durationMs,
        r.user ?? null,
        r.source ?? null,
      );
  }

  /** Total USD spend across [startMs, endMs). */
  spendBetween(startMs: number, endMs: number): number {
    const row = this.db
      .prepare(`SELECT COALESCE(SUM(cost_usd), 0) AS total FROM requests WHERE ts_epoch_ms >= ? AND ts_epoch_ms < ?`)
      .get(startMs, endMs) as { total: number };
    return row.total;
  }

  spendForSession(sessionId: string): number {
    const row = this.db
      .prepare(`SELECT COALESCE(SUM(cost_usd), 0) AS total FROM requests WHERE session_id = ?`)
      .get(sessionId) as { total: number };
    return row.total;
  }

  /** Spend within the last windowMs — used for runaway-loop detection. */
  spendInWindow(nowMs: number, windowMs: number): { costUsd: number; requests: number } {
    const row = this.db
      .prepare(
        `SELECT COALESCE(SUM(cost_usd),0) AS total, COUNT(*) AS n
         FROM requests WHERE ts_epoch_ms >= ?`,
      )
      .get(nowMs - windowMs) as { total: number; n: number };
    return { costUsd: row.total, requests: row.n };
  }

  /** Health counts for governance alerts: blocked (429) requests and estimated-priced spend. */
  healthStats(startMs: number, endMs: number): { blocked: number; estimatedCostUsd: number; totalCostUsd: number } {
    const row = this.db
      .prepare(
        `SELECT COALESCE(SUM(CASE WHEN status_code = 429 THEN 1 ELSE 0 END),0) AS blocked,
                COALESCE(SUM(CASE WHEN estimated = 1 THEN cost_usd ELSE 0 END),0) AS estCost,
                COALESCE(SUM(cost_usd),0) AS total
         FROM requests WHERE ts_epoch_ms >= ? AND ts_epoch_ms < ?`,
      )
      .get(startMs, endMs) as { blocked: number; estCost: number; total: number };
    return { blocked: row.blocked, estimatedCostUsd: row.estCost, totalCostUsd: row.total };
  }

  summary(startMs: number, endMs: number): SpendBucket {
    const row = this.db
      .prepare(
        `SELECT COALESCE(SUM(cost_usd),0) AS cost, COUNT(*) AS n,
                COALESCE(SUM(input_tokens),0) AS inp, COALESCE(SUM(output_tokens),0) AS outp
         FROM requests WHERE ts_epoch_ms >= ? AND ts_epoch_ms < ?`,
      )
      .get(startMs, endMs) as { cost: number; n: number; inp: number; outp: number };
    return { label: 'range', costUsd: row.cost, requests: row.n, inputTokens: row.inp, outputTokens: row.outp };
  }

  byModel(startMs: number, endMs: number): Array<SpendBucket & { provider: string }> {
    const rows = this.db
      .prepare(
        `SELECT provider, model AS label,
                COALESCE(SUM(cost_usd),0) AS costUsd, COUNT(*) AS requests,
                COALESCE(SUM(input_tokens),0) AS inputTokens, COALESCE(SUM(output_tokens),0) AS outputTokens
         FROM requests WHERE ts_epoch_ms >= ? AND ts_epoch_ms < ?
         GROUP BY provider, model ORDER BY costUsd DESC`,
      )
      .all(startMs, endMs) as unknown as Array<SpendBucket & { provider: string }>;
    return rows;
  }

  byProject(startMs: number, endMs: number): SpendBucket[] {
    return this.db
      .prepare(
        `SELECT project AS label,
                COALESCE(SUM(cost_usd),0) AS costUsd, COUNT(*) AS requests,
                COALESCE(SUM(input_tokens),0) AS inputTokens, COALESCE(SUM(output_tokens),0) AS outputTokens
         FROM requests WHERE ts_epoch_ms >= ? AND ts_epoch_ms < ?
         GROUP BY project ORDER BY costUsd DESC`,
      )
      .all(startMs, endMs) as unknown as SpendBucket[];
  }

  /** Spend grouped by developer/team (x-aegis-user); null is reported as 'unassigned'. */
  byUser(startMs: number, endMs: number): SpendBucket[] {
    return this.db
      .prepare(
        `SELECT COALESCE(user, 'unassigned') AS label,
                COALESCE(SUM(cost_usd),0) AS costUsd, COUNT(*) AS requests,
                COALESCE(SUM(input_tokens),0) AS inputTokens, COALESCE(SUM(output_tokens),0) AS outputTokens
         FROM requests WHERE ts_epoch_ms >= ? AND ts_epoch_ms < ?
         GROUP BY COALESCE(user, 'unassigned') ORDER BY costUsd DESC`,
      )
      .all(startMs, endMs) as unknown as SpendBucket[];
  }

  /**
   * Spend grouped by connected source/feed (x-aegis-source); null reads as
   * 'direct'. A source is one AI tool deliberately routed through AegisFlow — the
   * unit the product meters. The tag is set by `aegisflow connect <tool>` and
   * stripped before the request leaves the machine, so the provider never sees it.
   */
  bySource(startMs: number, endMs: number): SpendBucket[] {
    return this.db
      .prepare(
        `SELECT COALESCE(source, 'direct') AS label,
                COALESCE(SUM(cost_usd),0) AS costUsd, COUNT(*) AS requests,
                COALESCE(SUM(input_tokens),0) AS inputTokens, COALESCE(SUM(output_tokens),0) AS outputTokens
         FROM requests WHERE ts_epoch_ms >= ? AND ts_epoch_ms < ?
         GROUP BY COALESCE(source, 'direct') ORDER BY costUsd DESC`,
      )
      .all(startMs, endMs) as unknown as SpendBucket[];
  }

  /**
   * Sources with their measured DEPTH — what each connected feed actually
   * exposes, read off real signals (never asserted):
   *   · spend       — always (the request ledger);
   *   · acceptance  — the source emitted captured proposals, so First-Pass
   *                   Acceptance is measurable for it;
   *   · outcomes    — the source's traffic landed in projects that have
   *                   realized-value snapshots, so the RoI loop is in view.
   * `tagged` is false for 'direct' (routed but un-attributed) traffic. The
   * proposals join is session-aware: real proxy proposals carry the request_id,
   * but a session-linked proposal (no request_id) still attributes to the source
   * via its session — so neither path is silently missed.
   */
  bySourceWithDepth(
    startMs: number,
    endMs: number,
  ): Array<SpendBucket & { tagged: boolean; hasProposals: boolean; hasOutcomes: boolean }> {
    const base = this.bySource(startMs, endMs);

    const propRows = this.db
      .prepare(
        `SELECT DISTINCT COALESCE(r.source, 'direct') AS label
         FROM proposals p JOIN requests r
           ON (p.request_id = r.request_id
               OR (p.request_id IS NULL AND p.session_id IS NOT NULL AND p.session_id = r.session_id))
         WHERE p.ts_epoch_ms >= ? AND p.ts_epoch_ms < ?`,
      )
      .all(startMs, endMs) as Array<{ label: string }>;
    const withProposals = new Set(propRows.map((r) => r.label));

    const realizedProjects = new Set(this.realizationProjects());
    const withOutcomes = new Set<string>();
    if (realizedProjects.size > 0) {
      const srcProj = this.db
        .prepare(
          `SELECT DISTINCT COALESCE(source, 'direct') AS label, project
           FROM requests WHERE ts_epoch_ms >= ? AND ts_epoch_ms < ?`,
        )
        .all(startMs, endMs) as Array<{ label: string; project: string }>;
      for (const r of srcProj) if (realizedProjects.has(r.project)) withOutcomes.add(r.label);
    }

    return base.map((s) => ({
      ...s,
      tagged: s.label !== 'direct',
      hasProposals: withProposals.has(s.label),
      hasOutcomes: withOutcomes.has(s.label),
    }));
  }

  /**
   * Spend series over [startMs, endMs) bucketed by bucketMs, for charts.
   *
   * The bucket index is CAST to INTEGER so the division truncates to a whole
   * bucket. Without it, node:sqlite binds bucketMs as a float and `(ts/bucket)*
   * bucket` becomes a near-identity — every request lands in its own bucket
   * instead of its day/hour. (That silent break also fed a per-request value into
   * the spend-spike baseline.)
   */
  series(startMs: number, endMs: number, bucketMs: number): Array<{ bucketMs: number; costUsd: number }> {
    const rows = this.db
      .prepare(
        `SELECT CAST(ts_epoch_ms / ? AS INTEGER) * ? AS bucketMs, COALESCE(SUM(cost_usd),0) AS costUsd
         FROM requests WHERE ts_epoch_ms >= ? AND ts_epoch_ms < ?
         GROUP BY bucketMs ORDER BY bucketMs ASC`,
      )
      .all(bucketMs, bucketMs, startMs, endMs) as Array<{ bucketMs: number; costUsd: number }>;
    return rows;
  }

  recent(limit: number): RequestRow[] {
    const rows = this.db
      .prepare(
        `SELECT request_id AS requestId, session_id AS sessionId, ts_epoch_ms AS tsEpochMs,
                provider, model, project, task_weight AS taskWeight,
                input_tokens AS inputTokens, output_tokens AS outputTokens,
                cache_write_tokens AS cacheWriteTokens, cache_read_tokens AS cacheReadTokens,
                reasoning_tokens AS reasoningTokens, cost_usd AS costUsd,
                estimated, streamed, status_code AS statusCode, duration_ms AS durationMs, user, source
         FROM requests ORDER BY ts_epoch_ms DESC LIMIT ?`,
      )
      .all(limit) as Array<Record<string, unknown>>;
    return rows.map((r) => ({
      ...(r as unknown as RequestRow),
      estimated: Boolean(r.estimated),
      streamed: Boolean(r.streamed),
    }));
  }

  /** Every metered request in [startMs, endMs), oldest first — for data export. */
  requestsInRange(startMs: number, endMs: number): RequestRow[] {
    const rows = this.db
      .prepare(
        `SELECT request_id AS requestId, session_id AS sessionId, ts_epoch_ms AS tsEpochMs,
                provider, model, project, task_weight AS taskWeight,
                input_tokens AS inputTokens, output_tokens AS outputTokens,
                cache_write_tokens AS cacheWriteTokens, cache_read_tokens AS cacheReadTokens,
                reasoning_tokens AS reasoningTokens, cost_usd AS costUsd,
                estimated, streamed, status_code AS statusCode, duration_ms AS durationMs, user, source
         FROM requests WHERE ts_epoch_ms >= ? AND ts_epoch_ms < ? ORDER BY ts_epoch_ms ASC`,
      )
      .all(startMs, endMs) as Array<Record<string, unknown>>;
    return rows.map((r) => ({
      ...(r as unknown as RequestRow),
      estimated: Boolean(r.estimated),
      streamed: Boolean(r.streamed),
    }));
  }

  insertCommit(c: {
    commitHash: string;
    project: string;
    tsEpochMs: number;
    linesAdded: number;
    linesDeleted: number;
    filesChanged: number;
    subject: string;
  }): void {
    this.db
      .prepare(
        `INSERT INTO git_commits (commit_hash, project, ts_epoch_ms, lines_added, lines_deleted, files_changed, subject)
         VALUES (?,?,?,?,?,?,?)
         ON CONFLICT(commit_hash) DO UPDATE SET
           lines_added=excluded.lines_added, lines_deleted=excluded.lines_deleted,
           files_changed=excluded.files_changed, subject=excluded.subject`,
      )
      .run(c.commitHash, c.project, c.tsEpochMs, c.linesAdded, c.linesDeleted, c.filesChanged, c.subject);
  }

  saveAttribution(a: {
    commitHash: string;
    windowStartMs: number;
    windowEndMs: number;
    attributedCostUsd: number;
    attributedRequests: number;
    attributedOutputTokens: number;
  }): void {
    this.db
      .prepare(
        `INSERT INTO commit_attribution
           (commit_hash, window_start_ms, window_end_ms, attributed_cost_usd, attributed_requests, attributed_output_tokens)
         VALUES (?,?,?,?,?,?)
         ON CONFLICT(commit_hash) DO UPDATE SET
           window_start_ms=excluded.window_start_ms, window_end_ms=excluded.window_end_ms,
           attributed_cost_usd=excluded.attributed_cost_usd, attributed_requests=excluded.attributed_requests,
           attributed_output_tokens=excluded.attributed_output_tokens`,
      )
      .run(
        a.commitHash,
        a.windowStartMs,
        a.windowEndMs,
        a.attributedCostUsd,
        a.attributedRequests,
        a.attributedOutputTokens,
      );
  }

  insertProposal(p: ProposalRow): void {
    this.db
      .prepare(
        `INSERT INTO proposals (proposal_id, request_id, session_id, ts_epoch_ms, provider, model, project, files_json)
         VALUES (?,?,?,?,?,?,?,?)
         ON CONFLICT(proposal_id) DO NOTHING`,
      )
      .run(p.proposalId, p.requestId, p.sessionId, p.tsEpochMs, p.provider, p.model, p.project, JSON.stringify(p.files));
  }

  /** Proposals logged for a project within [startMs, endMs). */
  proposalsInWindow(project: string, startMs: number, endMs: number): ProposalRow[] {
    const rows = this.db
      .prepare(
        `SELECT proposal_id AS proposalId, request_id AS requestId, session_id AS sessionId,
                ts_epoch_ms AS tsEpochMs, provider, model, project, files_json AS filesJson
         FROM proposals WHERE project = ? AND ts_epoch_ms >= ? AND ts_epoch_ms < ?
         ORDER BY ts_epoch_ms ASC`,
      )
      .all(project, startMs, endMs) as Array<Record<string, unknown>>;
    return rows.map((r) => ({
      proposalId: r.proposalId as string,
      requestId: (r.requestId as string) ?? null,
      sessionId: (r.sessionId as string) ?? null,
      tsEpochMs: r.tsEpochMs as number,
      provider: r.provider as string,
      model: r.model as string,
      project: r.project as string,
      files: JSON.parse((r.filesJson as string) || '[]'),
    }));
  }

  insertSignal(s: GateSignalRow): void {
    this.db
      .prepare(
        `INSERT INTO gate_signals (signal_id, kind, commit_hash, project, ts_epoch_ms, verdict, detail)
         VALUES (?,?,?,?,?,?,?)
         ON CONFLICT(signal_id) DO NOTHING`,
      )
      .run(s.signalId, s.kind, s.commitHash, s.project, s.tsEpochMs, s.verdict, s.detail);
  }

  /** Signals explicitly linked to a commit hash. */
  signalsForCommit(commitHash: string): GateSignalRow[] {
    const rows = this.db
      .prepare(
        `SELECT signal_id AS signalId, kind, commit_hash AS commitHash, project,
                ts_epoch_ms AS tsEpochMs, verdict, detail
         FROM gate_signals WHERE commit_hash = ?`,
      )
      .all(commitHash) as unknown as GateSignalRow[];
    return rows;
  }

  /** Project-wide signals not tied to a specific commit, within a window. */
  signalsInWindow(project: string, startMs: number, endMs: number): GateSignalRow[] {
    const rows = this.db
      .prepare(
        `SELECT signal_id AS signalId, kind, commit_hash AS commitHash, project,
                ts_epoch_ms AS tsEpochMs, verdict, detail
         FROM gate_signals WHERE project = ? AND commit_hash IS NULL
           AND ts_epoch_ms >= ? AND ts_epoch_ms < ?`,
      )
      .all(project, startMs, endMs) as unknown as GateSignalRow[];
    return rows;
  }

  /**
   * Sessions with their spend in a window, flagged by whether they produced code
   * proposals. Sessions WITHOUT proposals are the non-coding usage (chat,
   * research, drafting) that the universal RoI lenses also measure.
   */
  sessionUnits(startMs: number, endMs: number): Array<{ sessionId: string; costUsd: number; requests: number; hasProposals: boolean }> {
    const rows = this.db
      .prepare(
        `SELECT session_id AS sessionId, COALESCE(SUM(cost_usd),0) AS costUsd, COUNT(*) AS requests
         FROM requests WHERE session_id IS NOT NULL AND ts_epoch_ms >= ? AND ts_epoch_ms < ?
         GROUP BY session_id`,
      )
      .all(startMs, endMs) as Array<{ sessionId: string; costUsd: number; requests: number }>;
    const propRows = this.db
      .prepare(`SELECT DISTINCT session_id AS s FROM proposals WHERE session_id IS NOT NULL`)
      .all() as Array<{ s: string }>;
    const withProposals = new Set(propRows.map((r) => r.s));
    return rows.map((r) => ({ ...r, hasProposals: withProposals.has(r.sessionId) }));
  }

  saveReceipt(r: { unit: string; project: string; tsEpochMs: number; realized: boolean; receiptJson: string }): void {
    this.db
      .prepare(
        `INSERT INTO receipts (unit, project, ts_epoch_ms, realized, receipt_json)
         VALUES (?,?,?,?,?)
         ON CONFLICT(unit) DO UPDATE SET
           ts_epoch_ms=excluded.ts_epoch_ms, realized=excluded.realized, receipt_json=excluded.receipt_json`,
      )
      .run(r.unit, r.project, r.tsEpochMs, r.realized ? 1 : 0, r.receiptJson);
  }

  getReceipt(unit: string): string | null {
    const row = this.db.prepare(`SELECT receipt_json AS j FROM receipts WHERE unit = ?`).get(unit) as
      | { j: string }
      | undefined;
    return row ? row.j : null;
  }

  /**
   * Persist a snapshot of computed work units so realized value survives the
   * process that computed it — the basis for serving RoI to a dashboard with no
   * local checkout (a manager's machine). Keyed by commit hash, so re-running
   * `realize` refreshes the snapshot rather than double-counting. `computed_at_ms`
   * is retained so a future trend view can switch to append-mode without a
   * destructive migration.
   */
  saveRealizationUnits(records: RealizationUnitRecord[]): void {
    const stmt = this.db.prepare(
      `INSERT INTO realization_units
         (commit_hash, project, ts_epoch_ms, computed_at_ms, attributed_cost_usd, maturing, realized, unit_json)
       VALUES (?,?,?,?,?,?,?,?)
       ON CONFLICT(commit_hash) DO UPDATE SET
         project=excluded.project, ts_epoch_ms=excluded.ts_epoch_ms, computed_at_ms=excluded.computed_at_ms,
         attributed_cost_usd=excluded.attributed_cost_usd, maturing=excluded.maturing,
         realized=excluded.realized, unit_json=excluded.unit_json`,
    );
    for (const r of records) {
      stmt.run(
        r.commitHash,
        r.project,
        r.tsEpochMs,
        r.computedAtMs,
        r.attributedCostUsd,
        r.maturing ? 1 : 0,
        r.realized ? 1 : 0,
        r.unitJson,
      );
    }
  }

  /** Rehydrate stored work-unit snapshots (newest commit first), optionally one project. */
  realizationUnitRows(project?: string): Array<{ unitJson: string; computedAtMs: number }> {
    const sql =
      `SELECT unit_json AS unitJson, computed_at_ms AS computedAtMs FROM realization_units` +
      (project ? ` WHERE project = ?` : ``) +
      ` ORDER BY ts_epoch_ms DESC`;
    const stmt = this.db.prepare(sql);
    return (project ? stmt.all(project) : stmt.all()) as Array<{ unitJson: string; computedAtMs: number }>;
  }

  /** How many stored realization units exist (optionally scoped to one project). */
  countRealizationUnits(project?: string): number {
    const sql = `SELECT COUNT(*) AS n FROM realization_units` + (project ? ` WHERE project = ?` : ``);
    const stmt = this.db.prepare(sql);
    const row = (project ? stmt.get(project) : stmt.get()) as { n: number };
    return row.n;
  }

  /** Distinct projects that have stored realization snapshots — the budget owner's rows. */
  realizationProjects(): string[] {
    const rows = this.db
      .prepare(`SELECT DISTINCT project FROM realization_units ORDER BY project`)
      .all() as Array<{ project: string }>;
    return rows.map((r) => r.project);
  }

  /** Maintenance: prune old requests and compact. Returns rows removed. */
  prune(beforeMs: number): number {
    const info = this.db.prepare(`DELETE FROM requests WHERE ts_epoch_ms < ?`).run(beforeMs);
    this.db.prepare('VACUUM').run();
    return Number(info.changes ?? 0);
  }
}
