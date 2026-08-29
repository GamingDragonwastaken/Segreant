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

  append(value: EconomicEvent | EconomicEventInput): EconomicAppendResult {
    const item = economicEvent(value);
    const encoded = serializeEconomicEvent(item);
    return this.transaction(() => {
      const existing = row<StoredEconomicRow>(this.db.prepare(
        'SELECT event_id, event_kind, subject, occurred_at, recorded_at, event_json, event_digest FROM economic_events WHERE event_id = ?',
      ).get(item.id));
      if (existing !== null) {
        const replay = storedRecord(existing);
        const replayEncoded = serializeEconomicEvent(replay);
        if (replayEncoded.body !== encoded.body || replayEncoded.digest !== encoded.digest) {
          throw new Error(`different economic event already exists for ${item.id}`);
        }
        return 'duplicate';
      }
      for (const sourceId of item.sourceEventIds) {
        if (this.read(sourceId) === null) throw new Error(`unknown source economic event: ${sourceId}`);
      }
      if (item.reversalOf !== null && !item.sourceEventIds.includes(item.reversalOf)) {
        throw new Error(`economic event ${item.id} reversalOf must appear in sourceEventIds`);
      }
      this.db.prepare(
        'INSERT INTO economic_events (event_id, event_kind, subject, occurred_at, recorded_at, event_json, event_digest) VALUES (?, ?, ?, ?, ?, ?, ?)',
      ).run(item.id, item.kind, item.subject, item.occurredAt, item.recordedAt, encoded.body, encoded.digest);
      return 'inserted';
    });
  }

  read(id: string): EconomicEvent | null {
    if (typeof id !== 'string' || id.trim().length === 0) throw new Error('economic event id is required');
    const stored = row<StoredEconomicRow>(this.db.prepare(
      'SELECT event_id, event_kind, subject, occurred_at, recorded_at, event_json, event_digest FROM economic_events WHERE event_id = ?',
    ).get(id));
    return stored === null ? null : storedRecord(stored);
  }

  events(asOf?: Instant): readonly EconomicEvent[] {
    const boundary = asOf === undefined ? null : canonicalBoundary(asOf);
    const boundaryMs = boundary === null ? null : Date.parse(boundary);
    const rows = this.db.prepare(
      'SELECT event_id, event_kind, subject, occurred_at, recorded_at, event_json, event_digest FROM economic_events ORDER BY recorded_at ASC, event_id ASC',
    ).all() as unknown as StoredEconomicRow[];
    const values = rows.map(storedRecord).filter((item) => boundaryMs === null || Date.parse(item.recordedAt) <= boundaryMs);
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
