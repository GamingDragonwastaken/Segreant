/**
 * The schema and its migrations — the single place that issues DDL.
 *
 * Split out of db.ts so the table definitions and the guarded ALTERs that keep
 * older databases readable live together, away from the query surface. The
 * store module remains the only writer of DDL; this file is where it writes it.
 */

import type { DatabaseSync } from 'node:sqlite';

/** On-disk schema generation understood by this build. */
export const CURRENT_SCHEMA_VERSION = 1;

/** Read and validate SQLite's monotonic application schema version. */
export function readSchemaVersion(db: DatabaseSync): number {
  const row = db.prepare('PRAGMA user_version').get() as { user_version?: unknown } | undefined;
  if (typeof row?.user_version !== 'number'
      || !Number.isSafeInteger(row.user_version)
      || row.user_version < 0) {
    throw new Error('schema version is invalid');
  }
  return row.user_version;
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
  attribution_basis TEXT NOT NULL DEFAULT 'legacy_unknown',
  capture_coverage TEXT NOT NULL DEFAULT 'legacy_unknown'
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
  files_json  TEXT NOT NULL,
  capture_coverage TEXT NOT NULL DEFAULT 'legacy_unknown'
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
  -- Optional causal-study identity asserted by a causal-aware producer outside
  -- unit_json. Ordinary realization rows leave this NULL and therefore cannot
  -- establish causal lineage by accident.
  causal_unit_id_digest TEXT,
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

-- Operator-declared mappings are a separate, append-only evidence layer. A
-- mapping points at one immutable provider record by its source identity and
-- digest and it never rewrites that record or a request-ledger row. A later
-- declaration is a new version, so the prior accounting decision remains
-- inspectable.
CREATE TABLE IF NOT EXISTS billing_record_mapping_versions (
  mapping_id            TEXT PRIMARY KEY NOT NULL,
  mapping_key           TEXT NOT NULL,
  mapping_version       INTEGER NOT NULL,
  schema_version        INTEGER NOT NULL,
  source_system         TEXT NOT NULL CHECK (source_system = 'operator-export'),
  provider              TEXT NOT NULL CHECK (provider = 'openai'),
  billing_account_ref   TEXT NOT NULL,
  source_record_id      TEXT NOT NULL,
  source_record_sha256  TEXT NOT NULL,
  first_import_id       TEXT NOT NULL,
  target_project        TEXT NOT NULL,
  target_account_ref    TEXT NOT NULL,
  declared_at_ms        INTEGER NOT NULL,
  trust                 TEXT NOT NULL CHECK (trust = 'operator_declared_unverified'),
  UNIQUE(mapping_key, mapping_version)
);

CREATE INDEX IF NOT EXISTS idx_billing_record_mapping_key
  ON billing_record_mapping_versions(mapping_key, mapping_version DESC);

CREATE INDEX IF NOT EXISTS idx_billing_record_mapping_import
  ON billing_record_mapping_versions(first_import_id, declared_at_ms DESC);

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

-- Version-2 assignment rows are physically isolated from retained version-1
-- evidence. Store-owned sequence and entropy never enter the public plan JSON.
CREATE TABLE IF NOT EXISTS causal_assignment_plans_v2 (
  study_id        TEXT NOT NULL,
  block_id        TEXT NOT NULL,
  protocol_hash   TEXT NOT NULL,
  sequence        INTEGER NOT NULL,
  created_at_ms   INTEGER NOT NULL,
  block_root      TEXT NOT NULL,
  allocation_hash TEXT NOT NULL,
  material_digest TEXT NOT NULL,
  plan_hash       TEXT NOT NULL UNIQUE,
  entropy_blob    BLOB NOT NULL,
  plan_json       TEXT NOT NULL,
  PRIMARY KEY (study_id, block_id),
  UNIQUE (study_id, sequence)
);

CREATE TABLE IF NOT EXISTS causal_decisions_v2 (
  decision_id     TEXT PRIMARY KEY NOT NULL,
  study_id        TEXT NOT NULL,
  block_id        TEXT NOT NULL,
  block_sequence  INTEGER NOT NULL,
  decision_index  INTEGER NOT NULL,
  unit_id_digest  TEXT NOT NULL,
  assigned_arm_id TEXT NOT NULL,
  event_hash      TEXT NOT NULL UNIQUE,
  decision_json   TEXT NOT NULL,
  UNIQUE (study_id, block_sequence, decision_index)
);

CREATE INDEX IF NOT EXISTS idx_causal_decisions_v2_study
  ON causal_decisions_v2(study_id, block_sequence, decision_index);

-- This table is the SQLite authority for study-scoped unit enrollment.
CREATE TABLE IF NOT EXISTS causal_assignment_units_v2 (
  study_id        TEXT NOT NULL,
  unit_id_digest  TEXT NOT NULL,
  decision_id     TEXT NOT NULL UNIQUE,
  block_id        TEXT NOT NULL,
  block_sequence  INTEGER NOT NULL,
  claimed_at_ms   INTEGER NOT NULL,
  PRIMARY KEY (study_id, unit_id_digest)
);

CREATE TABLE IF NOT EXISTS causal_assignment_manifests_v2 (
  study_id        TEXT NOT NULL,
  generation      INTEGER NOT NULL,
  protocol_hash   TEXT NOT NULL,
  manifest_hash   TEXT NOT NULL UNIQUE,
  manifest_json   TEXT NOT NULL,
  PRIMARY KEY (study_id, generation)
);

CREATE INDEX IF NOT EXISTS idx_causal_assignment_manifests_v2_current
  ON causal_assignment_manifests_v2(study_id, generation DESC);

-- Version-2 terminal evidence is physically isolated from retained v1 causal
-- execution/outcome rows.  The JSON is canonical and duplicated scalar columns
-- are the physical identity anchors checked on every Store reload.
CREATE TABLE IF NOT EXISTS causal_executions_v2 (
  execution_id                    TEXT PRIMARY KEY NOT NULL,
  decision_id                     TEXT NOT NULL UNIQUE,
  study_id                        TEXT NOT NULL,
  protocol_hash                   TEXT NOT NULL,
  started_at_ms                   INTEGER NOT NULL,
  completed_at_ms                 INTEGER NOT NULL,
  previous_event_hash             TEXT NOT NULL,
  event_hash                      TEXT NOT NULL UNIQUE,
  execution_json                  TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_causal_executions_v2_study_completed
  ON causal_executions_v2(study_id, completed_at_ms, execution_id);

CREATE TABLE IF NOT EXISTS causal_terminal_outcomes_v2 (
  outcome_id                      TEXT PRIMARY KEY NOT NULL,
  decision_id                     TEXT NOT NULL UNIQUE,
  study_id                        TEXT NOT NULL,
  protocol_hash                   TEXT NOT NULL,
  observed_at_ms                  INTEGER NOT NULL,
  maturity                        TEXT NOT NULL,
  previous_event_hash             TEXT NOT NULL,
  event_hash                      TEXT NOT NULL UNIQUE,
  terminal_outcome_json            TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_causal_terminal_outcomes_v2_study_observed
  ON causal_terminal_outcomes_v2(study_id, observed_at_ms, outcome_id);

-- One scalar-only binding joins an authenticated execution to its retained
-- request ids, terminal outcome, and immutable realization snapshot.  The
-- canonical JSON is duplicated only so every physical identity anchor can be
-- checked on reload, and contains no prompts, source text, or unit_json.
CREATE TABLE IF NOT EXISTS causal_lineage_bindings_v2 (
  binding_id                 TEXT PRIMARY KEY NOT NULL,
  study_id                   TEXT NOT NULL,
  protocol_hash              TEXT NOT NULL,
  decision_id                TEXT NOT NULL UNIQUE,
  execution_id               TEXT NOT NULL UNIQUE,
  outcome_id                 TEXT NOT NULL UNIQUE,
  unit_id_digest             TEXT NOT NULL,
  request_ids_json           TEXT NOT NULL,
  realization_commit_hash    TEXT NOT NULL,
  realization_snapshot_digest TEXT NOT NULL,
  binding_digest             TEXT NOT NULL UNIQUE,
  binding_json               TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_causal_lineage_bindings_v2_study
  ON causal_lineage_bindings_v2(study_id, decision_id);

-- The Store-owned wall-time floor preserves local rollback continuity across
-- handles and restarts. It is metadata, not causal evidence, so it remains
-- mutable only through the protected terminal-append clock boundary.
CREATE TABLE IF NOT EXISTS causal_clock_state (
  clock_id      TEXT PRIMARY KEY CHECK (clock_id = 'causal-v2'),
  last_wall_ms  INTEGER NOT NULL CHECK (last_wall_ms >= 0)
);
`;

/**
 * Trusted Epistemic Kernel persistence. Keeping these definitions beside the
 * operational schema preserves the repository's one-writer DDL rule; the
 * ledger domain only issues DML against these tables.
 */
const EPISTEMIC_SCHEMA = `
CREATE TABLE IF NOT EXISTS epistemic_nodes (
  node_id TEXT PRIMARY KEY,
  node_kind TEXT NOT NULL,
  available_at TEXT NOT NULL,
  epistemic TEXT NOT NULL,
  supersedes_json TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_epistemic_nodes_available ON epistemic_nodes(available_at, node_id);

CREATE TABLE IF NOT EXISTS epistemic_evidence (
  evidence_id TEXT PRIMARY KEY,
  evidence_json TEXT NOT NULL,
  evidence_digest TEXT NOT NULL,
  FOREIGN KEY (evidence_id) REFERENCES epistemic_nodes(node_id)
);

CREATE TABLE IF NOT EXISTS epistemic_claims (
  claim_id TEXT PRIMARY KEY,
  claim_json TEXT NOT NULL,
  claim_digest TEXT NOT NULL,
  FOREIGN KEY (claim_id) REFERENCES epistemic_nodes(node_id)
);

CREATE TABLE IF NOT EXISTS epistemic_assumptions (
  assumption_id TEXT PRIMARY KEY,
  assumption_json TEXT NOT NULL,
  assumption_digest TEXT NOT NULL,
  FOREIGN KEY (assumption_id) REFERENCES epistemic_nodes(node_id)
);

CREATE TABLE IF NOT EXISTS epistemic_witnesses (
  witness_id TEXT PRIMARY KEY,
  witness_json TEXT NOT NULL,
  witness_digest TEXT NOT NULL,
  FOREIGN KEY (witness_id) REFERENCES epistemic_nodes(node_id)
);

CREATE TABLE IF NOT EXISTS epistemic_derivations (
  derivation_id TEXT PRIMARY KEY,
  derivation_json TEXT NOT NULL,
  derivation_digest TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS epistemic_edges (
  from_id TEXT NOT NULL,
  to_id TEXT NOT NULL,
  relation TEXT NOT NULL,
  PRIMARY KEY (from_id, to_id, relation),
  FOREIGN KEY (from_id) REFERENCES epistemic_nodes(node_id),
  FOREIGN KEY (to_id) REFERENCES epistemic_nodes(node_id)
);

CREATE INDEX IF NOT EXISTS idx_epistemic_edges_from ON epistemic_edges(from_id, to_id, relation);
CREATE INDEX IF NOT EXISTS idx_epistemic_edges_to ON epistemic_edges(to_id, from_id, relation);

CREATE TABLE IF NOT EXISTS epistemic_revocations (
  event_id TEXT PRIMARY KEY,
  target_id TEXT NOT NULL,
  recorded_at TEXT NOT NULL,
  reason TEXT NOT NULL,
  FOREIGN KEY (target_id) REFERENCES epistemic_nodes(node_id)
);

CREATE INDEX IF NOT EXISTS idx_epistemic_revocations_target ON epistemic_revocations(target_id, event_id);
`;

/** Immutable exact-Money economic event subledger. */
const ECONOMIC_SCHEMA = `
CREATE TABLE IF NOT EXISTS economic_events (
  event_id TEXT PRIMARY KEY,
  event_kind TEXT NOT NULL,
  subject TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  recorded_at TEXT NOT NULL,
  event_json TEXT NOT NULL,
  event_digest TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS economic_event_sources (
  event_id        TEXT NOT NULL,
  source_event_id TEXT NOT NULL,
  PRIMARY KEY (event_id, source_event_id),
  FOREIGN KEY (event_id) REFERENCES economic_events(event_id),
  FOREIGN KEY (source_event_id) REFERENCES economic_events(event_id)
);

CREATE INDEX IF NOT EXISTS idx_economic_events_recorded ON economic_events(recorded_at, event_id);
CREATE INDEX IF NOT EXISTS idx_economic_events_subject ON economic_events(subject, recorded_at, event_id);
CREATE INDEX IF NOT EXISTS idx_economic_events_occurred ON economic_events(occurred_at, event_id);
CREATE INDEX IF NOT EXISTS idx_economic_event_sources_source ON economic_event_sources(source_event_id, event_id);

-- Historical FX knowledge is evidence, not mutable configuration. The
-- canonical observation and digest are retained together, while recorded_at and the
-- explicit predecessor edge are queryable side columns whose values are
-- revalidated against the canonical JSON at every read boundary.
CREATE TABLE IF NOT EXISTS economic_fx_rate_observations (
  observation_id     TEXT PRIMARY KEY NOT NULL,
  recorded_at        TEXT NOT NULL,
  supersedes_id      TEXT,
  observation_json   TEXT NOT NULL,
  observation_digest TEXT NOT NULL,
  FOREIGN KEY (supersedes_id) REFERENCES economic_fx_rate_observations(observation_id)
);

CREATE INDEX IF NOT EXISTS idx_economic_fx_rate_observations_recorded
  ON economic_fx_rate_observations(recorded_at, observation_id);

CREATE TABLE IF NOT EXISTS economic_allocation_runs (
  allocation_run_id TEXT PRIMARY KEY NOT NULL,
  period_start_ms INTEGER NOT NULL,
  period_end_ms INTEGER NOT NULL,
  run_at_ms INTEGER NOT NULL,
  computed_at_ms INTEGER NOT NULL,
  complete INTEGER NOT NULL CHECK (complete IN (0, 1)),
  conserves INTEGER NOT NULL CHECK (conserves IN (0, 1)),
  result_json TEXT NOT NULL,
  result_digest TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS economic_allocation_lineage (
  allocation_run_id TEXT NOT NULL,
  item_kind TEXT NOT NULL CHECK (item_kind IN ('line', 'unallocated')),
  item_index INTEGER NOT NULL CHECK (item_index >= 0),
  source_event_id TEXT NOT NULL,
  PRIMARY KEY (allocation_run_id, item_kind, item_index, source_event_id),
  FOREIGN KEY (allocation_run_id) REFERENCES economic_allocation_runs(allocation_run_id),
  FOREIGN KEY (source_event_id) REFERENCES economic_events(event_id)
);

CREATE INDEX IF NOT EXISTS idx_economic_allocation_lineage_source ON economic_allocation_lineage(source_event_id, allocation_run_id);

-- A close authorization is separate from the canonical allocation result so
-- the result digest remains compatible while new runs carry an immutable,
-- explicitly validated period-close witness. Older runs without this row are
-- intentionally unreadable rather than backfilled by inference.
CREATE TABLE IF NOT EXISTS economic_allocation_close_bindings (
  allocation_run_id  TEXT PRIMARY KEY NOT NULL,
  period_start_ms    INTEGER NOT NULL,
  period_end_ms      INTEGER NOT NULL,
  finalization_id    TEXT NOT NULL,
  projection_digest  TEXT NOT NULL,
  event_count        INTEGER NOT NULL CHECK (event_count >= 0),
  FOREIGN KEY (allocation_run_id) REFERENCES economic_allocation_runs(allocation_run_id),
  FOREIGN KEY (finalization_id) REFERENCES economic_events(event_id)
);

CREATE INDEX IF NOT EXISTS idx_economic_allocation_close_finalization ON economic_allocation_close_bindings(finalization_id);
`;

/**
 * Configure connection-local SQLite behavior before any schema inspection or
 * causal write.  INSERT OR REPLACE implements conflict resolution by deleting
 * the conflicting row first; SQLite only runs that delete through the normal
 * trigger path when recursive triggers are enabled on this connection.
 */
export function configureDatabaseConnection(db: DatabaseSync): void {
  db.prepare('PRAGMA recursive_triggers = ON').run();
  db.prepare('PRAGMA foreign_keys = ON').run();
}

/** Reject tampered append-only metadata before idempotent DDL can repair it. */
function validateAppendOnlyTriggerAuthority(db: DatabaseSync): void {
  const expected: ReadonlyArray<{ name: string; table: string; sql: string }> = [
    {
      name: 'economic_events_append_only_update',
      table: 'economic_events',
      sql: "CREATE TRIGGER economic_events_append_only_update BEFORE UPDATE ON economic_events BEGIN SELECT RAISE(ABORT, 'economic event ledger is append-only'); END",
    },
    {
      name: 'economic_events_append_only_delete',
      table: 'economic_events',
      sql: "CREATE TRIGGER economic_events_append_only_delete BEFORE DELETE ON economic_events BEGIN SELECT RAISE(ABORT, 'economic event ledger is append-only'); END",
    },
    {
      name: 'economic_events_append_only_insert',
      table: 'economic_events',
      sql: "CREATE TRIGGER economic_events_append_only_insert BEFORE INSERT ON economic_events WHEN EXISTS (SELECT 1 FROM economic_events WHERE event_id = NEW.event_id) BEGIN SELECT RAISE(ABORT, 'economic event ledger is append-only'); END",
    },
    {
      name: 'economic_fx_rate_observations_append_only_update',
      table: 'economic_fx_rate_observations',
      sql: "CREATE TRIGGER economic_fx_rate_observations_append_only_update BEFORE UPDATE ON economic_fx_rate_observations BEGIN SELECT RAISE(ABORT, 'historical FX rate observations are append-only'); END",
    },
    {
      name: 'economic_fx_rate_observations_append_only_delete',
      table: 'economic_fx_rate_observations',
      sql: "CREATE TRIGGER economic_fx_rate_observations_append_only_delete BEFORE DELETE ON economic_fx_rate_observations BEGIN SELECT RAISE(ABORT, 'historical FX rate observations are append-only'); END",
    },
    {
      name: 'economic_fx_rate_observations_append_only_insert',
      table: 'economic_fx_rate_observations',
      sql: "CREATE TRIGGER economic_fx_rate_observations_append_only_insert BEFORE INSERT ON economic_fx_rate_observations WHEN EXISTS (SELECT 1 FROM economic_fx_rate_observations WHERE observation_id = NEW.observation_id) BEGIN SELECT RAISE(ABORT, 'historical FX rate observations are append-only'); END",
    },
    {
      name: 'economic_event_sources_append_only_update',
      table: 'economic_event_sources',
      sql: "CREATE TRIGGER economic_event_sources_append_only_update BEFORE UPDATE ON economic_event_sources BEGIN SELECT RAISE(ABORT, 'economic event source links are append-only'); END",
    },
    {
      name: 'economic_event_sources_append_only_delete',
      table: 'economic_event_sources',
      sql: "CREATE TRIGGER economic_event_sources_append_only_delete BEFORE DELETE ON economic_event_sources BEGIN SELECT RAISE(ABORT, 'economic event source links are append-only'); END",
    },
    {
      name: 'economic_event_sources_append_only_insert',
      table: 'economic_event_sources',
      sql: "CREATE TRIGGER economic_event_sources_append_only_insert BEFORE INSERT ON economic_event_sources WHEN EXISTS (SELECT 1 FROM economic_event_sources WHERE event_id = NEW.event_id AND source_event_id = NEW.source_event_id) BEGIN SELECT RAISE(ABORT, 'economic event source links are append-only'); END",
    },
    {
      name: 'billing_mapping_no_update',
      table: 'billing_record_mapping_versions',
      sql: "CREATE TRIGGER billing_mapping_no_update BEFORE UPDATE ON billing_record_mapping_versions BEGIN SELECT RAISE(ABORT, 'billing mapping evidence is append-only'); END",
    },
    {
      name: 'billing_mapping_no_delete',
      table: 'billing_record_mapping_versions',
      sql: "CREATE TRIGGER billing_mapping_no_delete BEFORE DELETE ON billing_record_mapping_versions BEGIN SELECT RAISE(ABORT, 'billing mapping evidence is append-only'); END",
    },
    {
      name: 'economic_allocation_close_bindings_append_only_update',
      table: 'economic_allocation_close_bindings',
      sql: "CREATE TRIGGER economic_allocation_close_bindings_append_only_update BEFORE UPDATE ON economic_allocation_close_bindings BEGIN SELECT RAISE(ABORT, 'exact economic allocation close bindings are append-only'); END",
    },
    {
      name: 'economic_allocation_close_bindings_append_only_delete',
      table: 'economic_allocation_close_bindings',
      sql: "CREATE TRIGGER economic_allocation_close_bindings_append_only_delete BEFORE DELETE ON economic_allocation_close_bindings BEGIN SELECT RAISE(ABORT, 'exact economic allocation close bindings are append-only'); END",
    },
    {
      name: 'economic_allocation_close_bindings_append_only_insert',
      table: 'economic_allocation_close_bindings',
      sql: "CREATE TRIGGER economic_allocation_close_bindings_append_only_insert BEFORE INSERT ON economic_allocation_close_bindings WHEN EXISTS (SELECT 1 FROM economic_allocation_close_bindings WHERE allocation_run_id = NEW.allocation_run_id) BEGIN SELECT RAISE(ABORT, 'exact economic allocation close bindings are append-only'); END",
    },
  ];
  const existingTables = new Set((db.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table'",
  ).all() as Array<{ name: string }>).map((row) => row.name));
  const defects = expected.filter((item) => {
    if (!existingTables.has(item.table)) return false;
    const actual = db.prepare(
      "SELECT tbl_name, sql FROM sqlite_master WHERE type = 'trigger' AND name = ?",
    ).get(item.name) as { tbl_name: string; sql: string | null } | undefined;
    return !actual || actual.tbl_name !== item.table
      || normalizeAuthoritySql(actual.sql) !== normalizeAuthoritySql(item.sql);
  });
  if (defects.length > 0) {
    throw new Error('database integrity validation failed: append-only trigger authority mismatch');
  }
}

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
  if (!cols.some((c) => c.name === 'capture_coverage')) {
    // Existing rows predate response-capture coverage tracking. Preserve their
    // uncertainty rather than upgrading them to a complete observation.
    db.prepare("ALTER TABLE requests ADD COLUMN capture_coverage TEXT NOT NULL DEFAULT 'legacy_unknown'").run();
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
  if (!unitCols.some((c) => c.name === 'causal_unit_id_digest')) {
    // No backfill. Existing snapshots have no independently retained causal
    // unit identity, and deriving one from unit_json would make ordinary
    // realization data appear to be randomized-study evidence.
    db.prepare('ALTER TABLE realization_units ADD COLUMN causal_unit_id_digest TEXT').run();
  }
  const proposalCols = db.prepare('PRAGMA table_info(proposals)').all() as Array<{ name: string }>;
  if (!proposalCols.some((c) => c.name === 'capture_coverage')) {
    // Existing proposal rows were captured before truncation was tracked. Keep
    // their coverage unknown rather than silently upgrading them to complete.
    db.prepare("ALTER TABLE proposals ADD COLUMN capture_coverage TEXT NOT NULL DEFAULT 'legacy_unknown'").run();
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
    'causal_assignment_plans_v2',
    'causal_decisions_v2',
    'causal_assignment_units_v2',
    'causal_assignment_manifests_v2',
    'causal_executions_v2',
    'causal_terminal_outcomes_v2',
    'causal_lineage_bindings_v2',
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
 * Create and protect the Trusted Epistemic Kernel tables. This is exported so
 * the standalone kernel ledger can initialize an isolated DatabaseSync handle,
 * while all DDL remains physically owned by this schema module.
 */
export function initializeEpistemicSchema(db: DatabaseSync): void {
  db.prepare('PRAGMA foreign_keys = ON').run();
  runScript(db, EPISTEMIC_SCHEMA);
  const tables = [
    'epistemic_nodes',
    'epistemic_evidence',
    'epistemic_claims',
    'epistemic_assumptions',
    'epistemic_witnesses',
    'epistemic_derivations',
    'epistemic_edges',
    'epistemic_revocations',
  ];
  for (const table of tables) {
    const updateTrigger = 'epistemic_' + table.replace('epistemic_', '') + '_append_only_update';
    const deleteTrigger = 'epistemic_' + table.replace('epistemic_', '') + '_append_only_delete';
    db.prepare(
      'CREATE TRIGGER IF NOT EXISTS ' + updateTrigger +
      ' BEFORE UPDATE ON ' + table +
      ' BEGIN SELECT RAISE(ABORT, \'epistemic ledger is append-only\'); END',
    ).run();
    db.prepare(
      'CREATE TRIGGER IF NOT EXISTS ' + deleteTrigger +
      ' BEFORE DELETE ON ' + table +
      ' BEGIN SELECT RAISE(ABORT, \'epistemic ledger is append-only\'); END',
    ).run();
  }
  const duplicateGuards: ReadonlyArray<{ table: string; key: string }> = [
    { table: 'epistemic_nodes', key: 'node_id = NEW.node_id' },
    { table: 'epistemic_evidence', key: 'evidence_id = NEW.evidence_id' },
    { table: 'epistemic_claims', key: 'claim_id = NEW.claim_id' },
    { table: 'epistemic_assumptions', key: 'assumption_id = NEW.assumption_id' },
    { table: 'epistemic_witnesses', key: 'witness_id = NEW.witness_id' },
    { table: 'epistemic_derivations', key: 'derivation_id = NEW.derivation_id' },
    { table: 'epistemic_edges', key: 'from_id = NEW.from_id AND to_id = NEW.to_id AND relation = NEW.relation' },
    { table: 'epistemic_revocations', key: 'event_id = NEW.event_id' },
  ];
  for (const guard of duplicateGuards) {
    const trigger = 'epistemic_' + guard.table.replace('epistemic_', '') + '_append_only_insert';
    db.prepare(
      'CREATE TRIGGER IF NOT EXISTS ' + trigger +
      ' BEFORE INSERT ON ' + guard.table +
      ' WHEN EXISTS (SELECT 1 FROM ' + guard.table + ' WHERE ' + guard.key + ')' +
      ' BEGIN SELECT RAISE(ABORT, \'epistemic ledger is append-only\'); END',
    ).run();
  }
}

/**
 * Create and protect the immutable exact-Money economic event table. DDL stays
 * in this schema module; `src/economics/ledger.ts` performs validated DML only.
 */
export function initializeEconomicSchema(db: DatabaseSync): void {
  db.prepare('PRAGMA foreign_keys = ON').run();
  runScript(db, ECONOMIC_SCHEMA);
  const updateTrigger = 'economic_events_append_only_update';
  const deleteTrigger = 'economic_events_append_only_delete';
  db.prepare(
    'CREATE TRIGGER IF NOT EXISTS ' + updateTrigger +
    ' BEFORE UPDATE ON economic_events' +
    ' BEGIN SELECT RAISE(ABORT, \'economic event ledger is append-only\'); END',
  ).run();
  db.prepare(
    'CREATE TRIGGER IF NOT EXISTS ' + deleteTrigger +
    ' BEFORE DELETE ON economic_events' +
    ' BEGIN SELECT RAISE(ABORT, \'economic event ledger is append-only\'); END',
  ).run();
  db.prepare(
    'CREATE TRIGGER IF NOT EXISTS economic_events_append_only_insert' +
    ' BEFORE INSERT ON economic_events' +
    ' WHEN EXISTS (SELECT 1 FROM economic_events WHERE event_id = NEW.event_id)' +
    ' BEGIN SELECT RAISE(ABORT, \'economic event ledger is append-only\'); END',
  ).run();
  db.prepare(
    'CREATE TRIGGER IF NOT EXISTS economic_fx_rate_observations_append_only_update' +
    ' BEFORE UPDATE ON economic_fx_rate_observations' +
    ' BEGIN SELECT RAISE(ABORT, \'historical FX rate observations are append-only\'); END',
  ).run();
  db.prepare(
    'CREATE TRIGGER IF NOT EXISTS economic_fx_rate_observations_append_only_delete' +
    ' BEFORE DELETE ON economic_fx_rate_observations' +
    ' BEGIN SELECT RAISE(ABORT, \'historical FX rate observations are append-only\'); END',
  ).run();
  db.prepare(
    'CREATE TRIGGER IF NOT EXISTS economic_fx_rate_observations_append_only_insert' +
    ' BEFORE INSERT ON economic_fx_rate_observations' +
    ' WHEN EXISTS (SELECT 1 FROM economic_fx_rate_observations WHERE observation_id = NEW.observation_id)' +
    ' BEGIN SELECT RAISE(ABORT, \'historical FX rate observations are append-only\'); END',
  ).run();
  db.prepare(
    'CREATE TRIGGER IF NOT EXISTS economic_event_sources_append_only_update' +
    ' BEFORE UPDATE ON economic_event_sources' +
    ' BEGIN SELECT RAISE(ABORT, \'economic event source links are append-only\'); END',
  ).run();
  db.prepare(
    'CREATE TRIGGER IF NOT EXISTS economic_event_sources_append_only_delete' +
    ' BEFORE DELETE ON economic_event_sources' +
    ' BEGIN SELECT RAISE(ABORT, \'economic event source links are append-only\'); END',
  ).run();
  db.prepare(
    'CREATE TRIGGER IF NOT EXISTS economic_event_sources_append_only_insert' +
    ' BEFORE INSERT ON economic_event_sources' +
    ' WHEN EXISTS (SELECT 1 FROM economic_event_sources WHERE event_id = NEW.event_id AND source_event_id = NEW.source_event_id)' +
    ' BEGIN SELECT RAISE(ABORT, \'economic event source links are append-only\'); END',
  ).run();
  db.prepare(
    'CREATE TRIGGER IF NOT EXISTS economic_allocation_runs_append_only_update' +
    ' BEFORE UPDATE ON economic_allocation_runs' +
    ' BEGIN SELECT RAISE(ABORT, \'exact economic allocation runs are append-only\'); END',
  ).run();
  db.prepare(
    'CREATE TRIGGER IF NOT EXISTS economic_allocation_runs_append_only_delete' +
    ' BEFORE DELETE ON economic_allocation_runs' +
    ' BEGIN SELECT RAISE(ABORT, \'exact economic allocation runs are append-only\'); END',
  ).run();
  db.prepare(
    'CREATE TRIGGER IF NOT EXISTS economic_allocation_runs_append_only_insert' +
    ' BEFORE INSERT ON economic_allocation_runs' +
    ' WHEN EXISTS (SELECT 1 FROM economic_allocation_runs WHERE allocation_run_id = NEW.allocation_run_id)' +
    ' BEGIN SELECT RAISE(ABORT, \'exact economic allocation runs are append-only\'); END',
  ).run();
  db.prepare(
    'CREATE TRIGGER IF NOT EXISTS economic_allocation_lineage_append_only_update' +
    ' BEFORE UPDATE ON economic_allocation_lineage' +
    ' BEGIN SELECT RAISE(ABORT, \'exact economic allocation lineage is append-only\'); END',
  ).run();
  db.prepare(
    'CREATE TRIGGER IF NOT EXISTS economic_allocation_lineage_append_only_delete' +
    ' BEFORE DELETE ON economic_allocation_lineage' +
    ' BEGIN SELECT RAISE(ABORT, \'exact economic allocation lineage is append-only\'); END',
  ).run();
  db.prepare(
    'CREATE TRIGGER IF NOT EXISTS economic_allocation_lineage_append_only_insert' +
    ' BEFORE INSERT ON economic_allocation_lineage' +
    ' WHEN EXISTS (SELECT 1 FROM economic_allocation_lineage WHERE allocation_run_id = NEW.allocation_run_id AND item_kind = NEW.item_kind AND item_index = NEW.item_index AND source_event_id = NEW.source_event_id)' +
    ' BEGIN SELECT RAISE(ABORT, \'exact economic allocation lineage is append-only\'); END',
  ).run();
  db.prepare(
    'CREATE TRIGGER IF NOT EXISTS economic_allocation_close_bindings_append_only_update' +
    ' BEFORE UPDATE ON economic_allocation_close_bindings' +
    ' BEGIN SELECT RAISE(ABORT, \'exact economic allocation close bindings are append-only\'); END',
  ).run();
  db.prepare(
    'CREATE TRIGGER IF NOT EXISTS economic_allocation_close_bindings_append_only_delete' +
    ' BEFORE DELETE ON economic_allocation_close_bindings' +
    ' BEGIN SELECT RAISE(ABORT, \'exact economic allocation close bindings are append-only\'); END',
  ).run();
  db.prepare(
    'CREATE TRIGGER IF NOT EXISTS economic_allocation_close_bindings_append_only_insert' +
    ' BEFORE INSERT ON economic_allocation_close_bindings' +
    ' WHEN EXISTS (SELECT 1 FROM economic_allocation_close_bindings WHERE allocation_run_id = NEW.allocation_run_id)' +
    ' BEGIN SELECT RAISE(ABORT, \'exact economic allocation close bindings are append-only\'); END',
  ).run();
}

/** Operator mappings are evidence, not mutable configuration. */
function installBillingMappingImmutability(db: DatabaseSync): void {
  db.prepare(
    "CREATE TRIGGER IF NOT EXISTS billing_mapping_no_update BEFORE UPDATE ON billing_record_mapping_versions " +
    "BEGIN SELECT RAISE(ABORT, 'billing mapping evidence is append-only'); END",
  ).run();
  db.prepare(
    "CREATE TRIGGER IF NOT EXISTS billing_mapping_no_delete BEFORE DELETE ON billing_record_mapping_versions " +
    "BEGIN SELECT RAISE(ABORT, 'billing mapping evidence is append-only'); END",
  ).run();
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

interface CausalV2ColumnContract {
  name: string;
  type: 'TEXT' | 'INTEGER' | 'BLOB';
  pk: number;
  notnull?: 0 | 1;
}

interface CausalV2IndexContract {
  origin: 'pk' | 'u' | 'c';
  unique: 0 | 1;
  columns: Array<{ cid: number; name: string; desc: 0 | 1 }>;
  /** Bound only for checked-in explicit indexes; SQLite owns autoindex names. */
  name?: string;
  sql?: string;
}

interface CausalV2TableContract {
  sql: string;
  columns: CausalV2ColumnContract[];
  indexes: CausalV2IndexContract[];
}

const C = (
  name: string,
  type: 'TEXT' | 'INTEGER' | 'BLOB',
  pk = 0,
  notnull: 0 | 1 = 1,
): CausalV2ColumnContract => ({ name, type, pk, notnull });
const I = (
  origin: 'pk' | 'u' | 'c',
  unique: 0 | 1,
  columns: Array<{ cid: number; name: string; desc?: 0 | 1 }>,
  explicit?: { name: string; sql: string },
): CausalV2IndexContract => ({
  origin,
  unique,
  columns: columns.map((column) => ({ ...column, desc: column.desc ?? 0 })),
  ...explicit,
});

const CAUSAL_V2_TABLE_CONTRACTS: Record<string, CausalV2TableContract> = {
  causal_assignment_plans_v2: {
    sql: `CREATE TABLE causal_assignment_plans_v2 (
  study_id        TEXT NOT NULL,
  block_id        TEXT NOT NULL,
  protocol_hash   TEXT NOT NULL,
  sequence        INTEGER NOT NULL,
  created_at_ms   INTEGER NOT NULL,
  block_root      TEXT NOT NULL,
  allocation_hash TEXT NOT NULL,
  material_digest TEXT NOT NULL,
  plan_hash       TEXT NOT NULL UNIQUE,
  entropy_blob    BLOB NOT NULL,
  plan_json       TEXT NOT NULL,
  PRIMARY KEY (study_id, block_id),
  UNIQUE (study_id, sequence)
)`,
    columns: [
      C('study_id', 'TEXT', 1), C('block_id', 'TEXT', 2), C('protocol_hash', 'TEXT'),
      C('sequence', 'INTEGER'), C('created_at_ms', 'INTEGER'), C('block_root', 'TEXT'),
      C('allocation_hash', 'TEXT'), C('material_digest', 'TEXT'), C('plan_hash', 'TEXT'),
      C('entropy_blob', 'BLOB'), C('plan_json', 'TEXT'),
    ],
    indexes: [
      I('u', 1, [{ cid: 8, name: 'plan_hash' }]),
      I('pk', 1, [{ cid: 0, name: 'study_id' }, { cid: 1, name: 'block_id' }]),
      I('u', 1, [{ cid: 0, name: 'study_id' }, { cid: 3, name: 'sequence' }]),
    ],
  },
  causal_decisions_v2: {
    sql: `CREATE TABLE causal_decisions_v2 (
  decision_id     TEXT PRIMARY KEY NOT NULL,
  study_id        TEXT NOT NULL,
  block_id        TEXT NOT NULL,
  block_sequence  INTEGER NOT NULL,
  decision_index  INTEGER NOT NULL,
  unit_id_digest  TEXT NOT NULL,
  assigned_arm_id TEXT NOT NULL,
  event_hash      TEXT NOT NULL UNIQUE,
  decision_json   TEXT NOT NULL,
  UNIQUE (study_id, block_sequence, decision_index)
)`,
    columns: [
      C('decision_id', 'TEXT', 1), C('study_id', 'TEXT'), C('block_id', 'TEXT'),
      C('block_sequence', 'INTEGER'), C('decision_index', 'INTEGER'),
      C('unit_id_digest', 'TEXT'), C('assigned_arm_id', 'TEXT'),
      C('event_hash', 'TEXT'), C('decision_json', 'TEXT'),
    ],
    indexes: [
      I('c', 0, [
        { cid: 1, name: 'study_id' }, { cid: 3, name: 'block_sequence' },
        { cid: 4, name: 'decision_index' },
      ], {
        name: 'idx_causal_decisions_v2_study',
        sql: `CREATE INDEX idx_causal_decisions_v2_study
  ON causal_decisions_v2(study_id, block_sequence, decision_index)`,
      }),
      I('u', 1, [
        { cid: 1, name: 'study_id' }, { cid: 3, name: 'block_sequence' },
        { cid: 4, name: 'decision_index' },
      ]),
      I('u', 1, [{ cid: 7, name: 'event_hash' }]),
      I('pk', 1, [{ cid: 0, name: 'decision_id' }]),
    ],
  },
  causal_assignment_units_v2: {
    sql: `CREATE TABLE causal_assignment_units_v2 (
  study_id        TEXT NOT NULL,
  unit_id_digest  TEXT NOT NULL,
  decision_id     TEXT NOT NULL UNIQUE,
  block_id        TEXT NOT NULL,
  block_sequence  INTEGER NOT NULL,
  claimed_at_ms   INTEGER NOT NULL,
  PRIMARY KEY (study_id, unit_id_digest)
)`,
    columns: [
      C('study_id', 'TEXT', 1), C('unit_id_digest', 'TEXT', 2),
      C('decision_id', 'TEXT'), C('block_id', 'TEXT'),
      C('block_sequence', 'INTEGER'), C('claimed_at_ms', 'INTEGER'),
    ],
    indexes: [
      I('pk', 1, [{ cid: 0, name: 'study_id' }, { cid: 1, name: 'unit_id_digest' }]),
      I('u', 1, [{ cid: 2, name: 'decision_id' }]),
    ],
  },
  causal_assignment_manifests_v2: {
    sql: `CREATE TABLE causal_assignment_manifests_v2 (
  study_id        TEXT NOT NULL,
  generation      INTEGER NOT NULL,
  protocol_hash   TEXT NOT NULL,
  manifest_hash   TEXT NOT NULL UNIQUE,
  manifest_json   TEXT NOT NULL,
  PRIMARY KEY (study_id, generation)
)`,
    columns: [
      C('study_id', 'TEXT', 1), C('generation', 'INTEGER', 2),
      C('protocol_hash', 'TEXT'), C('manifest_hash', 'TEXT'), C('manifest_json', 'TEXT'),
    ],
    indexes: [
      I('c', 0, [
        { cid: 0, name: 'study_id' }, { cid: 1, name: 'generation', desc: 1 },
      ], {
        name: 'idx_causal_assignment_manifests_v2_current',
        sql: `CREATE INDEX idx_causal_assignment_manifests_v2_current
  ON causal_assignment_manifests_v2(study_id, generation DESC)`,
      }),
      I('pk', 1, [{ cid: 0, name: 'study_id' }, { cid: 1, name: 'generation' }]),
      I('u', 1, [{ cid: 3, name: 'manifest_hash' }]),
    ],
  },
  causal_executions_v2: {
    sql: `CREATE TABLE causal_executions_v2 (
  execution_id                    TEXT PRIMARY KEY NOT NULL,
  decision_id                     TEXT NOT NULL UNIQUE,
  study_id                        TEXT NOT NULL,
  protocol_hash                   TEXT NOT NULL,
  started_at_ms                   INTEGER NOT NULL,
  completed_at_ms                 INTEGER NOT NULL,
  previous_event_hash             TEXT NOT NULL,
  event_hash                      TEXT NOT NULL UNIQUE,
  execution_json                  TEXT NOT NULL
)`,
    columns: [
      C('execution_id', 'TEXT', 1), C('decision_id', 'TEXT'), C('study_id', 'TEXT'),
      C('protocol_hash', 'TEXT'), C('started_at_ms', 'INTEGER'),
      C('completed_at_ms', 'INTEGER'), C('previous_event_hash', 'TEXT'),
      C('event_hash', 'TEXT'), C('execution_json', 'TEXT'),
    ],
    indexes: [
      I('c', 0, [
        { cid: 2, name: 'study_id' }, { cid: 5, name: 'completed_at_ms' },
        { cid: 0, name: 'execution_id' },
      ], {
        name: 'idx_causal_executions_v2_study_completed',
        sql: `CREATE INDEX idx_causal_executions_v2_study_completed
  ON causal_executions_v2(study_id, completed_at_ms, execution_id)`,
      }),
      I('u', 1, [{ cid: 7, name: 'event_hash' }]),
      I('u', 1, [{ cid: 1, name: 'decision_id' }]),
      I('pk', 1, [{ cid: 0, name: 'execution_id' }]),
    ],
  },
  causal_terminal_outcomes_v2: {
    sql: `CREATE TABLE causal_terminal_outcomes_v2 (
  outcome_id                      TEXT PRIMARY KEY NOT NULL,
  decision_id                     TEXT NOT NULL UNIQUE,
  study_id                        TEXT NOT NULL,
  protocol_hash                   TEXT NOT NULL,
  observed_at_ms                  INTEGER NOT NULL,
  maturity                        TEXT NOT NULL,
  previous_event_hash             TEXT NOT NULL,
  event_hash                      TEXT NOT NULL UNIQUE,
  terminal_outcome_json            TEXT NOT NULL
)`,
    columns: [
      C('outcome_id', 'TEXT', 1), C('decision_id', 'TEXT'), C('study_id', 'TEXT'),
      C('protocol_hash', 'TEXT'), C('observed_at_ms', 'INTEGER'), C('maturity', 'TEXT'),
      C('previous_event_hash', 'TEXT'), C('event_hash', 'TEXT'), C('terminal_outcome_json', 'TEXT'),
    ],
    indexes: [
      I('c', 0, [
        { cid: 2, name: 'study_id' }, { cid: 4, name: 'observed_at_ms' },
        { cid: 0, name: 'outcome_id' },
      ], {
        name: 'idx_causal_terminal_outcomes_v2_study_observed',
        sql: `CREATE INDEX idx_causal_terminal_outcomes_v2_study_observed
  ON causal_terminal_outcomes_v2(study_id, observed_at_ms, outcome_id)`,
      }),
      I('u', 1, [{ cid: 7, name: 'event_hash' }]),
      I('u', 1, [{ cid: 1, name: 'decision_id' }]),
      I('pk', 1, [{ cid: 0, name: 'outcome_id' }]),
    ],
  },
  causal_lineage_bindings_v2: {
    sql: `CREATE TABLE causal_lineage_bindings_v2 (
  binding_id                  TEXT PRIMARY KEY NOT NULL,
  study_id                    TEXT NOT NULL,
  protocol_hash               TEXT NOT NULL,
  decision_id                 TEXT NOT NULL UNIQUE,
  execution_id               TEXT NOT NULL UNIQUE,
  outcome_id                 TEXT NOT NULL UNIQUE,
  unit_id_digest              TEXT NOT NULL,
  request_ids_json            TEXT NOT NULL,
  realization_commit_hash     TEXT NOT NULL,
  realization_snapshot_digest TEXT NOT NULL,
  binding_digest              TEXT NOT NULL UNIQUE,
  binding_json                TEXT NOT NULL
)`,
    columns: [
      C('binding_id', 'TEXT', 1), C('study_id', 'TEXT'), C('protocol_hash', 'TEXT'),
      C('decision_id', 'TEXT'), C('execution_id', 'TEXT'), C('outcome_id', 'TEXT'),
      C('unit_id_digest', 'TEXT'), C('request_ids_json', 'TEXT'),
      C('realization_commit_hash', 'TEXT'), C('realization_snapshot_digest', 'TEXT'),
      C('binding_digest', 'TEXT'), C('binding_json', 'TEXT'),
    ],
    indexes: [
      I('c', 0, [
        { cid: 1, name: 'study_id' }, { cid: 3, name: 'decision_id' },
      ], {
        name: 'idx_causal_lineage_bindings_v2_study',
        sql: `CREATE INDEX idx_causal_lineage_bindings_v2_study
  ON causal_lineage_bindings_v2(study_id, decision_id)`,
      }),
      I('u', 1, [{ cid: 10, name: 'binding_digest' }]),
      I('u', 1, [{ cid: 5, name: 'outcome_id' }]),
      I('u', 1, [{ cid: 4, name: 'execution_id' }]),
      I('u', 1, [{ cid: 3, name: 'decision_id' }]),
      I('pk', 1, [{ cid: 0, name: 'binding_id' }]),
    ],
  },
  causal_clock_state: {
    sql: `CREATE TABLE causal_clock_state (
  clock_id      TEXT PRIMARY KEY CHECK (clock_id = 'causal-v2'),
  last_wall_ms  INTEGER NOT NULL CHECK (last_wall_ms >= 0)
)`,
    columns: [
      C('clock_id', 'TEXT', 1, 0), C('last_wall_ms', 'INTEGER'),
    ],
    indexes: [
      I('pk', 1, [{ cid: 0, name: 'clock_id' }]),
    ],
  },
};

const CAUSAL_V2_TABLES = Object.keys(CAUSAL_V2_TABLE_CONTRACTS);
const CAUSAL_V2_EVIDENCE_TABLES = CAUSAL_V2_TABLES.filter((table) => table !== 'causal_clock_state');

export type CausalV2SchemaState =
  | 'absent'
  | 'exact-s3'
  | 'exact-pre-clock'
  | 'exact-pre-lineage'
  | 'exact-pre-clock-pre-lineage'
  | 'exact'
  | 'incomplete';

export interface CausalV2SchemaAttestation {
  state: CausalV2SchemaState;
  defectIds: string[];
}

/**
 * Tokenize checked-in SQLite authority without changing quoted material.
 *
 * SQLite preserves the creating statement in `sqlite_schema.sql`, but its
 * formatting and keyword case are not semantic.  Comparing the token stream
 * binds every constraint, conflict policy, clause, identifier and literal
 * while safely tolerating only whitespace/comments and bare-keyword case.
 * Quoted tokens remain byte-exact; malformed quoting/comments fail closed.
 */
function normalizeAuthoritySql(sql: unknown): string | null {
  if (typeof sql !== 'string') return null;
  const tokens: string[] = [];
  let index = 0;
  while (index < sql.length) {
    const char = sql[index]!;
    if (/\s/.test(char)) {
      index += 1;
      continue;
    }
    if (char === '-' && sql[index + 1] === '-') {
      index += 2;
      while (index < sql.length && sql[index] !== '\n' && sql[index] !== '\r') index += 1;
      continue;
    }
    if (char === '/' && sql[index + 1] === '*') {
      const close = sql.indexOf('*/', index + 2);
      if (close === -1) return null;
      index = close + 2;
      continue;
    }
    if (char === "'" || char === '"' || char === '`') {
      const delimiter = char;
      let literal = delimiter;
      index += 1;
      let closed = false;
      while (index < sql.length) {
        const next = sql[index]!;
        literal += next;
        index += 1;
        if (next !== delimiter) continue;
        if (sql[index] === delimiter) {
          literal += delimiter;
          index += 1;
          continue;
        }
        closed = true;
        break;
      }
      if (!closed) return null;
      tokens.push(literal);
      continue;
    }
    if (char === '[') {
      const close = sql.indexOf(']', index + 1);
      if (close === -1) return null;
      tokens.push(sql.slice(index, close + 1));
      index = close + 1;
      continue;
    }
    if (/[A-Za-z_]/.test(char)) {
      let end = index + 1;
      while (end < sql.length && /[A-Za-z0-9_$]/.test(sql[end]!)) end += 1;
      tokens.push(sql.slice(index, end).toLowerCase());
      index = end;
      continue;
    }
    if (/[0-9]/.test(char)) {
      let end = index + 1;
      while (end < sql.length && /[0-9A-Fa-fxXeE.+-]/.test(sql[end]!)) end += 1;
      tokens.push(sql.slice(index, end));
      index = end;
      continue;
    }
    if ('(),;=+-*/.<>!|&%~'.includes(char)) {
      tokens.push(char);
      index += 1;
      continue;
    }
    // Parameters and syntax outside the checked-in authority fail closed.
    return null;
  }
  return tokens.join(' ');
}

function expectedImmutabilityTriggers(tables: readonly string[] = CAUSAL_V2_EVIDENCE_TABLES): Map<string, { table: string; sql: string }> {
  const expected = new Map<string, { table: string; sql: string }>();
  for (const table of tables) {
    for (const operation of ['update', 'delete'] as const) {
      const name = 'causal_no_' + operation + '_' + table;
      const sql = 'CREATE TRIGGER ' + name + ' BEFORE ' + operation.toUpperCase() +
        ' ON ' + table + " BEGIN SELECT RAISE(ABORT, 'causal evidence is append-only'); END";
      expected.set(name, { table, sql: normalizeAuthoritySql(sql)! });
    }
  }
  return expected;
}

const SLICE3_CAUSAL_V2_TABLES = [
  'causal_assignment_plans_v2',
  'causal_decisions_v2',
  'causal_assignment_units_v2',
  'causal_assignment_manifests_v2',
] as const;

/**
 * The complete pre-T-069 generation is an additive migration predecessor.  It
 * has the exact Slice 4 evidence and clock authority, but no lineage sidecar.
 * Keep this list explicit: accepting a lookalike or partial sidecar generation
 * would turn CREATE TABLE IF NOT EXISTS into an authority upgrade.
 */
const PRE_LINEAGE_CAUSAL_V2_EVIDENCE_TABLES = [
  'causal_assignment_plans_v2',
  'causal_decisions_v2',
  'causal_assignment_units_v2',
  'causal_assignment_manifests_v2',
  'causal_executions_v2',
  'causal_terminal_outcomes_v2',
] as const;


/**
 * The four-table assignment generation is the only trusted predecessor for
 * the additive Slice 4 migration.  A partial or lookalike generation must not
 * be upgraded merely because CREATE TABLE IF NOT EXISTS can fill its gaps.
 */
function exactSlice3AssignmentSchema(db: DatabaseSync): boolean {
  const lineagePresent = db.prepare(
    "SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'causal_lineage_bindings_v2'",
  ).get() as { present: number } | undefined;
  // A current-generation database with its terminal tables intentionally
  // removed (the historical Slice 3 migration test shape) may retain the
  // newly-created but necessarily empty sidecar.  It is accepted only when
  // that sidecar is itself exact and empty, never when lineage rows survive
  // without their terminal predecessors.
  if (lineagePresent
      && (!tableContractMatches(db, 'causal_lineage_bindings_v2', CAUSAL_V2_TABLE_CONTRACTS.causal_lineage_bindings_v2!)
        || Number((db.prepare('SELECT COUNT(*) AS count FROM causal_lineage_bindings_v2').get() as { count: number }).count) !== 0)) {
    return false;
  }
  for (const table of CAUSAL_V2_EVIDENCE_TABLES) {
    const exists = db.prepare(
      "SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = ?",
    ).get(table) as { present: number } | undefined;
    if (SLICE3_CAUSAL_V2_TABLES.includes(table as typeof SLICE3_CAUSAL_V2_TABLES[number])) {
      const contract = CAUSAL_V2_TABLE_CONTRACTS[table];
      if (!exists || !contract || !tableContractMatches(db, table, contract)) return false;
    } else if (table === 'causal_lineage_bindings_v2' && lineagePresent) {
      // Checked above, and kept explicit to make the accepted table set clear.
    } else if (exists) {
      return false;
    }
  }
  const clockPresent = db.prepare(
    "SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'causal_clock_state'",
  ).get() as { present: number } | undefined;
  if (clockPresent && !tableContractMatches(db, 'causal_clock_state', CAUSAL_V2_TABLE_CONTRACTS.causal_clock_state!)) {
    return false;
  }
  if (clockPresent && !causalClockStateRowExact(db)) return false;
  const v2Tables = db.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'causal_%_v2' ORDER BY name",
  ).all() as Array<{ name: string }>;
  const acceptedTables = lineagePresent
    ? [...SLICE3_CAUSAL_V2_TABLES, 'causal_lineage_bindings_v2']
    : [...SLICE3_CAUSAL_V2_TABLES];
  if (JSON.stringify(v2Tables.map((row) => row.name)) !== JSON.stringify(acceptedTables.sort())) {
    return false;
  }
  const expected = expectedImmutabilityTriggers(acceptedTables);
  const triggers = db.prepare(
    "SELECT name, tbl_name, sql FROM sqlite_master WHERE type = 'trigger' ORDER BY name",
  ).all() as Array<{ name: string; tbl_name: string; sql: string | null }>;
  const relevant = triggers.filter((row) => expected.has(row.name) || acceptedTables.includes(row.tbl_name));
  if (relevant.length !== expected.size) return false;
  return relevant.every((row) => {
    const authority = expected.get(row.name);
    return authority !== undefined && authority.table === row.tbl_name
      && normalizeAuthoritySql(row.sql) === authority.sql;
  });
}

/**
 * A complete Slice 4 evidence generation created before the Store-owned clock
 * metadata was introduced is an authenticated additive predecessor.  Unlike a
 * partial Slice 4 database, every evidence table and its append-only authority
 * must already be exact; only the clock table may be absent.
 */
function exactPreClockCausalV2Schema(db: DatabaseSync): boolean {
  const clockPresent = db.prepare(
    "SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'causal_clock_state'",
  ).get() as { present: number } | undefined;
  if (clockPresent) return false;

  for (const table of CAUSAL_V2_EVIDENCE_TABLES) {
    const exists = db.prepare(
      "SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = ?",
    ).get(table) as { present: number } | undefined;
    const contract = CAUSAL_V2_TABLE_CONTRACTS[table];
    if (!exists || !contract || !tableContractMatches(db, table, contract)) return false;
  }

  const v2Tables = db.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'causal_%_v2' ORDER BY name",
  ).all() as Array<{ name: string }>;
  if (JSON.stringify(v2Tables.map((row) => row.name))
      !== JSON.stringify([...CAUSAL_V2_EVIDENCE_TABLES].sort())) return false;

  const expected = expectedImmutabilityTriggers();
  const triggers = db.prepare(
    "SELECT name, tbl_name, sql FROM sqlite_master WHERE type = 'trigger' ORDER BY name",
  ).all() as Array<{ name: string; tbl_name: string; sql: string | null }>;
  const relevant = triggers.filter((row) =>
    expected.has(row.name) || CAUSAL_V2_EVIDENCE_TABLES.includes(row.tbl_name),
  );
  if (relevant.length !== expected.size) return false;
  return relevant.every((row) => {
    const authority = expected.get(row.name);
    return authority !== undefined && authority.table === row.tbl_name
      && normalizeAuthoritySql(row.sql) === authority.sql;
  });
}

/**
 * A complete pre-T-069 Slice 4 database may have the Store-owned clock but no
 * lineage sidecar.  It is accepted only as the named predecessor for the
 * additive sidecar migration; its rows and authority are never repaired in
 * place by inference.
 */
function exactPreLineageCausalV2Schema(db: DatabaseSync): boolean {
  const clockPresent = db.prepare(
    "SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'causal_clock_state'",
  ).get() as { present: number } | undefined;
  if (!clockPresent || !tableContractMatches(db, 'causal_clock_state', CAUSAL_V2_TABLE_CONTRACTS.causal_clock_state!)) {
    return false;
  }
  if (!causalClockStateRowExact(db)) return false;

  for (const table of PRE_LINEAGE_CAUSAL_V2_EVIDENCE_TABLES) {
    const exists = db.prepare(
      "SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = ?",
    ).get(table) as { present: number } | undefined;
    const contract = CAUSAL_V2_TABLE_CONTRACTS[table];
    if (!exists || !contract || !tableContractMatches(db, table, contract)) return false;
  }
  const lineagePresent = db.prepare(
    "SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'causal_lineage_bindings_v2'",
  ).get() as { present: number } | undefined;
  if (lineagePresent) return false;

  const v2Tables = db.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'causal_%_v2' ORDER BY name",
  ).all() as Array<{ name: string }>;
  if (JSON.stringify(v2Tables.map((row) => row.name))
      !== JSON.stringify([...PRE_LINEAGE_CAUSAL_V2_EVIDENCE_TABLES].sort())) return false;

  const expected = expectedImmutabilityTriggers(PRE_LINEAGE_CAUSAL_V2_EVIDENCE_TABLES);
  const triggers = db.prepare(
    "SELECT name, tbl_name, sql FROM sqlite_master WHERE type = 'trigger' ORDER BY name",
  ).all() as Array<{ name: string; tbl_name: string; sql: string | null }>;
  const relevant = triggers.filter((row) =>
    expected.has(row.name) || PRE_LINEAGE_CAUSAL_V2_EVIDENCE_TABLES.includes(row.tbl_name as typeof PRE_LINEAGE_CAUSAL_V2_EVIDENCE_TABLES[number]),
  );
  if (relevant.length !== expected.size) return false;
  return relevant.every((row) => {
    const authority = expected.get(row.name);
    return authority !== undefined && authority.table === row.tbl_name
      && normalizeAuthoritySql(row.sql) === authority.sql;
  });
}

/** The pre-T-069 generation without the clock is also a valid predecessor. */
function exactPreClockPreLineageCausalV2Schema(db: DatabaseSync): boolean {
  const clockPresent = db.prepare(
    "SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'causal_clock_state'",
  ).get() as { present: number } | undefined;
  if (clockPresent) return false;

  for (const table of PRE_LINEAGE_CAUSAL_V2_EVIDENCE_TABLES) {
    const exists = db.prepare(
      "SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = ?",
    ).get(table) as { present: number } | undefined;
    const contract = CAUSAL_V2_TABLE_CONTRACTS[table];
    if (!exists || !contract || !tableContractMatches(db, table, contract)) return false;
  }
  const lineagePresent = db.prepare(
    "SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'causal_lineage_bindings_v2'",
  ).get() as { present: number } | undefined;
  if (lineagePresent) return false;

  const v2Tables = db.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'causal_%_v2' ORDER BY name",
  ).all() as Array<{ name: string }>;
  if (JSON.stringify(v2Tables.map((row) => row.name))
      !== JSON.stringify([...PRE_LINEAGE_CAUSAL_V2_EVIDENCE_TABLES].sort())) return false;

  const expected = expectedImmutabilityTriggers(PRE_LINEAGE_CAUSAL_V2_EVIDENCE_TABLES);
  const triggers = db.prepare(
    "SELECT name, tbl_name, sql FROM sqlite_master WHERE type = 'trigger' ORDER BY name",
  ).all() as Array<{ name: string; tbl_name: string; sql: string | null }>;
  const relevant = triggers.filter((row) =>
    expected.has(row.name) || PRE_LINEAGE_CAUSAL_V2_EVIDENCE_TABLES.includes(row.tbl_name as typeof PRE_LINEAGE_CAUSAL_V2_EVIDENCE_TABLES[number]),
  );
  if (relevant.length !== expected.size) return false;
  return relevant.every((row) => {
    const authority = expected.get(row.name);
    return authority !== undefined && authority.table === row.tbl_name
      && normalizeAuthoritySql(row.sql) === authority.sql;
  });
}

function causalClockStateRowExact(db: DatabaseSync): boolean {
  try {
    const rows = db.prepare(
      'SELECT clock_id, typeof(last_wall_ms) AS wall_type, CAST(last_wall_ms AS TEXT) AS wall_text ' +
      'FROM causal_clock_state ORDER BY rowid',
    ).all() as Array<{ clock_id: unknown; wall_type: unknown; wall_text: unknown }>;
    if (rows.length !== 1) return false;
    const row = rows[0]!;
    if (row.clock_id !== 'causal-v2' || row.wall_type !== 'integer' || typeof row.wall_text !== 'string'
        || !/^(?:0|[1-9][0-9]*)$/.test(row.wall_text)) return false;
    const value = BigInt(row.wall_text);
    return value <= BigInt(Number.MAX_SAFE_INTEGER);
  } catch {
    return false;
  }
}

/** Create the one Store-owned clock row only while a database is initialized. */
function initializeCausalClockState(db: DatabaseSync, predecessorState: CausalV2SchemaState): void {
  if (predecessorState !== 'absent'
      && predecessorState !== 'exact-s3'
      && predecessorState !== 'exact-pre-clock'
      && predecessorState !== 'exact-pre-clock-pre-lineage') return;
  const rows = db.prepare(
    'SELECT clock_id FROM causal_clock_state ORDER BY rowid',
  ).all() as Array<{ clock_id: unknown }>;
  if (rows.length === 0) {
    const nowMs = Date.now();
    db.prepare(
      "INSERT INTO causal_clock_state (clock_id, last_wall_ms) VALUES ('causal-v2', ?)",
    ).run(nowMs);
    return;
  }
  if (!causalClockStateRowExact(db)) {
    throw new Error('causal v2 schema validation failed: CAUSAL_V2_CLOCK_STATE_INVALID');
  }
}

function tableContractMatches(db: DatabaseSync, table: string, contract: CausalV2TableContract): boolean {
  const schemaRow = db.prepare(
    "SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = ? AND tbl_name = ?",
  ).get(table, table) as { sql: string | null } | undefined;
  if (!schemaRow || normalizeAuthoritySql(schemaRow.sql) !== normalizeAuthoritySql(contract.sql)) return false;

  const tableList = db.prepare('PRAGMA table_list(' + table + ')').all() as Array<{
    schema: string; name: string; type: string; ncol: number; wr: number; strict: number;
  }>;
  if (tableList.length !== 1) return false;
  const listed = tableList[0]!;
  if (listed.schema !== 'main' || listed.name !== table || listed.type !== 'table'
      || listed.ncol !== contract.columns.length || listed.wr !== 0 || listed.strict !== 0) return false;

  const expectedColumns = contract.columns.map((column, cid) => ({
    cid,
    name: column.name,
    type: column.type,
    notnull: column.notnull ?? 1,
    dflt_value: null,
    pk: column.pk,
  }));
  const tableInfo = db.prepare('PRAGMA table_info(' + table + ')').all() as Array<{
    cid: number; name: string; type: string; notnull: number; dflt_value: unknown; pk: number;
  }>;
  if (JSON.stringify(tableInfo) !== JSON.stringify(expectedColumns)) return false;
  const tableXinfo = db.prepare('PRAGMA table_xinfo(' + table + ')').all() as Array<{
    cid: number; name: string; type: string; notnull: number; dflt_value: unknown; pk: number; hidden: number;
  }>;
  const expectedXinfo = expectedColumns.map((column) => ({ ...column, hidden: 0 }));
  if (JSON.stringify(tableXinfo) !== JSON.stringify(expectedXinfo)) return false;

  const actualIndexes: CausalV2IndexContract[] = [];
  const indexList = db.prepare('PRAGMA index_list(' + table + ')').all() as Array<{
    name: string; unique: number; origin: string; partial: number;
  }>;
  for (const index of indexList) {
    if ((index.unique !== 0 && index.unique !== 1)
        || !['pk', 'u', 'c'].includes(index.origin)
        || index.partial !== 0) return false;
    // `index.name` is SQLite metadata, not a checked-in identifier. The bound
    // table-valued pragma keeps arbitrary valid names data rather than syntax.
    const xinfo = db.prepare(
      'SELECT seqno, cid, name, desc, coll, key FROM pragma_index_xinfo(?) ORDER BY seqno',
    ).all(index.name) as Array<{
      seqno: number; cid: number; name: string | null; desc: number; coll: string | null; key: number;
    }>;
    if (xinfo.some((entry) => entry.key !== 1 && entry.cid !== -1)) return false;
    const keyRows = xinfo.filter((entry) => entry.key === 1).sort((left, right) => left.seqno - right.seqno);
    if (keyRows.some((entry) => entry.cid < 0 || entry.name === null
        || entry.coll !== 'BINARY' || (entry.desc !== 0 && entry.desc !== 1))) return false;
    let explicit: { name: string; sql: string } | undefined;
    if (index.origin === 'c') {
      const schemaIndex = db.prepare(
        "SELECT sql FROM sqlite_schema WHERE type = 'index' AND name = ? AND tbl_name = ?",
      ).get(index.name, table) as { sql: string | null } | undefined;
      if (!schemaIndex || typeof schemaIndex.sql !== 'string') return false;
      explicit = { name: index.name, sql: schemaIndex.sql };
    }
    actualIndexes.push({
      origin: index.origin as 'pk' | 'u' | 'c',
      unique: index.unique as 0 | 1,
      columns: keyRows.map((entry) => ({
        cid: entry.cid,
        name: entry.name!,
        desc: entry.desc as 0 | 1,
      })),
      ...explicit,
    });
  }
  const semanticKey = (value: CausalV2IndexContract): string | null => {
    const shared = { origin: value.origin, unique: value.unique, columns: value.columns };
    if (value.origin !== 'c') return JSON.stringify(shared);
    const sql = normalizeAuthoritySql(value.sql);
    if (typeof value.name !== 'string' || sql === null) return null;
    return JSON.stringify({ ...shared, name: value.name, sql });
  };
  const actualKeys = actualIndexes.map(semanticKey);
  const expectedKeys = contract.indexes.map(semanticKey);
  if (actualKeys.some((value) => value === null) || expectedKeys.some((value) => value === null)) return false;
  return JSON.stringify((actualKeys as string[]).sort())
    === JSON.stringify((expectedKeys as string[]).sort());
}

/** Authenticate the complete v2 table/index/trigger authority. */
export function causalV2SchemaAttestation(db: DatabaseSync): CausalV2SchemaAttestation {
  const defectIds = new Set<string>();
  let presentTables = 0;
  for (const [table, contract] of Object.entries(CAUSAL_V2_TABLE_CONTRACTS)) {
    const present = db.prepare(
      "SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = ?",
    ).get(table) as { present: number } | undefined;
    if (!present) {
      defectIds.add('CAUSAL_V2_TABLE_MISSING');
      continue;
    }
    presentTables += 1;
    if (!tableContractMatches(db, table, contract)) {
      defectIds.add('CAUSAL_V2_TABLE_OR_INDEX_AUTHORITY_MISMATCH');
    }
    if (table === 'causal_clock_state' && !causalClockStateRowExact(db)) {
      defectIds.add('CAUSAL_V2_CLOCK_STATE_INVALID');
    }
  }

  // The contract is closed.  An unrelated table with a v2-looking name is a
  // hostile/extra generation, not a harmless extension to ignore.
  const expectedTableNames = new Set(CAUSAL_V2_TABLES);
  const extraTables = (db.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'causal_%_v2'",
  ).all() as Array<{ name: string }>).some((row) => !expectedTableNames.has(row.name));
  if (extraTables) defectIds.add('CAUSAL_V2_EXTRA_TABLE');

  const expectedTriggers = expectedImmutabilityTriggers();
  const triggerRows = db.prepare(
    "SELECT name, tbl_name, sql FROM sqlite_master WHERE type = 'trigger' ORDER BY name",
  ).all() as Array<{ name: string; tbl_name: string; sql: string | null }>;
  const relevantTriggers = triggerRows.filter((row) =>
    expectedTriggers.has(row.name) || CAUSAL_V2_EVIDENCE_TABLES.includes(row.tbl_name),
  );
  if (relevantTriggers.length !== expectedTriggers.size) {
    defectIds.add('CAUSAL_V2_TRIGGER_AUTHORITY_MISMATCH');
  } else {
    for (const row of relevantTriggers) {
      const expected = expectedTriggers.get(row.name);
      if (!expected || row.tbl_name !== expected.table
          || normalizeAuthoritySql(row.sql) !== expected.sql) {
        defectIds.add('CAUSAL_V2_TRIGGER_AUTHORITY_MISMATCH');
      }
    }
  }

  if (presentTables === 0 && relevantTriggers.length === 0 && !extraTables) {
    return { state: 'absent', defectIds: ['CAUSAL_V2_SCHEMA_ABSENT'] };
  }
  if (extraTables) defectIds.add('CAUSAL_V2_EXTRA_TABLE');
  if (exactPreClockCausalV2Schema(db)) {
    return { state: 'exact-pre-clock', defectIds: [] };
  }
  if (exactPreLineageCausalV2Schema(db)) {
    return { state: 'exact-pre-lineage', defectIds: [] };
  }
  if (exactPreClockPreLineageCausalV2Schema(db)) {
    return { state: 'exact-pre-clock-pre-lineage', defectIds: [] };
  }
  if (exactSlice3AssignmentSchema(db)) {
    return { state: 'exact-s3', defectIds: [] };
  }
  if (presentTables === CAUSAL_V2_TABLES.length && defectIds.size === 0) {
    return { state: 'exact', defectIds: [] };
  }
  if (presentTables > 0 && presentTables < CAUSAL_V2_TABLES.length) {
    defectIds.add('CAUSAL_V2_PARTIAL_SCHEMA');
  }
  return { state: 'incomplete', defectIds: [...defectIds].sort() };
}

export function causalV2SchemaComplete(db: DatabaseSync): boolean {
  return causalV2SchemaAttestation(db).state === 'exact';
}


/**
 * Open-time setup, in the order the store has always run it: journal + sync
 * PRAGMAs first, then the schema, then the guarded migrations. The sequence is
 * load-bearing — migrate() reads `PRAGMA table_info` for tables SCHEMA has just
 * guaranteed exist.
 */
export function initializeSchema(
  db: DatabaseSync,
  options: {
    expectedCausalV2State?: CausalV2SchemaState;
    migrationBackupVerified?: boolean;
    allowUnbackedCausalV2Create?: boolean;
  } = {},
): void {
  configureDatabaseConnection(db);
  runScript(db, 'PRAGMA journal_mode = WAL');
  runScript(db, 'PRAGMA synchronous = NORMAL');
  const preflightState = options.expectedCausalV2State ?? causalV2SchemaAttestation(db).state;
  db.prepare('BEGIN IMMEDIATE').run();
  try {
    const lockedState = causalV2SchemaAttestation(db).state;
    if (lockedState !== preflightState) {
      throw new Error('causal v2 schema validation failed: CAUSAL_V2_PREFLIGHT_STATE_DRIFT');
    }
    if (lockedState !== 'exact'
        && !options.migrationBackupVerified
        && !options.allowUnbackedCausalV2Create) {
      throw new Error('causal v2 schema validation failed: CAUSAL_V2_VERIFIED_BACKUP_REQUIRED');
    }
    if (lockedState === 'incomplete' && !exactSlice3AssignmentSchema(db)) {
      throw new Error('causal v2 schema validation failed: CAUSAL_V2_UNRECOGNIZED_PREDECESSOR');
    }
    validateAppendOnlyTriggerAuthority(db);
    runScript(db, SCHEMA);
    initializeEpistemicSchema(db);
    initializeEconomicSchema(db);
    migrate(db);
    installCausalImmutability(db);
    installBillingMappingImmutability(db);
    initializeCausalClockState(db, lockedState);
    const finalAttestation = causalV2SchemaAttestation(db);
    if (finalAttestation.state !== 'exact') {
      throw new Error(
        'causal v2 schema validation failed: ' +
        (finalAttestation.defectIds.join(',') || 'CAUSAL_V2_SCHEMA_INCOMPLETE'),
      );
    }
    const schemaVersion = readSchemaVersion(db);
    if (schemaVersion > CURRENT_SCHEMA_VERSION) {
      throw new Error(`schema version ${schemaVersion} is newer than supported version ${CURRENT_SCHEMA_VERSION}`);
    }
    if (schemaVersion < CURRENT_SCHEMA_VERSION) {
      db.prepare(`PRAGMA user_version = ${CURRENT_SCHEMA_VERSION}`).run();
    }
    db.prepare('COMMIT').run();
  } catch (error) {
    try {
      db.prepare('ROLLBACK').run();
    } catch {
      // Preserve the migration failure if SQLite already closed the transaction.
    }
    throw error;
  }
}
