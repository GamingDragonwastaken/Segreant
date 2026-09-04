/**
 * Allocation — cost centres, the rule book, and the runs that apply it.
 *
 * Split out of db.ts. `Store` still owns the public method names; these are the
 * implementations behind them, operating on the shared `DatabaseSync` handle.
 *
 * The distinction this domain sits on: an allocated cost is NOT a metered cost
 * and NOT a provider-billed one. It is a metered amount assigned to a budget
 * owner by a rule the operator authored, and every record here has to stay
 * reconstructible back to the rule text that actually applied at the time.
 */

import type { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { runScript } from './schema.ts';
import {
  validateCostCentre,
  validateRule,
  type AllocatableRow,
  type AllocationRule,
  type CostCentre,
} from '../alloc/rules.ts';
import { applyAllocation, type AllocationRunResult } from '../alloc/apply.ts';
import { deserializeExactAllocationRun, serializeExactAllocationRun, validateExactAllocationCloseBinding, type ExactAllocationCloseBinding, type ExactAllocationRunResult, type SerializedExactAllocationRun } from '../alloc/exact.ts';
import { EconomicLedger } from '../economics/ledger.ts';
import { addMoney, compareMoney, formatMoneyAmount, money, type Money } from '../economics/money.ts';
import { economicEventRole } from '../economics/events.ts';
import { closeFinalizationMetadata } from '../economics/close.ts';
import type { RequestRow } from './db.ts';

export function upsertCostCentre(
  db: DatabaseSync,
  input: { costCentreId: string; name: string; owner?: string | null; createdAtMs?: number },
): CostCentre {
  validateCostCentre(input);
  const createdAtMs = input.createdAtMs ?? Date.now();
  db
    .prepare(
      `INSERT INTO cost_centres (cost_centre_id, name, owner, created_at_ms, archived_at_ms)
         VALUES (?,?,?,?,NULL)
         ON CONFLICT(cost_centre_id) DO UPDATE SET name = excluded.name, owner = excluded.owner`,
    )
    .run(input.costCentreId, input.name, input.owner ?? null, createdAtMs);
  return costCentres(db).find((c) => c.costCentreId === input.costCentreId)!;
}

/** Archive rather than delete: past runs must stay explicable. */
export function archiveCostCentre(db: DatabaseSync, costCentreId: string, archivedAtMs: number): boolean {
  const info = db
    .prepare('UPDATE cost_centres SET archived_at_ms = ? WHERE cost_centre_id = ? AND archived_at_ms IS NULL')
    .run(archivedAtMs, costCentreId);
  return Number(info.changes ?? 0) > 0;
}

export function costCentres(db: DatabaseSync): CostCentre[] {
  const rows = db
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
export function saveAllocationRule(
  db: DatabaseSync,
  input: Omit<AllocationRule, 'version' | 'createdAtMs'> & { createdAtMs?: number },
): AllocationRule {
  const createdAtMs = input.createdAtMs ?? Date.now();
  const existing = db
    .prepare('SELECT MAX(version) AS maxVersion FROM allocation_rules WHERE rule_id = ?')
    .get(input.ruleId) as Record<string, unknown> | undefined;
  const previous = existing && existing.maxVersion !== null ? Number(existing.maxVersion) : 0;
  const rule: AllocationRule = { ...input, version: previous + 1, createdAtMs };
  validateRule(rule);

  runScript(db, 'BEGIN');
  try {
    if (previous > 0) {
      db
        .prepare(
          `UPDATE allocation_rules SET effective_to_ms = ?
              WHERE rule_id = ? AND version = ? AND effective_to_ms IS NULL`,
        )
        .run(rule.effectiveFromMs, rule.ruleId, previous);
    }
    db
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
    runScript(db, 'COMMIT');
  } catch (err) {
    runScript(db, 'ROLLBACK');
    throw err;
  }
  return rule;
}

/** Withdraw a rule from a point in time forward. The row is retained. */
export function revokeAllocationRule(db: DatabaseSync, ruleId: string, revokedAtMs: number): number {
  const info = db
    .prepare('UPDATE allocation_rules SET revoked_at_ms = ? WHERE rule_id = ? AND revoked_at_ms IS NULL')
    .run(revokedAtMs, ruleId);
  return Number(info.changes ?? 0);
}

/** Every rule version ever written, so a past period stays reconstructible. */
export function allocationRules(db: DatabaseSync): AllocationRule[] {
  const rows = db
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
 *
 * `requestsInRange` is passed in rather than queried here: alias resolution
 * lives with the request domain, and allocation must read spend through exactly
 * the same projection the rest of the product totals it under.
 */
export function allocatePeriod(
  db: DatabaseSync,
  requestsInRange: (startMs: number, endMs: number) => RequestRow[],
  periodStartMs: number,
  periodEndMs: number,
  runAtMs: number,
): AllocationRunResult {
  const rows: AllocatableRow[] = requestsInRange(periodStartMs, periodEndMs).map((r) => ({
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
    rules: allocationRules(db),
    costCentres: costCentres(db),
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
export function saveAllocationRun(db: DatabaseSync, result: AllocationRunResult, computedAtMs: number): string {
  if (!result.conserves) {
    throw new Error('refusing to record an allocation run that does not conserve its input');
  }
  const id = randomUUID();
  db
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

export function allocationRuns(
  db: DatabaseSync,
  limit: number,
): Array<{ allocationRunId: string; computedAtMs: number; result: AllocationRunResult }> {
  const rows = db
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

export interface ExactAllocationRunRecord {
  allocationRunId: string;
  computedAtMs: number;
  result: ExactAllocationRunResult;
  closeBinding: ExactAllocationCloseBinding;
}

function exactRunId(serialized: SerializedExactAllocationRun): string {
  return `economic:allocation:${serialized.digest.slice('sha256:'.length)}`;
}

function lineageRows(db: DatabaseSync, allocationRunId: string): Array<{ itemKind: string; itemIndex: number; sourceEventId: string }> {
  return db.prepare(
    `SELECT item_kind AS itemKind, item_index AS itemIndex, source_event_id AS sourceEventId
       FROM economic_allocation_lineage
      WHERE allocation_run_id = ?
      ORDER BY item_kind ASC, item_index ASC, source_event_id ASC`,
  ).all(allocationRunId) as Array<{ itemKind: string; itemIndex: number; sourceEventId: string }>;
}

function expectedLineage(result: ExactAllocationRunResult): Array<{ itemKind: string; itemIndex: number; sourceEventId: string }> {
  const rows: Array<{ itemKind: string; itemIndex: number; sourceEventId: string }> = [];
  for (const [itemIndex, line] of result.lines.entries()) for (const sourceEventId of line.sourceEventIds) rows.push({ itemKind: 'line', itemIndex, sourceEventId });
  for (const [itemIndex, line] of result.unallocated.entries()) for (const sourceEventId of line.sourceEventIds) rows.push({ itemKind: 'unallocated', itemIndex, sourceEventId });
  return rows.sort((a, b) => a.itemKind.localeCompare(b.itemKind) || a.itemIndex - b.itemIndex || a.sourceEventId.localeCompare(b.sourceEventId));
}

function verifyExactAllocationLineage(db: DatabaseSync, allocationRunId: string, result: ExactAllocationRunResult): void {
  const expected = expectedLineage(result);
  const actual = lineageRows(db, allocationRunId);
  if (actual.length !== expected.length || actual.some((row, index) => row.itemKind !== expected[index]!.itemKind || row.itemIndex !== expected[index]!.itemIndex || row.sourceEventId !== expected[index]!.sourceEventId)) {
    throw new Error(`exact allocation run ${allocationRunId} lineage diverges from its canonical result`);
  }
}

function insertExactAllocationLineage(db: DatabaseSync, allocationRunId: string, result: ExactAllocationRunResult): void {
  const exists = db.prepare('SELECT 1 AS present FROM economic_events WHERE event_id = ?');
  const insert = db.prepare(
    'INSERT INTO economic_allocation_lineage (allocation_run_id, item_kind, item_index, source_event_id) VALUES (?, ?, ?, ?)',
  );
  for (const row of expectedLineage(result)) {
    if (exists.get(row.sourceEventId) === undefined) throw new Error(`unknown source economic event for exact allocation: ${row.sourceEventId}`);
    insert.run(allocationRunId, row.itemKind, row.itemIndex, row.sourceEventId);
  }
}

function identityKey(amount: Money): string {
  return `${amount.currency}\u0000${amount.basis}`;
}

function sameIds(left: readonly string[], right: readonly string[]): boolean {
  const a = [...left].sort();
  const b = [...right].sort();
  return a.length === b.length && a.every((id, index) => id === b[index]);
}

function allocationSourceIds(result: ExactAllocationRunResult): readonly string[] {
  const ids = new Set<string>();
  for (const bucket of result.totalByIdentity) {
    for (const sourceEventId of bucket.sourceEventIds) ids.add(sourceEventId);
  }
  return [...ids].sort();
}

function closeBindingRow(db: DatabaseSync, allocationRunId: string): ExactAllocationCloseBinding {
  const row = db.prepare(
    `SELECT period_start_ms AS periodStartMs, period_end_ms AS periodEndMs,
            finalization_id AS finalizationId, projection_digest AS projectionDigest,
            event_count AS eventCount
       FROM economic_allocation_close_bindings
      WHERE allocation_run_id = ?`,
  ).get(allocationRunId) as Record<string, unknown> | undefined;
  if (row === undefined) {
    throw new Error(`exact allocation run ${allocationRunId} has no immutable economic close binding`);
  }
  const binding = Object.freeze({
    periodStartMs: Number(row.periodStartMs),
    periodEndMs: Number(row.periodEndMs),
    finalizationId: String(row.finalizationId),
    projectionDigest: String(row.projectionDigest),
    eventCount: Number(row.eventCount),
  });
  validateExactAllocationCloseBinding(binding, binding.periodStartMs, binding.periodEndMs);
  return binding;
}

function validateCloseBinding(
  ledger: EconomicLedger,
  result: ExactAllocationRunResult,
  binding: ExactAllocationCloseBinding,
): ExactAllocationCloseBinding {
  validateExactAllocationCloseBinding(binding, result.periodStartMs, result.periodEndMs);
  const finalization = ledger.read(binding.finalizationId);
  if (finalization === null || finalization.kind !== 'close_finalized') {
    throw new Error(`exact allocation close binding ${binding.finalizationId} is not a finalized economic close`);
  }
  const metadata = closeFinalizationMetadata(finalization.metadata);
  if (metadata.periodStartMs !== binding.periodStartMs || metadata.periodEndMs !== binding.periodEndMs
      || metadata.projectionDigest !== binding.projectionDigest || metadata.eventCount !== binding.eventCount) {
    throw new Error(`exact allocation close binding ${binding.finalizationId} does not match its immutable close metadata`);
  }
  const closeSources = new Set(finalization.sourceEventIds);
  const missing = allocationSourceIds(result).filter((sourceEventId) => !closeSources.has(sourceEventId));
  if (missing.length > 0) {
    throw new Error(`exact allocation sources were not included in close ${binding.finalizationId}: ${missing.join(', ')}`);
  }
  return binding;
}

function activeCloseBinding(ledger: EconomicLedger, result: ExactAllocationRunResult): ExactAllocationCloseBinding {
  const status = ledger.periodCloseStatus(result.periodStartMs, result.periodEndMs);
  if (status.status !== 'finalized' || status.activeFinalizationId === null) {
    throw new Error('exact allocation requires an active finalized economic close for its period');
  }
  const finalization = ledger.read(status.activeFinalizationId);
  if (finalization === null || finalization.kind !== 'close_finalized') {
    throw new Error('exact allocation active economic close is missing or invalid');
  }
  const metadata = closeFinalizationMetadata(finalization.metadata);
  const binding: ExactAllocationCloseBinding = Object.freeze({
    periodStartMs: metadata.periodStartMs,
    periodEndMs: metadata.periodEndMs,
    finalizationId: finalization.id,
    projectionDigest: metadata.projectionDigest,
    eventCount: metadata.eventCount,
  });
  return validateCloseBinding(ledger, result, binding);
}

/**
 * Prove that an exact allocation result is grounded in the economic charge
 * events it names. The allocation result's own conservation check only proves
 * that its declared total equals its declared lines; without this second check
 * a caller could fabricate a larger total and cite an unrelated or non-charge
 * event as its source.
 *
 * Every source charge is compared using the exact source-event set named by the
 * allocation. An uncorrected source may retain its original basis or the
 * compatibility `effective` basis. A corrected source must name its root charge
 * and each cited local correction, and its effective amount is recomputed from
 * those cited events only; later corrections do not rewrite an older run.
 * Provider/billed charges remain
 * charge sources; translations, usage, allocations, and adjustments do not.
 */
function validateExactAllocationSourceConservationWithLedger(
  ledger: EconomicLedger,
  result: ExactAllocationRunResult,
): void {
  const periodStart = new Date(result.periodStartMs);
  const periodEnd = new Date(result.periodEndMs);
  if (!Number.isFinite(periodStart.getTime()) || !Number.isFinite(periodEnd.getTime())) {
    throw new Error('exact allocation period is outside the supported timestamp range');
  }

  const actualByIdentity = new Map<string, { amount: Money; sourceEventIds: readonly string[] }>();
  const sourceOwner = new Map<string, string>();
  for (const bucket of result.totalByIdentity) {
    const key = identityKey(bucket.amount);
    if (actualByIdentity.has(key)) throw new Error(`exact allocation source totals contain duplicate identity: ${key}`);
    for (const sourceEventId of bucket.sourceEventIds) {
      const prior = sourceOwner.get(sourceEventId);
      if (prior !== undefined) {
        throw new Error(`exact allocation source event ${sourceEventId} is assigned to multiple identities (${prior}, ${key})`);
      }
      sourceOwner.set(sourceEventId, key);
    }
    actualByIdentity.set(key, { amount: bucket.amount, sourceEventIds: bucket.sourceEventIds });
  }

  const roots = new Map<string, Set<string>>();
  for (const sourceEventId of sourceOwner.keys()) {
    const source = ledger.read(sourceEventId);
    if (source === null) throw new Error(`exact allocation source event is missing: ${sourceEventId}`);
    const role = economicEventRole(source.kind);
    if (role === 'charge') {
      const ids = roots.get(source.id) ?? new Set<string>();
      ids.add(source.id);
      roots.set(source.id, ids);
      const occurredAt = Date.parse(source.occurredAt);
      if (occurredAt < result.periodStartMs || occurredAt >= result.periodEndMs) {
        throw new Error(`exact allocation source charge ${source.id} occurred outside the allocation period`);
      }
      continue;
    }
    if (source.kind !== 'price_corrected') {
      throw new Error(`exact allocation source ${source.id} must be a charge or local price correction (received ${source.kind})`);
    }
    if (source.sourceEventIds.length !== 1) {
      throw new Error(`exact allocation price correction ${source.id} must reference exactly one charge source`);
    }
    const rootId = source.sourceEventIds[0];
    if (rootId === undefined || !sourceOwner.has(rootId)) {
      throw new Error(`exact allocation price correction ${source.id} must be accompanied by its root charge`);
    }
    const root = ledger.read(rootId);
    if (root === null || economicEventRole(root.kind) !== 'charge') {
      throw new Error(`exact allocation price correction ${source.id} does not resolve to a charge root`);
    }
    const ids = roots.get(rootId) ?? new Set<string>();
    ids.add(source.id);
    roots.set(rootId, ids);
  }

  const expectedByIdentity = new Map<string, { amount: Money; sourceEventIds: Set<string> }>();
  for (const [rootId, providedIds] of roots) {
    const root = ledger.read(rootId);
    if (root === null || root.amount === null) throw new Error(`exact allocation charge source ${rootId} has no monetary amount`);
    const effective = ledger.effectiveChargeFor(rootId);
    if (effective === null) throw new Error(`exact allocation charge source ${rootId} has no effective charge projection`);
    const declaredIdentity = sourceOwner.get(rootId);
    if (declaredIdentity === undefined) throw new Error(`exact allocation charge source ${rootId} has no declared identity`);
    const originalIdentity = identityKey(root.amount);
    const effectiveIdentity = identityKey(effective.amount);
    const citedCorrections = [...providedIds]
      .filter((sourceEventId) => sourceEventId !== rootId)
      .map((sourceEventId) => ledger.read(sourceEventId))
      .filter((source): source is NonNullable<ReturnType<EconomicLedger['read']>> => source !== null);
    let expectedAmount = root.amount;
    const expectedIds = [rootId, ...citedCorrections.map((correction) => correction.id)];
    if (citedCorrections.length > 0) {
      if (declaredIdentity !== `${root.amount.currency}\u0000effective`) {
        throw new Error(`exact allocation corrected charge ${rootId} must use its effective economic identity`);
      }
      for (const correction of citedCorrections) {
        if (correction.kind !== 'price_corrected') {
          throw new Error(`exact allocation source ${correction.id} must be a local price correction`);
        }
        if (correction.amount === null) throw new Error(`exact allocation price correction ${correction.id} has no amount`);
        expectedAmount = addMoney(expectedAmount, correction.amount);
      }
      expectedAmount = money(formatMoneyAmount(expectedAmount), expectedAmount.currency, 'effective');
    } else if (declaredIdentity === originalIdentity) {
      // An allocation computed directly from an uncorrected charge may retain
      // that charge's original basis; this is the compatibility form used by
      // the exact allocation adapter's standalone callers.
      expectedAmount = root.amount;
    } else if (declaredIdentity === effectiveIdentity) {
      // Store.allocatePeriodExact consumes the same uncorrected charge through
      // effectiveChargesFor, so its canonical result legitimately names the
      // effective basis even though no correction event exists.
      expectedAmount = money(formatMoneyAmount(root.amount), root.amount.currency, 'effective');
    } else {
      throw new Error(`exact allocation declared identity for ${rootId} does not match its economic charge`);
    }
    const key = identityKey(expectedAmount);
    const prior = expectedByIdentity.get(key);
    if (prior === undefined) {
      expectedByIdentity.set(key, { amount: expectedAmount, sourceEventIds: new Set(expectedIds) });
    } else {
      prior.amount = addMoney(prior.amount, expectedAmount);
      for (const sourceEventId of expectedIds) prior.sourceEventIds.add(sourceEventId);
    }
  }

  if (expectedByIdentity.size !== actualByIdentity.size) {
    throw new Error('exact allocation declared source totals do not match economic charge identities');
  }
  for (const [key, expected] of expectedByIdentity) {
    const actual = actualByIdentity.get(key);
    if (actual === undefined || compareMoney(actual.amount, expected.amount) !== 0 || !sameIds(actual.sourceEventIds, [...expected.sourceEventIds])) {
      throw new Error(`exact allocation declared total for ${key} does not match its economic charge sources`);
    }
  }
}

/** Validate one exact allocation against the economic ledger on a database handle. */
export function validateExactAllocationSourceConservation(
  db: DatabaseSync,
  result: ExactAllocationRunResult,
): void {
  validateExactAllocationSourceConservationWithLedger(new EconomicLedger(db), result);
}

/** Persist one canonical exact allocation result without mutating an earlier run. */
export function saveExactAllocationRun(db: DatabaseSync, result: ExactAllocationRunResult, computedAtMs = Date.now()): string {
  if (!result.conserves) throw new Error('refusing to record an exact allocation run that does not conserve its input');
  if (!Number.isSafeInteger(computedAtMs)) throw new Error('exact allocation computedAt must be a safe timestamp');
  const serialized = serializeExactAllocationRun(result);
  const canonical = deserializeExactAllocationRun(serialized);
  const allocationRunId = exactRunId(serialized);
  const economicLedger = new EconomicLedger(db);
  runScript(db, 'BEGIN IMMEDIATE');
  try {
    const existing = db.prepare(
      `SELECT allocation_run_id AS allocationRunId, period_start_ms AS periodStartMs, period_end_ms AS periodEndMs,
              run_at_ms AS runAtMs, computed_at_ms AS computedAtMs, complete, conserves, result_json AS resultJson, result_digest AS resultDigest
         FROM economic_allocation_runs WHERE allocation_run_id = ?`,
    ).get(allocationRunId) as Record<string, unknown> | undefined;
    if (existing !== undefined) {
      if (String(existing.resultJson) !== serialized.body || String(existing.resultDigest) !== serialized.digest || Number(existing.periodStartMs) !== canonical.periodStartMs || Number(existing.periodEndMs) !== canonical.periodEndMs || Number(existing.runAtMs) !== canonical.runAtMs || Boolean(existing.complete) !== canonical.complete || Boolean(existing.conserves) !== canonical.conserves) {
        throw new Error(`different exact allocation result already exists for ${allocationRunId}`);
      }
      const existingResult = deserializeExactAllocationRun({ kind: 'exact_allocation_run', schemaVersion: 1, body: String(existing.resultJson), digest: String(existing.resultDigest) });
      const existingBinding = closeBindingRow(db, allocationRunId);
      validateCloseBinding(economicLedger, existingResult, existingBinding);
      validateExactAllocationSourceConservationWithLedger(economicLedger, existingResult);
      verifyExactAllocationLineage(db, allocationRunId, existingResult);
      runScript(db, 'COMMIT');
      return allocationRunId;
    }
    const binding = activeCloseBinding(economicLedger, canonical);
    db.prepare(
      `INSERT INTO economic_allocation_runs
          (allocation_run_id, period_start_ms, period_end_ms, run_at_ms, computed_at_ms, complete, conserves, result_json, result_digest)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(allocationRunId, canonical.periodStartMs, canonical.periodEndMs, canonical.runAtMs, computedAtMs, canonical.complete ? 1 : 0, canonical.conserves ? 1 : 0, serialized.body, serialized.digest);
    insertExactAllocationLineage(db, allocationRunId, canonical);
    validateExactAllocationSourceConservationWithLedger(economicLedger, canonical);
    verifyExactAllocationLineage(db, allocationRunId, canonical);
    db.prepare(
      `INSERT INTO economic_allocation_close_bindings
          (allocation_run_id, period_start_ms, period_end_ms, finalization_id, projection_digest, event_count)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(allocationRunId, binding.periodStartMs, binding.periodEndMs, binding.finalizationId, binding.projectionDigest, binding.eventCount);
    runScript(db, 'COMMIT');
    return allocationRunId;
  } catch (error) {
    try { runScript(db, 'ROLLBACK'); } catch { /* preserve original failure */ }
    throw error;
  }
}

/** Read and re-authenticate one exact allocation result plus every source link. */
export function exactAllocationRun(db: DatabaseSync, allocationRunId: string): ExactAllocationRunRecord | null {
  if (typeof allocationRunId !== 'string' || allocationRunId.trim().length === 0) throw new Error('exact allocation run id is required');
  const row = db.prepare(
    `SELECT allocation_run_id AS allocationRunId, period_start_ms AS periodStartMs, period_end_ms AS periodEndMs,
            run_at_ms AS runAtMs, computed_at_ms AS computedAtMs, complete, conserves, result_json AS resultJson, result_digest AS resultDigest
       FROM economic_allocation_runs WHERE allocation_run_id = ?`,
  ).get(allocationRunId) as Record<string, unknown> | undefined;
  if (row === undefined) return null;
  const result = deserializeExactAllocationRun({ kind: 'exact_allocation_run', schemaVersion: 1, body: String(row.resultJson), digest: String(row.resultDigest) });
  if (String(row.allocationRunId) !== allocationRunId || Number(row.periodStartMs) !== result.periodStartMs || Number(row.periodEndMs) !== result.periodEndMs || Number(row.runAtMs) !== result.runAtMs || Boolean(row.complete) !== result.complete || Boolean(row.conserves) !== result.conserves) throw new Error(`exact allocation run ${allocationRunId} failed physical identity verification`);
  if (!Number.isSafeInteger(Number(row.computedAtMs))) throw new Error(`exact allocation run ${allocationRunId} has an invalid computedAt timestamp`);
  const binding = closeBindingRow(db, allocationRunId);
  const economicLedger = new EconomicLedger(db);
  validateCloseBinding(economicLedger, result, binding);
  validateExactAllocationSourceConservationWithLedger(economicLedger, result);
  verifyExactAllocationLineage(db, allocationRunId, result);
  return { allocationRunId, computedAtMs: Number(row.computedAtMs), result, closeBinding: binding };
}

/** Read bounded exact allocation history, newest computation first. */
export function exactAllocationRuns(db: DatabaseSync, limit = 20): ExactAllocationRunRecord[] {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 10_000) throw new Error('exact allocation run limit must be between 1 and 10000');
  const rows = db.prepare(
    `SELECT allocation_run_id AS allocationRunId FROM economic_allocation_runs
      ORDER BY computed_at_ms DESC, allocation_run_id DESC LIMIT ?`,
  ).all(limit) as Array<{ allocationRunId: string }>;
  return rows.map((row) => {
    const result = exactAllocationRun(db, row.allocationRunId);
    if (result === null) throw new Error(`exact allocation run ${row.allocationRunId} disappeared during read`);
    return result;
  });
}
