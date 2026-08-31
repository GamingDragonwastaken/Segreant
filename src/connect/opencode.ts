/**
 * Native metering for opencode — reads its local session database, no routing.
 *
 * opencode records every assistant message to a SQLite store at
 * <data>/opencode/opencode.db, and each row's JSON carries the model, the
 * provider, the token breakdown (input / output / reasoning / cache read+write)
 * and opencode's own computed cost. We read that database READ-ONLY: SQLite in
 * WAL mode serves a consistent snapshot to readers while opencode keeps writing,
 * so importing never blocks the tool — exactly what a live feed needs.
 *
 * Cost policy: opencode already priced each message against its own provider
 * table, so its `cost` is authoritative (0 is correct for free-tier models —
 * and RoI is dollar-free at its core, so those requests still score). Only when
 * opencode reports 0 AND we hold an EXACT rate for a known provider do we
 * re-price, so a paid model opencode failed to price still gets a real number.
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import type { Store, RequestRow } from '../store/db.ts';
import { computeCost, toolReportedPricingEvidence, type Provider } from '../cost/pricing.ts';
import { projectKeyWithBasis, type AttributionBasis } from '../value/characterization.ts';
import { type ImportSummary, type ImportOptions, emptyImportSummary, recordInsert, markImportTruncated } from './importShared.ts';
import { RESOURCE_LIMITS } from '../util/resource-limits.ts';

/** Locate opencode's data dir across platforms; first existing wins. null = not installed. */
export function defaultOpencodeDbPath(): string | null {
  const candidates = [
    process.env.OPENCODE_DATA ? join(process.env.OPENCODE_DATA, 'opencode.db') : null,
    process.env.XDG_DATA_HOME ? join(process.env.XDG_DATA_HOME, 'opencode', 'opencode.db') : null,
    join(homedir(), '.local', 'share', 'opencode', 'opencode.db'),
    process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, 'opencode', 'opencode.db') : null,
    process.env.APPDATA ? join(process.env.APPDATA, 'opencode', 'opencode.db') : null,
  ].filter((p): p is string => p !== null);
  for (const p of candidates) if (existsSync(p)) return p;
  return null;
}

export interface OpencodeUsageEvent {
  requestId: string;
  sessionId: string | null;
  tsEpochMs: number;
  provider: string;
  model: string;
  project: string;
  /** Whether that project came from a real recorded path or from the tool-name fallback. */
  attributionBasis: AttributionBasis;
  /** Full working-directory path — the repo Fiscus can find and auto-correlate. */
  cwd: string | null;
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  /** opencode's own computed cost (USD); 0 is legitimate for free-tier models. */
  reportedCostUsd: number;
}

interface OpencodeMessageData {
  role?: string;
  providerID?: string;
  modelID?: string;
  cost?: number;
  tokens?: { input?: number; output?: number; reasoning?: number; cache?: { read?: number; write?: number } };
  time?: { created?: number; completed?: number };
  path?: { cwd?: string; root?: string };
}

/** Parse one opencode message row into a usage event, or null for anything that isn't billable traffic. */
export function parseOpencodeMessage(id: string, dataJson: string, fallbackTsMs?: number): OpencodeUsageEvent | null {
  if (Buffer.byteLength(dataJson, 'utf8') > RESOURCE_LIMITS.transcriptLineBytes) return null;
  let d: OpencodeMessageData;
  try {
    d = JSON.parse(dataJson) as OpencodeMessageData;
  } catch {
    return null;
  }
  if (d.role !== 'assistant') return null;
  const model = d.modelID ?? '';
  if (!model) return null;
  const t = d.tokens ?? {};
  const input = t.input ?? 0;
  const output = t.output ?? 0;
  const reasoning = t.reasoning ?? 0;
  const cacheRead = t.cache?.read ?? 0;
  const cacheWrite = t.cache?.write ?? 0;
  // A message with no tokens at all is a placeholder/aborted turn — not traffic.
  if (input === 0 && output === 0 && reasoning === 0 && cacheRead === 0 && cacheWrite === 0) return null;

  const ts = d.time?.created ?? fallbackTsMs;
  if (typeof ts !== 'number' || !Number.isFinite(ts)) return null;
  const cwd = d.path?.cwd ?? '';
  const { project, basis: attributionBasis } = projectKeyWithBasis(cwd, 'opencode');

  return {
    requestId: id,
    sessionId: null, // filled from the row's session_id by the importer
    tsEpochMs: ts,
    provider: d.providerID ?? 'opencode',
    model,
    project,
    attributionBasis,
    cwd: cwd || null,
    inputTokens: input,
    outputTokens: output,
    reasoningTokens: reasoning,
    cacheReadTokens: cacheRead,
    cacheWriteTokens: cacheWrite,
    reportedCostUsd: typeof d.cost === 'number' && d.cost >= 0 ? d.cost : 0,
  };
}

/** opencode provider ids that our own rate card can price exactly. */
const REPRICEABLE: Record<string, Provider> = { anthropic: 'anthropic', openai: 'openai' };

/**
 * Import opencode's local usage. Read-only against the live DB (WAL snapshot),
 * idempotent by message id, so this is safe to re-run or poll on a timer.
 */
export function importOpencode(store: Store, opts: ImportOptions = {}): ImportSummary {
  const dbPath = opts.root ?? defaultOpencodeDbPath();
  const source = opts.source ?? 'opencode';
  const sinceMs = opts.sinceMs ?? 0;

  if (!dbPath || !existsSync(dbPath)) return emptyImportSummary(0);

  let db: DatabaseSync;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
  } catch {
    return emptyImportSummary(0); // locked/absent → honest empty, never a crash
  }

  const summary = emptyImportSummary(1);
  try {
    const statement = db.prepare('SELECT id, session_id AS sessionId, time_created AS tc, data FROM message ORDER BY time_created ASC, id ASC');
    let scannedRows = 0;
    for (const r of statement.iterate() as Iterable<{
      id: string;
      sessionId: string | null;
      tc: number | null;
      data: string;
    }>) {
      scannedRows += 1;
      if (scannedRows > RESOURCE_LIMITS.importRows) {
        markImportTruncated(summary, 'rows');
        break;
      }
      if (Buffer.byteLength(r.data, 'utf8') > RESOURCE_LIMITS.transcriptLineBytes) {
        markImportTruncated(summary, 'lines');
        continue;
      }
      const ev = parseOpencodeMessage(r.id, r.data, r.tc ?? undefined);
      if (!ev || ev.tsEpochMs < sinceMs) continue;

      // OpenCode supplies this number; Fiscus records it as tool-reported rather
      // than calling it an invoice. Only a zero amount with an exact local match
      // is replaced by a local list-price calculation.
      let costUsd = ev.reportedCostUsd;
      let estimated = false;
      let pricing = toolReportedPricingEvidence();
      let economicAmount: RequestRow['economicAmount'];
      if (costUsd === 0 && REPRICEABLE[ev.provider]) {
        const c = computeCost(REPRICEABLE[ev.provider]!, ev.model, {
          inputTokens: ev.inputTokens,
          outputTokens: ev.outputTokens,
          cacheWriteTokens: ev.cacheWriteTokens,
          cacheReadTokens: ev.cacheReadTokens,
        });
        if (!c.estimated) {
          costUsd = c.costUsd; // only adopt an EXACT match; never the fallback rate
          pricing = c.pricing;
          economicAmount = c.exact?.total;
        }
      }

      const row: RequestRow = {
        requestId: ev.requestId,
        sessionId: r.sessionId ?? null,
        tsEpochMs: ev.tsEpochMs,
        provider: ev.provider,
        model: ev.model,
        project: ev.project,
        attributionBasis: ev.attributionBasis,
        taskWeight: 1,
        inputTokens: ev.inputTokens,
        outputTokens: ev.outputTokens,
        cacheWriteTokens: ev.cacheWriteTokens,
        cacheReadTokens: ev.cacheReadTokens,
        reasoningTokens: ev.reasoningTokens,
        costUsd,
        economicAmount,
        estimated,
        pricing,
        streamed: true,
        statusCode: 200,
        durationMs: null,
        user: null,
        source,
        cwd: ev.cwd,
      };
      if (r.sessionId) store.upsertSession(r.sessionId, ev.project, source, ev.tsEpochMs);
      recordInsert(store, summary, row, estimated);
    }
  } finally {
    db.close();
  }
  return summary;
}
