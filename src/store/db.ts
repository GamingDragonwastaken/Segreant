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
import { initializeSchema, runScript } from './schema.ts';
import { dirname } from 'node:path';
import { existsSync, mkdirSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { legacyPricingEvidence, type RequestPricingEvidence } from '../cost/pricing.ts';
import {
  BILLING_IMPORTER_VERSION,
  usdMicros,
  type BillingChargeType,
  type BillingCoverage,
  type NormalizedBillingImport,
} from '../billing/types.ts';
import {
  newOpenAiScopeDeclaration,
  normalizeOpenAiUpstream,
  type ProviderScopeDeclaration,
  type ScopeCaptureStatus,
} from '../billing/scope.ts';
import { ATTRIBUTION_BASES, type AttributionBasis } from '../value/characterization.ts';
import type { OpenAiCostObservation, OpenAiCostsFailureCode } from '../billing/openaiCosts.ts';
import { buildOpenAiCostsCaptureCoverage, type OpenAiCostsCaptureCoverage } from '../billing/openaiCostsCoverage.ts';
import { reconcileOpenAiCosts, type ProviderSourceKind, type ReconciliationCoverage, type ReconciliationResult, type ReconciliationRun } from '../billing/reconcile.ts';

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * A microdollar integer as the plain decimal string the observation grain
 * stores. Never a float round-trip: the ledger is exact integers and the
 * provider grain is an exact decimal, so the conversion between them must not
 * introduce a representation error a reconciliation would then report as a
 * residual.
 */
function microsToDecimal(micros: number): string {
  const sign = micros < 0 ? '-' : '';
  const abs = Math.abs(micros);
  return `${sign}${Math.floor(abs / 1_000_000)}.${String(abs % 1_000_000).padStart(6, '0')}`;
}
import {
  validateCostCentre,
  validateRule,
  type AllocatableRow,
  type AllocationRule,
  type CostCentre,
} from '../alloc/rules.ts';
import { applyAllocation, type AllocationRunResult } from '../alloc/apply.ts';
import type { OpenAiCostsAdoptionPlan, RequestRow, PricingEvidenceBucket, AttributionEvidenceBucket, RequestPriceEvent, RepriceUpdate, BillingImportInput, BillingImportRun, BillingEvidenceRecord, BillingImportResult, BillingSummary, OpenAiCostsObservationRun, OpenAiCostsObservationLine, OpenAiCostsObservationInput, OpenAiCostsObservationStatus, SpendBucket, Characterization, ProposalRow, ProviderConnection, GateSignalRow, VerifiedGateEvidenceInput, VerifiedGateEvidenceWrite, RealizationUnitRecord, CostScope, RealizationCostSync } from './types.ts';
export type { OpenAiCostsAdoptionPlan, RequestRow, PricingEvidenceBucket, AttributionEvidenceBucket, RequestPriceEvent, RepriceUpdate, BillingImportInput, BillingImportRun, BillingEvidenceRecord, BillingImportResult, BillingSummary, OpenAiCostsObservationRun, OpenAiCostsObservationLine, OpenAiCostsObservationInput, OpenAiCostsObservationStatus, SpendBucket, Characterization, ProposalRow, ProviderConnection, GateSignalRow, VerifiedGateEvidenceInput, VerifiedGateEvidenceWrite, RealizationUnitRecord, CostScope, RealizationCostSync } from './types.ts';


function pricingEvidenceFromRecord(record: Record<string, unknown>, prefix = ''): RequestPricingEvidence {
  const fallback = legacyPricingEvidence();
  const value = (name: string): unknown => record[prefix ? `${prefix}${name}` : `${name[0]!.toLowerCase()}${name.slice(1)}`];
  const costBasis = value('CostBasis');
  const rateCardSha256 = value('RateCardSha256');
  const rateCardSourceKind = value('RateCardSourceKind');
  const rateMatchKind = value('RateMatchKind');
  const rateMatchProvider = value('RateMatchProvider');
  const rateMatchModel = value('RateMatchModel');
  return {
    costBasis: typeof costBasis === 'string' ? costBasis as RequestPricingEvidence['costBasis'] : fallback.costBasis,
    rateCardSha256: typeof rateCardSha256 === 'string' ? rateCardSha256 : null,
    rateCardSourceKind: typeof rateCardSourceKind === 'string'
      ? rateCardSourceKind as RequestPricingEvidence['rateCardSourceKind']
      : fallback.rateCardSourceKind,
    rateMatchKind: typeof rateMatchKind === 'string' ? rateMatchKind as RequestPricingEvidence['rateMatchKind'] : fallback.rateMatchKind,
    rateMatchProvider: typeof rateMatchProvider === 'string' ? rateMatchProvider : null,
    rateMatchModel: typeof rateMatchModel === 'string' ? rateMatchModel : null,
  };
}

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

function scopeDeclarationFromRecord(row: Record<string, unknown>): ProviderScopeDeclaration {
  return {
    declarationId: String(row.declarationId),
    provider: 'openai',
    billingAccountRef: String(row.billingAccountRef),
    providerProjectRef: typeof row.providerProjectRef === 'string' ? row.providerProjectRef : null,
    upstreamFingerprint: String(row.upstreamFingerprint),
    upstreamDisplay: String(row.upstreamDisplay),
    declaredAtMs: Number(row.declaredAtMs),
    trust: 'operator_declared_unverified',
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

function billingRunFromRecord(row: Record<string, unknown>): BillingImportRun {
  return {
    importId: String(row.importId),
    importedAtMs: Number(row.importedAtMs),
    format: 'json',
    schemaVersion: Number(row.schemaVersion),
    importerVersion: String(row.importerVersion),
    fileName: String(row.fileName),
    fileSha256: String(row.fileSha256),
    fileSizeBytes: Number(row.fileSizeBytes),
    sourceSystem: 'operator-export',
    sourceExportId: String(row.sourceExportId),
    provider: 'openai',
    billingAccountRef: String(row.billingAccountRef),
    exportedAtMs: Number(row.exportedAtMs),
    periodStartMs: Number(row.periodStartMs),
    periodEndMs: Number(row.periodEndMs),
    coverage: String(row.coverage) as BillingCoverage,
    trust: 'operator_supplied_unverified',
    rawRetention: 'digest_only',
    recordsSeen: Number(row.recordsSeen),
    recordsInserted: Number(row.recordsInserted),
    recordsDuplicate: Number(row.recordsDuplicate),
  };
}

function billingRecordFromRecord(row: Record<string, unknown>): BillingEvidenceRecord {
  return {
    recordId: String(row.recordId),
    sourceSystem: 'operator-export',
    billingAccountRef: String(row.billingAccountRef),
    sourceRecordId: String(row.sourceRecordId),
    sourceRecordSha256: String(row.sourceRecordSha256),
    firstImportId: String(row.firstImportId),
    sourceExportId: String(row.sourceExportId),
    provider: 'openai',
    providerProjectRef: typeof row.providerProjectRef === 'string' ? row.providerProjectRef : null,
    service: String(row.service),
    sku: String(row.sku),
    model: typeof row.model === 'string' ? row.model : null,
    region: typeof row.region === 'string' ? row.region : null,
    observedAtMs: Number(row.observedAtMs),
    chargePeriodStartMs: Number(row.chargePeriodStartMs),
    chargePeriodEndMs: Number(row.chargePeriodEndMs),
    chargeType: String(row.chargeType) as BillingChargeType,
    currency: 'USD',
    amountMicros: Number(row.amountMicros),
    usageUnit: typeof row.usageUnit === 'string' ? row.usageUnit : null,
    usageQuantity: typeof row.usageQuantity === 'string' ? row.usageQuantity : null,
    costBasis: 'provider_reported',
    trust: 'operator_supplied_unverified',
  };
}

function openAiCostsRunFromRecord(row: Record<string, unknown>): OpenAiCostsObservationRun {
  return {
    observationRunId: String(row.observationRunId),
    declaredScopeId: String(row.declaredScopeId),
    providerProjectRef: String(row.providerProjectRef),
    periodStartMs: Number(row.periodStartMs),
    periodEndMs: Number(row.periodEndMs),
    fetchedAtMs: Number(row.fetchedAtMs),
    paginationComplete: Boolean(row.paginationComplete),
    pageCount: Number(row.pageCount),
    pageDigestChainSha256: typeof row.pageDigestChainSha256 === 'string' ? row.pageDigestChainSha256 : null,
    resultState: String(row.resultState) as OpenAiCostsObservationRun['resultState'],
    failureCode: typeof row.failureCode === 'string' ? row.failureCode as OpenAiCostsFailureCode : null,
    providerFinality: 'undocumented',
    trust: 'provider_observation_unreconciled',
    rawRetention: 'digest_only',
    observationsStored: Number(row.observationsStored),
    // Anything not one of the two known writers stays unknown rather than being
    // coerced into the one that happens to be more flattering.
    sourceKind: row.sourceKind === 'provider_api_pull' || row.sourceKind === 'operator_supplied_export'
      ? row.sourceKind
      : 'legacy_unknown',
  };
}

function openAiCostsLineFromRecord(row: Record<string, unknown>): OpenAiCostsObservationLine {
  return {
    observationId: String(row.observationId),
    observationRunId: String(row.observationRunId),
    declaredScopeId: String(row.declaredScopeId),
    fetchedAtMs: Number(row.fetchedAtMs),
    providerProjectRef: String(row.providerProjectRef),
    bucketStartMs: Number(row.bucketStartMs),
    bucketEndMs: Number(row.bucketEndMs),
    lineItem: String(row.lineItem),
    currency: String(row.currency),
    amountDecimal: String(row.amountDecimal),
  };
}

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
    initializeSchema(this.db);
  }

  /** Transaction control and one-off DDL — see runScript in schema.ts. */
  private runScript(sql: string): void {
    runScript(this.db, sql);
  }

  close(): void {
    this.db.close();
  }

  raw(): DatabaseSync {
    return this.db;
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
   * with x-aegis-project) from untagged 'default' proxy traffic. Attribution uses it
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
  // Tool launch cwds fragment one real project across labels ("aegisflow" vs
  // "aegisflow-ts", editor-named dirs, etc.). Aliases fix the LABELS at query
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
   * NON-CODING sessions with their attributed user (the x-aegis-user tag) and
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
         (commit_hash, project, ts_epoch_ms, computed_at_ms, attributed_cost_usd, maturing, realized, unit_json,
          cost_scope, cost_stale)
       VALUES (?,?,?,?,?,?,?,?,?,0)
       ON CONFLICT(commit_hash) DO UPDATE SET
         project=excluded.project, ts_epoch_ms=excluded.ts_epoch_ms, computed_at_ms=excluded.computed_at_ms,
         attributed_cost_usd=excluded.attributed_cost_usd, maturing=excluded.maturing,
         realized=excluded.realized, unit_json=excluded.unit_json,
         cost_scope=excluded.cost_scope, cost_stale=0`,
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
        r.costScope,
      );
    }
  }

  /**
   * Rehydrate stored work-unit snapshots (newest commit first), optionally one
   * project. `costStale` travels with the row rather than inside `unitJson`: a
   * reprice changes whether a snapshot's dollars are current WITHOUT changing the
   * unit it describes, so it is a property of the stored record, not of the work.
   */
  realizationUnitRows(project?: string): Array<{ unitJson: string; computedAtMs: number; costStale: boolean }> {
    const fam = project ? this.familyFilter('project', project) : null;
    const sql =
      `SELECT unit_json AS unitJson, computed_at_ms AS computedAtMs, cost_stale AS costStale FROM realization_units` +
      (fam ? ` WHERE ${fam.sql}` : ``) +
      ` ORDER BY ts_epoch_ms DESC`;
    const stmt = this.db.prepare(sql);
    const rows = (fam ? stmt.all(...fam.args) : stmt.all()) as Array<{
      unitJson: string;
      computedAtMs: number;
      costStale: number;
    }>;
    return rows.map((r) => ({ unitJson: r.unitJson, computedAtMs: r.computedAtMs, costStale: Boolean(r.costStale) }));
  }

  /** How many stored realization units exist (optionally scoped to one project). */
  countRealizationUnits(project?: string): number {
    const fam = project ? this.familyFilter('project', project) : null;
    const sql = `SELECT COUNT(*) AS n FROM realization_units` + (fam ? ` WHERE ${fam.sql}` : ``);
    const stmt = this.db.prepare(sql);
    const row = (fam ? stmt.get(...fam.args) : stmt.get()) as { n: number };
    return row.n;
  }

  /** Total outcome signals ever recorded (`report`/`exec` wiring), across projects. */
  countSignals(): number {
    const row = this.db.prepare(`SELECT COUNT(*) AS n FROM gate_signals`).get() as { n: number };
    return row.n;
  }

  /** Distinct projects that have stored realization snapshots — the budget owner's rows. */
  realizationProjects(): string[] {
    const rows = this.db
      .prepare(
        `SELECT DISTINCT COALESCE(a.canonical, u.project) AS project
         FROM realization_units u LEFT JOIN project_aliases a ON a.alias = u.project
         ORDER BY project`,
      )
      .all() as Array<{ project: string }>;
    return rows.map((r) => r.project);
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
    return this.db
      .prepare(
        `SELECT request_id AS requestId, provider, model,
                input_tokens AS inputTokens, output_tokens AS outputTokens,
                cache_write_tokens AS cacheWriteTokens, cache_read_tokens AS cacheReadTokens,
                cost_usd AS costUsd
         FROM requests WHERE estimated = 1`,
      )
      .all() as Array<{
      requestId: string;
      provider: string;
      model: string;
      inputTokens: number;
      outputTokens: number;
      cacheWriteTokens: number;
      cacheReadTokens: number;
      costUsd: number;
    }>;
  }

  /**
   * Re-cost estimated rows in one transaction and retain the previous
   * amount/evidence as an audit event.
   *
   * A reprice moves money that persisted realized-value snapshots were already
   * built from, so the request ledger and `realization_units` would otherwise
   * disagree: `/api/overview` would show the corrected spend while `/api/value`
   * served RoI, realized value, and per-model trial prices computed from the old
   * one, with nothing on either surface saying which. The snapshots are therefore
   * re-attributed HERE, inside the same transaction, on each unit's own recorded
   * basis — the same rule applied to corrected prices, never a new rule. Units
   * whose basis predates `cost_scope` cannot be reproduced faithfully, so they are
   * left marked stale for disclosure instead of being recomputed on a guess.
   */
  applyRepricedCosts(updates: RepriceUpdate[], appliedAtMs = Date.now()): RealizationCostSync {
    const prior = this.db.prepare(
      `SELECT cost_usd AS costUsd, estimated, ts_epoch_ms AS tsEpochMs, project,
              cost_basis AS CostBasis, rate_card_sha256 AS RateCardSha256,
              rate_card_source_kind AS RateCardSourceKind, rate_match_kind AS RateMatchKind,
              rate_match_provider AS RateMatchProvider, rate_match_model AS RateMatchModel
       FROM requests WHERE request_id = ?`,
    );
    const update = this.db.prepare(
      `UPDATE requests
       SET cost_usd = ?, estimated = 0,
           cost_basis = ?, rate_card_sha256 = ?, rate_card_source_kind = ?, rate_match_kind = ?,
           rate_match_provider = ?, rate_match_model = ?
       WHERE request_id = ? AND estimated = 1`,
    );
    const event = this.db.prepare(
      `INSERT INTO request_price_events (
         request_id, action, applied_at_ms, previous_cost_usd, previous_estimated,
         previous_cost_basis, previous_rate_card_sha256, previous_rate_card_source_kind,
         previous_rate_match_kind, previous_rate_match_provider, previous_rate_match_model,
         new_cost_usd, new_estimated, new_cost_basis, new_rate_card_sha256,
         new_rate_card_source_kind, new_rate_match_kind, new_rate_match_provider, new_rate_match_model
       ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    );
    const touched: Array<{ tsEpochMs: number; project: string }> = [];
    this.runScript('BEGIN');
    try {
      for (const u of updates) {
        const old = prior.get(u.requestId) as Record<string, unknown> | undefined;
        if (!old || !Boolean(old.estimated)) continue;
        const oldPricing = pricingEvidenceFromRecord(old);
        const written = update.run(
          u.costUsd,
          u.pricing.costBasis,
          u.pricing.rateCardSha256,
          u.pricing.rateCardSourceKind,
          u.pricing.rateMatchKind,
          u.pricing.rateMatchProvider,
          u.pricing.rateMatchModel,
          u.requestId,
        );
        if (Number(written.changes ?? 0) !== 1) continue;
        event.run(
          u.requestId, 'reprice', appliedAtMs, Number(old.costUsd), Boolean(old.estimated) ? 1 : 0,
          oldPricing.costBasis, oldPricing.rateCardSha256, oldPricing.rateCardSourceKind,
          oldPricing.rateMatchKind, oldPricing.rateMatchProvider, oldPricing.rateMatchModel,
          u.costUsd, 0, u.pricing.costBasis, u.pricing.rateCardSha256,
          u.pricing.rateCardSourceKind, u.pricing.rateMatchKind, u.pricing.rateMatchProvider, u.pricing.rateMatchModel,
        );
        touched.push({ tsEpochMs: Number(old.tsEpochMs), project: String(old.project) });
      }
      const sync = this.syncRealizationCosts(touched);
      this.runScript('COMMIT');
      return sync;
    } catch (e) {
      this.runScript('ROLLBACK');
      throw e;
    }
  }

  /**
   * Bring persisted realized-value snapshots back in step with repriced requests.
   *
   * A unit is affected when one of the repriced requests falls inside its
   * attribution window — the same half-open `[windowStartMs, windowEndMs)` test
   * `summary()` applies, so a request on a boundary is counted by exactly one
   * side here and there. A `project`-scoped unit absorbed only its own project
   * family's spend, so a repriced request from elsewhere leaves it untouched; a
   * `window`-scoped unit took the project-blind sum and is affected by any of
   * them. A `legacy_unknown` unit is treated as affected either way (the
   * conservative direction: it may be wrong, and saying so beats a silent guess)
   * but is never recomputed.
   *
   * Recomputation re-runs only the MONEY half of attribution. Gate verdicts,
   * survival, acceptance, maturity, and the realized flag are all independent of
   * price and are left exactly as computed — this is a re-attribution, not a
   * re-scoring, so a reprice can never change whether work realized.
   *
   * Caller must already be inside a transaction.
   */
  private syncRealizationCosts(repriced: Array<{ tsEpochMs: number; project: string }>): RealizationCostSync {
    const empty: RealizationCostSync = { markedStale: 0, resynced: 0, unresolvable: 0, costUsdBefore: 0, costUsdAfter: 0 };
    if (repriced.length === 0) return empty;

    const rows = this.db
      .prepare(
        `SELECT commit_hash AS commitHash, project, cost_scope AS costScope,
                attributed_cost_usd AS attributedCostUsd, unit_json AS unitJson
         FROM realization_units`,
      )
      .all() as Array<{ commitHash: string; project: string; costScope: string; attributedCostUsd: number; unitJson: string }>;
    if (rows.length === 0) return empty;

    // Canonicalize once: a unit and a request can name the same project through
    // different aliases, and project scoping is defined over the alias family.
    const canonical = new Map<string, string>();
    const canon = (name: string): string => {
      const hit = canonical.get(name);
      if (hit !== undefined) return hit;
      const c = this.canonicalProject(name);
      canonical.set(name, c);
      return c;
    };
    const priced = repriced.map((r) => ({ tsEpochMs: r.tsEpochMs, project: canon(r.project) }));

    const markStale = this.db.prepare(`UPDATE realization_units SET cost_stale = 1 WHERE commit_hash = ?`);
    const writeBack = this.db.prepare(
      `UPDATE realization_units SET attributed_cost_usd = ?, unit_json = ?, cost_stale = 0 WHERE commit_hash = ?`,
    );

    const out: RealizationCostSync = { ...empty };
    for (const row of rows) {
      let unit: Record<string, unknown>;
      try {
        unit = JSON.parse(row.unitJson) as Record<string, unknown>;
      } catch {
        continue; // an unparseable snapshot is not something to rewrite blind
      }
      const startMs = Number(unit.windowStartMs);
      const endMs = Number(unit.windowEndMs);
      if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) continue;
      const scope: CostScope =
        row.costScope === 'project' || row.costScope === 'window' || row.costScope === 'synthetic_demo'
          ? row.costScope
          : 'legacy_unknown';
      // A synthetic unit's dollars were asserted, never summed from the ledger, so
      // repricing the ledger cannot have staled them. Skipped rather than marked.
      if (scope === 'synthetic_demo') continue;
      const unitProject = canon(row.project);
      const affected = priced.some(
        (p) => p.tsEpochMs >= startMs && p.tsEpochMs < endMs && (scope !== 'project' || p.project === unitProject),
      );
      if (!affected) continue;

      out.markedStale += 1;
      if (scope === 'legacy_unknown') {
        markStale.run(row.commitHash);
        out.unresolvable += 1;
        continue;
      }

      const scoped = scope === 'project' ? row.project : undefined;
      const spend = this.summary(startMs, endMs, scoped);
      const modelSpend = this.byModel(startMs, endMs, scoped);
      const windowModelTotal = modelSpend.reduce((s, m) => s + m.costUsd, 0);
      const totalLines = Number(unit.linesAdded ?? 0) + Number(unit.linesDeleted ?? 0);

      unit.attributedCostUsd = spend.costUsd;
      unit.attributedRequests = spend.requests;
      unit.attributedOutputTokens = spend.outputTokens;
      unit.costPerHundredLines = totalLines > 0 ? (spend.costUsd / totalLines) * 100 : null;
      unit.dominantModel = modelSpend.length > 0 ? modelSpend[0]!.label : null;
      unit.dominantModelCostUsd = modelSpend.length > 0 ? modelSpend[0]!.costUsd : null;
      unit.dominantModelCostShare =
        modelSpend.length > 0 && windowModelTotal > 0 ? modelSpend[0]!.costUsd / windowModelTotal : null;

      writeBack.run(spend.costUsd, JSON.stringify(unit), row.commitHash);
      out.resynced += 1;
      out.costUsdBefore += row.attributedCostUsd;
      out.costUsdAfter += spend.costUsd;
    }
    return out;
  }

  /** How many persisted snapshots are carrying pre-reprice dollars. */
  countStaleRealizationUnits(): number {
    const row = this.db.prepare(`SELECT COUNT(*) AS n FROM realization_units WHERE cost_stale = 1`).get() as { n: number };
    return row.n;
  }

  /** Append-only price changes for one request, oldest first. */
  requestPriceEvents(requestId: string): RequestPriceEvent[] {
    const rows = this.db.prepare(
      `SELECT event_id AS eventId, request_id AS requestId, action, applied_at_ms AS appliedAtMs,
              previous_cost_usd AS previousCostUsd, previous_estimated AS previousEstimated,
              previous_cost_basis AS previousCostBasis, previous_rate_card_sha256 AS previousRateCardSha256,
              previous_rate_card_source_kind AS previousRateCardSourceKind, previous_rate_match_kind AS previousRateMatchKind,
              previous_rate_match_provider AS previousRateMatchProvider, previous_rate_match_model AS previousRateMatchModel,
              new_cost_usd AS newCostUsd, new_estimated AS newEstimated,
              new_cost_basis AS newCostBasis, new_rate_card_sha256 AS newRateCardSha256,
              new_rate_card_source_kind AS newRateCardSourceKind, new_rate_match_kind AS newRateMatchKind,
              new_rate_match_provider AS newRateMatchProvider, new_rate_match_model AS newRateMatchModel
       FROM request_price_events WHERE request_id = ? ORDER BY event_id ASC`,
    ).all(requestId) as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      eventId: Number(row.eventId),
      requestId: String(row.requestId),
      action: 'reprice',
      appliedAtMs: Number(row.appliedAtMs),
      previousCostUsd: Number(row.previousCostUsd),
      previousEstimated: Boolean(row.previousEstimated),
      previousPricing: pricingEvidenceFromRecord(row, 'previous'),
      newCostUsd: Number(row.newCostUsd),
      newEstimated: Boolean(row.newEstimated),
      newPricing: pricingEvidenceFromRecord(row, 'new'),
    }));
  }

  /**
   * Write one validated provider-cost export as immutable evidence. This never
   * creates or changes request rows: local metering and provider reports have
   * different scopes and cannot be silently added together.
   */
  applyBillingImport(input: BillingImportInput, importedAtMs = Date.now()): BillingImportResult {
    if (!/^[a-f0-9]{64}$/.test(input.fileSha256)) throw new Error('billing fileSha256 must be a lowercase SHA-256 digest');
    if (!Number.isSafeInteger(input.fileSizeBytes) || input.fileSizeBytes < 0) throw new Error('billing file size is invalid');
    const d = input.document;
    const priorFile = this.db.prepare(
      `SELECT import_id AS importId, imported_at_ms AS importedAtMs, format, schema_version AS schemaVersion,
              importer_version AS importerVersion, file_name AS fileName, file_sha256 AS fileSha256,
              file_size_bytes AS fileSizeBytes, source_system AS sourceSystem, source_export_id AS sourceExportId,
              provider, billing_account_ref AS billingAccountRef, exported_at_ms AS exportedAtMs,
              period_start_ms AS periodStartMs, period_end_ms AS periodEndMs, coverage, trust, raw_retention AS rawRetention,
              records_seen AS recordsSeen, records_inserted AS recordsInserted, records_duplicate AS recordsDuplicate
       FROM billing_import_runs WHERE file_sha256 = ?`,
    ).get(input.fileSha256) as Record<string, unknown> | undefined;
    if (priorFile) return { run: billingRunFromRecord(priorFile), duplicateFile: true };

    const existing = this.db.prepare(
      `SELECT source_record_sha256 AS sourceRecordSha256
       FROM billing_evidence_records
       WHERE source_system = ? AND provider = ? AND billing_account_ref = ? AND source_record_id = ?`,
    );
    let recordsDuplicate = 0;
    const recordsToInsert = [] as typeof d.records;
    for (const record of d.records) {
      const row = existing.get(d.source.system, d.source.provider, d.source.billingAccountRef, record.sourceRecordId) as
        | { sourceRecordSha256: string }
        | undefined;
      if (!row) {
        recordsToInsert.push(record);
      } else if (row.sourceRecordSha256 === record.sourceRecordSha256) {
        recordsDuplicate++;
      } else {
        throw new Error(
          `billing source-record conflict for ${record.sourceRecordId}: the same provider/account record id has different content`,
        );
      }
    }

    const run: BillingImportRun = {
      importId: randomUUID(),
      importedAtMs,
      format: input.format,
      schemaVersion: d.schemaVersion,
      importerVersion: BILLING_IMPORTER_VERSION,
      fileName: input.fileName,
      fileSha256: input.fileSha256,
      fileSizeBytes: input.fileSizeBytes,
      sourceSystem: d.source.system,
      sourceExportId: d.source.exportId,
      provider: d.source.provider,
      billingAccountRef: d.source.billingAccountRef,
      exportedAtMs: d.exportedAtMs,
      periodStartMs: d.periodStartMs,
      periodEndMs: d.periodEndMs,
      coverage: d.source.coverage,
      trust: 'operator_supplied_unverified',
      rawRetention: 'digest_only',
      recordsSeen: d.records.length,
      recordsInserted: recordsToInsert.length,
      recordsDuplicate,
    };
    const writeRun = this.db.prepare(
      `INSERT INTO billing_import_runs (
         import_id, imported_at_ms, format, schema_version, importer_version, file_name, file_sha256, file_size_bytes,
         source_system, source_export_id, provider, billing_account_ref, exported_at_ms, period_start_ms, period_end_ms,
         coverage, trust, raw_retention, records_seen, records_inserted, records_duplicate
       ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    );
    const writeRecord = this.db.prepare(
      `INSERT INTO billing_evidence_records (
         record_id, source_system, billing_account_ref, source_record_id, source_record_sha256, first_import_id,
         source_export_id, provider, provider_project_ref, service, sku, model, region, observed_at_ms,
         charge_period_start_ms, charge_period_end_ms, charge_type, currency, amount_micros, usage_unit,
         usage_quantity, cost_basis, trust
       ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    );
    this.runScript('BEGIN');
    try {
      writeRun.run(
        run.importId, run.importedAtMs, run.format, run.schemaVersion, run.importerVersion, run.fileName, run.fileSha256,
        run.fileSizeBytes, run.sourceSystem, run.sourceExportId, run.provider, run.billingAccountRef, run.exportedAtMs,
        run.periodStartMs, run.periodEndMs, run.coverage, run.trust, run.rawRetention, run.recordsSeen,
        run.recordsInserted, run.recordsDuplicate,
      );
      for (const record of recordsToInsert) {
        writeRecord.run(
          randomUUID(), d.source.system, d.source.billingAccountRef, record.sourceRecordId, record.sourceRecordSha256,
          run.importId, d.source.exportId, d.source.provider, record.providerProjectRef, record.service, record.sku,
          record.model, record.region, record.observedAtMs, record.chargePeriodStartMs, record.chargePeriodEndMs,
          record.chargeType, record.currency, record.amountMicros, record.usageUnit, record.usageQuantity,
          'provider_reported', 'operator_supplied_unverified',
        );
      }
      this.runScript('COMMIT');
    } catch (error) {
      this.runScript('ROLLBACK');
      throw error;
    }
    return { run, duplicateFile: false };
  }

  /** Newest first, including empty/replay-only evidence runs for auditability. */
  billingImportRuns(limit = 50): BillingImportRun[] {
    const safeLimit = Math.max(1, Math.min(500, Math.floor(limit)));
    const rows = this.db.prepare(
      `SELECT import_id AS importId, imported_at_ms AS importedAtMs, format, schema_version AS schemaVersion,
              importer_version AS importerVersion, file_name AS fileName, file_sha256 AS fileSha256,
              file_size_bytes AS fileSizeBytes, source_system AS sourceSystem, source_export_id AS sourceExportId,
              provider, billing_account_ref AS billingAccountRef, exported_at_ms AS exportedAtMs,
              period_start_ms AS periodStartMs, period_end_ms AS periodEndMs, coverage, trust, raw_retention AS rawRetention,
              records_seen AS recordsSeen, records_inserted AS recordsInserted, records_duplicate AS recordsDuplicate
       FROM billing_import_runs ORDER BY imported_at_ms DESC, import_id DESC LIMIT ?`,
    ).all(safeLimit) as Array<Record<string, unknown>>;
    return rows.map(billingRunFromRecord);
  }

  /** Immutable provider-declared lines, deliberately separate from requestsInRange(). */
  billingEvidenceRecords(): BillingEvidenceRecord[] {
    const rows = this.db.prepare(
      `SELECT record_id AS recordId, source_system AS sourceSystem, billing_account_ref AS billingAccountRef,
              source_record_id AS sourceRecordId, source_record_sha256 AS sourceRecordSha256,
              first_import_id AS firstImportId, source_export_id AS sourceExportId, provider,
              provider_project_ref AS providerProjectRef, service, sku, model, region, observed_at_ms AS observedAtMs,
              charge_period_start_ms AS chargePeriodStartMs, charge_period_end_ms AS chargePeriodEndMs,
              charge_type AS chargeType, currency, amount_micros AS amountMicros, usage_unit AS usageUnit,
              usage_quantity AS usageQuantity, cost_basis AS costBasis, trust
       FROM billing_evidence_records
       ORDER BY charge_period_start_ms ASC, source_record_id ASC`,
    ).all() as Array<Record<string, unknown>>;
    return rows.map(billingRecordFromRecord);
  }

  /** Provider-declared USD total only. It is not a reconciliation or a request-ledger total. */
  billingSummary(): BillingSummary {
    const imports = this.db.prepare(
      `SELECT COUNT(*) AS importCount, MAX(imported_at_ms) AS lastImportedAtMs FROM billing_import_runs`,
    ).get() as { importCount: number; lastImportedAtMs: number | null };
    const records = this.db.prepare(
      `SELECT COUNT(*) AS recordCount, COALESCE(SUM(amount_micros), 0) AS providerReportedUsdMicros
       FROM billing_evidence_records`,
    ).get() as { recordCount: number; providerReportedUsdMicros: number };
    return {
      importCount: Number(imports.importCount),
      recordCount: Number(records.recordCount),
      providerReportedUsdMicros: Number(records.providerReportedUsdMicros),
      lastImportedAtMs: imports.lastImportedAtMs === null ? null : Number(imports.lastImportedAtMs),
      reconciliationStatus: 'not_reconciled',
    };
  }

  /**
   * Retain one direct OpenAI Costs API attempt. Failed and partial attempts are
   * audit rows only: they store no usable provider observations. Successful
   * attempts retain their own snapshot lines, even when a later pull changes a
   * daily provider line. Nothing here mutates or contributes to request spend.
   */
  recordOpenAiCostsObservation(input: OpenAiCostsObservationInput): OpenAiCostsObservationRun {
    const text = (value: string, label: string, pattern: RegExp): void => {
      if (!pattern.test(value)) throw new Error(`OpenAI Costs ${label} is invalid`);
    };
    text(input.declaredScopeId, 'declared scope id', /^[A-Za-z0-9_-]{8,200}$/);
    text(input.providerProjectRef, 'project reference', /^proj_[A-Za-z0-9_-]+$/);
    if (!Number.isSafeInteger(input.periodStartMs) || !Number.isSafeInteger(input.periodEndMs)
      || input.periodEndMs <= input.periodStartMs || (input.periodEndMs - input.periodStartMs) % 86_400_000 !== 0) {
      throw new Error('OpenAI Costs observation range must be whole UTC days');
    }
    if (!Number.isSafeInteger(input.fetchedAtMs) || input.fetchedAtMs < 0) throw new Error('OpenAI Costs fetched time is invalid');
    if (!Number.isSafeInteger(input.pageCount) || input.pageCount < 0 || input.pageCount > 64) {
      throw new Error('OpenAI Costs page count is invalid');
    }
    if (input.pageDigestChainSha256 !== null) text(input.pageDigestChainSha256, 'page digest chain', /^[a-f0-9]{64}$/);
    const succeeded = input.resultState === 'succeeded';
    if (succeeded !== input.paginationComplete) throw new Error('OpenAI Costs success state must match complete pagination');
    if (succeeded && (input.failureCode !== null || input.pageCount < 1 || input.pageDigestChainSha256 === null)) {
      throw new Error('OpenAI Costs successful observation is incomplete');
    }
    if (!succeeded && (input.failureCode === null || input.observations.length !== 0)) {
      throw new Error('OpenAI Costs failed observation cannot expose provider lines');
    }
    const run: OpenAiCostsObservationRun = {
      observationRunId: randomUUID(),
      declaredScopeId: input.declaredScopeId,
      providerProjectRef: input.providerProjectRef,
      periodStartMs: input.periodStartMs,
      periodEndMs: input.periodEndMs,
      fetchedAtMs: input.fetchedAtMs,
      paginationComplete: input.paginationComplete,
      pageCount: input.pageCount,
      pageDigestChainSha256: input.pageDigestChainSha256,
      resultState: input.resultState,
      failureCode: input.failureCode,
      providerFinality: 'undocumented',
      trust: 'provider_observation_unreconciled',
      rawRetention: 'digest_only',
      observationsStored: input.observations.length,
      sourceKind: input.sourceKind ?? 'provider_api_pull',
    };
    const seen = new Set<string>();
    for (const observation of input.observations) {
      if (observation.providerProjectRef !== run.providerProjectRef) throw new Error('OpenAI Costs observation project does not match its declared scope');
      if (!Number.isSafeInteger(observation.bucketStartMs) || !Number.isSafeInteger(observation.bucketEndMs)
        || observation.bucketEndMs - observation.bucketStartMs !== 86_400_000
        || observation.bucketStartMs < run.periodStartMs || observation.bucketEndMs > run.periodEndMs) {
        throw new Error('OpenAI Costs observation bucket is invalid');
      }
      text(observation.lineItem, 'line item', /^[^\u0000-\u001F\u007F]{1,500}$/);
      text(observation.currency, 'currency', /^[A-Z]{3}$/);
      text(observation.amountDecimal, 'amount decimal', /^-?(?:0|[1-9]\d*)(?:\.\d+)?$/);
      const key = `${observation.bucketStartMs}\u0000${observation.bucketEndMs}\u0000${observation.lineItem}\u0000${observation.currency}`;
      if (seen.has(key)) throw new Error('OpenAI Costs observation has duplicate daily line grouping');
      seen.add(key);
    }
    const writeRun = this.db.prepare(
      `INSERT INTO openai_cost_observation_runs (
         observation_run_id, declared_scope_id, provider_project_ref, period_start_ms, period_end_ms, fetched_at_ms,
         pagination_complete, page_count, page_digest_chain_sha256, result_state, failure_code, provider_finality,
         trust, raw_retention, observations_stored, source_kind
       ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    );
    const writeLine = this.db.prepare(
      `INSERT INTO openai_cost_observation_lines (
         observation_id, observation_run_id, declared_scope_id, provider_project_ref, fetched_at_ms,
         bucket_start_ms, bucket_end_ms, line_item, currency, amount_decimal
       ) VALUES (?,?,?,?,?,?,?,?,?,?)`,
    );
    this.runScript('BEGIN');
    try {
      writeRun.run(
        run.observationRunId, run.declaredScopeId, run.providerProjectRef, run.periodStartMs, run.periodEndMs,
        run.fetchedAtMs, run.paginationComplete ? 1 : 0, run.pageCount, run.pageDigestChainSha256, run.resultState,
        run.failureCode, run.providerFinality, run.trust, run.rawRetention, run.observationsStored,
        run.sourceKind,
      );
      for (const observation of input.observations) {
        writeLine.run(
          randomUUID(), run.observationRunId, run.declaredScopeId, run.providerProjectRef, run.fetchedAtMs,
          observation.bucketStartMs, observation.bucketEndMs, observation.lineItem, observation.currency,
          observation.amountDecimal,
        );
      }
      this.runScript('COMMIT');
    } catch (error) {
      this.runScript('ROLLBACK');
      throw error;
    }
    return run;
  }

  /**
   * Plan the adoption of an already-imported operator export as a Costs
   * observation, so a reconciliation can run WITHOUT an Admin credential.
   *
   * This exists because the credential was the wrong thing to be blocked on.
   * A read-only Costs pull is the better evidence and stays the recommended
   * path, but an account owner who can export a report should not be unable to
   * reconcile merely because minting an Admin key needs a different permission
   * than reading a bill. What changes is the EVIDENCE CLASS, not the
   * arithmetic: the resulting run is stamped `operator_supplied_export` and
   * carries a fifth permanent condition saying nothing in it was obtained from
   * the provider by Fiscus.
   *
   * Read-only: this computes a plan and writes nothing. Everything it cannot
   * adopt is REPORTED with its amount rather than dropped — an adoption that
   * quietly discarded an account-level credit would understate the provider
   * side and turn a missing line into a fake residual.
   */
  planOpenAiCostsAdoption(input: { importId: string; declaredScopeId: string; providerProjectRef: string }): OpenAiCostsAdoptionPlan {
    const run = this.billingImportRuns(500).find((r) => r.importId === input.importId);
    if (!run) return { adoptable: false, refusal: 'no_such_import', detail: `no billing import ${input.importId}` };
    if (run.provider !== 'openai') {
      return { adoptable: false, refusal: 'import_is_not_openai', detail: `import ${input.importId} is for ${run.provider}` };
    }

    const all = this.billingEvidenceRecords().filter((r) => r.firstImportId === input.importId);
    if (all.length === 0) {
      // Every row was a replay of an earlier import, so this import id owns
      // none of them. Adopting it would silently observe nothing.
      return { adoptable: false, refusal: 'import_owns_no_records', detail: `import ${input.importId} inserted no new charge lines` };
    }

    const matched = all.filter((r) => r.providerProjectRef === input.providerProjectRef);
    const excludedOtherProject = all.filter((r) => r.providerProjectRef !== input.providerProjectRef);
    if (matched.length === 0) {
      return {
        adoptable: false,
        refusal: 'no_records_for_declared_project',
        detail: `no charge line in ${input.importId} carries providerProjectRef ${input.providerProjectRef}`,
      };
    }

    const currencies = [...new Set(matched.map((r) => r.currency))].sort();
    if (currencies.length > 1 || currencies[0] !== 'USD') {
      return {
        adoptable: false,
        refusal: 'records_are_not_single_currency_usd',
        detail: `the matched lines report ${currencies.join(', ')}; no rate is applied here`,
      };
    }
    const nonDaily = matched.filter((r) => r.chargePeriodEndMs - r.chargePeriodStartMs !== DAY_MS
      || r.chargePeriodStartMs % DAY_MS !== 0);
    if (nonDaily.length > 0) {
      return {
        adoptable: false,
        refusal: 'records_are_not_whole_utc_days',
        detail: `${nonDaily.length} matched line(s) do not cover exactly one UTC day; the provider bucket grain is the only grain that joins`,
      };
    }

    const byKey = new Map<string, { bucketStartMs: number; lineItem: string; micros: number }>();
    for (const record of matched) {
      const lineItem = record.sku || record.service || 'unspecified';
      const key = `${record.chargePeriodStartMs}\u0000${lineItem}`;
      const entry = byKey.get(key) ?? { bucketStartMs: record.chargePeriodStartMs, lineItem, micros: 0 };
      entry.micros += record.amountMicros;
      byKey.set(key, entry);
    }
    const observations: OpenAiCostObservation[] = [...byKey.values()]
      .sort((a, b) => (a.bucketStartMs - b.bucketStartMs) || a.lineItem.localeCompare(b.lineItem))
      .map((entry) => ({
        providerProjectRef: input.providerProjectRef,
        bucketStartMs: entry.bucketStartMs,
        bucketEndMs: entry.bucketStartMs + DAY_MS,
        lineItem: entry.lineItem,
        currency: 'USD',
        amountDecimal: microsToDecimal(entry.micros),
      }));

    const days = observations.map((o) => o.bucketStartMs);
    return {
      adoptable: true,
      importId: input.importId,
      declaredScopeId: input.declaredScopeId,
      providerProjectRef: input.providerProjectRef,
      periodStartMs: Math.min(...days),
      periodEndMs: Math.max(...days) + DAY_MS,
      fileSha256: run.fileSha256,
      // An operator declaration even when it says `complete`. Carried onto the
      // plan so a partial export cannot become a silent under-report of the
      // provider side, which would read as off-path spend that never happened.
      declaredCoverage: run.coverage,
      observations,
      matchedRecordCount: matched.length,
      matchedMicros: matched.reduce((sum, r) => sum + r.amountMicros, 0),
      excluded: {
        otherOrNoProjectRecordCount: excludedOtherProject.length,
        otherOrNoProjectMicros: excludedOtherProject.reduce((sum, r) => sum + r.amountMicros, 0),
      },
    };
  }

  /** Record an adoption plan as an observation. Refuses anything not adoptable. */
  adoptOpenAiCostsFromImport(plan: OpenAiCostsAdoptionPlan, adoptedAtMs = Date.now()): OpenAiCostsObservationRun {
    if (!plan.adoptable) throw new Error(`refusing to adopt: ${plan.refusal} — ${plan.detail}`);
    return this.recordOpenAiCostsObservation({
      declaredScopeId: plan.declaredScopeId,
      providerProjectRef: plan.providerProjectRef,
      periodStartMs: plan.periodStartMs,
      periodEndMs: plan.periodEndMs,
      fetchedAtMs: adoptedAtMs,
      paginationComplete: true,
      // One "page": the operator's file. Its SHA-256 is genuinely the digest of
      // the only artifact that produced these lines, so the field keeps its
      // meaning rather than being repurposed.
      pageCount: 1,
      pageDigestChainSha256: plan.fileSha256,
      resultState: 'succeeded',
      failureCode: null,
      observations: plan.observations,
      sourceKind: 'operator_supplied_export',
    });
  }

  /**
   * What the local side of a reconciliation would actually contain, split by
   * why each row does or does not qualify.
   *
   * Built after hitting the failure on a real machine: a ledger can hold
   * hundreds of dollars of genuine OpenAI spend and still reconcile to a local
   * side of ZERO, because every row arrived by native import rather than
   * through the proxy. Reconciliation counts only proxy traffic carrying the
   * declaration, and it has to — an imported row records the model and the cost
   * but nothing that ties it to the declared provider project, so counting it
   * would be inventing the very attribution the layer refuses to invent.
   *
   * Surfacing this BEFORE the credential step is the whole point. Discovering
   * it afterwards means someone minted an Admin key for nothing.
   */
  openAiReconciliationCoverage(declaredScopeId: string | null): ReconciliationCoverage | null {
    const row = this.db.prepare(
      `SELECT
         COALESCE(SUM(CASE WHEN via = 'proxy' AND scope_capture_status = 'declared_unverified'
                            AND provider_scope_declaration_id = ? THEN cost_usd END), 0) AS onUsd,
         COALESCE(SUM(CASE WHEN via = 'proxy' AND scope_capture_status = 'declared_unverified'
                            AND provider_scope_declaration_id = ? THEN 1 END), 0) AS onReq,
         COALESCE(SUM(CASE WHEN via = 'import' THEN cost_usd END), 0) AS importedUsd,
         COALESCE(SUM(CASE WHEN via = 'import' THEN 1 END), 0) AS importedReq,
         COALESCE(SUM(CASE WHEN via = 'proxy' AND NOT (scope_capture_status = 'declared_unverified'
                            AND provider_scope_declaration_id = ?) THEN cost_usd END), 0) AS offUsd,
         COALESCE(SUM(CASE WHEN via = 'proxy' AND NOT (scope_capture_status = 'declared_unverified'
                            AND provider_scope_declaration_id = ?) THEN 1 END), 0) AS offReq,
         COUNT(*) AS total
       FROM requests WHERE provider = 'openai'`,
    ).get(declaredScopeId, declaredScopeId, declaredScopeId, declaredScopeId) as Record<string, unknown>;
    if (Number(row.total) === 0) return null;
    return {
      onDeclaredRouteUsd: Number(row.onUsd),
      onDeclaredRouteRequests: Number(row.onReq),
      importedUsd: Number(row.importedUsd),
      importedRequests: Number(row.importedReq),
      proxyOffScopeUsd: Number(row.offUsd),
      proxyOffScopeRequests: Number(row.offReq),
    };
  }

  /** Newest first; includes failed pulls so a finance owner can see freshness failures. */
  openAiCostsObservationRuns(limit = 50): OpenAiCostsObservationRun[] {
    const safeLimit = Math.max(1, Math.min(500, Math.floor(limit)));
    const rows = this.db.prepare(
      `SELECT observation_run_id AS observationRunId, declared_scope_id AS declaredScopeId,
              provider_project_ref AS providerProjectRef, period_start_ms AS periodStartMs, period_end_ms AS periodEndMs,
              fetched_at_ms AS fetchedAtMs, pagination_complete AS paginationComplete, page_count AS pageCount,
              page_digest_chain_sha256 AS pageDigestChainSha256, result_state AS resultState, failure_code AS failureCode,
              provider_finality AS providerFinality, trust, raw_retention AS rawRetention,
              observations_stored AS observationsStored, source_kind AS sourceKind
         FROM openai_cost_observation_runs
        ORDER BY fetched_at_ms DESC, observation_run_id DESC LIMIT ?`,
    ).all(safeLimit) as Array<Record<string, unknown>>;
    return rows.map(openAiCostsRunFromRecord);
  }

  /** Latest fully paginated successful snapshot only; failed runs never become a projection. */
  latestCompleteOpenAiCostsObservation(): { run: OpenAiCostsObservationRun; observations: OpenAiCostsObservationLine[] } | null {
    const row = this.db.prepare(
      `SELECT observation_run_id AS observationRunId, declared_scope_id AS declaredScopeId,
              provider_project_ref AS providerProjectRef, period_start_ms AS periodStartMs, period_end_ms AS periodEndMs,
              fetched_at_ms AS fetchedAtMs, pagination_complete AS paginationComplete, page_count AS pageCount,
              page_digest_chain_sha256 AS pageDigestChainSha256, result_state AS resultState, failure_code AS failureCode,
              provider_finality AS providerFinality, trust, raw_retention AS rawRetention,
              observations_stored AS observationsStored, source_kind AS sourceKind
         FROM openai_cost_observation_runs
        WHERE result_state = 'succeeded' AND pagination_complete = 1
        ORDER BY fetched_at_ms DESC, observation_run_id DESC LIMIT 1`,
    ).get() as Record<string, unknown> | undefined;
    if (!row) return null;
    const run = openAiCostsRunFromRecord(row);
    const observations = this.db.prepare(
      `SELECT observation_id AS observationId, observation_run_id AS observationRunId, declared_scope_id AS declaredScopeId,
              provider_project_ref AS providerProjectRef, fetched_at_ms AS fetchedAtMs, bucket_start_ms AS bucketStartMs,
              bucket_end_ms AS bucketEndMs, line_item AS lineItem, currency, amount_decimal AS amountDecimal
         FROM openai_cost_observation_lines
        WHERE observation_run_id = ?
        ORDER BY bucket_start_ms ASC, line_item ASC, currency ASC`,
    ).all(run.observationRunId) as Array<Record<string, unknown>>;
    return { run, observations: observations.map(openAiCostsLineFromRecord) };
  }

  /** Status has no financial total by design, so independent snapshots cannot be double counted. */
  openAiCostsObservationStatus(): OpenAiCostsObservationStatus {
    const latest = this.openAiCostsObservationRuns(1)[0] ?? null;
    const latestComplete = this.latestCompleteOpenAiCostsObservation()?.run ?? null;
    return { latestRun: latest, latestCompleteRun: latestComplete, reconciliationStatus: 'not_reconciled' };
  }

  /**
   * Read-only local capture coverage for the newest complete Costs snapshot.
   * It deliberately returns no provider total and no variance: a local route
   * declaration does not prove provider-account ownership or off-path coverage.
   */
  openAiCostsCaptureCoverage(): OpenAiCostsCaptureCoverage | null {
    const latest = this.latestCompleteOpenAiCostsObservation();
    if (!latest) return null;
    return buildOpenAiCostsCaptureCoverage({
      run: latest.run,
      observations: latest.observations,
      requests: this.requestsInRange(latest.run.periodStartMs, latest.run.periodEndMs),
    });
  }

  /**
   * Per-day provider totals from the newest COMPLETE observation of this period
   * that is not the one being reconciled — the evidence behind
   * `snapshotStability`. Returns null when no independent observation exists,
   * which is honestly different from "two observations agreed".
   *
   * Matched on the exact period and scope: a snapshot of a different range is
   * not an independent observation of this one, and comparing them would
   * manufacture instability out of a boundary difference.
   */
  priorOpenAiCostsDayTotals(exceptRunId: string, scopeId: string, periodStartMs: number, periodEndMs: number): Map<number, number> | null {
    const row = this.db.prepare(
      `SELECT observation_run_id AS observationRunId
         FROM openai_cost_observation_runs
        WHERE result_state = 'succeeded' AND pagination_complete = 1
          AND observation_run_id <> ? AND declared_scope_id = ?
          AND period_start_ms = ? AND period_end_ms = ?
        ORDER BY fetched_at_ms DESC, observation_run_id DESC LIMIT 1`,
    ).get(exceptRunId, scopeId, periodStartMs, periodEndMs) as Record<string, unknown> | undefined;
    if (!row) return null;
    const lines = this.db.prepare(
      `SELECT bucket_start_ms AS bucketStartMs, amount_decimal AS amountDecimal
         FROM openai_cost_observation_lines WHERE observation_run_id = ?`,
    ).all(String(row.observationRunId)) as Array<Record<string, unknown>>;
    const totals = new Map<number, number>();
    for (const line of lines) {
      const day = Number(line.bucketStartMs);
      totals.set(day, (totals.get(day) ?? 0) + usdMicros(String(line.amountDecimal), 'provider amount'));
    }
    return totals;
  }

  /**
   * Compare the newest complete provider snapshot with the local ledger.
   *
   * Read-only: computing a reconciliation does not record one. `saveReconciliationRun`
   * is a separate, explicit step, so an operator can look at a variance before
   * it becomes part of the durable record.
   */
  reconcileOpenAiCosts(opts: { materialityUsd?: number; now?: number } = {}): ReconciliationResult | null {
    const latest = this.latestCompleteOpenAiCostsObservation();
    if (!latest) return null;
    return reconcileOpenAiCosts({
      run: latest.run,
      observations: latest.observations,
      requests: this.requestsInRange(latest.run.periodStartMs, latest.run.periodEndMs),
      priorDayTotals: this.priorOpenAiCostsDayTotals(
        latest.run.observationRunId,
        latest.run.declaredScopeId,
        latest.run.periodStartMs,
        latest.run.periodEndMs,
      ),
      materialityUsd: opts.materialityUsd,
      now: opts.now,
    });
  }

  /** Persist a computed reconciliation as an immutable derived record. */
  saveReconciliationRun(result: ReconciliationRun, computedAtMs = Date.now()): string {
    const id = randomUUID();
    this.db
      .prepare(
        `INSERT INTO reconciliation_runs (
            reconciliation_run_id, observation_run_id, declared_scope_id, provider_project_ref,
            period_start_ms, period_end_ms, computed_at_ms, currency, materiality_usd,
            provider_reported_micros, local_captured_micros, unexplained_variance_micros,
            snapshot_stability, trust, result_json
         ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        id,
        result.observationRunId,
        result.declaredScopeId,
        result.providerProjectRef,
        result.periodStartMs,
        result.periodEndMs,
        computedAtMs,
        result.currency,
        result.materialityUsd,
        result.providerReportedMicros,
        result.localCapturedMicros,
        result.unexplainedVarianceMicros,
        result.snapshotStability,
        result.trust,
        JSON.stringify(result),
      );
    return id;
  }

  // ── Allocation ────────────────────────────────────────────────────────────

  upsertCostCentre(input: { costCentreId: string; name: string; owner?: string | null; createdAtMs?: number }): CostCentre {
    validateCostCentre(input);
    const createdAtMs = input.createdAtMs ?? Date.now();
    this.db
      .prepare(
        `INSERT INTO cost_centres (cost_centre_id, name, owner, created_at_ms, archived_at_ms)
         VALUES (?,?,?,?,NULL)
         ON CONFLICT(cost_centre_id) DO UPDATE SET name = excluded.name, owner = excluded.owner`,
      )
      .run(input.costCentreId, input.name, input.owner ?? null, createdAtMs);
    return this.costCentres().find((c) => c.costCentreId === input.costCentreId)!;
  }

  /** Archive rather than delete: past runs must stay explicable. */
  archiveCostCentre(costCentreId: string, archivedAtMs = Date.now()): boolean {
    const info = this.db
      .prepare('UPDATE cost_centres SET archived_at_ms = ? WHERE cost_centre_id = ? AND archived_at_ms IS NULL')
      .run(archivedAtMs, costCentreId);
    return Number(info.changes ?? 0) > 0;
  }

  costCentres(): CostCentre[] {
    const rows = this.db
      .prepare(
        `SELECT cost_centre_id AS costCentreId, name, owner, created_at_ms AS createdAtMs, archived_at_ms AS archivedAtMs
           FROM cost_centres ORDER BY cost_centre_id ASC`,
      )
      .all() as Array<Record<string, unknown>>;
    return rows.map((r) => ({
      costCentreId: String(r.costCentreId),
      name: String(r.name),
      owner: r.owner === null ? null : String(r.owner),
      createdAtMs: Number(r.createdAtMs),
      archivedAtMs: r.archivedAtMs === null ? null : Number(r.archivedAtMs),
    }));
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
    const createdAtMs = input.createdAtMs ?? Date.now();
    const existing = this.db
      .prepare('SELECT MAX(version) AS maxVersion FROM allocation_rules WHERE rule_id = ?')
      .get(input.ruleId) as Record<string, unknown> | undefined;
    const previous = existing && existing.maxVersion !== null ? Number(existing.maxVersion) : 0;
    const rule: AllocationRule = { ...input, version: previous + 1, createdAtMs };
    validateRule(rule);

    this.runScript('BEGIN');
    try {
      if (previous > 0) {
        this.db
          .prepare(
            `UPDATE allocation_rules SET effective_to_ms = ?
              WHERE rule_id = ? AND version = ? AND effective_to_ms IS NULL`,
          )
          .run(rule.effectiveFromMs, rule.ruleId, previous);
      }
      this.db
        .prepare(
          `INSERT INTO allocation_rules (
              rule_id, version, method, match_json, targets_json, priority,
              effective_from_ms, effective_to_ms, revoked_at_ms, owner, note, created_at_ms
           ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
        )
        .run(
          rule.ruleId,
          rule.version,
          rule.method,
          JSON.stringify(rule.match),
          JSON.stringify(rule.targets),
          rule.priority,
          rule.effectiveFromMs,
          rule.effectiveToMs,
          rule.revokedAtMs,
          rule.owner,
          rule.note,
          rule.createdAtMs,
        );
      this.runScript('COMMIT');
    } catch (err) {
      this.runScript('ROLLBACK');
      throw err;
    }
    return rule;
  }

  /** Withdraw a rule from a point in time forward. The row is retained. */
  revokeAllocationRule(ruleId: string, revokedAtMs = Date.now()): number {
    const info = this.db
      .prepare('UPDATE allocation_rules SET revoked_at_ms = ? WHERE rule_id = ? AND revoked_at_ms IS NULL')
      .run(revokedAtMs, ruleId);
    return Number(info.changes ?? 0);
  }

  /** Every rule version ever written, so a past period stays reconstructible. */
  allocationRules(): AllocationRule[] {
    const rows = this.db
      .prepare(
        `SELECT rule_id AS ruleId, version, method, match_json AS matchJson, targets_json AS targetsJson,
                priority, effective_from_ms AS effectiveFromMs, effective_to_ms AS effectiveToMs,
                revoked_at_ms AS revokedAtMs, owner, note, created_at_ms AS createdAtMs
           FROM allocation_rules ORDER BY priority ASC, rule_id ASC, version ASC`,
      )
      .all() as Array<Record<string, unknown>>;
    return rows.map((r) => ({
      ruleId: String(r.ruleId),
      version: Number(r.version),
      method: String(r.method) as AllocationRule['method'],
      match: JSON.parse(String(r.matchJson)) as AllocationRule['match'],
      targets: JSON.parse(String(r.targetsJson)) as AllocationRule['targets'],
      priority: Number(r.priority),
      effectiveFromMs: Number(r.effectiveFromMs),
      effectiveToMs: r.effectiveToMs === null ? null : Number(r.effectiveToMs),
      revokedAtMs: r.revokedAtMs === null ? null : Number(r.revokedAtMs),
      owner: r.owner === null ? null : String(r.owner),
      note: r.note === null ? null : String(r.note),
      createdAtMs: Number(r.createdAtMs),
    }));
  }

  /**
   * Allocate one closed period. Read-only — computing does not record.
   *
   * Rows are read through the alias-canonical projection so allocation totals
   * agree with `byProject`, and matched on the instant the spend happened.
   */
  allocatePeriod(periodStartMs: number, periodEndMs: number, runAtMs = Date.now()): AllocationRunResult {
    const rows: AllocatableRow[] = this.requestsInRange(periodStartMs, periodEndMs).map((r) => ({
      project: r.projectCanonical ?? r.project,
      provider: r.provider,
      model: r.model,
      source: r.source ?? null,
      user: r.user ?? null,
      tsEpochMs: r.tsEpochMs,
      costUsd: r.costUsd,
      costBasis: r.pricing?.costBasis ?? 'legacy_unknown',
    }));
    return applyAllocation({
      rows,
      rules: this.allocationRules(),
      costCentres: this.costCentres(),
      periodStartMs,
      periodEndMs,
      runAtMs,
    });
  }

  /**
   * Persist a run. Refuses a result that does not conserve its input: an
   * allocation that lost or invented money is not a record worth keeping, and
   * storing it would put an unauditable number in front of a budget owner.
   */
  saveAllocationRun(result: AllocationRunResult, computedAtMs = Date.now()): string {
    if (!result.conserves) {
      throw new Error('refusing to record an allocation run that does not conserve its input');
    }
    const id = randomUUID();
    this.db
      .prepare(
        `INSERT INTO allocation_runs (
            allocation_run_id, period_start_ms, period_end_ms, computed_at_ms,
            total_micros, allocated_micros, unallocated_micros, conserves, trust, result_json
         ) VALUES (?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        id,
        result.periodStartMs,
        result.periodEndMs,
        computedAtMs,
        result.totalMicros,
        result.allocatedMicros,
        result.unallocatedMicros,
        1,
        result.trust,
        JSON.stringify(result),
      );
    return id;
  }

  allocationRuns(limit = 20): Array<{ allocationRunId: string; computedAtMs: number; result: AllocationRunResult }> {
    const rows = this.db
      .prepare(
        `SELECT allocation_run_id AS allocationRunId, computed_at_ms AS computedAtMs, result_json AS resultJson
           FROM allocation_runs ORDER BY computed_at_ms DESC, allocation_run_id DESC LIMIT ?`,
      )
      .all(limit) as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      allocationRunId: String(row.allocationRunId),
      computedAtMs: Number(row.computedAtMs),
      result: JSON.parse(String(row.resultJson)) as AllocationRunResult,
    }));
  }

  /** Recorded reconciliation runs, newest first. */
  reconciliationRuns(limit = 20): Array<{ reconciliationRunId: string; computedAtMs: number; result: ReconciliationRun }> {
    const rows = this.db
      .prepare(
        `SELECT reconciliation_run_id AS reconciliationRunId, computed_at_ms AS computedAtMs, result_json AS resultJson
           FROM reconciliation_runs ORDER BY computed_at_ms DESC, reconciliation_run_id DESC LIMIT ?`,
      )
      .all(limit) as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      reconciliationRunId: String(row.reconciliationRunId),
      computedAtMs: Number(row.computedAtMs),
      result: JSON.parse(String(row.resultJson)) as ReconciliationRun,
    }));
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
    const declaration = newOpenAiScopeDeclaration(input);
    const select = this.db.prepare(
      `SELECT declaration_id AS declarationId, billing_account_ref AS billingAccountRef,
              provider_project_ref AS providerProjectRef, upstream_fingerprint AS upstreamFingerprint,
              upstream_display AS upstreamDisplay, declared_at_ms AS declaredAtMs
         FROM provider_scope_declarations
        WHERE provider = 'openai' AND billing_account_ref = ?
          AND provider_project_ref IS ? AND upstream_fingerprint = ?`,
    );
    this.runScript('BEGIN');
    try {
      let record = select.get(
        declaration.billingAccountRef,
        declaration.providerProjectRef,
        declaration.upstreamFingerprint,
      ) as Record<string, unknown> | undefined;
      // SQLite's UNIQUE treats NULL values as distinct. Look up first so the
      // optional provider project cannot create duplicate declarations on each
      // idempotent `scope set` invocation.
      if (!record) {
        this.db.prepare(
          `INSERT INTO provider_scope_declarations (
             declaration_id, provider, billing_account_ref, provider_project_ref, upstream_fingerprint,
             upstream_display, declared_at_ms, trust
           ) VALUES (?,?,?,?,?,?,?,?)`,
        ).run(
          declaration.declarationId, declaration.provider, declaration.billingAccountRef, declaration.providerProjectRef,
          declaration.upstreamFingerprint, declaration.upstreamDisplay, declaration.declaredAtMs, declaration.trust,
        );
        record = select.get(
          declaration.billingAccountRef,
          declaration.providerProjectRef,
          declaration.upstreamFingerprint,
        ) as Record<string, unknown> | undefined;
      }
      if (!record) throw new Error('could not persist the local OpenAI scope declaration');
      const persisted = scopeDeclarationFromRecord(record);
      this.db.prepare(
        `INSERT INTO active_provider_scope_routes (provider, declaration_id, upstream_fingerprint, activated_at_ms)
         VALUES ('openai',?,?,?)
         ON CONFLICT(provider) DO UPDATE SET declaration_id=excluded.declaration_id,
           upstream_fingerprint=excluded.upstream_fingerprint, activated_at_ms=excluded.activated_at_ms`,
      ).run(persisted.declarationId, persisted.upstreamFingerprint, input.activatedAtMs ?? Date.now());
      this.runScript('COMMIT');
      return persisted;
    } catch (error) {
      this.runScript('ROLLBACK');
      throw error;
    }
  }

  /** Stop attaching the local scope to future OpenAI-proxy rows. Historical rows are immutable. */
  clearOpenAiScope(): boolean {
    const info = this.db.prepare(`DELETE FROM active_provider_scope_routes WHERE provider = 'openai'`).run();
    return Number(info.changes ?? 0) > 0;
  }

  /** Active local declaration, if one exists. It still has unverified trust. */
  activeOpenAiScope(): ProviderScopeDeclaration | null {
    const row = this.db.prepare(
      `SELECT d.declaration_id AS declarationId, d.billing_account_ref AS billingAccountRef,
              d.provider_project_ref AS providerProjectRef, d.upstream_fingerprint AS upstreamFingerprint,
              d.upstream_display AS upstreamDisplay, d.declared_at_ms AS declaredAtMs
         FROM active_provider_scope_routes a
         JOIN provider_scope_declarations d ON d.declaration_id = a.declaration_id
        WHERE a.provider = 'openai'`,
    ).get() as Record<string, unknown> | undefined;
    return row ? scopeDeclarationFromRecord(row) : null;
  }

  /** Snapshot only when a request's resolved OpenAI endpoint exactly matches the active declaration. */
  matchingOpenAiScope(upstreamBase: string): ProviderScopeDeclaration | null {
    let fingerprint: string;
    try {
      fingerprint = normalizeOpenAiUpstream(upstreamBase).fingerprint;
    } catch {
      return null;
    }
    const active = this.activeOpenAiScope();
    return active?.upstreamFingerprint === fingerprint ? active : null;
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
