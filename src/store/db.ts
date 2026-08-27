/**
 * Local persistence — built on Node's bundled SQLite (node:sqlite).
 *
 * The store has no native module or external database service dependency. A
 * packaged distribution still has a build step; this module persists the local
 * ledger under ~/.fiscus. Provider forwarding and optional outbound paths are
 * governed by the declared Fiscus-process egress boundary elsewhere.
 *
 * Timestamps are stored twice: an ISO string for humans and an epoch-ms integer
 * for fast range/window queries. Day boundaries are computed in JS (local time)
 * and queried by epoch range, which sidesteps SQLite timezone surprises.
 */

import '../util/quiet.ts';
import { DatabaseSync } from 'node:sqlite';
import { causalV2SchemaAttestation, configureDatabaseConnection, initializeSchema, runScript } from './schema.ts';
import { dirname, resolve } from 'node:path';
import {
  closeSync,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
} from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { legacyPricingEvidence, type RequestPricingEvidence } from '../cost/pricing.ts';
import { pricingEvidenceFromRecord } from './rows.ts';
import type { ProviderScopeDeclaration, ScopeCaptureStatus } from '../billing/scope.ts';
import { ATTRIBUTION_BASES, type AttributionBasis } from '../value/characterization.ts';
import type { OpenAiCostsCaptureCoverage } from '../billing/openaiCostsCoverage.ts';
import type { ReconciliationCoverage, ReconciliationResult, ReconciliationRun } from '../billing/reconcile.ts';
import type { BillingMappingCoverage, BillingRecordMapping } from '../billing/mapping.ts';
import type { AllocationRule, CostCentre } from '../alloc/rules.ts';
import type { AllocationRunResult } from '../alloc/apply.ts';
import * as allocation from './allocation.ts';
import * as billing from './billing.ts';
import * as causal from './causal.ts';
import * as causalLineage from './causalLineage.ts';
import * as realization from './realization.ts';
import type {
  RealizationCostSync,
  RealizationUnitRecord,
  RepriceUpdate,
  RequestPriceEvent,
} from './realization.ts';
/** Realized-value record shapes now live in ./realization.ts; re-exported for callers. */
export type {
  CostScope,
  RealizationCostSync,
  RealizationUnitRecord,
  RepriceUpdate,
  RequestPriceEvent,
} from './realization.ts';
import type {
  BillingEvidenceRecord,
  BillingRecordMappingDeclarationInput,
  BillingRecordMappingDeclarationResult,
  BillingImportInput,
  BillingImportResult,
  BillingImportRun,
  BillingSummary,
  OpenAiCostsAdoptionPlan,
  OpenAiCostsObservationInput,
  OpenAiCostsObservationLine,
  OpenAiCostsObservationRun,
  OpenAiCostsObservationStatus,
} from './billing.ts';
import type {
  AnyCommittedCausalStudyProtocol,
  CausalAssignmentManifestV2,
  CausalAssignmentPlan,
  CausalAssignmentRequestV2,
  CausalAssignmentResultV2,
  CausalExecutionRecord,
  CausalOutcomeRecord,
  CommittedCausalStudyProtocol,
} from '../causal/types.ts';

/**
 * Provider-side evidence shapes now live in ./billing.ts. They are re-exported
 * from here because the store facade is where every caller imports them from,
 * and the split is meant to be invisible above this file.
 */
export type {
  BillingEvidenceRecord,
  BillingRecordMappingDeclarationInput,
  BillingRecordMappingDeclarationResult,
  BillingImportInput,
  BillingImportResult,
  BillingImportRun,
  BillingSummary,
  OpenAiCostsAdoptionPlan,
  OpenAiCostsObservationInput,
  OpenAiCostsObservationLine,
  OpenAiCostsObservationRun,
  OpenAiCostsObservationStatus,
} from './billing.ts';
export type { BillingMappingCoverage, BillingRecordMapping, ProviderScopeAuthority } from '../billing/mapping.ts';
export type {
  AnyCommittedCausalStudyProtocol,
  CausalAssignmentManifestV2,
  CausalAssignmentPlan,
  CausalAssignmentRequestV2,
  CausalAssignmentResultV2,
  CausalExecutionRecord,
  CausalOutcomeRecord,
  CausalStudyData,
  CausalStudyEstimate,
  CommittedCausalStudyProtocol,
} from '../causal/types.ts';
export type { CausalAnalysisSnapshot, CausalStudySummary } from './causal.ts';
export type {
  CausalLineageBindingLookupV2,
  CausalLineageBindingValidationV2,
  CausalLineageBindingV2,
} from './causalLineage.ts';

export interface RequestRow {
  requestId: string;
  sessionId: string | null;
  tsEpochMs: number;
  provider: string;
  model: string;
  /** The label exactly as recorded at metering time. Never rewritten by an alias. */
  project: string;
  /**
   * The project this row rolls up into once `project_aliases` is applied — the
   * same label `byProject` aggregates under. Equal to `project` when unaliased.
   *
   * Both are carried because they answer different questions: `project` is what
   * was actually recorded, `projectCanonical` is what it counts as. An export
   * that carried only the raw label would total differently from the dashboard
   * as soon as any alias existed; one that carried only the canonical would lose
   * the recorded evidence and could not survive the alias being removed.
   */
  projectCanonical?: string;
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
  user?: string | null; // developer/team attribution (x-fiscus-user header); null = unassigned
  source?: string | null; // connected tool/feed attribution (x-fiscus-source header); null = direct
  cwd?: string | null; // full working-directory path this request was made from; null = unknown. The
  // link that lets Fiscus find the git repo behind a project and auto-correlate
  // its spend into RoI with no --repo — the "no wiring" path. `project` is its basename.
  via?: 'proxy' | 'import'; // how the row entered the ledger: live proxy traffic
  // (blockable, marginal API cost) vs a native importer reading a tool's own logs
  // (sunk subscription cost, observed after the fact). Cap ENFORCEMENT keys on this.
  /** Evidence for the amount above. Missing only means a pre-lineage/legacy row. */
  pricing?: RequestPricingEvidence;
  /** Local route-scope provenance. Never a provider-account verification. */
  scopeCaptureStatus?: ScopeCaptureStatus;
  providerScopeDeclarationId?: string | null;
  /**
   * How `project` above was obtained. Never an identity verification — a declared
   * label is a self-assertion. Missing only means a pre-lineage/legacy row.
   */
  attributionBasis?: AttributionBasis;
}

/**
 * One immutable pricing-evidence cohort in the local request ledger. A cohort
 * never blends two cards, source kinds, or match paths: that would make a
 * later rate-card refresh look like it had priced an older request.
 */
export interface PricingEvidenceBucket {
  provider: string;
  model: string;
  costBasis: RequestPricingEvidence['costBasis'];
  rateCardSha256: string | null;
  rateCardSourceKind: RequestPricingEvidence['rateCardSourceKind'];
  rateMatchKind: RequestPricingEvidence['rateMatchKind'];
  rateMatchProvider: string | null;
  rateMatchModel: string | null;
  requests: number;
  costUsd: number;
  estimatedCostUsd: number;
  inputTokens: number;
  outputTokens: number;
}

/**
 * One attribution-evidence cohort: a project label paired with the basis it was
 * obtained by. A project that appears under two bases yields two rows — merging
 * them would hide that part of its cost is self-declared and part is unattributed,
 * which is the whole question this answers.
 */
export interface AttributionEvidenceBucket {
  /** The canonical project label, so this reconciles with `byProject`. */
  project: string;
  attributionBasis: AttributionBasis;
  requests: number;
  costUsd: number;
}

export interface SpendBucket {
  label: string;
  costUsd: number;
  requests: number;
  inputTokens: number;
  outputTokens: number;
}

/**
 * A window's spend characterized across the flat axes — the typed, one-call
 * breakdown the CLI and the HTTP API both render, so "by project / model / source
 * / user" means the same thing on every surface (see value/characterization.ts for
 * the axis vocabulary). Session is a finer per-thread drill-down with its own
 * shape (sessionUnits), not one of these uniform spend buckets.
 */
export interface Characterization {
  byProject: SpendBucket[];
  byModel: Array<SpendBucket & { provider: string }>;
  bySource: SpendBucket[];
  byUser: SpendBucket[];
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

/** A provider/model that has routed proxy traffic recently — dashboard connection status. */
export interface ProviderConnection {
  provider: string;
  model: string;
  lastSeenMs: number;
  requestCount: number;
}

export interface GateSignalRow {
  signalId: string;
  kind: string; // 'tested' | 'merged' | 'shipped' | 'incident'
  commitHash: string | null;
  project: string;
  tsEpochMs: number;
  verdict: string; // 'pass' | 'fail'
  detail: string | null;
  /** How the outcome entered the ledger; never silently collapse provenance. */
  evidenceSource?: 'manual' | 'local-command' | 'signed-ci';
}

/** A retained, verified external-evidence envelope plus the resulting gate signal. */
export interface VerifiedGateEvidenceInput {
  eventId: string;
  source: 'github-actions';
  evidenceClass: 'signed-ci';
  commitHash: string;
  repositoryId: string;
  policyId: string;
  bodyHash: string;
  signerKeyId: string;
  envelopeJson: string;
  verifiedAtMs: number;
  signal: Omit<GateSignalRow, 'signalId' | 'commitHash' | 'evidenceSource'>;
}

export type VerifiedGateEvidenceWrite = 'inserted' | 'duplicate' | 'conflict';

function requestRowFromRecord(record: Record<string, unknown>): RequestRow {
  const {
    costBasis,
    rateCardSha256,
    rateCardSourceKind,
    rateMatchKind,
    rateMatchProvider,
    rateMatchModel,
    ...row
  } = record;
  return {
    ...(row as unknown as RequestRow),
    estimated: Boolean(record.estimated),
    streamed: Boolean(record.streamed),
    pricing: pricingEvidenceFromRecord(record),
    scopeCaptureStatus: typeof record.scopeCaptureStatus === 'string'
      ? record.scopeCaptureStatus as ScopeCaptureStatus
      : 'legacy_unknown',
    // An unrecognized value reads as legacy_unknown rather than being passed
    // through: a label nobody can interpret must not look like a real basis.
    attributionBasis:
      typeof record.attributionBasis === 'string'
        && (ATTRIBUTION_BASES as readonly string[]).includes(record.attributionBasis)
        ? record.attributionBasis as AttributionBasis
        : 'legacy_unknown',
    providerScopeDeclarationId: typeof record.providerScopeDeclarationId === 'string'
      ? record.providerScopeDeclarationId
      : null,
  };
}

function scopeCaptureForInsert(row: RequestRow): { status: ScopeCaptureStatus; declarationId: string | null } {
  if (row.scopeCaptureStatus) {
    return { status: row.scopeCaptureStatus, declarationId: row.providerScopeDeclarationId ?? null };
  }
  // Native importer traffic cannot attest to the endpoint it originally used.
  // New proxy rows are deliberately not given an account identity by default.
  return { status: row.via === 'import' ? 'not_observed' : 'unscoped', declarationId: null };
}

export class Store {
  private db: DatabaseSync;
  private migrationBackupEvidence: { path: string; sha256: string } | null = null;

  constructor(path: string) {
    const databasePath = path === ':memory:' ? path : resolve(path);
    const existingFile = databasePath !== ':memory:' && existsSync(databasePath);
    if (databasePath !== ':memory:') {
      const dir = dirname(databasePath);
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    }
    this.db = new DatabaseSync(databasePath);
    let backupPath: string | null = null;
    let backupVerified = false;
    try {
      configureDatabaseConnection(this.db);
      this.db.prepare('PRAGMA busy_timeout = 5000').run();
      // node:sqlite's DatabaseSync exposes only prepare() + a multi-statement
      // runner; we run DDL/PRAGMA as individual prepared statements so the schema
      // setup stays uniform and side-effect-free. Preflight belongs inside this
      // guarded boundary because retained SQLite metadata is untrusted input.
      const causalV2Preflight = causalV2SchemaAttestation(this.db);
      if (existingFile) {
        if (causalV2Preflight.state !== 'exact') {
          backupPath = databasePath + '.pre-causal-v2-' + randomUUID() + '.sqlite';
          if (existsSync(backupPath)) throw new Error('exclusive causal migration backup path already exists');
          this.db.prepare('VACUUM INTO ?').run(backupPath);
          backupPath = realpathSync.native(backupPath);
          const pathBefore = lstatSync(backupPath);
          if (!pathBefore.isFile() || pathBefore.isSymbolicLink()) {
            throw new Error('causal migration backup is not a safe regular sibling file');
          }
          const descriptor = openSync(backupPath, 'r');
          try {
            const descriptorBefore = fstatSync(descriptor);
            const verification = new DatabaseSync(backupPath, { readOnly: true });
            try {
              configureDatabaseConnection(verification);
              const quickCheck = verification.prepare('PRAGMA quick_check').get() as { quick_check: string } | undefined;
              if (quickCheck?.quick_check !== 'ok') throw new Error('backup quick_check did not return ok');
            } finally {
              verification.close();
            }
            const bytes = readFileSync(descriptor);
            try {
              const descriptorAfter = fstatSync(descriptor);
              const pathAfter = lstatSync(backupPath);
              const stable = descriptorBefore.dev === descriptorAfter.dev
                && descriptorBefore.ino === descriptorAfter.ino
                && descriptorBefore.size === descriptorAfter.size
                && descriptorBefore.mtimeMs === descriptorAfter.mtimeMs
                && descriptorBefore.dev === pathAfter.dev
                && descriptorBefore.ino === pathAfter.ino
                && descriptorBefore.size === pathAfter.size
                && descriptorBefore.mtimeMs === pathAfter.mtimeMs
                && pathAfter.isFile()
                && !pathAfter.isSymbolicLink();
              if (!stable) throw new Error('causal migration backup identity changed during verification');
              this.migrationBackupEvidence = {
                path: backupPath,
                sha256: createHash('sha256').update(bytes).digest('hex'),
              };
            } finally {
              // A database backup can contain retained private assignment entropy.
              // Clear the owned JS copy even when identity verification fails.
              bytes.fill(0);
            }
          } finally {
            closeSync(descriptor);
          }
          backupVerified = true;
        }
      }
      initializeSchema(this.db, {
        expectedCausalV2State: causalV2Preflight.state,
        migrationBackupVerified: backupVerified,
        allowUnbackedCausalV2Create: !existingFile,
      });
    } catch {
      let closeConfirmed = true;
      try {
        this.db.close();
      } catch {
        closeConfirmed = false;
      }
      const closeGuidance = closeConfirmed
        ? 'The failed Store handle was closed. '
        : 'The failed Store handle could not be confirmed closed; stop using this database until operator recovery. ';
      if (backupVerified && backupPath) {
        throw new Error(
          'CAUSAL_IO_FAILURE: causal v2 migration failed before an operational Store opened; ' +
          'the retained database was not accepted. The verified backup remains readable at ' + backupPath + '. ' +
          closeGuidance + 'Inspect the retained database and verified backup before recovery.',
        );
      }
      if (existingFile) {
        const candidateGuidance = backupPath
          ? 'No verified backup was produced; an unverified backup candidate may exist at ' + backupPath + '. '
          : 'No verified backup was produced. ';
        throw new Error(
          'CAUSAL_IO_FAILURE: causal v2 schema initialization failed before an operational Store opened; ' +
          'the retained database was not accepted. ' + candidateGuidance + closeGuidance +
          'Inspect the retained database before recovery.',
        );
      }
      throw new Error(
        'CAUSAL_IO_FAILURE: causal v2 schema initialization failed before an operational Store opened; ' +
        'no retained database migration was performed. ' + closeGuidance +
        'Inspect the database path before retrying.',
      );
    }
  }

  /** Transaction control and one-off DDL — see runScript in schema.ts. */
  private runScript(sql: string): void {
    runScript(this.db, sql);
  }

  /**
   * The request/project reads the realization domain needs, bound to this store.
   *
   * Handed over rather than reimplemented: a re-attributed snapshot has to be
   * summed by exactly the aggregate that produced it, and the alias family it
   * scopes over has to be the same one `byProject` uses.
   */
  private realizationDeps(): realization.RealizationDeps {
    return {
      familyFilter: (column, project) => this.familyFilter(column, project),
      canonicalProject: (name) => this.canonicalProject(name),
      summary: (startMs, endMs, project) => this.summary(startMs, endMs, project),
      byModel: (startMs, endMs, project) => this.byModel(startMs, endMs, project),
    };
  }

  close(): void {
    this.db.close();
  }

  raw(): DatabaseSync {
    return this.db;
  }

  /** Evidence for the backup created immediately before this open migrated v2 tables. */
  causalMigrationBackupEvidence(): { path: string; sha256: string } | null {
    return this.migrationBackupEvidence ? { ...this.migrationBackupEvidence } : null;
  }

  /**
   * Persist the last system-scan result for a given set of roots, so a later scan
   * of the SAME roots can report what changed (the re-scan diff). Keyed by the roots
   * string: scanning your home and scanning one subfolder keep independent history.
   * This is scan bookkeeping only — it stores directory paths + tool ids, never any
   * spend, prompt, or code.
   */
  saveScanSnapshot(rootsKey: string, repos: string[], toolIds: string[], atMs: number): void {
    this.db
      .prepare(
        `INSERT INTO scan_snapshots (roots_key, repos_json, tools_json, at_ms)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(roots_key) DO UPDATE SET
           repos_json = excluded.repos_json,
           tools_json = excluded.tools_json,
           at_ms      = excluded.at_ms`,
      )
      .run(rootsKey, JSON.stringify(repos), JSON.stringify(toolIds), atMs);
  }

  /** The last scan of these roots, or null if this set of roots has never been scanned. */
  loadScanSnapshot(rootsKey: string): { repos: string[]; toolIds: string[]; atMs: number } | null {
    const row = this.db
      .prepare(`SELECT repos_json, tools_json, at_ms FROM scan_snapshots WHERE roots_key = ?`)
      .get(rootsKey) as { repos_json: string; tools_json: string; at_ms: number } | undefined;
    if (!row) return null;
    try {
      return { repos: JSON.parse(row.repos_json), toolIds: JSON.parse(row.tools_json), atMs: row.at_ms };
    } catch (err) {
      // Treated as "never scanned" (never thrown — this is bookkeeping, not the ledger),
      // but logged so a corrupt row doesn't silently erase scan history without a trace.
      console.error(`  scan snapshot for "${rootsKey}" is corrupt, treating as missing: ${String(err)}`);
      return null;
    }
  }

  /**
   * Earliest recorded request across the whole ledger, or null if nothing has
   * ever been metered. The personal Lift-baseline miner uses this as the
   * "before AI tracking began" cutoff: commits older than this are the honest
   * personal-history evidence (see value/liftBaseline.ts). Bookkeeping only —
   * one MIN() over an indexed column, never a project-scoped ledger read.
   */
  earliestRequestMs(): number | null {
    const row = this.db.prepare(`SELECT MIN(ts_epoch_ms) AS m FROM requests`).get() as { m: number | null };
    return row.m ?? null;
  }

  /**
   * Persist the computed personal Lift-baseline buckets for a project, so the
   * (relatively expensive) git-history mining runs once and is reused rather
   * than recomputed on every `roi`/dashboard read. Caller owns the JSON shape
   * (PersonalBaselineBucket[]) — this is storage only, exactly like
   * saveRealizationUnits/realizationUnitRows keep the typed shape in value/.
   */
  saveLiftBaseline(project: string, bucketsJson: string, atMs: number): void {
    project = this.canonicalProject(project); // merged projects share one baseline
    this.db
      .prepare(
        `INSERT INTO lift_baselines (project, buckets_json, at_ms)
         VALUES (?, ?, ?)
         ON CONFLICT(project) DO UPDATE SET
           buckets_json = excluded.buckets_json,
           at_ms        = excluded.at_ms`,
      )
      .run(project, bucketsJson, atMs);
  }

  /** The last computed personal Lift-baseline for a project, or null if never computed. */
  loadLiftBaseline(project: string): { bucketsJson: string; atMs: number } | null {
    const row = this.db
      .prepare(`SELECT buckets_json, at_ms FROM lift_baselines WHERE project = ?`)
      .get(this.canonicalProject(project)) as
      | { buckets_json: string; at_ms: number }
      | undefined;
    return row ? { bucketsJson: row.buckets_json, atMs: row.at_ms } : null;
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

  /** One session's recorded metadata — the judge uses `tool` to know whether an
   * on-disk transcript can exist for it (claude-code names files by session id). */
  getSessionMeta(sessionId: string): { project: string; tool: string; startMs: number } | null {
    const row = this.db
      .prepare(`SELECT project, tool, start_ms FROM sessions WHERE session_id = ?`)
      .get(sessionId) as { project: string; tool: string; start_ms: number } | undefined;
    return row ? { project: row.project, tool: row.tool, startMs: row.start_ms } : null;
  }

  /**
   * Real sessions with request activity in a window, newest-activity first —
   * what `fiscus judge` enumerates so it judges sessions that actually happened
   * (aliases folded into the project family, same as every other project read).
   * `tool` comes from the sessions table when the session was upserted by an
   * importer/proxy, else 'unknown' — never guessed from the request rows.
   */
  sessionsInWindow(
    project: string,
    startMs: number,
    endMs: number,
  ): Array<{ sessionId: string; tool: string; requestCount: number; lastMs: number; costUsd: number }> {
    const fam = this.familyFilter('r.project', project);
    const rows = this.db
      .prepare(
        `SELECT r.session_id AS sessionId,
                COALESCE(s.tool, 'unknown') AS tool,
                COUNT(*) AS requestCount,
                MAX(r.ts_epoch_ms) AS lastMs,
                SUM(r.cost_usd) AS costUsd
           FROM requests r
           LEFT JOIN sessions s ON s.session_id = r.session_id
          WHERE r.session_id IS NOT NULL
            AND r.ts_epoch_ms >= ? AND r.ts_epoch_ms < ?
            AND ${fam.sql}
          GROUP BY r.session_id
          ORDER BY lastMs DESC`,
      )
      .all(startMs, endMs, ...fam.args) as Array<{
      sessionId: string;
      tool: string;
      requestCount: number;
      lastMs: number;
      costUsd: number;
    }>;
    return rows;
  }

  insertRequest(r: RequestRow): void {
    const pricing = r.pricing ?? legacyPricingEvidence();
    const scope = scopeCaptureForInsert(r);
    this.db
      .prepare(
        `INSERT INTO requests (
            request_id, session_id, ts_iso, ts_epoch_ms, provider, model, project,
            task_weight, input_tokens, output_tokens, cache_write_tokens, cache_read_tokens,
            reasoning_tokens, cost_usd, estimated, streamed, status_code, duration_ms, user, source, cwd, via,
            cost_basis, rate_card_sha256, rate_card_source_kind, rate_match_kind, rate_match_provider, rate_match_model,
            scope_capture_status, provider_scope_declaration_id, attribution_basis
         ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
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
        r.cwd ?? null,
        r.via ?? 'proxy',
        pricing.costBasis,
        pricing.rateCardSha256,
        pricing.rateCardSourceKind,
        pricing.rateMatchKind,
        pricing.rateMatchProvider,
        pricing.rateMatchModel,
        scope.status,
        scope.declarationId,
        r.attributionBasis ?? 'legacy_unknown',
      );
  }

  /**
   * Idempotent insert for imported feeds (local transcripts, billing exports):
   * request_id is the natural key, so re-importing the same period is a no-op.
   * Returns true when the row was actually new.
   */
  insertRequestIfNew(r: RequestRow): boolean {
    const pricing = r.pricing ?? legacyPricingEvidence();
    const scope = scopeCaptureForInsert(r);
    const info = this.db
      .prepare(
        `INSERT INTO requests (
            request_id, session_id, ts_iso, ts_epoch_ms, provider, model, project,
            task_weight, input_tokens, output_tokens, cache_write_tokens, cache_read_tokens,
            reasoning_tokens, cost_usd, estimated, streamed, status_code, duration_ms, user, source, cwd, via,
            cost_basis, rate_card_sha256, rate_card_source_kind, rate_match_kind, rate_match_provider, rate_match_model,
            scope_capture_status, provider_scope_declaration_id, attribution_basis
         ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT(request_id) DO NOTHING`,
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
        r.cwd ?? null,
        r.via ?? 'proxy',
        pricing.costBasis,
        pricing.rateCardSha256,
        pricing.rateCardSourceKind,
        pricing.rateMatchKind,
        pricing.rateMatchProvider,
        pricing.rateMatchModel,
        scope.status,
        scope.declarationId,
        r.attributionBasis ?? 'legacy_unknown',
      );
    return Number(info.changes ?? 0) > 0;
  }

  // `liveOnly` restricts a spend reading to rows that arrived through the proxy —
  // the traffic a cap can actually BLOCK. Imported subscription spend is sunk cost
  // observed after the fact; counting it toward enforcement froze live traffic in
  // dogfooding. Legacy NULL via reads as proxy (the conservative direction).
  private viaClause(liveOnly: boolean): string {
    return liveOnly ? ` AND COALESCE(via,'proxy') = 'proxy'` : '';
  }

  /** Total USD spend across [startMs, endMs). */
  spendBetween(startMs: number, endMs: number, liveOnly = false): number {
    const row = this.db
      .prepare(
        `SELECT COALESCE(SUM(cost_usd), 0) AS total FROM requests WHERE ts_epoch_ms >= ? AND ts_epoch_ms < ?` +
          this.viaClause(liveOnly),
      )
      .get(startMs, endMs) as { total: number };
    return row.total;
  }

  spendForSession(sessionId: string, liveOnly = false): number {
    const row = this.db
      .prepare(`SELECT COALESCE(SUM(cost_usd), 0) AS total FROM requests WHERE session_id = ?` + this.viaClause(liveOnly))
      .get(sessionId) as { total: number };
    return row.total;
  }

  /** Spend within the last windowMs — used for runaway-loop detection. */
  spendInWindow(nowMs: number, windowMs: number, liveOnly = false): { costUsd: number; requests: number } {
    const row = this.db
      .prepare(
        `SELECT COALESCE(SUM(cost_usd),0) AS total, COUNT(*) AS n
         FROM requests WHERE ts_epoch_ms >= ?` + this.viaClause(liveOnly),
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

  /**
   * Local rate-card lineage grouped strictly by the evidence captured when each
   * request was priced. This is not provider billing and intentionally does not
   * call the current pricing table: rows retain their historical evidence.
   */
  pricingEvidenceByModel(startMs: number, endMs: number): PricingEvidenceBucket[] {
    return this.db
      .prepare(
        `SELECT provider, model,
                cost_basis AS costBasis, rate_card_sha256 AS rateCardSha256,
                rate_card_source_kind AS rateCardSourceKind, rate_match_kind AS rateMatchKind,
                rate_match_provider AS rateMatchProvider, rate_match_model AS rateMatchModel,
                COUNT(*) AS requests, COALESCE(SUM(cost_usd),0) AS costUsd,
                COALESCE(SUM(CASE WHEN estimated = 1 THEN cost_usd ELSE 0 END),0) AS estimatedCostUsd,
                COALESCE(SUM(input_tokens),0) AS inputTokens, COALESCE(SUM(output_tokens),0) AS outputTokens
         FROM requests WHERE ts_epoch_ms >= ? AND ts_epoch_ms < ?
         GROUP BY provider, model, cost_basis, rate_card_sha256, rate_card_source_kind,
                  rate_match_kind, rate_match_provider, rate_match_model
         ORDER BY costUsd DESC, requests DESC`,
      )
      .all(startMs, endMs) as unknown as PricingEvidenceBucket[];
  }

  /**
   * Spend grouped by project AND the basis its label was obtained by.
   *
   * Grouped on the alias-canonical label so the totals reconcile with `byProject`
   * exactly. This reads the ledger only: it never re-derives an attribution, and
   * a `legacy_unknown` row stays unknown rather than being inferred after the fact.
   */
  attributionEvidenceByProject(startMs: number, endMs: number): AttributionEvidenceBucket[] {
    return this.db
      .prepare(
        `SELECT COALESCE(a.canonical, r.project) AS project,
                r.attribution_basis AS attributionBasis,
                COUNT(*) AS requests, COALESCE(SUM(r.cost_usd),0) AS costUsd
         FROM requests r LEFT JOIN project_aliases a ON a.alias = r.project
         WHERE r.ts_epoch_ms >= ? AND r.ts_epoch_ms < ?
         -- Group by the EXPRESSION, not the output alias: a bare \`project\` here
         -- binds to the raw \`requests.project\` column instead, which silently
         -- leaves aliased labels unmerged and disagreeing with byProject.
         GROUP BY COALESCE(a.canonical, r.project), r.attribution_basis
         ORDER BY costUsd DESC, requests DESC`,
      )
      .all(startMs, endMs) as unknown as AttributionEvidenceBucket[];
  }

  /**
   * Total spend over [startMs, endMs), optionally scoped to one project key. The
   * project filter is what makes attribution project-aware: a commit's window can
   * absorb only ITS project's spend instead of every project's concurrent traffic
   * (see git/correlate.ts). Omit `project` for the project-blind total (the default,
   * unchanged for every existing caller).
   */
  summary(startMs: number, endMs: number, project?: string): SpendBucket {
    // A project filter matches the whole alias family, so merged labels stay merged.
    const fam = project !== undefined ? this.familyFilter('project', project) : null;
    const args: Array<number | string> = fam ? [startMs, endMs, ...fam.args] : [startMs, endMs];
    const row = this.db
      .prepare(
        `SELECT COALESCE(SUM(cost_usd),0) AS cost, COUNT(*) AS n,
                COALESCE(SUM(input_tokens),0) AS inp, COALESCE(SUM(output_tokens),0) AS outp
         FROM requests WHERE ts_epoch_ms >= ? AND ts_epoch_ms < ?` +
          (fam ? ` AND ${fam.sql}` : ``),
      )
      .get(...args) as { cost: number; n: number; inp: number; outp: number };
    return { label: project ?? 'range', costUsd: row.cost, requests: row.n, inputTokens: row.inp, outputTokens: row.outp };
  }

  /**
   * Does the ledger hold ANY spend tagged with this exact project key? It separates
   * data that IS characterized by project (native imports, or proxy traffic tagged
   * with x-fiscus-project) from untagged 'default' proxy traffic. Attribution uses it
   * to decide whether scoping a commit's window to its project is meaningful — so a
   * project-blind store keeps its original window-wide behavior, no regression.
   */
  hasProjectSpend(project: string): boolean {
    const fam = this.familyFilter('project', project);
    const row = this.db.prepare(`SELECT 1 AS present FROM requests WHERE ${fam.sql} LIMIT 1`).get(...fam.args) as
      | { present: number }
      | undefined;
    return row !== undefined;
  }

  // ---- Project aliasing ------------------------------------------------------
  // Tool launch cwds fragment one real project across labels ("fiscus" vs
  // "fiscus-ts", editor-named dirs, etc.). Aliases fix the LABELS at query
  // time; raw ledger rows are never rewritten, so the underlying record stays
  // honest and an alias can be removed without loss. The mapping is kept FLAT
  // (an alias always points at a real canonical, never at another alias).

  /** Map `alias` → `canonical`. Flattens transitively and re-points anything aliased to `alias`. */
  setProjectAlias(alias: string, canonical: string): void {
    const target = this.canonicalProject(canonical); // flatten: never chain alias→alias
    if (alias === target) throw new Error(`"${alias}" cannot alias itself`);
    this.db
      .prepare(
        `INSERT INTO project_aliases (alias, canonical, at_ms) VALUES (?,?,?)
         ON CONFLICT(alias) DO UPDATE SET canonical=excluded.canonical, at_ms=excluded.at_ms`,
      )
      .run(alias, target, Date.now());
    // Anything previously merged INTO `alias` follows it to the new canonical.
    this.db.prepare(`UPDATE project_aliases SET canonical = ? WHERE canonical = ?`).run(target, alias);
  }

  removeProjectAlias(alias: string): boolean {
    const info = this.db.prepare(`DELETE FROM project_aliases WHERE alias = ?`).run(alias);
    return Number(info.changes) > 0;
  }

  listProjectAliases(): Array<{ alias: string; canonical: string }> {
    return this.db
      .prepare(`SELECT alias, canonical FROM project_aliases ORDER BY canonical, alias`)
      .all() as Array<{ alias: string; canonical: string }>;
  }

  /** The canonical label for a project name (itself when unaliased). */
  canonicalProject(name: string): string {
    const row = this.db.prepare(`SELECT canonical FROM project_aliases WHERE alias = ?`).get(name) as
      | { canonical: string }
      | undefined;
    return row ? row.canonical : name;
  }

  /** Every raw label that resolves to this project: [canonical, ...its aliases]. */
  projectFamily(name: string): string[] {
    const canonical = this.canonicalProject(name);
    const rows = this.db.prepare(`SELECT alias FROM project_aliases WHERE canonical = ?`).all(canonical) as Array<{
      alias: string;
    }>;
    return [canonical, ...rows.map((r) => r.alias)];
  }

  /** SQL fragment + args matching a column against a project's whole family. */
  private familyFilter(column: string, project: string): { sql: string; args: string[] } {
    const family = this.projectFamily(project);
    return { sql: `${column} IN (${family.map(() => '?').join(',')})`, args: family };
  }

  /** One typed breakdown across the flat characterization axes (project/model/source/user). */
  characterization(startMs: number, endMs: number): Characterization {
    return {
      byProject: this.byProject(startMs, endMs),
      byModel: this.byModel(startMs, endMs),
      bySource: this.bySource(startMs, endMs),
      byUser: this.byUser(startMs, endMs),
    };
  }

  /**
   * The interconnectedness map: for each project the ledger has a working directory
   * for, its REPRESENTATIVE cwd (the path most requests came from — a project's dir
   * is stable, so the mode is robust to the odd one-off subdir), the TOOLS (sources)
   * that produced its spend, and its cost/requests. This is what lets Fiscus find
   * the git repo behind a project AND say which AI tool coded it — repo↔project↔tool,
   * the thing that makes native per-project RoI possible with no --repo and no wiring.
   * Only rows carrying a cwd participate (imports set it; untagged proxy traffic is
   * excluded rather than guessed).
   */
  projectPaths(): Array<{ project: string; cwd: string; sources: string[]; costUsd: number; requests: number }> {
    const cwdRows = this.db
      .prepare(
        `SELECT COALESCE(a.canonical, r.project) AS project, r.cwd, COUNT(*) AS n, COALESCE(SUM(r.cost_usd),0) AS cost
         FROM requests r LEFT JOIN project_aliases a ON a.alias = r.project
         WHERE r.cwd IS NOT NULL AND r.cwd <> ''
         GROUP BY project, r.cwd`,
      )
      .all() as Array<{ project: string; cwd: string; n: number; cost: number }>;
    const srcRows = this.db
      .prepare(
        `SELECT DISTINCT COALESCE(a.canonical, r.project) AS project, COALESCE(r.source, 'direct') AS source
         FROM requests r LEFT JOIN project_aliases a ON a.alias = r.project
         WHERE r.cwd IS NOT NULL AND r.cwd <> ''`,
      )
      .all() as Array<{ project: string; source: string }>;

    // Pick each project's modal cwd (highest request count) and total its spend.
    const byProject = new Map<string, { cwd: string; bestN: number; costUsd: number; requests: number }>();
    for (const r of cwdRows) {
      const cur = byProject.get(r.project);
      if (!cur) {
        byProject.set(r.project, { cwd: r.cwd, bestN: r.n, costUsd: r.cost, requests: r.n });
      } else {
        cur.costUsd += r.cost;
        cur.requests += r.n;
        if (r.n > cur.bestN) {
          cur.cwd = r.cwd;
          cur.bestN = r.n;
        }
      }
    }
    const srcByProject = new Map<string, Set<string>>();
    for (const s of srcRows) {
      let set = srcByProject.get(s.project);
      if (!set) srcByProject.set(s.project, (set = new Set<string>()));
      set.add(s.source);
    }
    return [...byProject.entries()]
      .map(([project, v]) => ({
        project,
        cwd: v.cwd,
        sources: [...(srcByProject.get(project) ?? [])].sort(),
        costUsd: v.costUsd,
        requests: v.requests,
      }))
      .sort((a, b) => b.costUsd - a.costUsd);
  }

  /**
   * Spend per model over [startMs, endMs), optionally scoped to one project key.
   *
   * The `project` filter mirrors `summary()` exactly — same alias family expansion —
   * because the two are read together when a work unit's cost is attributed to a
   * model. Without it the dollars could be project-scoped while the model label was
   * taken from another project's concurrent traffic, which silently mislabels whose
   * model spent the money. Omit `project` for the project-blind total (the default,
   * unchanged for every existing caller).
   */
  byModel(
    startMs: number,
    endMs: number,
    project?: string,
  ): Array<SpendBucket & { provider: string; cacheReadTokens: number; cacheWriteTokens: number }> {
    // Cache columns surface the cache economics (reads are ~10x cheaper than
    // fresh input; writes carry a premium) that plain in/out totals hide.
    const fam = project !== undefined ? this.familyFilter('project', project) : null;
    const args: Array<number | string> = fam ? [startMs, endMs, ...fam.args] : [startMs, endMs];
    const rows = this.db
      .prepare(
        `SELECT provider, model AS label,
                COALESCE(SUM(cost_usd),0) AS costUsd, COUNT(*) AS requests,
                COALESCE(SUM(input_tokens),0) AS inputTokens, COALESCE(SUM(output_tokens),0) AS outputTokens,
                COALESCE(SUM(cache_read_tokens),0) AS cacheReadTokens, COALESCE(SUM(cache_write_tokens),0) AS cacheWriteTokens
         FROM requests WHERE ts_epoch_ms >= ? AND ts_epoch_ms < ?` +
          (fam ? ` AND ${fam.sql}` : ``) +
          ` GROUP BY provider, model ORDER BY costUsd DESC`,
      )
      .all(...args) as unknown as Array<
      SpendBucket & { provider: string; cacheReadTokens: number; cacheWriteTokens: number }
    >;
    return rows;
  }

  /**
   * The pricing lineage behind ONE model's spend in a window: which cost bases
   * priced it, and which rate-card revisions produced those amounts.
   *
   * Model-vs-model comparison is a claim about price, so it can only mean
   * something if both sides' dollars came from the same kind of price. A cell
   * pooling `local_list_price` rows with `fallback_estimate` guesses, or spanning
   * a rate-card refresh, is comparing eras and methods as much as models. Returns
   * distinct sorted values so the caller can collapse them to "one" or "mixed"
   * without re-deriving the rule.
   */
  modelPricingBasis(
    startMs: number,
    endMs: number,
    model: string,
    project?: string,
  ): { costBases: string[]; rateCardShas: string[] } {
    const fam = project !== undefined ? this.familyFilter('project', project) : null;
    const args: Array<number | string> = fam ? [startMs, endMs, model, ...fam.args] : [startMs, endMs, model];
    const rows = this.db
      .prepare(
        `SELECT DISTINCT cost_basis AS costBasis, rate_card_sha256 AS rateCardSha256
         FROM requests
         WHERE ts_epoch_ms >= ? AND ts_epoch_ms < ? AND model = ?` + (fam ? ` AND ${fam.sql}` : ``),
      )
      .all(...args) as Array<{ costBasis: string; rateCardSha256: string | null }>;
    const bases = new Set<string>();
    const cards = new Set<string>();
    for (const r of rows) {
      bases.add(r.costBasis);
      // A null card is not a distinct revision — plenty of bases (tool-reported,
      // unpriced) legitimately have none. Only real revisions count as a span.
      if (r.rateCardSha256) cards.add(r.rateCardSha256);
    }
    return { costBases: [...bases].sort(), rateCardShas: [...cards].sort() };
  }

  byProject(startMs: number, endMs: number): SpendBucket[] {
    // Aliased labels roll up into their canonical project at read time.
    return this.db
      .prepare(
        `SELECT COALESCE(a.canonical, r.project) AS label,
                COALESCE(SUM(r.cost_usd),0) AS costUsd, COUNT(*) AS requests,
                COALESCE(SUM(r.input_tokens),0) AS inputTokens, COALESCE(SUM(r.output_tokens),0) AS outputTokens
         FROM requests r LEFT JOIN project_aliases a ON a.alias = r.project
         WHERE r.ts_epoch_ms >= ? AND r.ts_epoch_ms < ?
         GROUP BY label ORDER BY costUsd DESC`,
      )
      .all(startMs, endMs) as unknown as SpendBucket[];
  }

  /** Spend grouped by developer/team (x-fiscus-user); null is reported as 'unassigned'. */
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
   * Spend grouped by connected source/feed (x-fiscus-source); null reads as
   * 'direct'. A source is one AI tool deliberately routed through Fiscus — the
   * unit the product meters. The tag is set by `fiscus connect <tool>` and
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
      // `realizationProjects()` returns alias-CANONICAL labels, so the request
      // side must be canonicalized too. Comparing a raw label against that set
      // makes an aliased project silently fail to match, and the source loses
      // its RoI depth badge even though its work did realize.
      const srcProj = this.db
        .prepare(
          `SELECT DISTINCT COALESCE(r.source, 'direct') AS label,
                  COALESCE(a.canonical, r.project) AS project
           FROM requests r LEFT JOIN project_aliases a ON a.alias = r.project
           WHERE r.ts_epoch_ms >= ? AND r.ts_epoch_ms < ?`,
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
   * The model mix WITHIN each source — which models a given tool is spending on
   * (Source→Model). Flat rows, cost-descending; the caller groups by `source`.
   * null source reads as 'direct', matching bySource.
   */
  sourceModelBreakdown(
    startMs: number,
    endMs: number,
  ): Array<{ source: string; provider: string; model: string; costUsd: number; requests: number }> {
    return this.db
      .prepare(
        `SELECT COALESCE(source, 'direct') AS source, provider, model,
                COALESCE(SUM(cost_usd),0) AS costUsd, COUNT(*) AS requests
         FROM requests WHERE ts_epoch_ms >= ? AND ts_epoch_ms < ?
         GROUP BY COALESCE(source, 'direct'), provider, model
         ORDER BY costUsd DESC`,
      )
      .all(startMs, endMs) as unknown as Array<{ source: string; provider: string; model: string; costUsd: number; requests: number }>;
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
  series(
    startMs: number,
    endMs: number,
    bucketMs: number,
    liveOnly = false,
  ): Array<{ bucketMs: number; costUsd: number; requests: number }> {
    const rows = this.db
      .prepare(
        `SELECT CAST(ts_epoch_ms / ? AS INTEGER) * ? AS bucketMs, COALESCE(SUM(cost_usd),0) AS costUsd, COUNT(*) AS requests
         FROM requests WHERE ts_epoch_ms >= ? AND ts_epoch_ms < ?` + this.viaClause(liveOnly) + `
         GROUP BY bucketMs ORDER BY bucketMs ASC`,
      )
      .all(bucketMs, bucketMs, startMs, endMs) as Array<{ bucketMs: number; costUsd: number; requests: number }>;
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
                estimated, streamed, status_code AS statusCode, duration_ms AS durationMs, user, source, cwd, via,
                cost_basis AS costBasis, rate_card_sha256 AS rateCardSha256,
                rate_card_source_kind AS rateCardSourceKind, rate_match_kind AS rateMatchKind,
                rate_match_provider AS rateMatchProvider, rate_match_model AS rateMatchModel,
                scope_capture_status AS scopeCaptureStatus,
                provider_scope_declaration_id AS providerScopeDeclarationId,
                attribution_basis AS attributionBasis
         FROM requests ORDER BY ts_epoch_ms DESC LIMIT ?`,
      )
      .all(limit) as Array<Record<string, unknown>>;
    return rows.map(requestRowFromRecord);
  }

  /** Every metered request in [startMs, endMs), oldest first — for data export. */
  requestsInRange(startMs: number, endMs: number): RequestRow[] {
    // Carry the alias-canonical label alongside the raw one so an export totals
    // the same way `byProject` does without rewriting the recorded row.
    const rows = this.db
      .prepare(
        `SELECT request_id AS requestId, session_id AS sessionId, ts_epoch_ms AS tsEpochMs,
                provider, model, r.project AS project,
                COALESCE(a.canonical, r.project) AS projectCanonical, task_weight AS taskWeight,
                input_tokens AS inputTokens, output_tokens AS outputTokens,
                cache_write_tokens AS cacheWriteTokens, cache_read_tokens AS cacheReadTokens,
                reasoning_tokens AS reasoningTokens, cost_usd AS costUsd,
                estimated, streamed, status_code AS statusCode, duration_ms AS durationMs, user, source, cwd, via,
                cost_basis AS costBasis, rate_card_sha256 AS rateCardSha256,
                rate_card_source_kind AS rateCardSourceKind, rate_match_kind AS rateMatchKind,
                rate_match_provider AS rateMatchProvider, rate_match_model AS rateMatchModel,
                scope_capture_status AS scopeCaptureStatus,
                provider_scope_declaration_id AS providerScopeDeclarationId,
                attribution_basis AS attributionBasis
         FROM requests r LEFT JOIN project_aliases a ON a.alias = r.project
         WHERE ts_epoch_ms >= ? AND ts_epoch_ms < ? ORDER BY ts_epoch_ms ASC`,
      )
      .all(startMs, endMs) as Array<Record<string, unknown>>;
    return rows.map(requestRowFromRecord);
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

  /**
   * Record what one commit's window absorbed, as observed at compute time.
   *
   * `commit_attribution` has no reader today — it is a written audit trail, not a
   * serving surface, and it is deliberately NOT re-attributed by a reprice: the
   * row states what the window cost when it was computed, and the reprice audit
   * (`request_price_events`) states what changed since. The realized-value
   * snapshots in `realization_units`, which ARE served, carry a `cost_scope` and
   * are resynced instead. If this table ever gains a reader, it needs the same
   * scope column first — otherwise it would serve pre-reprice dollars with
   * nothing marking them.
   */
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
    const fam = this.familyFilter('project', project);
    const rows = this.db
      .prepare(
        `SELECT proposal_id AS proposalId, request_id AS requestId, session_id AS sessionId,
                ts_epoch_ms AS tsEpochMs, provider, model, project, files_json AS filesJson
         FROM proposals WHERE ${fam.sql} AND ts_epoch_ms >= ? AND ts_epoch_ms < ?
         ORDER BY ts_epoch_ms ASC`,
      )
      .all(...fam.args, startMs, endMs) as Array<Record<string, unknown>>;
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
        `INSERT INTO gate_signals (signal_id, kind, commit_hash, project, ts_epoch_ms, verdict, detail, evidence_source)
         VALUES (?,?,?,?,?,?,?,?)
         ON CONFLICT(signal_id) DO NOTHING`,
      )
      .run(s.signalId, s.kind, s.commitHash, s.project, s.tsEpochMs, s.verdict, s.detail, s.evidenceSource ?? 'manual');
  }

  /**
   * Store a full verified envelope and its eligible commit-bound signal as one
   * operation. Replays of exactly the same signed body are harmless; reusing an
   * event id or body hash for a different claim is rejected before any signal is
   * written.
   */
  insertVerifiedGateEvidence(input: VerifiedGateEvidenceInput): VerifiedGateEvidenceWrite {
    this.db.prepare('BEGIN IMMEDIATE').run();
    try {
      const existingEvent = this.db.prepare('SELECT body_hash AS bodyHash FROM gate_evidence WHERE event_id = ?').get(input.eventId) as { bodyHash: string } | undefined;
      if (existingEvent) {
        this.db.prepare('COMMIT').run();
        return existingEvent.bodyHash === input.bodyHash ? 'duplicate' : 'conflict';
      }
      const existingBody = this.db.prepare('SELECT event_id AS eventId FROM gate_evidence WHERE source = ? AND body_hash = ?').get(input.source, input.bodyHash) as { eventId: string } | undefined;
      if (existingBody) {
        this.db.prepare('COMMIT').run();
        return 'duplicate';
      }
      const conflictingSignal = this.db.prepare('SELECT signal_id AS signalId FROM gate_signals WHERE signal_id = ?').get(input.eventId) as { signalId: string } | undefined;
      if (conflictingSignal) {
        this.db.prepare('COMMIT').run();
        return 'conflict';
      }
      this.db
        .prepare(
          `INSERT INTO gate_evidence (event_id, source, evidence_class, commit_hash, repository_id, policy_id, body_hash, signer_key_id, envelope_json, verified_at_ms)
           VALUES (?,?,?,?,?,?,?,?,?,?)`,
        )
        .run(input.eventId, input.source, input.evidenceClass, input.commitHash, input.repositoryId, input.policyId, input.bodyHash, input.signerKeyId, input.envelopeJson, input.verifiedAtMs);
      this.db
        .prepare(
          `INSERT INTO gate_signals (signal_id, kind, commit_hash, project, ts_epoch_ms, verdict, detail, evidence_source)
           VALUES (?,?,?,?,?,?,?,?)`,
        )
        .run(input.eventId, input.signal.kind, input.commitHash, input.signal.project, input.signal.tsEpochMs, input.signal.verdict, input.signal.detail, 'signed-ci');
      this.db.prepare('COMMIT').run();
      return 'inserted';
    } catch (error) {
      try { this.db.prepare('ROLLBACK').run(); } catch { /* no active transaction */ }
      throw error;
    }
  }

  /** Signals explicitly linked to a commit hash. */
  signalsForCommit(commitHash: string): GateSignalRow[] {
    const rows = this.db
      .prepare(
        `SELECT signal_id AS signalId, kind, commit_hash AS commitHash, project,
                ts_epoch_ms AS tsEpochMs, verdict, detail, evidence_source AS evidenceSource
         FROM gate_signals WHERE commit_hash = ?`,
      )
      .all(commitHash) as unknown as GateSignalRow[];
    return rows;
  }

  /** Project-wide signals not tied to a specific commit, within a window. */
  signalsInWindow(project: string, startMs: number, endMs: number): GateSignalRow[] {
    const fam = this.familyFilter('project', project);
    const rows = this.db
      .prepare(
        `SELECT signal_id AS signalId, kind, commit_hash AS commitHash, project,
                ts_epoch_ms AS tsEpochMs, verdict, detail, evidence_source AS evidenceSource
         FROM gate_signals WHERE ${fam.sql} AND commit_hash IS NULL
           AND ts_epoch_ms >= ? AND ts_epoch_ms < ?`,
      )
      .all(...fam.args, startMs, endMs) as unknown as GateSignalRow[];
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

  /**
   * NON-CODING sessions with their attributed user (the x-fiscus-user tag) and
   * cost, for per-user value. Scoped to sessions WITHOUT code proposals, because
   * only those have outcomes we can honestly attribute to a user: their outcome
   * is reported against the session (which carries the user tag). Coding value is
   * realized against git commits, not the user tag, so it lives in the git-based
   * RoI path instead of being mis-attributed here. A session with more than one
   * user tag splits its cost across those (user, session) pairs.
   */
  sessionUnitsByUser(startMs: number, endMs: number): Array<{ sessionId: string; user: string; costUsd: number }> {
    return this.db
      .prepare(
        `SELECT session_id AS sessionId, COALESCE(user, 'unassigned') AS user,
                COALESCE(SUM(cost_usd),0) AS costUsd
         FROM requests
         WHERE session_id IS NOT NULL AND ts_epoch_ms >= ? AND ts_epoch_ms < ?
           AND session_id NOT IN (SELECT DISTINCT session_id FROM proposals WHERE session_id IS NOT NULL)
         GROUP BY session_id, COALESCE(user, 'unassigned')`,
      )
      .all(startMs, endMs) as Array<{ sessionId: string; user: string; costUsd: number }>;
  }

  saveReceipt(r: { unit: string; project: string; tsEpochMs: number; realized: boolean; receiptJson: string }): void {
    realization.saveReceipt(this.db, r);
  }

  getReceipt(unit: string): string | null {
    return realization.getReceipt(this.db, unit);
  }

  /**
   * Persist a snapshot of computed work units so realized value survives the
   * process that computed it. Keyed by commit hash, so re-running `realize`
   * refreshes the snapshot rather than double-counting.
   */
  saveRealizationUnits(records: RealizationUnitRecord[]): void {
    realization.saveRealizationUnits(this.db, records);
  }

  /**
   * Rehydrate stored work-unit snapshots (newest commit first), optionally one
   * project. `costStale` travels with the row rather than inside `unitJson`.
   */
  realizationUnitRows(project?: string): Array<{ unitJson: string; computedAtMs: number; costStale: boolean }> {
    return realization.realizationUnitRows(this.db, this.realizationDeps(), project);
  }

  /** How many stored realization units exist (optionally scoped to one project). */
  countRealizationUnits(project?: string): number {
    return realization.countRealizationUnits(this.db, this.realizationDeps(), project);
  }

  /** Total outcome signals ever recorded (`report`/`exec` wiring), across projects. */
  countSignals(): number {
    const row = this.db.prepare(`SELECT COUNT(*) AS n FROM gate_signals`).get() as { n: number };
    return row.n;
  }

  /** Distinct projects that have stored realization snapshots — the budget owner's rows. */
  realizationProjects(): string[] {
    return realization.realizationProjects(this.db);
  }

  /** Every row priced with a fallback/family-match rate — the reprice candidates. */
  estimatedRequestRows(): Array<{
    requestId: string;
    provider: string;
    model: string;
    inputTokens: number;
    outputTokens: number;
    cacheWriteTokens: number;
    cacheReadTokens: number;
    costUsd: number;
  }> {
    return realization.estimatedRequestRows(this.db);
  }

  /**
   * Re-cost estimated rows in one transaction and retain the previous
   * amount/evidence as an audit event. Persisted realized-value snapshots are
   * re-attributed inside the same transaction, on each unit's own recorded
   * basis — see realization.ts for why that basis is never re-derived.
   */
  applyRepricedCosts(updates: RepriceUpdate[], appliedAtMs = Date.now()): RealizationCostSync {
    return realization.applyRepricedCosts(this.db, this.realizationDeps(), updates, appliedAtMs);
  }

  /** How many persisted snapshots are carrying pre-reprice dollars. */
  countStaleRealizationUnits(): number {
    return realization.countStaleRealizationUnits(this.db);
  }

  /** Append-only price changes for one request, oldest first. */
  requestPriceEvents(requestId: string): RequestPriceEvent[] {
    return realization.requestPriceEvents(this.db, requestId);
  }

  /**
   * Write one validated provider-cost export as immutable evidence. This never
   * creates or changes request rows: local metering and provider reports have
   * different scopes and cannot be silently added together.
   */
  applyBillingImport(input: BillingImportInput, importedAtMs = Date.now()): BillingImportResult {
    return billing.applyBillingImport(this.db, input, importedAtMs);
  }

  /** Newest first, including empty/replay-only evidence runs for auditability. */
  billingImportRuns(limit = 50): BillingImportRun[] {
    return billing.billingImportRuns(this.db, limit);
  }

  /** Immutable provider-declared lines, deliberately separate from requestsInRange(). */
  billingEvidenceRecords(): BillingEvidenceRecord[] {
    return billing.billingEvidenceRecords(this.db);
  }

  /** Every immutable operator-declared mapping version, oldest first per record. */
  billingRecordMappings(recordId?: string): BillingRecordMapping[] {
    return billing.billingRecordMappings(this.db, recordId);
  }

  /**
   * Append an exact imported-record mapping to a local project/account. A
   * repeated identical declaration is idempotent; a changed destination creates
   * a new version and leaves the prior decision intact.
   */
  declareBillingRecordMapping(input: BillingRecordMappingDeclarationInput): BillingRecordMappingDeclarationResult {
    return billing.declareBillingRecordMapping(this.db, input);
  }

  /**
   * Report mapped coverage and residual reasons without changing provider or
   * request evidence. The Store facade intentionally cannot assert
   * provider_verified; that authority must arrive from a future verified
   * connector boundary rather than an operator flag.
   */
  billingMappingCoverage(options: { importId?: string; asOfMs?: number } = {}): BillingMappingCoverage {
    return billing.billingMappingCoverage(this.db, options);
  }

  /** Provider-declared USD total only. It is not a reconciliation or a request-ledger total. */
  billingSummary(): BillingSummary {
    return billing.billingSummary(this.db);
  }

  /**
   * Retain one direct OpenAI Costs API attempt. Failed and partial attempts are
   * audit rows only. Nothing here mutates or contributes to request spend.
   */
  recordOpenAiCostsObservation(input: OpenAiCostsObservationInput): OpenAiCostsObservationRun {
    return billing.recordOpenAiCostsObservation(this.db, input);
  }

  /**
   * Plan the adoption of an already-imported operator export as a Costs
   * observation, so a reconciliation can run WITHOUT an Admin credential.
   * Read-only: this computes a plan and writes nothing.
   */
  planOpenAiCostsAdoption(input: { importId: string; declaredScopeId: string; providerProjectRef: string }): OpenAiCostsAdoptionPlan {
    return billing.planOpenAiCostsAdoption(this.db, input);
  }

  /** Record an adoption plan as an observation. Refuses anything not adoptable. */
  adoptOpenAiCostsFromImport(plan: OpenAiCostsAdoptionPlan, adoptedAtMs = Date.now()): OpenAiCostsObservationRun {
    return billing.adoptOpenAiCostsFromImport(this.db, plan, adoptedAtMs);
  }

  /**
   * What the local side of a reconciliation would actually contain, split by
   * why each row does or does not qualify. Surfacing this BEFORE the credential
   * step is the whole point.
   */
  openAiReconciliationCoverage(declaredScopeId: string | null): ReconciliationCoverage | null {
    return billing.openAiReconciliationCoverage(this.db, declaredScopeId);
  }

  /** Newest first; includes failed pulls so a finance owner can see freshness failures. */
  openAiCostsObservationRuns(limit = 50): OpenAiCostsObservationRun[] {
    return billing.openAiCostsObservationRuns(this.db, limit);
  }

  /** Latest fully paginated successful snapshot only; failed runs never become a projection. */
  latestCompleteOpenAiCostsObservation(): { run: OpenAiCostsObservationRun; observations: OpenAiCostsObservationLine[] } | null {
    return billing.latestCompleteOpenAiCostsObservation(this.db);
  }

  /** Status has no financial total by design, so independent snapshots cannot be double counted. */
  openAiCostsObservationStatus(): OpenAiCostsObservationStatus {
    return billing.openAiCostsObservationStatus(this.db);
  }

  /**
   * Read-only local capture coverage for the newest complete Costs snapshot.
   * It deliberately returns no provider total and no variance.
   */
  openAiCostsCaptureCoverage(): OpenAiCostsCaptureCoverage | null {
    return billing.openAiCostsCaptureCoverage(this.db, (startMs, endMs) => this.requestsInRange(startMs, endMs));
  }

  /**
   * Per-day provider totals from the newest COMPLETE observation of this period
   * that is not the one being reconciled — the evidence behind
   * `snapshotStability`. Null when no independent observation exists.
   */
  priorOpenAiCostsDayTotals(exceptRunId: string, scopeId: string, periodStartMs: number, periodEndMs: number): Map<number, number> | null {
    return billing.priorOpenAiCostsDayTotals(this.db, exceptRunId, scopeId, periodStartMs, periodEndMs);
  }

  /**
   * Compare the newest complete provider snapshot with the local ledger.
   *
   * Read-only: computing a reconciliation does not record one. `saveReconciliationRun`
   * is a separate, explicit step.
   */
  reconcileOpenAiCosts(opts: { materialityUsd?: number; now?: number } = {}): ReconciliationResult | null {
    return billing.reconcileOpenAiCosts(this.db, (startMs, endMs) => this.requestsInRange(startMs, endMs), opts);
  }

  /** Persist a computed reconciliation as an immutable derived record. */
  saveReconciliationRun(result: ReconciliationRun, computedAtMs = Date.now()): string {
    return billing.saveReconciliationRun(this.db, result, computedAtMs);
  }

  // ── Allocation ────────────────────────────────────────────────────────────

  upsertCostCentre(input: { costCentreId: string; name: string; owner?: string | null; createdAtMs?: number }): CostCentre {
    return allocation.upsertCostCentre(this.db, input);
  }

  /** Archive rather than delete: past runs must stay explicable. */
  archiveCostCentre(costCentreId: string, archivedAtMs = Date.now()): boolean {
    return allocation.archiveCostCentre(this.db, costCentreId, archivedAtMs);
  }

  costCentres(): CostCentre[] {
    return allocation.costCentres(this.db);
  }

  /**
   * Add a rule, or a new VERSION of an existing one.
   *
   * A new version closes the previous one at its own `effectiveFromMs` — the
   * only permitted post-insert write to a rule row, and only when that row is
   * still open. The superseded version keeps its method, match, targets, and
   * ratios exactly as authored, so any past period re-runs under the rule text
   * that actually applied to it.
   */
  saveAllocationRule(input: Omit<AllocationRule, 'version' | 'createdAtMs'> & { createdAtMs?: number }): AllocationRule {
    return allocation.saveAllocationRule(this.db, input);
  }

  /** Withdraw a rule from a point in time forward. The row is retained. */
  revokeAllocationRule(ruleId: string, revokedAtMs = Date.now()): number {
    return allocation.revokeAllocationRule(this.db, ruleId, revokedAtMs);
  }

  /** Every rule version ever written, so a past period stays reconstructible. */
  allocationRules(): AllocationRule[] {
    return allocation.allocationRules(this.db);
  }

  /**
   * Allocate one closed period. Read-only — computing does not record.
   *
   * Rows are read through the alias-canonical projection so allocation totals
   * agree with `byProject`, and matched on the instant the spend happened.
   */
  allocatePeriod(periodStartMs: number, periodEndMs: number, runAtMs = Date.now()): AllocationRunResult {
    return allocation.allocatePeriod(
      this.db,
      (startMs, endMs) => this.requestsInRange(startMs, endMs),
      periodStartMs,
      periodEndMs,
      runAtMs,
    );
  }

  /**
   * Persist a run. Refuses a result that does not conserve its input: an
   * allocation that lost or invented money is not a record worth keeping, and
   * storing it would put an unauditable number in front of a budget owner.
   */
  saveAllocationRun(result: AllocationRunResult, computedAtMs = Date.now()): string {
    return allocation.saveAllocationRun(this.db, result, computedAtMs);
  }

  allocationRuns(limit = 20): Array<{ allocationRunId: string; computedAtMs: number; result: AllocationRunResult }> {
    return allocation.allocationRuns(this.db, limit);
  }

  /** Recorded reconciliation runs, newest first. */
  reconciliationRuns(limit = 20): Array<{ reconciliationRunId: string; computedAtMs: number; result: ReconciliationRun }> {
    return billing.reconciliationRuns(this.db, limit);
  }

  /**
   * Create (or recover) an immutable local OpenAI route declaration and make it
   * active for future matching proxy rows. This is intentionally local operator
   * provenance, never a provider credential/account verification.
   */
  setOpenAiScope(input: {
    billingAccountRef: string;
    providerProjectRef?: string | null;
    upstreamBase: string;
    declaredAtMs?: number;
    activatedAtMs?: number;
  }): ProviderScopeDeclaration {
    return billing.setOpenAiScope(this.db, input);
  }

  /** Stop attaching the local scope to future OpenAI-proxy rows. Historical rows are immutable. */
  clearOpenAiScope(): boolean {
    return billing.clearOpenAiScope(this.db);
  }

  /** Active local declaration, if one exists. It still has unverified trust. */
  activeOpenAiScope(): ProviderScopeDeclaration | null {
    return billing.activeOpenAiScope(this.db);
  }

  /** Snapshot only when a request's resolved OpenAI endpoint exactly matches the active declaration. */
  matchingOpenAiScope(upstreamBase: string): ProviderScopeDeclaration | null {
    return billing.matchingOpenAiScope(this.db, upstreamBase);
  }

  /**
   * Commit a validated causal-study protocol. Existing committed records are
   * idempotent only when byte-for-byte equivalent; no update path exists.
   */
  registerCausalProtocol(protocol: unknown): 'created' | 'existing' {
    return causal.registerCausalProtocol(this.db, protocol);
  }

  /** Persist a complete pre-exposure randomisation block and its decision ledger. */
  saveCausalAssignmentPlan(plan: CausalAssignmentPlan): 'created' | 'existing' {
    return causal.saveCausalAssignmentPlan(this.db, plan);
  }

  /**
   * Atomically allocate and persist one v2 block. Sequence and cryptographic
   * entropy are Store-owned and allocations are returned only after commit.
   */
  assignCausalBlockV2(request: CausalAssignmentRequestV2): CausalAssignmentResultV2 {
    return causal.assignCausalBlockV2(this.db, request);
  }

  causalAssignmentManifestV2(studyId: string): CausalAssignmentManifestV2 | null {
    return causal.causalAssignmentManifestV2(this.db, studyId);
  }

  /** Append actual execution lineage after a stored randomized decision. */
  appendCausalExecution(record: CausalExecutionRecord): 'created' | 'existing' {
    return causal.appendCausalExecution(this.db, record);
  }

  /** Store-internal v2 execution append; terminal outcomes are a later slice. */
  appendCausalExecutionV2(record: unknown): 'created' | 'existing' {
    return causal.appendCausalExecutionV2(this.db, record);
  }

  /** Store-internal v2 terminal outcome append; pending is represented by absence. */
  appendCausalTerminalOutcomeV2(record: unknown): 'created' | 'existing' {
    return causal.appendCausalTerminalOutcomeV2(this.db, record);
  }

  /** Store-internal T-069 scalar request-to-realization sidecar append. */
  appendCausalLineageBindingV2(record: unknown): 'created' | 'existing' {
    return causalLineage.appendCausalLineageBindingV2(this.db, record);
  }

  /** Read only authenticated T-069 sidecar rows; prompts/source are absent. */
  causalLineageBindingsV2(
    studyId: string,
    lookup: causalLineage.CausalLineageBindingLookupV2 = {},
  ): causalLineage.CausalLineageBindingV2[] {
    return causalLineage.causalLineageBindingsV2(this.db, studyId, lookup);
  }

  /** Append outcome lineage after a stored execution. */
  appendCausalOutcome(record: CausalOutcomeRecord): 'created' | 'existing' {
    return causal.appendCausalOutcome(this.db, record);
  }

  /** Load the local evidence objects required for deterministic qualification. */
  causalStudyData(studyId: string): import('../causal/types.ts').CausalStudyData | null {
    return causal.causalStudyData(this.db, studyId);
  }

  causalAssignmentPlans(studyId: string): CausalAssignmentPlan[] {
    return causal.causalAssignmentPlans(this.db, studyId);
  }

  /**
   * Persist one immutable local analysis snapshot. It never changes provider
   * routing or budget configuration.
   */
  saveCausalAnalysis(
    studyId: string,
    analysisId: string,
    computedAtMs = Date.now(),
  ): causal.CausalAnalysisSnapshot {
    return causal.saveCausalAnalysis(this.db, studyId, analysisId, computedAtMs);
  }

  causalAnalysisSnapshots(studyId: string): causal.CausalAnalysisSnapshot[] {
    return causal.causalAnalysisSnapshots(this.db, studyId);
  }

  causalStudySummaries(): causal.CausalStudySummary[] {
    return causal.causalStudySummaries(this.db);
  }

  /** Maintenance: prune old requests and compact. Returns rows removed. */
  prune(beforeMs: number): number {
    const info = this.db.prepare(`DELETE FROM requests WHERE ts_epoch_ms < ?`).run(beforeMs);
    this.db.prepare('VACUUM').run();
    return Number(info.changes ?? 0);
  }

  /**
   * Privacy maintenance: prune PROPOSAL rows (the AI's literal proposed code) older
   * than beforeMs. Kept separate from prune() — proposals have a much shorter honest
   * retention need (the git-correlation window) than request/cost history.
   */
  pruneProposals(beforeMs: number): number {
    const info = this.db.prepare(`DELETE FROM proposals WHERE ts_epoch_ms < ?`).run(beforeMs);
    this.db.prepare('VACUUM').run();
    return Number(info.changes ?? 0);
  }

  /** Privacy control: delete every stored proposal immediately, regardless of age. */
  clearProposals(): number {
    const info = this.db.prepare(`DELETE FROM proposals`).run();
    this.db.prepare('VACUUM').run();
    return Number(info.changes ?? 0);
  }

  /**
   * Which provider(s)/model(s) have routed traffic through the proxy recently — the
   * dashboard Settings page's "connection status". Never a literal API key; Fiscus
   * never sees one (src/proxy/server.ts only forwards per-request headers).
   */
  recentProviderConnections(sinceMs: number): ProviderConnection[] {
    return this.db
      .prepare(
        `SELECT provider, model, MAX(ts_epoch_ms) AS lastSeenMs, COUNT(*) AS requestCount
         FROM requests WHERE ts_epoch_ms >= ?
         GROUP BY provider, model ORDER BY lastSeenMs DESC`,
      )
      .all(sinceMs) as unknown as ProviderConnection[];
  }
}
