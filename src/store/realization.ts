/**
 * Realization — persisted work-unit snapshots, receipts, and repricing.
 *
 * Split out of db.ts. `Store` still owns the public method names; these are the
 * implementations behind them, operating on the shared `DatabaseSync` handle.
 *
 * This is the REALIZED VALUE side of the distinction the product is built on,
 * plus the one place a recorded cost is allowed to change. Repricing corrects
 * an estimated amount against a real rate card; it re-attributes the money half
 * of a stored snapshot and nothing else, so a price correction can never move a
 * verdict about whether work realized.
 *
 * The reads this domain needs from the request/project domains — alias
 * canonicalization, the alias-family filter, and the two window aggregates —
 * are passed in as `RealizationDeps` rather than re-implemented, so a snapshot
 * is always re-attributed by exactly the same arithmetic that produced it.
 */

import type { DatabaseSync } from 'node:sqlite';
import { runScript } from './schema.ts';
import type { RequestPricingEvidence } from '../cost/pricing.ts';
import { pricingEvidenceFromRecord } from './rows.ts';
import type { SpendBucket } from './db.ts';
import type { EconomicLedger } from '../economics/ledger.ts';
import type { Money } from '../economics/money.ts';
import { requestEconomicEventId } from '../economics/request.ts';
import { priceCorrectionEvent } from '../economics/corrections.ts';
import { economicAttributionFromRows, economicAttributionNumber } from '../economics/attribution.ts';
import { canonicalModelAttribution, type EconomicModelUnit, type EffectiveRequestRow } from './economicReadModel.ts';

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
  /**
   * Optional causal-study unit identity captured outside `unitJson` by a
   * causal-aware producer. The current realization pipeline has no source from
   * which to derive this mapping, so a populated value is a producer assertion,
   * not independent causal proof. Normal snapshots do not have this identity
   * and remain ineligible for causal lineage qualification.
   */
  causalUnitIdDigest?: string | null;
  /**
   * Which spend basis produced this snapshot's dollars: `project` when the
   * window was scoped to the unit's own project family, `window` when it was the
   * project-blind sum (the classic proxy default). Recorded so a later reprice
   * can re-attribute on the SAME basis — recomputing a project-scoped unit as a
   * window sum (or the reverse) would move its cost for a reason that has
   * nothing to do with the price change.
   */
  costScope: CostScope;
}

/**
 * How a persisted unit's dollars were attributed.
 *
 * `project` and `window` are the two real bases and are the only ones a reprice
 * can reproduce. `synthetic_demo` marks seeded units whose cost is asserted
 * rather than summed from any window — no re-attribution reproduces them, and a
 * reprice of the ledger does not make them wrong, because the ledger was never
 * their source. `legacy_unknown` predates the column: the basis is unrecoverable,
 * so such a unit is marked stale but never recomputed.
 */
export type CostScope = 'project' | 'window' | 'synthetic_demo' | 'legacy_unknown';

/** What a reprice did to the persisted realized-value snapshots. */
export interface RealizationCostSync {
  markedStale: number; // units whose window contained a repriced request
  resynced: number; // of those, re-attributed on their recorded basis
  unresolvable: number; // stale but pre-dating `cost_scope`, so left stale on purpose
  costUsdBefore: number; // Σ attributed cost of the resynced units, before
  costUsdAfter: number; // …and after
}

export interface RepriceUpdate {
  requestId: string;
  costUsd: number;
  pricing: RequestPricingEvidence;
  /** Exact replacement when the request already has canonical economic history. */
  economicAmount?: Money;
}

/** One append-only price change, with the evidence on both sides of it. */
export interface RequestPriceEvent {
  eventId: number;
  requestId: string;
  action: 'reprice';
  appliedAtMs: number;
  previousCostUsd: number;
  previousEstimated: boolean;
  previousPricing: RequestPricingEvidence;
  newCostUsd: number;
  newEstimated: boolean;
  newPricing: RequestPricingEvidence;
}

/**
 * The request/project-domain reads a re-attribution depends on. Supplied by the
 * facade so re-attribution uses the ledger's own aggregates, never a second
 * implementation of them that could drift.
 */
export interface RealizationDeps {
  /** Alias-family filter for a column, as `byProject` and `summary` apply it. */
  familyFilter: (column: string, project: string) => { sql: string; args: string[] };
  canonicalProject: (name: string) => string;
  summary: (startMs: number, endMs: number, project?: string) => SpendBucket;
  byModel: (
    startMs: number,
    endMs: number,
    project?: string,
  ) => Array<SpendBucket & { provider: string; cacheReadTokens: number; cacheWriteTokens: number }>;
  /** Exact request rows used to keep persisted value snapshots in step. */
  economicRequestRows?: (startMs: number, endMs: number, project?: string) => EffectiveRequestRow[];
  /** Exact provider/model groups used to keep model-trial attribution in step. */
  economicModelUnits?: (startMs: number, endMs: number, project?: string) => EconomicModelUnit[];
  /** Shared economic ledger; exact reprices must append through this handle. */
  economicLedger?: EconomicLedger;
}

export function saveReceipt(
  db: DatabaseSync,
  r: { unit: string; project: string; tsEpochMs: number; realized: boolean; receiptJson: string },
): void {
  db
    .prepare(
      `INSERT INTO receipts (unit, project, ts_epoch_ms, realized, receipt_json)
         VALUES (?,?,?,?,?)
         ON CONFLICT(unit) DO UPDATE SET
           ts_epoch_ms=excluded.ts_epoch_ms, realized=excluded.realized, receipt_json=excluded.receipt_json`,
    )
    .run(r.unit, r.project, r.tsEpochMs, r.realized ? 1 : 0, r.receiptJson);
}

export function getReceipt(db: DatabaseSync, unit: string): string | null {
  const row = db.prepare(`SELECT receipt_json AS j FROM receipts WHERE unit = ?`).get(unit) as
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
export function saveRealizationUnits(db: DatabaseSync, records: RealizationUnitRecord[]): void {
  const stmt = db.prepare(
    `INSERT INTO realization_units
         (commit_hash, project, ts_epoch_ms, computed_at_ms, attributed_cost_usd, maturing, realized, unit_json,
          causal_unit_id_digest, cost_scope, cost_stale)
       VALUES (?,?,?,?,?,?,?,?,?,?,0)
       ON CONFLICT(commit_hash) DO UPDATE SET
         project=excluded.project, ts_epoch_ms=excluded.ts_epoch_ms, computed_at_ms=excluded.computed_at_ms,
         attributed_cost_usd=excluded.attributed_cost_usd, maturing=excluded.maturing,
         realized=excluded.realized, unit_json=excluded.unit_json,
         causal_unit_id_digest=COALESCE(excluded.causal_unit_id_digest, realization_units.causal_unit_id_digest),
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
      r.causalUnitIdDigest ?? null,
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
export function realizationUnitRows(
  db: DatabaseSync,
  deps: RealizationDeps,
  project?: string,
): Array<{ unitJson: string; computedAtMs: number; costStale: boolean }> {
  const fam = project ? deps.familyFilter('project', project) : null;
  const sql =
    `SELECT unit_json AS unitJson, computed_at_ms AS computedAtMs, cost_stale AS costStale FROM realization_units` +
    (fam ? ` WHERE ${fam.sql}` : ``) +
    ` ORDER BY ts_epoch_ms DESC`;
  const stmt = db.prepare(sql);
  const rows = (fam ? stmt.all(...fam.args) : stmt.all()) as Array<{
    unitJson: string;
    computedAtMs: number;
    costStale: number;
  }>;
  return rows.map((r) => ({ unitJson: r.unitJson, computedAtMs: r.computedAtMs, costStale: Boolean(r.costStale) }));
}

/** How many stored realization units exist (optionally scoped to one project). */
export function countRealizationUnits(db: DatabaseSync, deps: RealizationDeps, project?: string): number {
  const fam = project ? deps.familyFilter('project', project) : null;
  const sql = `SELECT COUNT(*) AS n FROM realization_units` + (fam ? ` WHERE ${fam.sql}` : ``);
  const stmt = db.prepare(sql);
  const row = (fam ? stmt.get(...fam.args) : stmt.get()) as { n: number };
  return row.n;
}

/** Distinct projects that have stored realization snapshots — the budget owner's rows. */
export function realizationProjects(db: DatabaseSync): string[] {
  const rows = db
    .prepare(
      `SELECT DISTINCT COALESCE(a.canonical, u.project) AS project
         FROM realization_units u LEFT JOIN project_aliases a ON a.alias = u.project
         ORDER BY project`,
    )
    .all() as Array<{ project: string }>;
  return rows.map((r) => r.project);
}

/** Every row priced with a fallback/family-match rate — the reprice candidates. */
export function estimatedRequestRows(db: DatabaseSync): Array<{
  requestId: string;
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheWriteTokens: number;
  cacheReadTokens: number;
  costUsd: number;
}> {
  return db
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
export function applyRepricedCosts(
  db: DatabaseSync,
  deps: RealizationDeps,
  updates: RepriceUpdate[],
  appliedAtMs: number,
): RealizationCostSync {
  const prior = db.prepare(
    `SELECT cost_usd AS costUsd, estimated, ts_epoch_ms AS tsEpochMs, project,
              cost_basis AS CostBasis, rate_card_sha256 AS RateCardSha256,
              rate_card_source_kind AS RateCardSourceKind, rate_match_kind AS RateMatchKind,
              rate_match_provider AS RateMatchProvider, rate_match_model AS RateMatchModel
       FROM requests WHERE request_id = ?`,
  );
  const update = db.prepare(
    `UPDATE requests
       SET cost_usd = ?, estimated = 0,
           cost_basis = ?, rate_card_sha256 = ?, rate_card_source_kind = ?, rate_match_kind = ?,
           rate_match_provider = ?, rate_match_model = ?
       WHERE request_id = ? AND estimated = 1`,
  );
  const event = db.prepare(
    `INSERT INTO request_price_events (
         request_id, action, applied_at_ms, previous_cost_usd, previous_estimated,
         previous_cost_basis, previous_rate_card_sha256, previous_rate_card_source_kind,
         previous_rate_match_kind, previous_rate_match_provider, previous_rate_match_model,
         new_cost_usd, new_estimated, new_cost_basis, new_rate_card_sha256,
         new_rate_card_source_kind, new_rate_match_kind, new_rate_match_provider, new_rate_match_model
       ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  );
  const touched: Array<{ tsEpochMs: number; project: string }> = [];
  runScript(db, 'BEGIN');
  try {
    for (const u of updates) {
      const old = prior.get(u.requestId) as Record<string, unknown> | undefined;
      if (!old || !Boolean(old.estimated)) continue;
      const exactSource = deps.economicLedger?.read(requestEconomicEventId(u.requestId)) ?? null;
      if (exactSource !== null) {
        if (u.economicAmount === undefined) {
          throw new Error(`exact reprice for request ${u.requestId} requires an exact replacement amount`);
        }
        const recordedAt = new Date(appliedAtMs).toISOString();
        const correction = priceCorrectionEvent({
          id: `economic:request:${u.requestId}:price-corrected`,
          source: exactSource,
          previousAmount: exactSource.amount!,
          nextAmount: u.economicAmount,
          recordedAt,
        });
        deps.economicLedger!.appendWithinTransaction(correction);
      }
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
    const sync = syncRealizationCosts(db, deps, touched);
    runScript(db, 'COMMIT');
    return sync;
  } catch (e) {
    runScript(db, 'ROLLBACK');
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
function syncRealizationCosts(
  db: DatabaseSync,
  deps: RealizationDeps,
  repriced: Array<{ tsEpochMs: number; project: string }>,
): RealizationCostSync {
  const empty: RealizationCostSync = { markedStale: 0, resynced: 0, unresolvable: 0, costUsdBefore: 0, costUsdAfter: 0 };
  if (repriced.length === 0) return empty;

  const rows = db
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
    const c = deps.canonicalProject(name);
    canonical.set(name, c);
    return c;
  };
  const priced = repriced.map((r) => ({ tsEpochMs: r.tsEpochMs, project: canon(r.project) }));

  const markStale = db.prepare(`UPDATE realization_units SET cost_stale = 1 WHERE commit_hash = ?`);
  const writeBack = db.prepare(
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
    const spend = deps.summary(startMs, endMs, scoped);
    const modelSpend = deps.byModel(startMs, endMs, scoped);
    const economicRows = deps.economicRequestRows?.(startMs, endMs, scoped);
    const economic = economicRows === undefined ? undefined : economicAttributionFromRows(economicRows);
    const modelAuthority = economicRows === undefined ? undefined : canonicalModelAttribution(economicRows);
    const totalLines = Number(unit.linesAdded ?? 0) + Number(unit.linesDeleted ?? 0);

    const projectedCost = economic === undefined
      ? spend.costUsd
      : economicAttributionNumber(economic, spend.costUsd);
    unit.attributedCostUsd = projectedCost;
    unit.attributedRequests = spend.requests;
    unit.attributedOutputTokens = spend.outputTokens;
    unit.costPerHundredLines = totalLines > 0 ? (projectedCost / totalLines) * 100 : null;
    // The canonical exact projection owns the winner. Partial coverage has no
    // winner; all-legacy snapshots keep only a display label and remain
    // unpriceable in the frontier through null cost/share.
    unit.dominantProvider = modelAuthority?.coverage === 'exact'
      ? modelAuthority.dominant?.provider ?? null
      : modelAuthority?.coverage === 'legacy_unknown'
        ? modelSpend[0]?.provider ?? null
        : null;
    unit.dominantModel = modelAuthority?.coverage === 'exact'
      ? modelAuthority.dominant?.model ?? null
      : modelAuthority?.coverage === 'legacy_unknown'
        ? modelSpend[0]?.label ?? null
        : null;
    unit.dominantModelCostUsd = modelAuthority?.coverage === 'exact' ? modelAuthority.dominantCostUsd : null;
    unit.dominantModelCostShare = modelAuthority?.coverage === 'exact' ? modelAuthority.dominantShare : null;
    if (modelAuthority?.coverage === 'exact' && modelAuthority.dominant !== null) unit.dominantModelEconomic = modelAuthority.dominant.economic;
    if (economic !== undefined) unit.economic = economic;

    writeBack.run(projectedCost, JSON.stringify(unit), row.commitHash);
    out.resynced += 1;
    out.costUsdBefore += row.attributedCostUsd;
    out.costUsdAfter += projectedCost;
  }
  return out;
}

/** How many persisted snapshots are carrying pre-reprice dollars. */
export function countStaleRealizationUnits(db: DatabaseSync): number {
  const row = db.prepare(`SELECT COUNT(*) AS n FROM realization_units WHERE cost_stale = 1`).get() as { n: number };
  return row.n;
}

/** Append-only price changes for one request, oldest first. */
export function requestPriceEvents(db: DatabaseSync, requestId: string): RequestPriceEvent[] {
  const rows = db.prepare(
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
