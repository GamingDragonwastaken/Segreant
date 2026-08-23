/**
 * The schema and its migrations — the single place that issues DDL.
 *
 * Split out of db.ts so the table definitions and the guarded ALTERs that keep
 * older databases readable live together, away from the query surface. The
 * store module remains the only writer of DDL; this file is where it writes it.
 */

import type { DatabaseSync } from 'node:sqlite';

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
  source            TEXT,
  cwd               TEXT,
  via               TEXT,
  cost_basis        TEXT NOT NULL DEFAULT 'legacy_unknown',
  rate_card_sha256  TEXT,
  rate_card_source_kind TEXT NOT NULL DEFAULT 'legacy_unknown',
  rate_match_kind   TEXT NOT NULL DEFAULT 'legacy_unknown',
  rate_match_provider TEXT,
  rate_match_model  TEXT,
  scope_capture_status TEXT NOT NULL DEFAULT 'legacy_unknown',
  provider_scope_declaration_id TEXT,
  attribution_basis TEXT NOT NULL DEFAULT 'legacy_unknown'
);

CREATE INDEX IF NOT EXISTS idx_requests_ts      ON requests(ts_epoch_ms);
CREATE INDEX IF NOT EXISTS idx_requests_session ON requests(session_id);
CREATE INDEX IF NOT EXISTS idx_requests_project ON requests(project);
CREATE INDEX IF NOT EXISTS idx_requests_model   ON requests(model);

CREATE TABLE IF NOT EXISTS provider_scope_declarations (
  declaration_id      TEXT PRIMARY KEY NOT NULL,
  provider            TEXT NOT NULL CHECK (provider = 'openai'),
  billing_account_ref TEXT NOT NULL,
  provider_project_ref TEXT,
  upstream_fingerprint TEXT NOT NULL,
  upstream_display    TEXT NOT NULL,
  declared_at_ms      INTEGER NOT NULL,
  trust               TEXT NOT NULL DEFAULT 'operator_declared_unverified',
  UNIQUE(provider, billing_account_ref, provider_project_ref, upstream_fingerprint)
);

CREATE TABLE IF NOT EXISTS active_provider_scope_routes (
  provider            TEXT PRIMARY KEY NOT NULL CHECK (provider = 'openai'),
  declaration_id      TEXT NOT NULL,
  upstream_fingerprint TEXT NOT NULL,
  activated_at_ms     INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS request_price_events (
  event_id          INTEGER PRIMARY KEY AUTOINCREMENT,
  request_id        TEXT NOT NULL,
  action            TEXT NOT NULL,
  applied_at_ms     INTEGER NOT NULL,
  previous_cost_usd REAL NOT NULL,
  previous_estimated INTEGER NOT NULL,
  previous_cost_basis TEXT NOT NULL,
  previous_rate_card_sha256 TEXT,
  previous_rate_card_source_kind TEXT NOT NULL,
  previous_rate_match_kind TEXT NOT NULL,
  previous_rate_match_provider TEXT,
  previous_rate_match_model TEXT,
  new_cost_usd      REAL NOT NULL,
  new_estimated     INTEGER NOT NULL,
  new_cost_basis    TEXT NOT NULL,
  new_rate_card_sha256 TEXT,
  new_rate_card_source_kind TEXT NOT NULL,
  new_rate_match_kind TEXT NOT NULL,
  new_rate_match_provider TEXT,
  new_rate_match_model TEXT
);

CREATE INDEX IF NOT EXISTS idx_request_price_events_request ON request_price_events(request_id, event_id);

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
  detail      TEXT,
  evidence_source TEXT NOT NULL DEFAULT 'manual'
);

CREATE INDEX IF NOT EXISTS idx_signals_commit ON gate_signals(commit_hash);
CREATE INDEX IF NOT EXISTS idx_signals_ts     ON gate_signals(ts_epoch_ms);

CREATE TABLE IF NOT EXISTS gate_evidence (
  event_id       TEXT PRIMARY KEY NOT NULL,
  source         TEXT NOT NULL,
  evidence_class TEXT NOT NULL,
  commit_hash    TEXT NOT NULL,
  repository_id  TEXT NOT NULL,
  policy_id      TEXT NOT NULL,
  body_hash      TEXT NOT NULL,
  signer_key_id  TEXT NOT NULL,
  envelope_json  TEXT NOT NULL,
  verified_at_ms INTEGER NOT NULL,
  UNIQUE(source, body_hash)
);

CREATE INDEX IF NOT EXISTS idx_gate_evidence_commit ON gate_evidence(commit_hash);

CREATE TABLE IF NOT EXISTS realization_units (
  commit_hash    TEXT PRIMARY KEY NOT NULL,
  project        TEXT NOT NULL DEFAULT 'default',
  ts_epoch_ms    INTEGER NOT NULL,
  computed_at_ms INTEGER NOT NULL,
  attributed_cost_usd REAL NOT NULL DEFAULT 0,
  maturing       INTEGER NOT NULL DEFAULT 0,
  realized       INTEGER NOT NULL DEFAULT 0,
  unit_json      TEXT NOT NULL,
  cost_scope     TEXT NOT NULL DEFAULT 'legacy_unknown',
  cost_stale     INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_realization_project ON realization_units(project);
CREATE INDEX IF NOT EXISTS idx_realization_ts      ON realization_units(ts_epoch_ms);

CREATE TABLE IF NOT EXISTS receipts (
  unit         TEXT PRIMARY KEY NOT NULL,
  project      TEXT NOT NULL,
  ts_epoch_ms  INTEGER NOT NULL,
  realized     INTEGER NOT NULL DEFAULT 0,
  receipt_json TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS scan_snapshots (
  roots_key  TEXT PRIMARY KEY NOT NULL,
  repos_json TEXT NOT NULL,
  tools_json TEXT NOT NULL,
  at_ms      INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS lift_baselines (
  project      TEXT PRIMARY KEY NOT NULL,
  buckets_json TEXT NOT NULL,
  at_ms        INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS project_aliases (
  alias     TEXT PRIMARY KEY NOT NULL,
  canonical TEXT NOT NULL,
  at_ms     INTEGER NOT NULL
);

-- Provider cost evidence has a deliberately separate grain and provenance from
-- request rows: it must never be double-counted as metered agent traffic.
CREATE TABLE IF NOT EXISTS billing_import_runs (
  import_id           TEXT PRIMARY KEY NOT NULL,
  imported_at_ms      INTEGER NOT NULL,
  format              TEXT NOT NULL,
  schema_version      INTEGER NOT NULL,
  importer_version    TEXT NOT NULL,
  file_name           TEXT NOT NULL,
  file_sha256         TEXT NOT NULL UNIQUE,
  file_size_bytes     INTEGER NOT NULL,
  source_system       TEXT NOT NULL,
  source_export_id    TEXT NOT NULL,
  provider            TEXT NOT NULL,
  billing_account_ref TEXT NOT NULL,
  exported_at_ms      INTEGER NOT NULL,
  period_start_ms     INTEGER NOT NULL,
  period_end_ms       INTEGER NOT NULL,
  coverage            TEXT NOT NULL,
  trust               TEXT NOT NULL,
  raw_retention       TEXT NOT NULL,
  records_seen        INTEGER NOT NULL,
  records_inserted    INTEGER NOT NULL,
  records_duplicate   INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_billing_import_runs_scope
  ON billing_import_runs(provider, billing_account_ref, period_start_ms, period_end_ms);

CREATE TABLE IF NOT EXISTS billing_evidence_records (
  record_id              TEXT PRIMARY KEY NOT NULL,
  source_system          TEXT NOT NULL,
  billing_account_ref    TEXT NOT NULL,
  source_record_id       TEXT NOT NULL,
  source_record_sha256   TEXT NOT NULL,
  first_import_id        TEXT NOT NULL,
  source_export_id       TEXT NOT NULL,
  provider               TEXT NOT NULL,
  provider_project_ref   TEXT,
  service                TEXT NOT NULL,
  sku                    TEXT NOT NULL,
  model                  TEXT,
  region                 TEXT,
  observed_at_ms         INTEGER NOT NULL,
  charge_period_start_ms INTEGER NOT NULL,
  charge_period_end_ms   INTEGER NOT NULL,
  charge_type            TEXT NOT NULL,
  currency               TEXT NOT NULL,
  amount_micros          INTEGER NOT NULL,
  usage_unit             TEXT,
  usage_quantity         TEXT,
  cost_basis             TEXT NOT NULL,
  trust                  TEXT NOT NULL,
  UNIQUE(source_system, provider, billing_account_ref, source_record_id)
);

CREATE INDEX IF NOT EXISTS idx_billing_evidence_scope
  ON billing_evidence_records(provider, billing_account_ref, charge_period_start_ms, charge_period_end_ms);
CREATE INDEX IF NOT EXISTS idx_billing_evidence_import
  ON billing_evidence_records(first_import_id);

-- Direct OpenAI Organization Costs observations have their own immutable grain.
-- They are not billing_evidence_records and never join/sum with requests.
CREATE TABLE IF NOT EXISTS openai_cost_observation_runs (
  observation_run_id       TEXT PRIMARY KEY NOT NULL,
  declared_scope_id        TEXT NOT NULL,
  provider_project_ref     TEXT NOT NULL,
  period_start_ms          INTEGER NOT NULL,
  period_end_ms            INTEGER NOT NULL,
  fetched_at_ms            INTEGER NOT NULL,
  pagination_complete      INTEGER NOT NULL,
  page_count               INTEGER NOT NULL,
  page_digest_chain_sha256 TEXT,
  result_state             TEXT NOT NULL,
  failure_code             TEXT,
  provider_finality        TEXT NOT NULL,
  trust                    TEXT NOT NULL,
  raw_retention            TEXT NOT NULL,
  observations_stored      INTEGER NOT NULL,
  -- How the figures reached Fiscus: read from the provider, or handed over by
  -- an operator. Different evidence classes, so the reconciliation says which.
  source_kind              TEXT NOT NULL DEFAULT 'legacy_unknown'
);

CREATE INDEX IF NOT EXISTS idx_openai_cost_observation_runs_latest
  ON openai_cost_observation_runs(result_state, pagination_complete, fetched_at_ms DESC, observation_run_id DESC);

CREATE TABLE IF NOT EXISTS openai_cost_observation_lines (
  observation_id       TEXT PRIMARY KEY NOT NULL,
  observation_run_id   TEXT NOT NULL,
  declared_scope_id    TEXT NOT NULL,
  provider_project_ref TEXT NOT NULL,
  fetched_at_ms        INTEGER NOT NULL,
  bucket_start_ms      INTEGER NOT NULL,
  bucket_end_ms        INTEGER NOT NULL,
  line_item            TEXT NOT NULL,
  currency             TEXT NOT NULL,
  amount_decimal       TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_openai_cost_observation_lines_run
  ON openai_cost_observation_lines(observation_run_id, bucket_start_ms, line_item);

-- Reconciliation runs are derived, immutable records. They reference the exact
-- observation snapshot they compared against and are never updated: a later
-- provider snapshot produces a NEW run, so the history of what was claimed when
-- stays inspectable. The original charge and the original request rows are
-- untouched by anything here.
CREATE TABLE IF NOT EXISTS reconciliation_runs (
  reconciliation_run_id    TEXT PRIMARY KEY NOT NULL,
  observation_run_id       TEXT NOT NULL,
  declared_scope_id        TEXT NOT NULL,
  provider_project_ref     TEXT NOT NULL,
  period_start_ms          INTEGER NOT NULL,
  period_end_ms            INTEGER NOT NULL,
  computed_at_ms           INTEGER NOT NULL,
  currency                 TEXT NOT NULL,
  materiality_usd          REAL NOT NULL,
  provider_reported_micros INTEGER NOT NULL,
  local_captured_micros    INTEGER NOT NULL,
  unexplained_variance_micros INTEGER NOT NULL,
  snapshot_stability       TEXT NOT NULL,
  trust                    TEXT NOT NULL,
  result_json              TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_reconciliation_runs_latest
  ON reconciliation_runs(computed_at_ms DESC, reconciliation_run_id DESC);

-- ── Allocation: the third layer of the truth chain ──────────────────────────
-- A cost centre is an ACCOUNTING position (who an organization decided owns the
-- money), not an instrumentation label like a project label. Allocation never rewrites
-- a request row. Every figure it produces is derived and re-derivable.
CREATE TABLE IF NOT EXISTS cost_centres (
  cost_centre_id TEXT PRIMARY KEY NOT NULL,
  name           TEXT NOT NULL,
  owner          TEXT,
  created_at_ms  INTEGER NOT NULL,
  archived_at_ms INTEGER
);

-- One row per (rule, version). Substantive content — method, match, targets,
-- ratios — is NEVER updated. Only two monotonic, write-once closures are
-- permitted after insert: effective_to_ms when a later version supersedes this
-- one, and revoked_at_ms when the rule is withdrawn. So the rule set that
-- applied to any past instant stays reconstructible.
CREATE TABLE IF NOT EXISTS allocation_rules (
  rule_id           TEXT NOT NULL,
  version           INTEGER NOT NULL,
  method            TEXT NOT NULL,
  match_json        TEXT NOT NULL,
  targets_json      TEXT NOT NULL,
  priority          INTEGER NOT NULL,
  effective_from_ms INTEGER NOT NULL,
  effective_to_ms   INTEGER,
  revoked_at_ms     INTEGER,
  owner             TEXT,
  note              TEXT,
  created_at_ms     INTEGER NOT NULL,
  PRIMARY KEY (rule_id, version)
);

CREATE INDEX IF NOT EXISTS idx_allocation_rules_window
  ON allocation_rules(effective_from_ms, effective_to_ms, priority);

-- An allocation run is an immutable derived record of one closed period under
-- the rule set that was in force during it. Re-running produces a NEW row.
CREATE TABLE IF NOT EXISTS allocation_runs (
  allocation_run_id TEXT PRIMARY KEY NOT NULL,
  period_start_ms   INTEGER NOT NULL,
  period_end_ms     INTEGER NOT NULL,
  computed_at_ms    INTEGER NOT NULL,
  total_micros      INTEGER NOT NULL,
  allocated_micros  INTEGER NOT NULL,
  unallocated_micros INTEGER NOT NULL,
  conserves         INTEGER NOT NULL,
  trust             TEXT NOT NULL,
  result_json       TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_allocation_runs_latest
  ON allocation_runs(computed_at_ms DESC, allocation_run_id DESC);

-- The causal-study lane stores only protocol/event metadata and declared
-- outcome facts. Raw prompts, source code, and credentials are neither schema
-- fields nor required inputs. These rows are append-only and immutability triggers
-- are installed below because runScript deliberately does not split triggers.
CREATE TABLE IF NOT EXISTS causal_protocols (
  study_id        TEXT PRIMARY KEY NOT NULL,
  protocol_hash   TEXT NOT NULL UNIQUE,
  committed_at_ms INTEGER NOT NULL,
  protocol_json   TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS causal_assignment_plans (
  study_id        TEXT NOT NULL,
  block_id        TEXT NOT NULL,
  protocol_hash   TEXT NOT NULL,
  created_at_ms   INTEGER NOT NULL,
  allocation_hash TEXT NOT NULL,
  material_sha256 TEXT NOT NULL,
  plan_json       TEXT NOT NULL,
  PRIMARY KEY (study_id, block_id)
);

CREATE TABLE IF NOT EXISTS causal_decisions (
  decision_id     TEXT PRIMARY KEY NOT NULL,
  study_id        TEXT NOT NULL,
  protocol_hash   TEXT NOT NULL,
  assigned_at_ms  INTEGER NOT NULL,
  event_hash      TEXT NOT NULL UNIQUE,
  decision_json   TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_causal_decisions_study
  ON causal_decisions(study_id, assigned_at_ms, decision_id);

CREATE TABLE IF NOT EXISTS causal_executions (
  execution_id    TEXT PRIMARY KEY NOT NULL,
  decision_id     TEXT NOT NULL UNIQUE,
  study_id        TEXT NOT NULL,
  protocol_hash   TEXT NOT NULL,
  completed_at_ms INTEGER NOT NULL,
  event_hash      TEXT NOT NULL UNIQUE,
  execution_json  TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_causal_executions_study
  ON causal_executions(study_id, completed_at_ms, execution_id);

CREATE TABLE IF NOT EXISTS causal_outcomes (
  outcome_id      TEXT PRIMARY KEY NOT NULL,
  decision_id     TEXT NOT NULL UNIQUE,
  study_id        TEXT NOT NULL,
  protocol_hash   TEXT NOT NULL,
  observed_at_ms  INTEGER NOT NULL,
  event_hash      TEXT NOT NULL UNIQUE,
  outcome_json    TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_causal_outcomes_study
  ON causal_outcomes(study_id, observed_at_ms, outcome_id);

CREATE TABLE IF NOT EXISTS causal_analysis_snapshots (
  analysis_id     TEXT PRIMARY KEY NOT NULL,
  study_id        TEXT NOT NULL,
  protocol_hash   TEXT NOT NULL,
  computed_at_ms  INTEGER NOT NULL,
  state           TEXT NOT NULL,
  analysis_json   TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_causal_analysis_latest
  ON causal_analysis_snapshots(study_id, computed_at_ms DESC, analysis_id DESC);
`;

/** Idempotent schema migrations for DBs created before a column existed. */
function migrate(db: DatabaseSync): void {
  const cols = db.prepare('PRAGMA table_info(requests)').all() as Array<{ name: string }>;
  if (!cols.some((c) => c.name === 'user')) {
    db.prepare('ALTER TABLE requests ADD COLUMN user TEXT').run();
  }
  if (!cols.some((c) => c.name === 'source')) {
    db.prepare('ALTER TABLE requests ADD COLUMN source TEXT').run();
  }
  if (!cols.some((c) => c.name === 'cwd')) {
    db.prepare('ALTER TABLE requests ADD COLUMN cwd TEXT').run();
  }
  if (!cols.some((c) => c.name === 'via')) {
    db.prepare('ALTER TABLE requests ADD COLUMN via TEXT').run();
    // One-time backfill for rows metered before the column existed. Importer
    // source tags identify imported rows; everything else came through the
    // proxy. (A historical proxy row that was ALSO source-tagged with an
    // importer id would be mis-bucketed here — acceptable one-time
    // approximation; every new row is stamped explicitly at insert.)
    db
      .prepare(
        `UPDATE requests SET via = CASE
           WHEN source IN ('claude-code','opencode','codex') THEN 'import' ELSE 'proxy' END
         WHERE via IS NULL`,
      )
      .run();
  }
  if (!cols.some((c) => c.name === 'cost_basis')) {
    db.prepare("ALTER TABLE requests ADD COLUMN cost_basis TEXT NOT NULL DEFAULT 'legacy_unknown'").run();
  }
  if (!cols.some((c) => c.name === 'rate_card_sha256')) {
    db.prepare('ALTER TABLE requests ADD COLUMN rate_card_sha256 TEXT').run();
  }
  if (!cols.some((c) => c.name === 'rate_card_source_kind')) {
    db.prepare("ALTER TABLE requests ADD COLUMN rate_card_source_kind TEXT NOT NULL DEFAULT 'legacy_unknown'").run();
  }
  if (!cols.some((c) => c.name === 'rate_match_kind')) {
    db.prepare("ALTER TABLE requests ADD COLUMN rate_match_kind TEXT NOT NULL DEFAULT 'legacy_unknown'").run();
  }
  if (!cols.some((c) => c.name === 'rate_match_provider')) {
    db.prepare('ALTER TABLE requests ADD COLUMN rate_match_provider TEXT').run();
  }
  if (!cols.some((c) => c.name === 'rate_match_model')) {
    db.prepare('ALTER TABLE requests ADD COLUMN rate_match_model TEXT').run();
  }
  if (!cols.some((c) => c.name === 'scope_capture_status')) {
    db.prepare("ALTER TABLE requests ADD COLUMN scope_capture_status TEXT NOT NULL DEFAULT 'legacy_unknown'").run();
  }
  if (!cols.some((c) => c.name === 'provider_scope_declaration_id')) {
    db.prepare('ALTER TABLE requests ADD COLUMN provider_scope_declaration_id TEXT').run();
  }
  if (!cols.some((c) => c.name === 'attribution_basis')) {
    // No backfill. A pre-existing row's label could have come from a header, a
    // cwd basename, or nothing at all, and the row does not record which — so
    // it stays `legacy_unknown`. Guessing here would manufacture exactly the
    // certainty this column exists to remove. New rows are stamped at insert.
    db.prepare("ALTER TABLE requests ADD COLUMN attribution_basis TEXT NOT NULL DEFAULT 'legacy_unknown'").run();
  }
  const unitCols = db.prepare('PRAGMA table_info(realization_units)').all() as Array<{ name: string }>;
  if (!unitCols.some((c) => c.name === 'cost_scope')) {
    // No backfill. A snapshot written before this column does not record
    // whether its dollars came from a project-scoped or a project-blind window,
    // and the answer cannot be recovered — `hasProjectSpend` is evaluated at
    // compute time and may since have flipped. Re-attributing it on a guessed
    // basis would move real money for a reason unrelated to any price change,
    // so such units stay `legacy_unknown` and are excluded from resync.
    db.prepare("ALTER TABLE realization_units ADD COLUMN cost_scope TEXT NOT NULL DEFAULT 'legacy_unknown'").run();
  }
  if (!unitCols.some((c) => c.name === 'cost_stale')) {
    // Pre-existing snapshots are NOT marked stale: a reprice that happened
    // before this column existed left no record, and asserting staleness we
    // cannot prove would be as invented as asserting freshness. Only reprices
    // from here on mark units.
    db.prepare('ALTER TABLE realization_units ADD COLUMN cost_stale INTEGER NOT NULL DEFAULT 0').run();
  }
  const obsRunCols = db.prepare('PRAGMA table_info(openai_cost_observation_runs)').all() as Array<{ name: string }>;
  if (obsRunCols.length > 0 && !obsRunCols.some((c) => c.name === 'source_kind')) {
    // No backfill, even though the direct API pull was the only writer that
    // could have produced these rows. Recording that as a fact would assert
    // provenance the row itself never captured — and provenance asserted
    // from context rather than from evidence is the exact failure this
    // column exists to prevent. Unknown stays unknown.
    db.prepare("ALTER TABLE openai_cost_observation_runs ADD COLUMN source_kind TEXT NOT NULL DEFAULT 'legacy_unknown'").run();
  }
  const signalCols = db.prepare('PRAGMA table_info(gate_signals)').all() as Array<{ name: string }>;
  if (!signalCols.some((c) => c.name === 'evidence_source')) {
    db.prepare("ALTER TABLE gate_signals ADD COLUMN evidence_source TEXT NOT NULL DEFAULT 'manual'").run();
  }
  runScript(db, 'CREATE INDEX IF NOT EXISTS idx_requests_user ON requests(user)');
  runScript(db, 'CREATE INDEX IF NOT EXISTS idx_requests_source ON requests(source)');
  runScript(db, 'CREATE INDEX IF NOT EXISTS idx_requests_scope_declaration ON requests(provider_scope_declaration_id)');
}

/** Immutable causal evidence is a local record-control, not an audit claim. */
function installCausalImmutability(db: DatabaseSync): void {
  const tables = [
    'causal_protocols',
    'causal_assignment_plans',
    'causal_decisions',
    'causal_executions',
    'causal_outcomes',
    'causal_analysis_snapshots',
  ];
  for (const table of tables) {
    const updateTrigger = 'causal_no_update_' + table;
    const deleteTrigger = 'causal_no_delete_' + table;
    db.prepare(
      'CREATE TRIGGER IF NOT EXISTS ' + updateTrigger +
      ' BEFORE UPDATE ON ' + table +
      ' BEGIN SELECT RAISE(ABORT, \'causal evidence is append-only\'); END',
    ).run();
    db.prepare(
      'CREATE TRIGGER IF NOT EXISTS ' + deleteTrigger +
      ' BEFORE DELETE ON ' + table +
      ' BEGIN SELECT RAISE(ABORT, \'causal evidence is append-only\'); END',
    ).run();
  }
}

/**
 * Run one or more `;`-separated statements via prepared statements.
 *
 * A chunk that is only `--` comments is skipped rather than prepared. Naive
 * splitting means one semicolon inside a comment severs the statement after
 * it, and the leftover comment-only fragment fails with `statement has been
 * finalized` — an error that names neither the schema nor the comma. Skipping
 * comment-only chunks costs nothing and turns a baffling constructor failure
 * into a no-op.
 */
export function runScript(db: DatabaseSync, sql: string): void {
  for (const part of sql.split(';')) {
    const stmt = part.trim();
    if (!stmt) continue;
    const withoutComments = stmt.replace(/^\s*--[^\n]*$/gm, '').trim();
    if (withoutComments) db.prepare(stmt).run();
  }
}


/**
 * Open-time setup, in the order the store has always run it: journal + sync
 * PRAGMAs first, then the schema, then the guarded migrations. The sequence is
 * load-bearing — migrate() reads `PRAGMA table_info` for tables SCHEMA has just
 * guaranteed exist.
 */
export function initializeSchema(db: DatabaseSync): void {
  runScript(db, 'PRAGMA journal_mode = WAL');
  runScript(db, 'PRAGMA synchronous = NORMAL');
  runScript(db, SCHEMA);
  migrate(db);
  installCausalImmutability(db);
}
