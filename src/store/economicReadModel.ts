/**
 * Request-level effective economic read model.
 *
 * The immutable event ledger is the accounting authority; request rows are a
 * compatibility index that supplies grouping dimensions. This adapter joins
 * the two without mutating either one, preserving unresolved legacy rows and
 * refusing a request/event identity mismatch before a value consumer can group
 * the wrong dollars under a project, model, session, or provider.
 */

import type { RequestRow } from './db.ts';
import type { EconomicLedger } from '../economics/ledger.ts';
import type { EconomicBasis, Money } from '../economics/money.ts';
import { economicEventRole, type EconomicEventKind } from '../economics/events.ts';
import { requestEconomicEventId } from '../economics/request.ts';

export type EconomicRequestUnresolvedReason = 'no_exact_economic_event';

export interface EffectiveRequestRow {
  requestId: string;
  tsEpochMs: number;
  sessionId: string | null;
  provider: string;
  model: string;
  project: string;
  projectCanonical: string;
  source: string | null;
  user: string | null;
  via: 'proxy' | 'import';
  /** Effective exact charge, or null when this legacy row has no event. */
  effectiveAmount: Money | null;
  sourceBases: readonly EconomicBasis[];
  sourceEventIds: readonly string[];
  unresolvedReason: EconomicRequestUnresolvedReason | null;
}

function metadataRecord(value: unknown, id: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`economic request event ${id} metadata must be an object`);
  }
  return value as Record<string, unknown>;
}

function assertMatches(request: RequestRow, event: {
  id: string;
  kind: string;
  subject: string;
  amount: Money | null;
  metadata: unknown;
}): void {
  if (event.subject !== `request:${request.requestId}` || event.amount === null || economicEventRole(event.kind as EconomicEventKind) !== 'charge') {
    throw new Error(`economic request event ${event.id} is not a canonical charge for ${request.requestId}`);
  }
  const metadata = metadataRecord(event.metadata, event.id);
  const expectedVia = request.via ?? 'proxy';
  if (metadata.requestId !== request.requestId
      || metadata.provider !== request.provider
      || metadata.model !== request.model
      || metadata.project !== request.project
      || metadata.via !== expectedVia) {
    throw new Error(`economic request event ${event.id} metadata disagrees with request ${request.requestId}`);
  }
  if (request.sessionId === null || request.sessionId === undefined) {
    if (metadata.sessionId !== undefined && metadata.sessionId !== null) {
      throw new Error(`economic request event ${event.id} session metadata disagrees with request ${request.requestId}`);
    }
  } else if (metadata.sessionId !== request.sessionId) {
    throw new Error(`economic request event ${event.id} session metadata disagrees with request ${request.requestId}`);
  }
}

/** Join one request row to its exact effective charge, failing closed on drift. */
export function effectiveRequestRow(request: RequestRow, ledger: EconomicLedger): EffectiveRequestRow {
  const sourceId = requestEconomicEventId(request.requestId);
  const source = ledger.read(sourceId);
  const base = {
    requestId: request.requestId,
    tsEpochMs: request.tsEpochMs,
    sessionId: request.sessionId ?? null,
    provider: request.provider,
    model: request.model,
    project: request.project,
    projectCanonical: request.projectCanonical ?? request.project,
    source: request.source ?? null,
    user: request.user ?? null,
    via: (request.via ?? 'proxy') as 'proxy' | 'import',
  };
  if (source === null) {
    return Object.freeze({
      ...base,
      effectiveAmount: null,
      sourceBases: Object.freeze([]),
      sourceEventIds: Object.freeze([]),
      unresolvedReason: 'no_exact_economic_event',
    });
  }
  assertMatches(request, source);
  const effective = ledger.effectiveChargeFor(sourceId);
  if (effective === null) throw new Error(`economic request event ${sourceId} has no effective charge projection`);
  return Object.freeze({
    ...base,
    effectiveAmount: effective.amount,
    sourceBases: Object.freeze([...effective.sourceBases]),
    sourceEventIds: Object.freeze([...effective.eventIds]),
    unresolvedReason: null,
  });
}

/** Build the exact request read model without changing legacy request rows. */
export function effectiveRequestRows(rows: readonly RequestRow[], ledger: EconomicLedger): EffectiveRequestRow[] {
  if (!Array.isArray(rows)) throw new Error('economic request rows must be an array');
  return rows.map((row) => effectiveRequestRow(row, ledger));
}
