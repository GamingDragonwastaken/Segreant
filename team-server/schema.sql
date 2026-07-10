-- AegisFlow team server — Postgres schema.
--
-- This database belongs entirely to the operator (the enterprise running this
-- server). AegisFlow never connects to it. Applied automatically and
-- idempotently on server startup (src/index.ts) via IF NOT EXISTS everywhere,
-- so re-running it against an already-initialized database is always safe.

-- One row per developer machine that has been explicitly registered by a team
-- admin (via POST /developers, gated by TEAM_SERVER_ADMIN_TOKEN). Registration
-- is deliberately NOT automatic on first push: a rollup's ed25519 signature
-- proves internal consistency, not who a keyId actually belongs to — without
-- this table pinning a specific public key to each keyId, anyone could
-- self-sign a fabricated rollup with a freshly generated keypair. See
-- src/team/rollup.ts's verifyRollup and its `trustedPublicKeyPem` option.
CREATE TABLE IF NOT EXISTS developers (
  key_id        TEXT PRIMARY KEY,
  public_key    TEXT NOT NULL,
  label         TEXT,
  registered_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- One row per accepted `aegisflow team push`. The full signed envelope is kept
-- in `body` (JSONB) as the tamper-evident source of truth; body_hash is the
-- same sha256 the signature covers, kept alongside for cheap integrity spot
-- checks without recomputing canonical() server-side.
CREATE TABLE IF NOT EXISTS rollups (
  id            BIGSERIAL PRIMARY KEY,
  key_id        TEXT NOT NULL REFERENCES developers(key_id),
  generated_at  TIMESTAMPTZ NOT NULL,
  period_from   TIMESTAMPTZ NOT NULL,
  period_to     TIMESTAMPTZ NOT NULL,
  body_hash     TEXT NOT NULL,
  body          JSONB NOT NULL,
  received_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS rollups_key_id_idx ON rollups (key_id);
CREATE INDEX IF NOT EXISTS rollups_period_idx ON rollups (period_from, period_to);

-- One row per project within a rollup — the same per-project breakdown
-- src/value/realization.ts's ProjectValue already computes locally, unpacked
-- here so aggregate dashboard queries (a later slice) can GROUP BY project
-- or developer in real SQL instead of unpacking `rollups.body` JSONB per query.
CREATE TABLE IF NOT EXISTS rollup_projects (
  id                     BIGSERIAL PRIMARY KEY,
  rollup_id              BIGINT NOT NULL REFERENCES rollups(id) ON DELETE CASCADE,
  project                TEXT NOT NULL,
  units                  INTEGER NOT NULL,
  cost_usd               DOUBLE PRECISION NOT NULL,
  realization_rate       DOUBLE PRECISION NOT NULL,
  realized_value_usd     DOUBLE PRECISION NOT NULL,
  net_realized_value_usd DOUBLE PRECISION NOT NULL,
  roi_index              DOUBLE PRECISION,
  sources                JSONB NOT NULL
);
CREATE INDEX IF NOT EXISTS rollup_projects_rollup_id_idx ON rollup_projects (rollup_id);
CREATE INDEX IF NOT EXISTS rollup_projects_project_idx ON rollup_projects (project);
