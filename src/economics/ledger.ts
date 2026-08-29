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
import { instant, type Instant } from '../epistemic/time.ts';
import { addMoney, type Money } from './money.ts';
import { economicEvent, type EconomicEvent, type EconomicEventInput } from './events.ts';
import { deserializeEconomicEvent, serializeEconomicEvent } from './serialization.ts';

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

export interface EconomicBalance {
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

export class EconomicLedger {
  private readonly db: DatabaseSync;

  public constructor(db: DatabaseSync) {
    this.db = db;
    initializeEconomicSchema(this.db);
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
    return stored === null ? null : storedRecord(stored);
  }

  /**
   * Revalidate references on every read, not only on the normal append path.
   * `Store.raw()` and SQLite tooling can write canonical bytes directly, so a
   * persisted row must not become trusted merely because its own digest is
   * valid. The path set also makes a corrupt reference cycle fail closed.
   */
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
    for (const sourceId of value.sourceEventIds) {
      if (sourceId === value.id) throw new Error(`economic event ${value.id} cannot reference itself`);
      const source = this.readStored(sourceId);
      if (source === null) throw new Error(`unknown source economic event: ${sourceId}`);
      this.validateReferenceClosure(source, visiting, validated);
    }
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
    return 'inserted';
  }

  append(value: EconomicEvent | EconomicEventInput): EconomicAppendResult {
    const item = economicEvent(value);
    const encoded = serializeEconomicEvent(item);
    return this.transaction(() => this.appendCanonical(item, encoded));
  }

  /**
   * Append while the caller owns an existing SQLite transaction. This is the
   * bridge used by Store request writes so the compatibility request row and
   * its exact economic event commit or roll back together. Callers must not
   * invoke this method outside their transaction boundary.
   */
  appendWithinTransaction(value: EconomicEvent | EconomicEventInput): EconomicAppendResult {
    const item = economicEvent(value);
    return this.appendCanonical(item, serializeEconomicEvent(item));
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

  project(asOf?: Instant): EconomicProjection {
    const boundary = asOf === undefined ? null : canonicalBoundary(asOf);
    const values = this.events(boundary ?? undefined);
    const groups = new Map<string, { amount: Money; eventIds: string[] }>();
    for (const item of values) {
      if (item.amount === null) continue;
      const key = `${item.amount.currency}\u0000${item.amount.basis}`;
      const group = groups.get(key);
      if (group === undefined) groups.set(key, { amount: item.amount, eventIds: [item.id] });
      else {
        group.amount = addMoney(group.amount, item.amount);
        group.eventIds.push(item.id);
      }
    }
    const balances = [...groups.values()]
      .map((group) => Object.freeze({ currency: group.amount.currency, basis: group.amount.basis, amount: group.amount, eventIds: Object.freeze([...group.eventIds]) }))
      .sort((a, b) => a.currency.localeCompare(b.currency) || a.basis.localeCompare(b.basis));
    return Object.freeze({
      asOf: boundary,
      eventIds: Object.freeze(values.map((item) => item.id)),
      balances: Object.freeze(balances),
    });
  }
}
