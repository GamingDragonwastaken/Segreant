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
