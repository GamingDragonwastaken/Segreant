/**
 * Append-only SQLite ledger and deterministic projections for economic events.
 *
 * The ledger stores canonical JSON plus a digest. It never stores a mutable
 * balance and never sums unlike Money bases together; projections group by the
 * exact currency/basis identity and can be replayed at a recorded-time
 * boundary.
 */

import type { DatabaseSync } from 'node:sqlite';
import { initializeEconomicSchema } from '../store/schema.ts';
import { instant, intervalContains, type Instant } from '../epistemic/time.ts';
import { addMoney, compareMoney, formatMoneyAmount, money, moneyFromJson, negateMoney, subtractMoney, type Money } from './money.ts';
import { economicEvent, economicEventRole, type EconomicEvent, type EconomicEventInput, type EconomicEventRole } from './events.ts';
import { deserializeEconomicEvent, deserializeHistoricalRateObservation, serializeEconomicEvent, serializeHistoricalRateObservation, type SerializedHistoricalRateObservation } from './serialization.ts';
import { applyExactRate, historicalRateBook as buildHistoricalRateBook, historicalRateObservation, rateFromJson, type HistoricalRateBook, type HistoricalRateObservation, type HistoricalRateObservationInput } from './rate.ts';
import { translateEffectiveChargeFromRateBook, type EffectiveFxChargeProjection } from './fx.ts';
import { canonicalPeriod, closeFinalizationMetadata, closeInvalidationMetadata, closeProjectionDigest, closeReopenMetadata, isCloseKind, type CloseFinalizationMetadata, type CloseInvalidationMetadata, type CloseProjectionBalance, type CloseReopenMetadata, type EconomicPeriod } from './close.ts';

export type EconomicAppendResult = 'inserted' | 'duplicate';

interface StoredEconomicRow {
  event_id: string;
  event_kind: string;
  subject: string;
  occurred_at: string;
  recorded_at: string;
  event_json: string;
  event_digest: string;
}

interface StoredHistoricalRateRow {
  observation_id: string;
  recorded_at: string;
  supersedes_id: string | null;
  observation_json: string;
  observation_digest: string;
}

export interface EconomicBalance {
  readonly role: EconomicEventRole;
  readonly currency: string;
  readonly basis: Money['basis'];
  readonly amount: Money;
  readonly eventIds: readonly string[];
}

export interface EconomicProjection {
  readonly asOf: Instant | null;
  readonly eventIds: readonly string[];
  readonly balances: readonly EconomicBalance[];
}

export type PeriodCloseState = 'open' | 'finalized' | 'reopened' | 'conflicted';

export interface EconomicPeriodCloseStatus {
  readonly periodStartMs: number;
  readonly periodEndMs: number;
  readonly asOf: Instant | null;
  readonly status: PeriodCloseState;
  readonly activeFinalizationId: string | null;
  readonly latestFinalizationId: string | null;
  readonly latestReopenId: string | null;
  readonly projectionDigest: string | null;
  readonly eventCount: number | null;
}

export interface PeriodFinalizationResult {
  readonly status: 'finalized';
  readonly eventId: string;
  readonly periodStartMs: number;
  readonly periodEndMs: number;
  readonly recordedAt: Instant;
  readonly projectionDigest: string;
  readonly eventCount: number;
  readonly balances: readonly CloseProjectionBalance[];
  readonly sourceEventIds: readonly string[];
}

export interface PeriodReopenResult {
  readonly status: 'reopened';
  readonly eventId: string;
  readonly periodStartMs: number;
  readonly periodEndMs: number;
  readonly recordedAt: Instant;
  readonly reason: string;
  readonly reopenedFinalizationId: string;
}

export interface PeriodFinalizationInput {
  readonly periodStartMs: number;
  readonly periodEndMs: number;
  readonly recordedAt?: Instant;
  readonly id?: string;
}

export interface PeriodReopenInput {
  readonly periodStartMs: number;
  readonly periodEndMs: number;
  readonly recordedAt?: Instant;
  readonly reason: string;
  readonly id?: string;
}

export interface PeriodRecoveryInput {
  readonly periodStartMs: number;
  readonly periodEndMs: number;
  readonly closeEventId: string;
  readonly recordedAt: Instant;
  readonly reason: string;
  readonly id?: string;
}

export interface PeriodRecoveryResult {
  readonly status: 'recovered';
  readonly eventId: string;
  readonly periodStartMs: number;
  readonly periodEndMs: number;
  readonly recordedAt: Instant;
  readonly reason: string;
  readonly invalidatedFinalizationId: string;
}

/** One charge after any visible, validated local price correction. */
export interface EffectiveEconomicCharge {
  readonly sourceEventId: string;
  readonly sourceAmount: Money;
  readonly amount: Money;
  readonly eventIds: readonly string[];
  readonly sourceBases: readonly Money['basis'][];
}

function row<T>(value: unknown): T | null {
  return value === undefined ? null : value as T;
}

function canonicalBoundary(value: Instant): Instant {
  if (typeof value !== 'string') throw new Error('economic projection asOf must be canonical UTC ISO-8601');
  try {
    return instant(value);
  } catch (error) {
    throw new Error(`economic projection asOf: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function storedRecord(rowValue: StoredEconomicRow): EconomicEvent {
  if (typeof rowValue.event_json !== 'string' || typeof rowValue.event_digest !== 'string') throw new Error(`stored economic event ${rowValue.event_id} is malformed`);
  let parsed: unknown;
  try { parsed = JSON.parse(rowValue.event_json); } catch { throw new Error(`stored economic event ${rowValue.event_id} has invalid JSON`); }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error(`stored economic event ${rowValue.event_id} JSON root is invalid`);
  const schemaVersion = (parsed as { schemaVersion?: unknown }).schemaVersion;
  const id = (parsed as { id?: unknown }).id;
  const item = deserializeEconomicEvent({
    kind: 'economic_event',
    schemaVersion: schemaVersion as number,
    id: id as string,
    body: rowValue.event_json,
    digest: rowValue.event_digest,
  });
  if (item.id !== rowValue.event_id || item.kind !== rowValue.event_kind || item.subject !== rowValue.subject || item.occurredAt !== rowValue.occurred_at || item.recordedAt !== rowValue.recorded_at) {
    throw new Error(`stored economic event ${rowValue.event_id} failed physical identity verification`);
  }
  return item;
}

function storedHistoricalRateObservation(rowValue: StoredHistoricalRateRow): HistoricalRateObservation {
  if (typeof rowValue.observation_id !== 'string'
      || typeof rowValue.recorded_at !== 'string'
      || (rowValue.supersedes_id !== null && typeof rowValue.supersedes_id !== 'string')
      || typeof rowValue.observation_json !== 'string'
      || typeof rowValue.observation_digest !== 'string') {
    throw new Error(`stored historical FX rate observation ${String(rowValue.observation_id)} is malformed`);
  }
  const item = deserializeHistoricalRateObservation({
    kind: 'historical_fx_rate_observation',
    schemaVersion: 1,
    id: rowValue.observation_id,
    body: rowValue.observation_json,
    digest: rowValue.observation_digest,
  } satisfies SerializedHistoricalRateObservation);
  if (item.id !== rowValue.observation_id
      || item.recordedAt !== rowValue.recorded_at
      || item.supersedes !== rowValue.supersedes_id) {
    throw new Error(`stored historical FX rate observation ${rowValue.observation_id} failed physical identity verification`);
  }
  return item;
}

function closeBalances(events: readonly EconomicEvent[]): CloseProjectionBalance[] {
  const groups = new Map<string, { role: EconomicEventRole; currency: string; basis: Money['basis']; amount: Money; eventIds: string[] }>();
  for (const item of events) {
    if (item.amount === null) continue;
    const role = economicEventRole(item.kind);
    const key = item.amount.currency + '\u0000' + item.amount.basis + '\u0000' + role;
    const group = groups.get(key);
    if (group === undefined) {
      groups.set(key, {
        role,
        currency: item.amount.currency,
        basis: item.amount.basis,
        amount: item.amount,
        eventIds: [item.id],
      });
    } else {
      group.amount = addMoney(group.amount, item.amount);
      group.eventIds.push(item.id);
    }
  }
  return [...groups.values()]
    .map((group) => Object.freeze({
      role: group.role,
      currency: group.currency,
      basis: group.basis,
      amount: group.amount,
      eventIds: Object.freeze([...group.eventIds].sort()),
    }))
    .sort((a, b) => a.currency.localeCompare(b.currency) || a.basis.localeCompare(b.basis) || a.role.localeCompare(b.role));
}

export class EconomicLedger {
  private readonly db: DatabaseSync;

  public constructor(db: DatabaseSync) {
    this.db = db;
    initializeEconomicSchema(this.db);
    this.backfillSourceLinks();
  }

  /**
   * Upgrade rows written before the normalized link table existed. The links
   * are a deterministic projection of the already-authenticated event JSON,
   * not a rewrite of economic history. A missing source or malformed event
   * aborts the upgrade so an old database cannot open with a partial graph.
   */
  private backfillSourceLinks(): void {
    const rows = this.db.prepare(
      'SELECT event_id, event_kind, subject, occurred_at, recorded_at, event_json, event_digest FROM economic_events ORDER BY event_id ASC',
    ).all() as unknown as StoredEconomicRow[];
    if (rows.length === 0) return;
    const has = this.db.prepare(
      'SELECT 1 AS present FROM economic_event_sources WHERE event_id = ? AND source_event_id = ?',
    );
    const add = this.db.prepare(
      'INSERT INTO economic_event_sources (event_id, source_event_id) VALUES (?, ?)',
    );
    this.db.prepare('BEGIN IMMEDIATE').run();
    try {
      for (const rowValue of rows) {
        const value = storedRecord(rowValue);
        for (const sourceId of value.sourceEventIds) {
          if (has.get(value.id, sourceId) === undefined) add.run(value.id, sourceId);
        }
      }
      this.db.prepare('COMMIT').run();
    } catch (error) {
      try { this.db.prepare('ROLLBACK').run(); } catch { /* preserve original failure */ }
      throw error;
    }
  }

  private transaction<T>(work: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = work();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      try { this.db.exec('ROLLBACK'); } catch { /* preserve original failure */ }
      throw error;
    }
  }

  private readStored(id: string): EconomicEvent | null {
    const stored = row<StoredEconomicRow>(this.db.prepare(
      'SELECT event_id, event_kind, subject, occurred_at, recorded_at, event_json, event_digest FROM economic_events WHERE event_id = ?',
    ).get(id));
    if (stored === null) return null;
    const value = storedRecord(stored);
    const links = this.db.prepare(
      'SELECT source_event_id AS sourceEventId FROM economic_event_sources WHERE event_id = ? ORDER BY source_event_id ASC',
    ).all(id) as Array<{ sourceEventId: string }>;
    const expected = [...value.sourceEventIds].sort();
    const actual = links.map((link) => link.sourceEventId);
    if (actual.length !== expected.length || actual.some((sourceId, index) => sourceId !== expected[index])) {
      throw new Error(`stored economic event ${id} source links diverge from its canonical record`);
    }
    return value;
  }

  private readHistoricalRateRows(asOf?: Instant): readonly HistoricalRateObservation[] {
    const boundary = asOf === undefined ? null : canonicalBoundary(asOf);
    const query = boundary === null
      ? 'SELECT observation_id, recorded_at, supersedes_id, observation_json, observation_digest FROM economic_fx_rate_observations ORDER BY recorded_at ASC, observation_id ASC'
      : 'SELECT observation_id, recorded_at, supersedes_id, observation_json, observation_digest FROM economic_fx_rate_observations WHERE recorded_at <= ? ORDER BY recorded_at ASC, observation_id ASC';
    const rows = (boundary === null
      ? this.db.prepare(query).all()
      : this.db.prepare(query).all(boundary)) as unknown as StoredHistoricalRateRow[];
    return Object.freeze(rows.map(storedHistoricalRateObservation));
  }

  private hasCloseInvalidation(closeEventId: string): boolean {
    const rowValue = this.db.prepare(
      `SELECT 1 AS present
         FROM economic_event_sources AS s
         JOIN economic_events AS e ON e.event_id = s.event_id
        WHERE e.event_kind = 'close_invalidated' AND s.source_event_id = ?
        LIMIT 1`,
    ).get(closeEventId);
    return rowValue !== undefined && rowValue !== null;
  }

  private closeBindingMatches(value: EconomicEvent, period: EconomicPeriod, metadata: CloseFinalizationMetadata): boolean {
    const allEvents = this.rawEventsInOccurrenceRange(period.startMs, period.endMs)
      .filter((event) => Date.parse(event.recordedAt) <= Date.parse(value.recordedAt));
    const allIds = allEvents.map((event) => event.id).sort();
    const sourceIds = [...value.sourceEventIds].sort();
    if (sourceIds.length !== allIds.length || sourceIds.some((id, index) => id !== allIds[index])) return false;
    if (metadata.eventCount !== allIds.length) return false;
    return metadata.projectionDigest === closeProjectionDigest(period, allIds, closeBalances(allEvents));
  }

  private validateCloseEvent(value: EconomicEvent, sources: ReadonlyMap<string, EconomicEvent>): void {
    if (!isCloseKind(value.kind)) return;
    const metadata = value.kind === 'close_finalized'
      ? closeFinalizationMetadata(value.metadata)
      : value.kind === 'close_reopened'
        ? closeReopenMetadata(value.metadata)
        : closeInvalidationMetadata(value.metadata);
    const period = canonicalPeriod(metadata.periodStartMs, metadata.periodEndMs);
    if (value.subject !== period.subject) throw new Error('economic close event subject does not match its period');
    if (value.occurredAt !== period.end) throw new Error('economic close event occurrence must equal the exclusive period end');
    if (Date.parse(value.recordedAt) < period.endMs) throw new Error('economic close event recordedAt cannot precede its period end');

    if (value.kind === 'close_finalized') {
      const finalMetadata = metadata as CloseFinalizationMetadata;
      const sourceIds = [...value.sourceEventIds].sort();
      if (sourceIds.some((id, index) => id !== value.sourceEventIds[index])) {
        throw new Error('economic close finalization sourceEventIds must be sorted');
      }
      // A recovery record is itself the append-only proof that this historical
      // snapshot is no longer the active close. Keep the original bytes and
      // metadata authenticated, but do not demand that its old population
      // still match the live ledger.
      const bindingMatches = this.closeBindingMatches(value, period, finalMetadata);
      if (this.hasCloseInvalidation(value.id)) {
        if (bindingMatches) throw new Error('economic close invalidation targets a verifiable close');
        return;
      }
      if (!bindingMatches) throw new Error('economic close finalization must bind every in-period event exactly once');
      if ([...sources.values()].some((event) => isCloseKind(event.kind))) {
        throw new Error('economic close finalization cannot include another close control event');
      }
      return;
    }

    const controlMetadata = metadata as CloseReopenMetadata | CloseInvalidationMetadata;
    if (value.sourceEventIds.length !== 1 || value.sourceEventIds[0] !== controlMetadata.closeEventId) {
      throw new Error(`economic ${value.kind} must reference exactly its finalized close event`);
    }
    const source = sources.get(controlMetadata.closeEventId);
    if (source === undefined || source.kind !== 'close_finalized') {
      throw new Error(`economic ${value.kind} must reference a close_finalized event`);
    }
    const sourceMetadata = closeFinalizationMetadata(source.metadata);
    if (sourceMetadata.periodStartMs !== period.startMs || sourceMetadata.periodEndMs !== period.endMs) {
      throw new Error(`economic ${value.kind} period does not match its finalized close`);
    }
  }

  /**
   * Revalidate references on every read, not only on the normal append path.
   * `Store.raw()` and SQLite tooling can write canonical bytes directly, so a
   * persisted row must not become trusted merely because its own digest is
   * valid. The path set also makes a corrupt reference cycle fail closed.
   */
  /**
   * The underlying non-translation event a translation ultimately restates.
   *
   * `fx_translated` may take another translation as its source, so "which
   * charge is this a restatement of" is a question about the whole ancestry
   * rather than one link. Walking to the root is what lets uniqueness be keyed
   * on the charge instead of on whichever hop happens to be nearest.
   *
   * The `seen` guard is belt and braces: `validateReferenceClosure` already
   * refuses a cycle, so reaching one here would mean a database that cannot be
   * read at all. Returning the current id rather than looping forever keeps a
   * corrupt store diagnosable instead of hanging.
   */
  private translationRoot(eventId: string): string {
    const seen = new Set<string>();
    let current = eventId;
    while (!seen.has(current)) {
      seen.add(current);
      const event = this.readStored(current);
      if (event === null || event.kind !== 'fx_translated') return current;
      const next = event.sourceEventIds[0];
      if (next === undefined) return current;
      current = next;
    }
    return current;
  }

  private validateReferenceClosure(
    value: EconomicEvent,
    visiting: Set<string> = new Set<string>(),
    validated: Set<string> = new Set<string>(),
  ): void {
    if (validated.has(value.id)) return;
    if (visiting.has(value.id)) throw new Error(`economic event reference cycle detected at ${value.id}`);
    visiting.add(value.id);
    if (value.reversalOf !== null && !value.sourceEventIds.includes(value.reversalOf)) {
      throw new Error(`economic event ${value.id} reversalOf must appear in sourceEventIds`);
    }
    const sources = new Map<string, EconomicEvent>();
    for (const sourceId of value.sourceEventIds) {
      if (sourceId === value.id) throw new Error(`economic event ${value.id} cannot reference itself`);
      const source = this.readStored(sourceId);
      if (source === null) throw new Error(`unknown source economic event: ${sourceId}`);
      if (Date.parse(value.recordedAt) < Date.parse(source.recordedAt)) {
        throw new Error(`economic event ${value.id} recordedAt cannot precede source ${source.id}`);
      }
      sources.set(sourceId, source);
      this.validateReferenceClosure(source, visiting, validated);
    }
    if (economicEventRole(value.kind) === 'adjustment' && value.amount !== null && value.sourceEventIds.length > 0) {
      const chargeSources = [...sources.values()].filter((source) => economicEventRole(source.kind) === 'charge');
      if (chargeSources.length !== value.sourceEventIds.length) {
        throw new Error(`economic event ${value.id} adjustment sources must all be charge events`);
      }
      for (const source of chargeSources) {
        if (source.amount === null) throw new Error(`economic event ${value.id} adjustment source ${source.id} has no monetary amount`);
        if (source.amount.currency !== value.amount.currency || source.amount.basis !== value.amount.basis) {
          throw new Error(`economic event ${value.id} adjustment must use the currency and basis of every referenced charge`);
        }
      }
    }
    if (economicEventRole(value.kind) === 'adjustment' && value.amount !== null && value.amount.coefficient < 0n && value.sourceEventIds.length > 0) {
      if (value.reversalOf === null && value.sourceEventIds.length !== 1) {
        throw new Error(`economic event ${value.id} negative adjustments with multiple charge sources require an explicit reversalOf target`);
      }
      const targetId = value.reversalOf ?? value.sourceEventIds[0];
      if (targetId !== undefined) {
        const target = sources.get(targetId);
        if (target !== undefined && economicEventRole(target.kind) === 'charge' && target.amount !== null) {
          const priorAdjustments = this.db.prepare(
            `SELECT s.event_id AS eventId
             FROM economic_event_sources AS s
             JOIN economic_events AS e ON e.event_id = s.event_id
             WHERE s.source_event_id = ? AND s.event_id <> ?
             ORDER BY s.event_id ASC`,
          ).all(target.id, value.id) as unknown as { eventId?: unknown }[];
          let adjusted = negateMoney(value.amount);
          const adjustmentIds = [value.id];
          for (const prior of priorAdjustments) {
            if (typeof prior.eventId !== 'string') continue;
            const recorded = this.readStored(prior.eventId);
            if (recorded === null || recorded.amount === null) continue;
            if (economicEventRole(recorded.kind) !== 'adjustment' || recorded.amount.coefficient >= 0n) continue;
            const recordedTarget = recorded.reversalOf
              ?? (recorded.sourceEventIds.length === 1 ? recorded.sourceEventIds[0] : null);
            if (recordedTarget !== target.id) continue;
            adjusted = addMoney(adjusted, negateMoney(recorded.amount));
            adjustmentIds.push(recorded.id);
          }
          if (compareMoney(adjusted, target.amount) > 0) {
            throw new Error(
              `economic event ${value.id} adjustments total ${formatMoneyAmount(adjusted)} `
              + `${target.amount.currency}, which exceeds the ${formatMoneyAmount(target.amount)} charge `
              + `${target.id} (${adjustmentIds.sort().join(', ')})`,
            );
          }
        }
      }
    }
    if (value.reversalOf !== null) {
      const target = sources.get(value.reversalOf);
      if (target === undefined) throw new Error(`economic event ${value.id} reversalOf must appear in sourceEventIds`);
      if (target.amount === null || value.amount === null) throw new Error(`economic event ${value.id} reversal requires monetary source and amount`);
      if (target.amount.currency !== value.amount.currency || target.amount.basis !== value.amount.basis) {
        throw new Error(`economic event ${value.id} reversal must use the source currency and basis`);
      }

      // A REVERSAL IS AN ACT, NOT A LABEL (WP-C04).
      //
      // Every conservation bound below sits inside the `allocation_reversed`
      // branch, so an event that DOES what a reversal does — points `reversalOf`
      // at a `cost_allocated` event and carries a negative allocated amount —
      // but is labelled `cost_allocated` walked past all of them. That produced
      // `allocation USD allocated -6` from a $10.00 allocation: bit for bit the
      // state the cumulative bound exists to make impossible, reached by
      // changing one string. A single disguised event of -100.00 projected -90.
      //
      // Reversing an allocation is spelled `allocation_reversed`. Refusing every
      // other kind at the boundary means the bounds cannot be reached around
      // rather than merely being harder to reach around.
      if (target.kind === 'cost_allocated' && value.kind !== 'allocation_reversed') {
        throw new Error(
          `economic event ${value.id} reverses allocation ${target.id} and must be recorded as `
          + `allocation_reversed, not ${value.kind}`,
        );
      }
      if (value.kind === 'allocation_reversed') {
        if (target.kind !== 'cost_allocated') throw new Error(`economic event ${value.id} allocation reversal must target cost_allocated`);
        if (target.subject !== value.subject) throw new Error(`economic event ${value.id} allocation reversal subject must match its source`);
        if (target.amount.coefficient < 0n) throw new Error(`economic event ${value.id} cannot reverse a negative allocation`);
        if (value.amount.coefficient > 0n) throw new Error(`economic event ${value.id} allocation reversal must be non-positive`);
        if (compareMoney(negateMoney(value.amount), target.amount) > 0) {
          throw new Error(`economic event ${value.id} allocation reversal exceeds its source amount`);
        }

        // CONSERVATION IS A PROPERTY OF THE SET, NOT OF ONE EVENT (WP-C04).
        //
        // The bound directly above is per event, so it is defeated by
        // splitting: two reversals of $8.00 against a $10.00 allocation are
        // each under it and jointly $6.00 over. The period then closed at
        // `allocation USD allocated -6` — more taken back than was ever
        // allocated, which is not a quantity that can exist.
        //
        // Same shape as the FX defect at D-090. A constructor is handed one
        // event and its source; only the STORE can see what else already
        // points at that source, so the closure check is the only place the
        // aggregate can be bounded — and being here rather than in `append`
        // means a database that already holds the split pair fails closed on
        // read instead of projecting the negative.
        //
        // Keyed on the TARGET, not on the ledger: reversing one allocation
        // must not constrain another. And placed after the single-event check
        // so a lone oversized reversal still fails for its own, more precise
        // reason.
        const priorReversals = this.db.prepare(
          `SELECT s.event_id AS eventId
           FROM economic_event_sources AS s
           JOIN economic_events AS e ON e.event_id = s.event_id
           WHERE s.source_event_id = ? AND s.event_id <> ?
           ORDER BY s.event_id ASC`,
        ).all(target.id, value.id) as unknown as { eventId?: unknown }[];
        let reversed = negateMoney(value.amount);
        const reversalIds = [value.id];
        for (const prior of priorReversals) {
          if (typeof prior.eventId !== 'string') continue;
          const recorded = this.readStored(prior.eventId);
          if (recorded === null || recorded.amount === null || recorded.reversalOf !== target.id) continue;
          reversed = addMoney(reversed, negateMoney(recorded.amount));
          reversalIds.push(recorded.id);
        }
        if (compareMoney(reversed, target.amount) > 0) {
          throw new Error(
            `economic event ${value.id} allocation reversals total ${formatMoneyAmount(reversed)} `
            + `${target.amount.currency}, which exceeds the ${formatMoneyAmount(target.amount)} allocated by `
            + `${target.id} (${reversalIds.sort().join(', ')})`,
          );
        }
      }
    }
    if (value.kind === 'price_corrected') {
      if (value.reversalOf !== null) throw new Error(`economic event ${value.id} price correction must not use reversalOf`);
      if (value.sourceEventIds.length !== 1) throw new Error(`economic event ${value.id} price correction requires exactly one source event`);
      const sourceId = value.sourceEventIds[0];
      if (sourceId === undefined) throw new Error(`economic event ${value.id} price correction source is missing`);
      const source = sources.get(sourceId);
      if (source === undefined) throw new Error(`economic event ${value.id} price correction source is missing`);
      const sourceRole = economicEventRole(source.kind);
      if (sourceRole !== 'charge' && sourceRole !== 'price') {
        throw new Error(
          `economic event ${value.id} price correction source must be a charge or prior correction `
          + `(received ${source.kind})`,
        );
      }
      if (source.kind !== 'charge_estimated' && source.kind !== 'price_corrected') {
        throw new Error(`economic event ${value.id} price correction must target a local charge_estimated or prior price_corrected event`);
      }
      if (source.amount === null) throw new Error(`economic event ${value.id} price correction predecessor must have a monetary amount`);
      let predecessorAmount = source.amount;
      if (source.kind === 'charge_estimated' && source.amount.basis !== 'list' && source.amount.basis !== 'estimated') {
        throw new Error(`economic event ${value.id} price correction must target a local charge_estimated event`);
      }
      if (source.kind === 'price_corrected') {
        const predecessorMetadata = source.metadata;
        if (predecessorMetadata === null || typeof predecessorMetadata !== 'object' || Array.isArray(predecessorMetadata)) {
          throw new Error(`economic event ${value.id} price correction predecessor metadata is missing typed amounts`);
        }
        const predecessorKeys = Object.keys(predecessorMetadata).sort();
        if (predecessorKeys.join('\u0000') !== ['correction', 'nextAmount', 'previousAmount'].join('\u0000')) {
          throw new Error(`economic event ${value.id} price correction predecessor metadata has unknown or missing fields`);
        }
        const predecessorRecord = predecessorMetadata as { correction?: unknown; previousAmount?: unknown; nextAmount?: unknown };
        if (predecessorRecord.correction !== 'reprice') throw new Error(`economic event ${value.id} price correction predecessor metadata correction must be reprice`);
        let predecessorPrevious: Money;
        let predecessorNext: Money;
        try {
          predecessorPrevious = moneyFromJson(predecessorRecord.previousAmount as Parameters<typeof moneyFromJson>[0]);
          predecessorNext = moneyFromJson(predecessorRecord.nextAmount as Parameters<typeof moneyFromJson>[0]);
        } catch (error) {
          throw new Error(`economic event ${value.id} price correction predecessor metadata has invalid typed amounts: ${error instanceof Error ? error.message : String(error)}`);
        }
        if (predecessorNext.coefficient < 0n || predecessorPrevious.currency !== source.amount.currency || predecessorPrevious.basis !== source.amount.basis || predecessorNext.currency !== source.amount.currency || predecessorNext.basis !== source.amount.basis || compareMoney(subtractMoney(predecessorNext, predecessorPrevious), source.amount) !== 0) {
          throw new Error(`economic event ${value.id} price correction predecessor metadata does not reproduce its delta`);
        }
        predecessorAmount = predecessorNext;
      }
      if (source.subject !== value.subject) throw new Error(`economic event ${value.id} price correction subject must match its source`);
      if (value.occurredAt !== source.occurredAt) throw new Error(`economic event ${value.id} price correction occurredAt must match its source occurrence`);
      if (value.amount === null) throw new Error(`economic event ${value.id} price correction requires a monetary delta`);
      if (predecessorAmount.coefficient < 0n) throw new Error(`economic event ${value.id} price correction predecessor amount must be non-negative`);
      if (value.amount.currency !== predecessorAmount.currency || value.amount.basis !== predecessorAmount.basis) {
        throw new Error(`economic event ${value.id} price correction must use the predecessor currency and basis`);
      }
      const metadata = value.metadata;
      if (metadata === null || typeof metadata !== 'object' || Array.isArray(metadata)) {
        throw new Error(`economic event ${value.id} price correction metadata must contain typed previousAmount and nextAmount`);
      }
      const keys = Object.keys(metadata).sort();
      if (keys.join('\u0000') !== ['correction', 'nextAmount', 'previousAmount'].join('\u0000')) {
        throw new Error(`economic event ${value.id} price correction metadata must contain exactly correction, previousAmount, and nextAmount`);
      }
      const record = metadata as { correction?: unknown; previousAmount?: unknown; nextAmount?: unknown };
      if (record.correction !== 'reprice') throw new Error(`economic event ${value.id} price correction metadata correction must be reprice`);
      let previous: Money;
      let next: Money;
      try {
        previous = moneyFromJson(record.previousAmount as Parameters<typeof moneyFromJson>[0]);
        next = moneyFromJson(record.nextAmount as Parameters<typeof moneyFromJson>[0]);
      } catch (error) {
        throw new Error(`economic event ${value.id} price correction metadata has invalid typed amounts: ${error instanceof Error ? error.message : String(error)}`);
      }
      if (compareMoney(previous, predecessorAmount) !== 0) throw new Error(`economic event ${value.id} price correction previousAmount must equal its predecessor next amount`);
      if (next.currency !== predecessorAmount.currency || next.basis !== predecessorAmount.basis) {
        throw new Error(`economic event ${value.id} price correction nextAmount must use the predecessor currency and basis`);
      }
      if (next.coefficient < 0n) throw new Error(`economic event ${value.id} price correction nextAmount must be non-negative`);
      if (compareMoney(subtractMoney(next, previous), value.amount) !== 0) {
        throw new Error(`economic event ${value.id} price correction amount must equal nextAmount minus previousAmount`);
      }
      const priorCorrections = this.db.prepare(
        `SELECT s.event_id AS eventId
         FROM economic_event_sources AS s
         JOIN economic_events AS e ON e.event_id = s.event_id
         WHERE s.source_event_id = ? AND s.event_id <> ? AND e.event_kind = 'price_corrected'
         LIMIT 1`,
      ).get(source.id, value.id) as { eventId?: unknown } | undefined;
      if (priorCorrections !== undefined && typeof priorCorrections.eventId === 'string') {
        throw new Error(`economic event ${value.id} price correction source ${source.id} already has a correction`);
      }
    }
    if (value.kind === 'fx_translated') {
      if (value.reversalOf !== null) throw new Error(`economic event ${value.id} FX translation must not use reversalOf`);
      if (value.sourceEventIds.length !== 1) throw new Error(`economic event ${value.id} FX translation requires exactly one source event`);
      const sourceId = value.sourceEventIds[0];
      if (sourceId === undefined) throw new Error(`economic event ${value.id} FX translation source is missing`);
      const source = sources.get(sourceId);
      if (source === undefined || source.amount === null) throw new Error(`economic event ${value.id} FX translation must target a monetary source`);
      const sourceRole = economicEventRole(source.kind);
      if (sourceRole !== 'charge' && sourceRole !== 'translation') {
        throw new Error(
          `economic event ${value.id} FX translation source must be a charge or prior FX translation `
          + `(received ${source.kind})`,
        );
      }
      if (source.subject !== value.subject) throw new Error(`economic event ${value.id} FX translation subject must match its source`);
      if (value.occurredAt !== source.occurredAt) throw new Error(`economic event ${value.id} FX translation occurrence must match its source`);
      if (value.amount === null) throw new Error(`economic event ${value.id} FX translation requires a monetary amount`);
      if (value.amount.currency === source.amount.currency || value.amount.basis !== source.amount.basis) {
        throw new Error(`economic event ${value.id} FX translation must change currency while preserving basis`);
      }
      const metadata = value.metadata;
      if (metadata === null || typeof metadata !== 'object' || Array.isArray(metadata)) {
        throw new Error(`economic event ${value.id} FX translation metadata is missing historical lineage`);
      }
      const metadataKeys = Object.keys(metadata).sort();
      if (metadataKeys.join('\u0000') !== ['convention', 'effectiveAt', 'rate', 'rateSource', 'rounding', 'sourceAmount'].join('\u0000')) {
        throw new Error(`economic event ${value.id} FX translation metadata must contain exactly sourceAmount, rate, rateSource, effectiveAt, convention, and rounding`);
      }
      const record = metadata as { sourceAmount?: unknown; rate?: unknown; rateSource?: unknown; effectiveAt?: unknown; convention?: unknown; rounding?: unknown };
      let sourceAmount: Money;
      try {
        sourceAmount = moneyFromJson(record.sourceAmount as Parameters<typeof moneyFromJson>[0]);
      } catch (error) {
        throw new Error(`economic event ${value.id} FX translation sourceAmount is invalid: ${error instanceof Error ? error.message : String(error)}`);
      }
      if (compareMoney(sourceAmount, source.amount) !== 0) throw new Error(`economic event ${value.id} FX translation sourceAmount must equal its source amount`);
      if (record.rate === null || typeof record.rate !== 'object' || Array.isArray(record.rate)) throw new Error(`economic event ${value.id} FX translation rate is missing`);
      const rateRecord = record.rate as Record<string, unknown>;
      const rateKeys = Object.keys(rateRecord).sort();
      const expectedRateKeys = ['denominator', 'numerator', 'sourceUnit', 'targetUnit'];
      if (Object.prototype.hasOwnProperty.call(rateRecord, 'validTime')) expectedRateKeys.push('validTime');
      expectedRateKeys.sort();
      if (rateKeys.join('\u0000') !== expectedRateKeys.join('\u0000')) {
        throw new Error(`economic event ${value.id} FX translation rate contains unknown or missing fields`);
      }
      let rate;
      try {
        rate = rateFromJson(rateRecord as unknown as Parameters<typeof rateFromJson>[0]);
      } catch (error) {
        throw new Error(`economic event ${value.id} FX translation rate is invalid: ${error instanceof Error ? error.message : String(error)}`);
      }
      if (rate.numerator <= 0n || rate.denominator <= 0n) throw new Error(`economic event ${value.id} FX translation rate must be positive`);
      if (rate.sourceUnit !== source.amount.currency || rate.targetUnit !== value.amount.currency) {
        throw new Error(`economic event ${value.id} FX translation rate currency identity does not match source and target`);
      }
      if (rate.targetUnit === rate.sourceUnit) throw new Error(`economic event ${value.id} FX translation must change currency`);
      if (typeof record.rateSource !== 'string' || record.rateSource.trim().length === 0) throw new Error(`economic event ${value.id} FX translation rateSource must be non-empty`);
      let effectiveAt: Instant;
      try {
        effectiveAt = instant(record.effectiveAt as string);
      } catch (error) {
        throw new Error(`economic event ${value.id} FX translation effectiveAt is invalid: ${error instanceof Error ? error.message : String(error)}`);
      }
      if (rate.validTime !== undefined && !intervalContains(rate.validTime, effectiveAt)) {
        throw new Error(`economic event ${value.id} FX translation effectiveAt must fall within the rate validTime interval`);
      }
      if (record.convention !== 'source-to-target') throw new Error(`economic event ${value.id} FX translation convention must be source-to-target`);
      if (record.rounding !== 'none') throw new Error(`economic event ${value.id} FX translation rounding must be none`);
      if (Date.parse(effectiveAt) > Date.parse(value.occurredAt)) throw new Error(`economic event ${value.id} FX translation effectiveAt cannot be after occurrence`);
      let expected: Money;
      try {
        expected = applyExactRate(source.amount, rate, source.amount.basis);
      } catch (error) {
        throw new Error(`economic event ${value.id} FX translation cannot be reproduced exactly: ${error instanceof Error ? error.message : String(error)}`);
      }
      if (compareMoney(expected, value.amount) !== 0) throw new Error(`economic event ${value.id} FX translation amount does not match its historical rate`);

      // ONE TRANSLATION PER SOURCE AND TARGET CURRENCY (WP-C03).
      //
      // A translation is a DERIVATIVE: it restates one charge in a second
      // currency without the charge ceasing to be true. `closeBalances` groups
      // by currency + basis + role and sums within a group, so two translations
      // of one charge into one currency land in the same group and are added —
      // a $10.00 bill translated at 0.9 and again at 0.8 closed at EUR 17,
      // which is neither answer and no rate produces it.
      //
      // `fxTranslationEvent` cannot catch this: it sees its own source and
      // nothing else. Uniqueness of a derivative is a property of the STORE, so
      // the closure check is the only place that can refuse it — and being here
      // rather than in `append` alone means a database that already holds the
      // pair fails closed on read instead of projecting their sum.
      //
      // `price_corrected`, the other single-source derivative, has carried
      // exactly this guard from the start (see `priorCorrections` above). This
      // is the missing half of a pair, not a new rule.
      //
      // Keyed on the PAIR, not the source: translating one charge into EUR and
      // into GBP is not double counting, because those are separate balance
      // groups that are never summed. And placed last in this block on purpose,
      // so a malformed second translation still fails for its own reason.
      // KEYED ON THE ROOT CHARGE, NOT THE IMMEDIATE SOURCE. The first form of
      // this guard compared immediate sources, which stops `bill -> GBP` twice
      // and does nothing about `bill -> GBP` alongside `bill -> EUR -> GBP`:
      // the chain's immediate source is the EUR translation, so nothing
      // connected it back to the bill. Both land in the same
      // `GBP + list + translation` group and are summed — a USD 10.00 charge
      // projected as GBP 12.50, which is neither the direct rate's 8.00 nor the
      // chained rate's 4.50. The thing being restated is the underlying charge,
      // however many hops away, so that is what the key has to be.
      //
      // Chaining ITSELF stays legal. With no direct USD->GBP rate to hand,
      // restating the EUR translation in GBP is the honest way to reach GBP.
      // The rule is one live translation per root and target currency, not a
      // ban on translations of translations.
      const root = this.translationRoot(source.id);
      const priorTranslations = this.db.prepare(
        "SELECT event_id AS eventId FROM economic_events WHERE event_kind = 'fx_translated' AND event_id <> ? ORDER BY event_id ASC",
      ).all(value.id) as unknown as { eventId?: unknown }[];
      for (const prior of priorTranslations) {
        if (typeof prior.eventId !== 'string') continue;
        const recorded = this.readStored(prior.eventId);
        if (recorded === null || recorded.amount === null) continue;
        if (recorded.amount.currency !== value.amount.currency) continue;
        if (this.translationRoot(recorded.id) !== root) continue;
        throw new Error(
          `economic event ${value.id} FX translation source ${root} is already translated into `
          + `${value.amount.currency} by ${recorded.id}`,
        );
      }
    }
    this.validateCloseEvent(value, sources);
    visiting.delete(value.id);
    validated.add(value.id);
  }

  private appendCanonical(item: EconomicEvent, encoded: ReturnType<typeof serializeEconomicEvent>): EconomicAppendResult {
    const existing = row<StoredEconomicRow>(this.db.prepare(
      'SELECT event_id, event_kind, subject, occurred_at, recorded_at, event_json, event_digest FROM economic_events WHERE event_id = ?',
    ).get(item.id));
    if (existing !== null) {
      const replay = storedRecord(existing);
      this.validateReferenceClosure(replay);
      const replayEncoded = serializeEconomicEvent(replay);
      if (replayEncoded.body !== encoded.body || replayEncoded.digest !== encoded.digest) {
        throw new Error(`different economic event already exists for ${item.id}`);
      }
      return 'duplicate';
    }
    for (const sourceId of item.sourceEventIds) {
      const source = this.read(sourceId);
      if (source === null) throw new Error(`unknown source economic event: ${sourceId}`);
    }
    this.validateReferenceClosure(item);
    this.db.prepare(
      'INSERT INTO economic_events (event_id, event_kind, subject, occurred_at, recorded_at, event_json, event_digest) VALUES (?, ?, ?, ?, ?, ?, ?)',
    ).run(item.id, item.kind, item.subject, item.occurredAt, item.recordedAt, encoded.body, encoded.digest);
    const link = this.db.prepare(
      'INSERT INTO economic_event_sources (event_id, source_event_id) VALUES (?, ?)',
    );
    for (const sourceId of item.sourceEventIds) link.run(item.id, sourceId);
    return 'inserted';
  }

  periodCloseStatus(startMs: number, endMs: number, asOf?: Instant): EconomicPeriodCloseStatus {
    const period = canonicalPeriod(startMs, endMs);
    const boundary = asOf === undefined ? null : canonicalBoundary(asOf);
    const values = this.events(boundary ?? undefined);
    let status: PeriodCloseState = 'open';
    let activeFinalizationId: string | null = null;
    let latestFinalizationId: string | null = null;
    let latestReopenId: string | null = null;
    let latestMetadata: CloseFinalizationMetadata | null = null;

    for (const value of values) {
      if (value.kind === 'close_finalized') {
        const metadata = closeFinalizationMetadata(value.metadata);
        if (metadata.periodStartMs !== period.startMs || metadata.periodEndMs !== period.endMs) continue;
        latestFinalizationId = value.id;
        latestMetadata = metadata;
        if (status === 'finalized') {
          status = 'conflicted';
        } else if (status !== 'conflicted') {
          status = 'finalized';
          activeFinalizationId = value.id;
        }
      } else if (value.kind === 'close_reopened') {
        const metadata = closeReopenMetadata(value.metadata);
        if (metadata.periodStartMs !== period.startMs || metadata.periodEndMs !== period.endMs) continue;
        latestReopenId = value.id;
        if (status !== 'finalized' || activeFinalizationId !== metadata.closeEventId) {
          status = 'conflicted';
        } else {
          status = 'reopened';
          activeFinalizationId = null;
        }
      } else if (value.kind === 'close_invalidated') {
        const metadata = closeInvalidationMetadata(value.metadata);
        if (metadata.periodStartMs !== period.startMs || metadata.periodEndMs !== period.endMs) continue;
        if (latestFinalizationId !== metadata.closeEventId) {
          status = 'conflicted';
        } else {
          status = 'reopened';
          activeFinalizationId = null;
        }
      }
    }

    return Object.freeze({
      periodStartMs: period.startMs,
      periodEndMs: period.endMs,
      asOf: boundary,
      status,
      activeFinalizationId,
      latestFinalizationId,
      latestReopenId,
      projectionDigest: latestMetadata?.projectionDigest ?? null,
      eventCount: latestMetadata?.eventCount ?? null,
    });
  }

  /**
   * May this event be recorded, given every close this ledger has ever recorded?
   *
   * TWO RULES, NOT ONE, AND THE SECOND WAS MISSING. The first is the period's
   * current state: while a period is `finalized` or `conflicted`, an in-period
   * event is refused until somebody reopens it. That guards the CURRENT state.
   *
   * `validateCloseEvent` guards something wider. It re-derives what a stored
   * `close_finalized` should have bound — every in-period event whose
   * `recordedAt` is at or before the close's own — and requires that to equal
   * what it did bind, which is how a deleted or forged in-period row is caught.
   * That check applies to every close event EVER recorded, so the guard's domain
   * was narrower than the check's, and a reopened period was the gap: finalize,
   * reopen, then append an in-period event recorded BEFORE the close, and the
   * close's binding becomes false. `events()` re-validates every stored event
   * and every economic projection is built on `events()`, so `events()`,
   * `periodCloseStatus`, `finalizePeriod` and `reopenPeriod` all threw
   * permanently. The ledger is append-only: nothing removes the event, nothing
   * supersedes the close, and the state is terminal. Under this project's own
   * rule that budget enforcement fails closed on an unreadable ledger, it also
   * stopped provider forwarding for good.
   *
   * WHY THE REFUSAL IS HERE AND NOT IN THE CHECK. Comparing a stored close
   * against its own recorded snapshot would make the symptom disappear and
   * delete the tamper detection with it: a close is precisely the claim that
   * these were all the in-period events, and asking only whether it agrees with
   * itself cannot notice that one of them is gone. The invariant to keep is that
   * a recorded close stays verifiable, so what must be refused is the append
   * that would retroactively falsify one.
   *
   * WHAT REMAINS PERMITTED, which is the whole legitimate use. A reopen happens
   * after the close, and evidence recorded after that carries a later
   * `recordedAt`. `occurredAt` is untouched and may sit anywhere inside the
   * period — that is what a reopen is for. It is `recordedAt`, the time Fiscus
   * recorded the event, that may not be backdated across a close. Recorded at
   * D-100.
   */
  private assertPeriodOpenForEvent(value: EconomicEvent): void {
    if (isCloseKind(value.kind)) return;
    const eventTimes = [Date.parse(value.occurredAt)];
    for (const sourceId of value.sourceEventIds) {
      const source = this.read(sourceId);
      if (source !== null) eventTimes.push(Date.parse(source.occurredAt));
    }
    const periods = new Map<string, EconomicPeriod>();
    // The latest `recordedAt` among the closes recorded for each period. Every
    // one of them carries its own binding, so the floor is the latest rather
    // than the active one: a rule written against `activeFinalizationId` would
    // leave an earlier close falsifiable.
    const closedThrough = new Map<string, number>();
    for (const control of this.events()) {
      if (control.kind === 'close_finalized') {
        const metadata = closeFinalizationMetadata(control.metadata);
        const period = canonicalPeriod(metadata.periodStartMs, metadata.periodEndMs);
        periods.set(period.subject, period);
        const recorded = Date.parse(control.recordedAt);
        const previous = closedThrough.get(period.subject);
        if (previous === undefined || recorded > previous) closedThrough.set(period.subject, recorded);
      } else if (control.kind === 'close_reopened') {
        const metadata = closeReopenMetadata(control.metadata);
        const period = canonicalPeriod(metadata.periodStartMs, metadata.periodEndMs);
        periods.set(period.subject, period);
      }
    }
    for (const period of periods.values()) {
      const inPeriod = eventTimes.some((time) => time >= period.startMs && time < period.endMs);
      const state = this.periodCloseStatus(period.startMs, period.endMs);
      if (state.status === 'finalized' || state.status === 'conflicted') {
        if (inPeriod) {
          throw new Error('economic period ' + period.startMs + '/' + period.endMs + ' is finalized; reopen it before recording an in-period event');
        }
        continue;
      }
      const floor = closedThrough.get(period.subject);
      if (!inPeriod || floor === undefined) continue;
      if (Date.parse(value.recordedAt) <= floor) {
        throw new Error(
          'economic period ' + period.startMs + '/' + period.endMs + ' was closed through '
          + new Date(floor).toISOString() + '; an in-period event recorded at or before that instant would '
          + 'falsify a recorded close. Record it at the time Fiscus observed it — occurredAt still carries '
          + 'when it happened.',
        );
      }
    }
  }

  finalizePeriod(input: PeriodFinalizationInput): PeriodFinalizationResult {
    const period = canonicalPeriod(input.periodStartMs, input.periodEndMs);
    const recordedAt = canonicalBoundary(input.recordedAt ?? new Date().toISOString());
    if (Date.parse(recordedAt) < period.endMs) throw new Error('economic period finalization recordedAt cannot precede the period end');
    return this.transaction(() => {
      const state = this.periodCloseStatus(period.startMs, period.endMs);
      if (state.status === 'finalized') throw new Error('economic period is already finalized; reopen it before finalizing again');
      if (state.status === 'conflicted') throw new Error('economic period close state is conflicted; refuse finalization');
      const events = this.eventsInOccurrenceRange(period.startMs, period.endMs)
        .filter((event) => Date.parse(event.recordedAt) <= Date.parse(recordedAt));
      const sourceEventIds = events.map((event) => event.id).sort();
      const balances = closeBalances(events);
      const projectionDigest = closeProjectionDigest(period, sourceEventIds, balances);
      const countRow = this.db.prepare(
        'SELECT COUNT(*) AS count FROM economic_events WHERE event_kind = ? AND subject = ?',
      ).get('close_finalized', period.subject) as { count: number };
      const id = input.id ?? 'economic:close:' + period.startMs + ':' + period.endMs + ':' + (Number(countRow.count) + 1);
      const close = economicEvent({
        id,
        kind: 'close_finalized',
        subject: period.subject,
        occurredAt: period.end,
        recordedAt,
        amount: null,
        sourceEventIds,
        reversalOf: null,
        metadata: {
          closeSchemaVersion: 1,
          periodStartMs: period.startMs,
          periodEndMs: period.endMs,
          projectionDigest,
          eventCount: sourceEventIds.length,
        },
        schemaVersion: 1,
      });
      this.appendCanonical(close, serializeEconomicEvent(close));
      return Object.freeze({
        status: 'finalized' as const,
        eventId: close.id,
        periodStartMs: period.startMs,
        periodEndMs: period.endMs,
        recordedAt,
        projectionDigest,
        eventCount: sourceEventIds.length,
        balances: Object.freeze(balances),
        sourceEventIds: Object.freeze(sourceEventIds),
      });
    });
  }

  reopenPeriod(input: PeriodReopenInput): PeriodReopenResult {
    const period = canonicalPeriod(input.periodStartMs, input.periodEndMs);
    const recordedAt = canonicalBoundary(input.recordedAt ?? new Date().toISOString());
    if (Date.parse(recordedAt) < period.endMs) throw new Error('economic period reopen recordedAt cannot precede the period end');
    if (typeof input.reason !== 'string' || input.reason.trim().length === 0) throw new Error('economic period reopen reason must be non-empty');
    return this.transaction(() => {
      const state = this.periodCloseStatus(period.startMs, period.endMs);
      if (state.status !== 'finalized' || state.activeFinalizationId === null) {
        throw new Error('economic period is not actively finalized; nothing to reopen');
      }
      const countRow = this.db.prepare(
        'SELECT COUNT(*) AS count FROM economic_events WHERE event_kind = ? AND subject = ?',
      ).get('close_reopened', period.subject) as { count: number };
      const id = input.id ?? 'economic:reopen:' + period.startMs + ':' + period.endMs + ':' + (Number(countRow.count) + 1);
      const reopened = economicEvent({
        id,
        kind: 'close_reopened',
        subject: period.subject,
        occurredAt: period.end,
        recordedAt,
        amount: null,
        sourceEventIds: [state.activeFinalizationId],
        reversalOf: null,
        metadata: {
          closeSchemaVersion: 1,
          periodStartMs: period.startMs,
          periodEndMs: period.endMs,
          closeEventId: state.activeFinalizationId,
          reason: input.reason.trim(),
        },
        schemaVersion: 1,
      });
      this.appendCanonical(reopened, serializeEconomicEvent(reopened));
      return Object.freeze({
        status: 'reopened' as const,
        eventId: reopened.id,
        periodStartMs: period.startMs,
        periodEndMs: period.endMs,
        recordedAt,
        reason: input.reason.trim(),
        reopenedFinalizationId: state.activeFinalizationId,
      });
    });
  }

  /**
   * Append an explicit recovery record for a close whose historical population
   * can no longer be verified. The original close is never rewritten; the
   * recovery event makes the exceptional state part of the append-only history.
   */
  recoverBrickedPeriod(input: PeriodRecoveryInput): PeriodRecoveryResult {
    const period = canonicalPeriod(input.periodStartMs, input.periodEndMs);
    const recordedAt = canonicalBoundary(input.recordedAt);
    if (Date.parse(recordedAt) < period.endMs) throw new Error('economic period recovery recordedAt cannot precede the period end');
    if (typeof input.closeEventId !== 'string' || input.closeEventId.trim().length === 0) throw new Error('economic period recovery closeEventId must be non-empty');
    if (typeof input.reason !== 'string' || input.reason.trim().length === 0) throw new Error('economic period recovery reason must be non-empty');
    if (input.id !== undefined && (typeof input.id !== 'string' || input.id.trim().length === 0)) throw new Error('economic period recovery id must be non-empty');
    const reason = input.reason.trim();

    return this.transaction(() => {
      const close = this.readStored(input.closeEventId);
      if (close === null) throw new Error(`economic period recovery close does not exist: ${input.closeEventId}`);
      if (close.kind !== 'close_finalized') throw new Error('economic period recovery target must be a close_finalized event');
      const closeMetadata = closeFinalizationMetadata(close.metadata);
      if (closeMetadata.periodStartMs !== period.startMs || closeMetadata.periodEndMs !== period.endMs) {
        throw new Error('economic period recovery period does not match its finalized close');
      }
      if (Date.parse(recordedAt) < Date.parse(close.recordedAt)) {
        throw new Error('economic period recovery recordedAt cannot precede its finalized close');
      }

      const existingRow = row<StoredEconomicRow>(this.db.prepare(
        `SELECT e.event_id, e.event_kind, e.subject, e.occurred_at, e.recorded_at, e.event_json, e.event_digest
           FROM economic_event_sources AS s
           JOIN economic_events AS e ON e.event_id = s.event_id
          WHERE e.event_kind = 'close_invalidated' AND s.source_event_id = ?
          ORDER BY e.recorded_at ASC, e.event_id ASC
          LIMIT 1`,
      ).get(input.closeEventId));
      if (existingRow !== null) {
        const existing = storedRecord(existingRow);
        const existingMetadata = closeInvalidationMetadata(existing.metadata);
        if (existingMetadata.closeEventId !== input.closeEventId
            || existingMetadata.periodStartMs !== period.startMs
            || existingMetadata.periodEndMs !== period.endMs) {
          throw new Error('economic period recovery found a mismatched close invalidation');
        }
        this.events();
        return Object.freeze({
          status: 'recovered' as const,
          eventId: existing.id,
          periodStartMs: period.startMs,
          periodEndMs: period.endMs,
          recordedAt: existing.recordedAt,
          reason: existingMetadata.reason,
          invalidatedFinalizationId: input.closeEventId,
        });
      }

      const visibleEvents = this.rawEventsInOccurrenceRange(period.startMs, period.endMs)
        .filter((event) => Date.parse(event.recordedAt) <= Date.parse(close.recordedAt));
      const visibleIds = visibleEvents.map((event) => event.id).sort();
      const boundIds = [...close.sourceEventIds].sort();
      const expectedDigest = closeProjectionDigest(period, visibleIds, closeBalances(visibleEvents));
      const bindingMatches = boundIds.length === visibleIds.length && boundIds.every((id, index) => id === visibleIds[index]);
      if (bindingMatches && closeMetadata.eventCount === visibleIds.length && closeMetadata.projectionDigest === expectedDigest) {
        throw new Error('economic period recovery target close is not bricked');
      }

      const id = input.id ?? `economic:close-invalidation:${input.closeEventId}`;
      const invalidated = economicEvent({
        id,
        kind: 'close_invalidated',
        subject: period.subject,
        occurredAt: period.end,
        recordedAt,
        amount: null,
        sourceEventIds: [input.closeEventId],
        reversalOf: null,
        metadata: {
          closeSchemaVersion: 1,
          periodStartMs: period.startMs,
          periodEndMs: period.endMs,
          closeEventId: input.closeEventId,
          reason,
        },
        schemaVersion: 1,
      });
      const encoded = serializeEconomicEvent(invalidated);
      const sameId = row<StoredEconomicRow>(this.db.prepare(
        'SELECT event_id, event_kind, subject, occurred_at, recorded_at, event_json, event_digest FROM economic_events WHERE event_id = ?',
      ).get(invalidated.id));
      if (sameId !== null) {
        const replay = storedRecord(sameId);
        const replayEncoded = serializeEconomicEvent(replay);
        if (replayEncoded.body !== encoded.body || replayEncoded.digest !== encoded.digest) {
          throw new Error(`different economic event already exists for ${invalidated.id}`);
        }
      } else {
        this.db.prepare(
          'INSERT INTO economic_events (event_id, event_kind, subject, occurred_at, recorded_at, event_json, event_digest) VALUES (?, ?, ?, ?, ?, ?, ?)',
        ).run(invalidated.id, invalidated.kind, invalidated.subject, invalidated.occurredAt, invalidated.recordedAt, encoded.body, encoded.digest);
        this.db.prepare(
          'INSERT INTO economic_event_sources (event_id, source_event_id) VALUES (?, ?)',
        ).run(invalidated.id, input.closeEventId);
      }

      // The normal reader is the commit gate. It validates the recovery link,
      // the old close metadata, every source, and the complete append-only set.
      this.events();
      return Object.freeze({
        status: 'recovered' as const,
        eventId: invalidated.id,
        periodStartMs: period.startMs,
        periodEndMs: period.endMs,
        recordedAt,
        reason,
        invalidatedFinalizationId: input.closeEventId,
      });
    });
  }

  append(value: EconomicEvent | EconomicEventInput): EconomicAppendResult {
    const item = economicEvent(value);
    if (item.kind === 'close_invalidated') throw new Error('close_invalidated may only be issued by recoverBrickedPeriod');
    const encoded = serializeEconomicEvent(item);
    return this.transaction(() => {
      const existing = this.db.prepare('SELECT event_id FROM economic_events WHERE event_id = ?').get(item.id);
      if (existing !== undefined) return this.appendCanonical(item, encoded);
      this.assertPeriodOpenForEvent(item);
      return this.appendCanonical(item, encoded);
    });
  }

  /**
   * Append while the caller owns an existing SQLite transaction. This is the
   * bridge used by Store request writes so the compatibility request row and
   * its exact economic event commit or roll back together. Callers must not
   * invoke this method outside their transaction boundary.
   */
  appendWithinTransaction(value: EconomicEvent | EconomicEventInput): EconomicAppendResult {
    const item = economicEvent(value);
    if (item.kind === 'close_invalidated') throw new Error('close_invalidated may only be issued by recoverBrickedPeriod');
    const existing = this.db.prepare('SELECT event_id FROM economic_events WHERE event_id = ?').get(item.id);
    if (existing !== undefined) return this.appendCanonical(item, serializeEconomicEvent(item));
    this.assertPeriodOpenForEvent(item);
    return this.appendCanonical(item, serializeEconomicEvent(item));
  }

  /**
   * Append one historical FX observation through the Store-owned evidence
   * boundary. The rate book validates the explicit predecessor edge before the
   * row is written; a same-ID different observation is never replaced.
   */
  appendHistoricalRateObservation(
    value: HistoricalRateObservation | HistoricalRateObservationInput,
  ): EconomicAppendResult {
    const candidate = historicalRateObservation(value);
    const encoded = serializeHistoricalRateObservation(candidate);
    return this.transaction(() => {
      const existing = row<StoredHistoricalRateRow>(this.db.prepare(
        'SELECT observation_id, recorded_at, supersedes_id, observation_json, observation_digest FROM economic_fx_rate_observations WHERE observation_id = ?',
      ).get(candidate.id));
      if (existing !== null) {
        const persisted = storedHistoricalRateObservation(existing);
        // Validate the complete persisted graph before acknowledging a
        // duplicate. A corrupted unrelated row must not be hidden by an
        // idempotent retry.
        this.historicalRateBook();
        const persistedEncoded = serializeHistoricalRateObservation(persisted);
        if (persistedEncoded.body === encoded.body && persistedEncoded.digest === encoded.digest) return 'duplicate';
        throw new Error(`different historical rate observation already exists: ${candidate.id}`);
      }
      const existingObservations = this.readHistoricalRateRows();
      buildHistoricalRateBook([...existingObservations, candidate]);
      this.db.prepare(
        `INSERT INTO economic_fx_rate_observations
          (observation_id, recorded_at, supersedes_id, observation_json, observation_digest)
         VALUES (?, ?, ?, ?, ?)`,
      ).run(candidate.id, candidate.recordedAt, candidate.supersedes, encoded.body, encoded.digest);
      return 'inserted';
    });
  }

  /** Read the authenticated historical FX evidence visible at a recording boundary. */
  historicalRateBook(asOf?: Instant): HistoricalRateBook {
    return buildHistoricalRateBook(this.readHistoricalRateRows(asOf));
  }

  read(id: string): EconomicEvent | null {
    if (typeof id !== 'string' || id.trim().length === 0) throw new Error('economic event id is required');
    const value = this.readStored(id);
    if (value === null) return null;
    this.validateReferenceClosure(value);
    return value;
  }

  events(asOf?: Instant): readonly EconomicEvent[] {
    const boundary = asOf === undefined ? null : canonicalBoundary(asOf);
    const query = boundary === null
      ? 'SELECT event_id, event_kind, subject, occurred_at, recorded_at, event_json, event_digest FROM economic_events ORDER BY recorded_at ASC, event_id ASC'
      : 'SELECT event_id, event_kind, subject, occurred_at, recorded_at, event_json, event_digest FROM economic_events WHERE recorded_at <= ? ORDER BY recorded_at ASC, event_id ASC';
    const rows = (boundary === null ? this.db.prepare(query).all() : this.db.prepare(query).all(boundary)) as unknown as StoredEconomicRow[];
    const values = rows.map(storedRecord);
    const validated = new Set<string>();
    for (const value of values) this.validateReferenceClosure(value, new Set<string>(), validated);
    return Object.freeze(values);
  }

  /** Load authenticated event rows without reference-closure validation. */
  private rawEventsInOccurrenceRange(startMs: number, endMs: number): readonly EconomicEvent[] {
    const rows = this.db.prepare(
      'SELECT event_id, event_kind, subject, occurred_at, recorded_at, event_json, event_digest FROM economic_events WHERE occurred_at >= ? AND occurred_at < ? ORDER BY occurred_at ASC, event_id ASC',
    ).all(new Date(startMs).toISOString(), new Date(endMs).toISOString()) as unknown as StoredEconomicRow[];
    return Object.freeze(rows.map(storedRecord));
  }

  /** Read events whose modeled occurrence lies in [startMs, endMs). */
  eventsInOccurrenceRange(startMs: number, endMs: number): readonly EconomicEvent[] {
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || startMs >= endMs) {
      throw new Error('economic occurrence range must contain ordered finite timestamps');
    }
    const from = new Date(startMs);
    const to = new Date(endMs);
    if (!Number.isFinite(from.getTime()) || !Number.isFinite(to.getTime())) throw new Error('economic occurrence range is outside the supported date range');
    const rows = this.db.prepare(
      'SELECT event_id, event_kind, subject, occurred_at, recorded_at, event_json, event_digest FROM economic_events WHERE occurred_at >= ? AND occurred_at < ? ORDER BY occurred_at ASC, event_id ASC',
    ).all(from.toISOString(), to.toISOString()) as unknown as StoredEconomicRow[];
    const values = rows.map(storedRecord);
    const validated = new Set<string>();
    for (const value of values) this.validateReferenceClosure(value, new Set<string>(), validated);
    return Object.freeze(values);
  }

  /**
   * Project charge events onto the explicit `effective` basis.  The source
   * event remains retained and visible in the ordinary role-aware projection;
   * this method is the narrow consumer boundary that applies an additive local
  * price correction without creating a second accounting history.
  */
  effectiveChargesFor(sourceEventIds: readonly string[], asOf?: Instant): ReadonlyMap<string, EffectiveEconomicCharge> {
    if (!Array.isArray(sourceEventIds)) throw new Error('economic source event ids must be an array');
    for (const sourceEventId of sourceEventIds) {
      if (typeof sourceEventId !== 'string' || sourceEventId.trim().length === 0) throw new Error('economic source event id must be non-empty');
    }
    const boundary = asOf === undefined ? undefined : canonicalBoundary(asOf);
    const requested = new Set(sourceEventIds);
    if (requested.size === 0) return new Map<string, EffectiveEconomicCharge>();
    const sources = new Map<string, EconomicEvent>();
    const corrections = new Map<string, EconomicEvent[]>();
    for (const sourceId of requested) {
      const source = this.read(sourceId);
      if (source === null || (boundary !== undefined && Date.parse(source.recordedAt) > Date.parse(boundary))) continue;
      if (economicEventRole(source.kind) === 'charge' && source.amount !== null) sources.set(source.id, source);
    }
    if (sources.size > 0) {
      const recordedClause = boundary === undefined ? '' : ' AND e.recorded_at <= ?';
      const correctionRows = this.db.prepare(
        `SELECT e.event_id, e.event_kind, e.subject, e.occurred_at, e.recorded_at, e.event_json, e.event_digest
           FROM economic_events AS e
          WHERE e.event_kind = 'price_corrected'${recordedClause}
          ORDER BY e.recorded_at ASC, e.event_id ASC`,
      ).all(...(boundary === undefined ? [] : [boundary])) as unknown as StoredEconomicRow[];
      const correctionBySource = new Map<string, EconomicEvent>();
      for (const rowValue of correctionRows) {
        const correction = this.read(rowValue.event_id);
        if (correction === null) continue;
        const sourceId = correction.sourceEventIds[0];
        if (sourceId !== undefined) correctionBySource.set(sourceId, correction);
      }
      for (const sourceId of sources.keys()) {
        const chain: EconomicEvent[] = [];
        const visited = new Set<string>();
        let predecessorId = sourceId;
        while (!visited.has(predecessorId)) {
          visited.add(predecessorId);
          const correction = correctionBySource.get(predecessorId);
          if (correction === undefined) break;
          chain.push(correction);
          predecessorId = correction.id;
        }
        if (visited.has(predecessorId) && correctionBySource.has(predecessorId)) {
          throw new Error(`economic price correction chain cycles at ${predecessorId}`);
        }
        if (chain.length > 0) corrections.set(sourceId, chain);
      }
    }
    const result = new Map<string, EffectiveEconomicCharge>();
    for (const [sourceId, source] of sources) {
      let amount = source.amount!;
      const eventIds = [source.id];
      const sourceBases = new Set<Money['basis']>([source.amount!.basis]);
      for (const correction of corrections.get(sourceId) ?? []) {
        if (correction.amount === null) throw new Error(`economic price correction ${correction.id} has no amount`);
        amount = addMoney(amount, correction.amount);
        eventIds.push(correction.id);
        sourceBases.add(correction.amount.basis);
      }
      result.set(sourceId, Object.freeze({
        sourceEventId: sourceId,
        sourceAmount: source.amount!,
        amount: money(formatMoneyAmount(amount), amount.currency, 'effective'),
        eventIds: Object.freeze(eventIds),
        sourceBases: Object.freeze([...sourceBases].sort()),
      }));
    }
    return result;
  }

  /** Project one charge onto `effective`, or return null if it is not visible. */
  effectiveChargeFor(sourceEventId: string, asOf?: Instant): EffectiveEconomicCharge | null {
    if (typeof sourceEventId !== 'string' || sourceEventId.trim().length === 0) throw new Error('economic source event id is required');
    return this.effectiveChargesFor([sourceEventId], asOf).get(sourceEventId) ?? null;
  }

  /**
   * Translate the effective correction projection at one replay boundary.
   * This is deliberately a read model rather than an `fx_translated` event:
   * the latter has one raw monetary source and cannot truthfully claim to
   * contain a later price correction in that source amount.
   */
  effectiveFxChargeFor(
    sourceEventId: string,
    targetUnit: string,
    rateBook: HistoricalRateBook,
    effectiveAt?: Instant,
    asOf?: Instant,
  ): EffectiveFxChargeProjection | null {
    const source = this.read(sourceEventId);
    if (source === null) return null;
    const effective = this.effectiveChargeFor(sourceEventId, asOf);
    if (effective === null) return null;
    return translateEffectiveChargeFromRateBook({
      source,
      effectiveAmount: effective.amount,
      eventIds: effective.eventIds,
      sourceBases: effective.sourceBases,
      targetUnit,
      rateBook,
      effectiveAt: effectiveAt ?? source.occurredAt,
      ...(asOf === undefined ? {} : { rateAsOf: asOf }),
    });
  }

  /**
   * Translate one effective charge using the persisted historical rate book.
   * Without an explicit boundary, knowledge stops at the source event's own
   * recording instant; this prevents a later rate correction from silently
   * rewriting an ordinary historical read.
   */
  effectiveFxChargeFromHistoricalRates(
    sourceEventId: string,
    targetUnit: string,
    effectiveAt?: Instant,
    asOf?: Instant,
  ): EffectiveFxChargeProjection | null {
    const source = this.read(sourceEventId);
    if (source === null) return null;
    const rateAsOf = asOf === undefined ? source.recordedAt : canonicalBoundary(asOf);
    const rateBook = this.historicalRateBook(rateAsOf);
    return this.effectiveFxChargeFor(sourceEventId, targetUnit, rateBook, effectiveAt, rateAsOf);
  }

  project(asOf?: Instant): EconomicProjection {
    const boundary = asOf === undefined ? null : canonicalBoundary(asOf);
    const values = this.events(boundary ?? undefined);
    const groups = new Map<string, { amount: Money; eventIds: string[] }>();
    for (const item of values) {
      if (item.amount === null) continue;
      const role = economicEventRole(item.kind);
      const key = `${item.amount.currency}\u0000${item.amount.basis}\u0000${role}`;
      const group = groups.get(key);
      if (group === undefined) groups.set(key, { amount: item.amount, eventIds: [item.id] });
      else {
        group.amount = addMoney(group.amount, item.amount);
        group.eventIds.push(item.id);
      }
    }
    const balances = [...groups.entries()]
      .map(([key, group]) => {
        const [, , role] = key.split('\u0000');
        return Object.freeze({ role: role as EconomicEventRole, currency: group.amount.currency, basis: group.amount.basis, amount: group.amount, eventIds: Object.freeze([...group.eventIds]) });
      })
      .sort((a, b) => a.currency.localeCompare(b.currency) || a.basis.localeCompare(b.basis) || a.role.localeCompare(b.role));
    return Object.freeze({
      asOf: boundary,
      eventIds: Object.freeze(values.map((item) => item.id)),
      balances: Object.freeze(balances),
    });
  }
}
