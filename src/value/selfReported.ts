/**
 * Operator-reported outcomes for chat, image and other non-code work.
 *
 * Records use the existing gate-signals ledger; evaluation uses the existing
 * non-coding WorkUnit/OutcomeAdapter in usage.ts. This layer owns validation,
 * append-only event reconstruction, spend linkage and descriptive reporting.
 */
import { randomUUID } from 'node:crypto';
import type { RequestRow, Store } from '../store/db.ts';
import { evaluateReportedLadder } from './usage.ts';

export const SELF_REPORTED_BASIS = 'self-reported by the operator; request costs are metered estimates, not provider-billed or causal value' as const;
export type WorkKind = 'chat' | 'image' | 'other';
export type WorkDecision = 'accepted_as_is' | 'edited_before_use' | 'rejected';
export type UseAction = 'exported' | 'copied' | 'shipped' | 'published' | 'not_used';
export type SpendLink =
  | { type: 'request'; requestId: string; basis: 'recorded' }
  | { type: 'session'; sessionId: string; basis: 'recorded' }
  | { type: 'window'; fromMs: number; toMs: number; tool: string; basis: 'inferred' };
export type ReportedSignal =
  | { type: 'rating'; value: 1 | 2 | 3 | 4 | 5; note?: string; source: 'operator'; observedAtMs: number }
  | { type: 'decision'; value: WorkDecision; source: 'operator'; observedAtMs: number }
  | { type: 'regenerated'; value: boolean; source: 'operator'; observedAtMs: number }
  | { type: 'attempts'; value: number; source: 'operator'; observedAtMs: number }
  | { type: 'use'; value: UseAction; source: 'operator'; observedAtMs: number }
  | { type: 'still_in_use'; value: boolean; source: 'operator'; observedAtMs: number };

export interface OutcomeInput {
  outcomeId: string;
  kind: WorkKind;
  link: SpendLink;
  rating?: number;
  note?: string;
  decision?: WorkDecision;
  regenerated?: boolean;
  attempts?: number;
  use?: UseAction;
  stillInUse?: boolean;
}
export interface ReportedEvent {
  outcomeId: string;
  kind: WorkKind;
  link: SpendLink;
  signals: ReportedSignal[];
  recordedAtMs: number;
}
export interface OutcomePreview {
  apply: boolean;
  basis: typeof SELF_REPORTED_BASIS;
  event: ReportedEvent;
  matchedRequests: number;
  matchedCostUsd: number | null;
  linkStatus: 'matched' | 'unmatched';
}

function id(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim() || value !== value.trim() || value.length > 160) {
    throw new Error(`${label} must be non-empty trimmed text of at most 160 characters`);
  }
  return value;
}
function time(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw new Error(`${label} must be a non-negative safe millisecond timestamp`);
  return value as number;
}
function validateLink(value: unknown): SpendLink {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('link must be an object');
  const link = value as Record<string, unknown>;
  if (link.type === 'request') {
    if (link.basis !== 'recorded') throw new Error('request link basis must be recorded');
    return { type: 'request', requestId: id(link.requestId, 'requestId'), basis: 'recorded' };
  }
  if (link.type === 'session') {
    if (link.basis !== 'recorded') throw new Error('session link basis must be recorded');
    return { type: 'session', sessionId: id(link.sessionId, 'sessionId'), basis: 'recorded' };
  }
  if (link.type === 'window') {
    if (link.basis !== 'inferred') throw new Error('window link basis must be inferred');
    const fromMs = time(link.fromMs, 'fromMs');
    const toMs = time(link.toMs, 'toMs');
    if (toMs <= fromMs || toMs - fromMs > 24 * 60 * 60 * 1000) throw new Error('window must be ordered and at most 24 hours');
    return { type: 'window', fromMs, toMs, tool: id(link.tool, 'tool'), basis: 'inferred' };
  }
  throw new Error('link type must be request, session, or window');
}
function sameIdentity(a: ReportedEvent, b: ReportedEvent): boolean {
  return a.kind === b.kind && JSON.stringify(a.link) === JSON.stringify(b.link);
}

export function prepareReportedOutcome(raw: OutcomeInput, atMs = Date.now()): ReportedEvent {
  const outcomeId = id(raw.outcomeId, 'outcomeId');
  if (!['chat', 'image', 'other'].includes(raw.kind)) throw new Error('kind must be chat, image, or other');
  const link = validateLink(raw.link);
  const recordedAtMs = time(atMs, 'recordedAtMs');
  const signals: ReportedSignal[] = [];
  if (raw.note !== undefined && (raw.rating === undefined || typeof raw.note !== 'string' || raw.note.length > 240)) {
    throw new Error('note requires a rating and must be at most 240 characters');
  }
  if (raw.rating !== undefined) {
    if (!Number.isInteger(raw.rating) || raw.rating < 1 || raw.rating > 5) throw new Error('rating must be an integer from 1 to 5');
    signals.push({ type: 'rating', value: raw.rating as 1 | 2 | 3 | 4 | 5, ...(raw.note === undefined ? {} : { note: raw.note }), source: 'operator', observedAtMs: recordedAtMs });
  }
  if (raw.decision !== undefined) {
    if (!['accepted_as_is', 'edited_before_use', 'rejected'].includes(raw.decision)) throw new Error('invalid decision');
    signals.push({ type: 'decision', value: raw.decision, source: 'operator', observedAtMs: recordedAtMs });
  }
  if (raw.regenerated !== undefined) {
    if (typeof raw.regenerated !== 'boolean') throw new Error('regenerated must be boolean');
    signals.push({ type: 'regenerated', value: raw.regenerated, source: 'operator', observedAtMs: recordedAtMs });
  }
  if (raw.attempts !== undefined) {
    if (!Number.isSafeInteger(raw.attempts) || raw.attempts < 1 || raw.attempts > 1000) throw new Error('attempts must be an integer from 1 to 1000');
    signals.push({ type: 'attempts', value: raw.attempts, source: 'operator', observedAtMs: recordedAtMs });
  }
  if (raw.use !== undefined) {
    if (!['exported', 'copied', 'shipped', 'published', 'not_used'].includes(raw.use)) throw new Error('invalid use action');
    signals.push({ type: 'use', value: raw.use, source: 'operator', observedAtMs: recordedAtMs });
  }
  if (raw.stillInUse !== undefined) {
    if (typeof raw.stillInUse !== 'boolean') throw new Error('stillInUse must be boolean');
    signals.push({ type: 'still_in_use', value: raw.stillInUse, source: 'operator', observedAtMs: recordedAtMs });
  }
  if (signals.length === 0) throw new Error('at least one outcome signal is required');
  return { outcomeId, kind: raw.kind, link, signals, recordedAtMs };
}

function decodeEvent(detail: string | null): ReportedEvent {
  if (!detail) throw new Error('self-reported outcome has no detail');
  const raw = JSON.parse(detail) as ReportedEvent;
  const input: OutcomeInput = { outcomeId: raw.outcomeId, kind: raw.kind, link: raw.link };
  for (const signal of raw.signals ?? []) {
    if (signal.source !== 'operator' || signal.observedAtMs !== raw.recordedAtMs) throw new Error('invalid self-reported signal provenance');
    if (signal.type === 'rating') { input.rating = signal.value; input.note = signal.note; }
    else if (signal.type === 'decision') input.decision = signal.value;
    else if (signal.type === 'regenerated') input.regenerated = signal.value;
    else if (signal.type === 'attempts') input.attempts = signal.value;
    else if (signal.type === 'use') input.use = signal.value;
    else if (signal.type === 'still_in_use') input.stillInUse = signal.value;
    else throw new Error('invalid self-reported signal type');
  }
  const validated = prepareReportedOutcome(input, raw.recordedAtMs);
  if (JSON.stringify(validated) !== JSON.stringify(raw)) throw new Error('self-reported outcome detail is not canonical');
  return validated;
}

function events(store: Store, startMs: number, endMs: number): ReportedEvent[] {
  return store.selfReportedOutcomeSignals(startMs, endMs).map((row) => {
    if (row.evidenceSource !== 'manual' || row.verdict !== 'reported') throw new Error('invalid self-reported outcome row provenance');
    const event = decodeEvent(row.detail);
    if (row.commitHash !== `outcome:${event.outcomeId}` || row.tsEpochMs !== event.recordedAtMs) throw new Error('self-reported outcome row identity mismatch');
    return event;
  });
}

function matched(rows: readonly RequestRow[], link: SpendLink): RequestRow[] {
  if (link.type === 'request') return rows.filter((row) => row.requestId === link.requestId);
  if (link.type === 'session') return rows.filter((row) => row.sessionId === link.sessionId);
  return rows.filter((row) => row.tsEpochMs >= link.fromMs && row.tsEpochMs < link.toMs && row.source === link.tool);
}

/** Preview is read-only; apply appends one signal to the existing ledger. */
export function recordReportedOutcome(store: Store, raw: OutcomeInput, apply = false, enabled = true, nowMs = Date.now()): OutcomePreview {
  if (!enabled) throw new Error('self-reported outcomes are disabled');
  const event = prepareReportedOutcome(raw, nowMs);
  const prior = events(store, 0, Number.MAX_SAFE_INTEGER).filter((item) => item.outcomeId === event.outcomeId);
  if (prior.some((item) => !sameIdentity(item, event))) throw new Error('outcomeId already has a different kind or spend link');
  const rows = matched(store.requestsInRange(0, Number.MAX_SAFE_INTEGER), event.link);
  const preview: OutcomePreview = {
    apply,
    basis: SELF_REPORTED_BASIS,
    event,
    matchedRequests: rows.length,
    matchedCostUsd: rows.length ? rows.reduce((sum, row) => sum + row.costUsd, 0) : null,
    linkStatus: rows.length ? 'matched' : 'unmatched',
  };
  if (apply) store.insertSignal({
    signalId: randomUUID(),
    kind: 'self_reported_outcome',
    commitHash: `outcome:${event.outcomeId}`,
    project: 'default',
    tsEpochMs: event.recordedAtMs,
    verdict: 'reported',
    detail: JSON.stringify(event),
    evidenceSource: 'manual',
  });
  return preview;
}

export interface ReportedUnit {
  outcomeId: string;
  kind: WorkKind;
  link: SpendLink;
  signals: ReportedSignal[];
  ladder: ReturnType<typeof evaluateReportedLadder>;
  model: string;
  matchedRequests: number;
  attributedCostUsd: number | null;
  basis: typeof SELF_REPORTED_BASIS;
}
export interface ReportedCell {
  key: string;
  outcomes: number;
  accepted: number;
  used: number;
  linked: number;
  costUsd: number;
  costPerAcceptedUsd: number | null;
  costPerUsedUsd: number | null;
  basis: typeof SELF_REPORTED_BASIS;
}
export interface ReportedValueReport {
  /** `disabled` means the subsystem did not run: empty lists are not a result. */
  status: 'available' | 'disabled';
  basis: typeof SELF_REPORTED_BASIS;
  units: ReportedUnit[];
  byKind: ReportedCell[];
  byModel: ReportedCell[];
  unlinkedOutcomes: number;
  inferredLinks: number;
  codingComparison: 'separate_basis';
}

/** No coding realization, manual-equivalent value or causal return enters this report. */
export function selfReportedValueReport(store: Store, startMs: number, endMs: number, enabled = true): ReportedValueReport {
  if (!enabled) return { status: 'disabled', basis: SELF_REPORTED_BASIS, units: [], byKind: [], byModel: [], unlinkedOutcomes: 0, inferredLinks: 0, codingComparison: 'separate_basis' };
  const all = events(store, 0, endMs);
  const grouped = new Map<string, ReportedEvent[]>();
  for (const event of all) grouped.set(event.outcomeId, [...(grouped.get(event.outcomeId) ?? []), event]);
  const selected = [...grouped.values()].filter((group) => group[0]!.recordedAtMs >= startMs && group[0]!.recordedAtMs < endMs);
  // A linked session or request may have started before the report window, so
  // spend is matched over all history up to the window end, exactly as the
  // record preview matches it. The window selects outcomes, not their cost.
  const requestRows = store.requestsInRange(0, endMs);
  const claims = selected.map((group) => matched(requestRows, group[0]!.link));
  const claimedBy = new Map<string, number>();
  for (const rows of claims) for (const row of rows) claimedBy.set(row.requestId, (claimedBy.get(row.requestId) ?? 0) + 1);
  const units: ReportedUnit[] = selected.map((group, index) => {
    const first = group[0]!;
    if (group.some((item) => !sameIdentity(first, item))) throw new Error('conflicting self-reported outcome identity');
    const rows = claims[index]!;
    const models = [...new Set(rows.map((row) => row.model))];
    return {
      outcomeId: first.outcomeId, kind: first.kind, link: first.link,
      signals: group.flatMap((event) => event.signals),
      ladder: evaluateReportedLadder(first.outcomeId, first.kind, group.flatMap((event) => event.signals)),
      model: models.length === 0 ? 'unlinked' : models.length === 1 ? models[0]! : 'mixed',
      matchedRequests: rows.length,
      attributedCostUsd: rows.length ? rows.reduce((sum, row) => sum + row.costUsd / claimedBy.get(row.requestId)!, 0) : null,
      basis: SELF_REPORTED_BASIS,
    };
  });
  const cells = (keyOf: (unit: ReportedUnit) => string): ReportedCell[] => {
    const keys = [...new Set(units.map(keyOf))].sort();
    return keys.map((key) => {
      const subset = units.filter((unit) => keyOf(unit) === key);
      const accepted = subset.filter((unit) => unit.ladder.accepted === 'pass').length;
      const used = subset.filter((unit) => unit.ladder.used === 'pass').length;
      const priced = subset.filter((unit) => unit.attributedCostUsd !== null);
      const costUsd = priced.reduce((sum, unit) => sum + unit.attributedCostUsd!, 0);
      return { key, outcomes: subset.length, accepted, used, linked: priced.length, costUsd,
        costPerAcceptedUsd: accepted > 0 && priced.length === subset.length ? costUsd / accepted : null,
        costPerUsedUsd: used > 0 && priced.length === subset.length ? costUsd / used : null,
        basis: SELF_REPORTED_BASIS };
    });
  };
  return { status: 'available', basis: SELF_REPORTED_BASIS, units, byKind: cells((unit) => unit.kind), byModel: cells((unit) => unit.model),
    unlinkedOutcomes: units.filter((unit) => unit.matchedRequests === 0).length,
    inferredLinks: units.filter((unit) => unit.link.basis === 'inferred').length,
    codingComparison: 'separate_basis' };
}
