/**
 * Native metering for Codex CLI — reads its rollout session logs, no routing.
 *
 * Codex appends a JSONL "rollout" per session under ~/.codex/sessions/<Y>/<M>/
 * <D>/rollout-*.jsonl (older ones under ~/.codex/archived_sessions) and later
 * compresses a finished one in place, to rollout-*.jsonl.zst. Each
 * `token_count` event carries the session's CUMULATIVE usage. We record one row
 * per turn as the DELTA of that cumulative total, which telescopes to the exact
 * session total (Codex's own last_token_usage double-counts re-read context, so
 * deltas are the honest basis) and lets a live session append new rows without
 * disturbing old ones.
 *
 * Idempotent: each turn's request_id is `codex:<sessionId>:<ordinal>`, stable
 * across re-imports because rollout files are append-only and ordered.
 *
 * Forked threads are written as rollout-<ts>-<parent>_<child>.jsonl. Their
 * session_meta repeats the PARENT's id and their first cumulative total starts
 * from the parent's history, so a fork is keyed by its own child id and its
 * first event counts only that turn (last_token_usage), never the carried total.
 * A subagent rollout instead opens with its own session_meta (forked_from_id
 * set) and then embeds the parent's, so the FIRST session_meta names the thread.
 *
 * A forked file may also replay the parent's last turns, token counts included.
 * Those requests are in the parent's own file, so they are not counted again: a
 * turn id is a UUIDv7, which sorts by time, and a replayed turn is older than
 * the thread it is replayed into.
 *
 * A thread that was not forked can also open with a carried total: Codex shortens
 * a long file to its recent history, and the total is then the only trace of the
 * thread's earlier work. It is counted as one row.
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import type { Store, RequestRow } from '../store/db.ts';
import { computeCost, unpricedPricingEvidence, type Provider } from '../cost/pricing.ts';
import { projectKeyWithBasis, type AttributionBasis } from '../value/characterization.ts';
import {
  type ImportSummary,
  type ImportOptions,
  emptyImportSummary,
  recordInsert,
  createRepoResolver,
  noteRelabel,
  boundedJsonlFiles,
  logBaseName,
  readLogLines,
  noteUnreadFiles,
  markImportTruncated,
  fileStampForImport,
  noteFileImported,
  noteFileUnchanged,
  truncationMark,
  commitObservationsInLine,
} from './importShared.ts';
import { tokenField } from './logFields.ts';
import { isUnreadableLog } from './logFiles.ts';
import { EconomicPeriodClosedError } from '../economics/ledger.ts';
import { RESOURCE_LIMITS } from '../util/resource-limits.ts';
import { codexRateLimitEvents, type QuotaEvent } from '../quota/limits.ts';

/** Codex home: ~/.codex (override with CODEX_HOME). null = not installed. */
export function defaultCodexRoot(): string | null {
  const home = process.env.CODEX_HOME ?? join(homedir(), '.codex');
  return existsSync(home) ? home : null;
}

interface TokenTotals {
  input: number;
  cachedInput: number;
  output: number;
  reasoning: number;
}

function totalsFrom(u: Record<string, number> | undefined): TokenTotals | null {
  if (!u || typeof u !== 'object') return null;
  return {
    input: tokenField(u.input_tokens),
    cachedInput: tokenField(u.cached_input_tokens),
    output: tokenField(u.output_tokens),
    reasoning: tokenField(u.reasoning_output_tokens),
  };
}

/** All rollout JSONL files under a Codex home (live sessions + archived). */
export function codexRolloutFileScan(root: string): { files: string[]; truncated: boolean; unsupported: number } {
  const dirs = [join(root, 'sessions'), join(root, 'archived_sessions')];
  const out: string[] = [];
  let truncated = false;
  let unsupported = 0;
  for (const dir of dirs) {
    const scan = boundedJsonlFiles(dir);
    unsupported += scan.unsupported;
    for (const file of scan.files) {
      if (out.length >= RESOURCE_LIMITS.importFiles) {
        truncated = true;
        break;
      }
      out.push(file);
    }
    truncated ||= scan.truncated;
    if (truncated) break;
  }
  return { files: out, truncated, unsupported };
}

/** Compatibility adapter for transcript lookup and existing callers. */
export function codexRolloutFiles(root: string): string[] {
  return codexRolloutFileScan(root).files;
}

export interface CodexUsageRow {
  requestId: string;
  sessionId: string | null;
  tsEpochMs: number;
  provider: string;
  model: string;
  project: string;
  /** Whether that project came from a real recorded cwd or the tool-name fallback. */
  attributionBasis: AttributionBasis;
  cwd: string | null;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  reasoningTokens: number;
  /** The count covers more than the request it names: a shortened log's carried total. */
  severalRequests?: boolean;
}

/** The child thread id of a forked rollout file, or null for an ordinary one. */
export function codexForkThreadId(file: string): string | null {
  const m = /-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}_([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i.exec(logBaseName(file));
  return m ? m[1]!.toLowerCase() : null;
}

/** The model of the Codex versions whose logs never named one. */
const MODEL_BEFORE_LOGS_NAMED_IT = 'gpt-5';

const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-/i;

export interface CodexParseOptions {
  onRow?: (row: CodexUsageRow) => void | Promise<void>;
  /** A request replayed from the parent's log, under the id an earlier reader gave it in this file. */
  onReplayed?: (requestId: string) => void;
  onTruncatedLine?: () => void;
  onTruncatedRow?: () => void;
  /** A commit git reported creating in this rollout's own turns (never a fork's replayed history). */
  onCommit?: (c: { sessionId: string; branch: string; shortSha: string; subject: string; tsEpochMs: number; cwd: string | null }) => void;
  /** The vendor's rate-limit meter, each time its percentage or reset changes within this file. */
  onRateLimit?: (e: QuotaEvent) => void;
  maxRows?: number;
}

/**
 * Parse one rollout file into per-turn usage rows (deltas of the cumulative
 * total). Pure over the file's lines; the importer handles I/O and insertion.
 */
export async function parseCodexRollout(file: string, options: CodexParseOptions = {}): Promise<CodexUsageRow[]> {
  let sessionId: string | null = null;
  const forkId = codexForkThreadId(file);
  let forked = forkId !== null;
  let firstCount = true;
  // A fork's replay ends at the first turn begun in this thread. A log whose
  // turns carry no ids gives no way to tell, and is read as before.
  let turnsNamed = false;
  let ownTurnSeen = false;
  let turnStartedMs = 0;
  let resets = 0;
  let provider = 'openai';
  let model: string | null = null;
  let project = 'codex';
  // A rollout that never emits a cwd keeps the tool-name placeholder, so the
  // basis starts as a fallback and is upgraded only when a real path arrives.
  let attributionBasis: AttributionBasis = 'tool_log_fallback';
  let cwd: string | null = null;
  let ordinal = 0;
  let prev: TokenTotals = { input: 0, cachedInput: 0, output: 0, reasoning: 0 };
  const rows: CodexUsageRow[] = [];
  let emittedRows = 0;
  const maxRows = options.maxRows ?? RESOURCE_LIMITS.importRows;

  // Usage can come before the first turn names its model (the carried total of a
  // shortened log does). It waits for that name.
  let unnamed: CodexUsageRow[] = [];
  const emit = async (row: CodexUsageRow): Promise<void> => {
    if (options.onRow) await options.onRow(row);
    else rows.push(row);
  };
  const releaseUnnamed = async (): Promise<void> => {
    const waiting = unnamed;
    unnamed = [];
    for (const row of waiting) await emit(model === null ? row : { ...row, model });
  };

  const projFromCwd = (cwd: string) => projectKeyWithBasis(cwd, 'codex');
  const lastMeter = new Map<string, string>();

  // Usage is in short lines of known types. A dropped tool output or snapshot
  // holds none, so losing it leaves the import complete.
  const onOversizedLine = (kind: string | null): void => {
    if (kind === null || kind === 'session_meta' || kind === 'turn_context') options.onTruncatedLine?.();
  };
  for await (const line of readLogLines(file, onOversizedLine)) {
    let o: { type?: string; timestamp?: string; payload?: Record<string, unknown> };
    try {
      o = JSON.parse(line);
    } catch {
      continue; // torn tail of a live session — next import gets it whole
    }
    if (o === null || typeof o !== 'object') continue; // JSON, but not a record
    const p = o.payload !== null && typeof o.payload === 'object' ? o.payload : {};
    // A fork or subagent file opens with its parent's history replayed; its own
    // turns begin after its first token count. Commits in the replay are the
    // parent's, so they are not credited to this thread.
    const turnId = p.turn_id;
    if (typeof turnId === 'string' && (o.type === 'turn_context' || (o.type === 'event_msg' && p.type === 'task_started'))) {
      const thread = forkId ?? sessionId;
      if (thread !== null && UUID_V7.test(turnId) && turnId.toLowerCase() >= thread.toLowerCase()) ownTurnSeen = true;
      turnsNamed = true;
      if (p.type === 'task_started') turnStartedMs = typeof p.started_at === 'number' ? p.started_at * 1000 : 0;
    }
    const replaying = forked && turnsNamed && !ownTurnSeen;
    if (options.onCommit && o.type !== 'session_meta' && o.type !== 'turn_context' && !(forked && firstCount) && !replaying) {
      const thread = forkId ?? sessionId;
      const ts = Date.parse(o.timestamp ?? '');
      if (thread && Number.isFinite(ts)) {
        for (const c of commitObservationsInLine(line)) options.onCommit({ sessionId: thread, ...c, tsEpochMs: ts, cwd });
      }
    }
    if (o.type === 'session_meta') {
      // Only the first session_meta names this file's thread; later ones are
      // the parent's context replayed into a subagent or fork.
      if (sessionId !== null) continue;
      sessionId = typeof p.id === 'string' ? p.id : null;
      if (typeof p.forked_from_id === 'string') forked = true;
      if (typeof p.cwd === 'string') {
        cwd = p.cwd;
        ({ project, basis: attributionBasis } = projFromCwd(p.cwd));
      }
      if (typeof p.model_provider === 'string') provider = p.model_provider;
      if (typeof p.model === 'string') model = p.model as string;
      continue;
    }
    if (o.type === 'turn_context') {
      if (typeof p.model === 'string') model = p.model as string;
      if (typeof p.cwd === 'string') {
        cwd = p.cwd;
        ({ project, basis: attributionBasis } = projFromCwd(p.cwd));
      }
      await releaseUnnamed();
      continue;
    }
    if (o.type === 'event_msg' && p.type === 'token_count' && options.onRateLimit && p.rate_limits !== undefined) {
      const ts = Date.parse(o.timestamp ?? '');
      if (Number.isFinite(ts)) {
        for (const e of codexRateLimitEvents(p.rate_limits, ts)) {
          const key = JSON.stringify([e.usedPercent, e.resetsAtMs]);
          if (lastMeter.get(e.kind) === key) continue;
          lastMeter.set(e.kind, key);
          options.onRateLimit(e);
        }
      }
    }
    if (o.type === 'event_msg' && p.type === 'token_count') {
      const info = p.info as { total_token_usage?: Record<string, number>; last_token_usage?: Record<string, number> } | undefined;
      const tot = totalsFrom(info?.total_token_usage);
      if (!tot) continue;
      if (forked && firstCount) {
        // The fork's first total includes the parent's history: baseline from it
        // so only this turn counts (its last_token_usage, or nothing if absent).
        const last = totalsFrom(info?.last_token_usage);
        prev = last
          ? {
              input: Math.max(0, tot.input - last.input),
              cachedInput: Math.max(0, tot.cachedInput - last.cachedInput),
              output: Math.max(0, tot.output - last.output),
              reasoning: Math.max(0, tot.reasoning - last.reasoning),
            }
          : tot;
      }
      firstCount = false;
      let dIn = Math.max(0, tot.input - prev.input);
      let dCached = Math.max(0, tot.cachedInput - prev.cachedInput);
      let dOut = Math.max(0, tot.output - prev.output);
      let dReason = Math.max(0, tot.reasoning - prev.reasoning);
      // The total went down: Codex restarted it, so the difference says nothing
      // about this turn and the turn's own figure does.
      const reset = tot.input < prev.input;
      const latest = totalsFrom(info?.last_token_usage);
      const severalRequests = !reset && latest !== null && dIn > latest.input;
      prev = tot;
      const clamped = dIn === 0 && dOut === 0 && dCached === 0;
      if (reset && latest) ({ input: dIn, cachedInput: dCached, output: dOut, reasoning: dReason } = latest);
      if (dIn === 0 && dOut === 0 && dCached === 0) continue; // no new work this event
      const logged = Date.parse(o.timestamp ?? '');
      if (Number.isNaN(logged)) continue;
      // Shortening a file restamps every line with one time, so a turn can be
      // logged before it began.
      const ts = Math.max(logged, turnStartedMs);
      // A turn that earlier readers clamped away takes an id of its own, so the
      // ids after it stay what they were.
      const place = reset && clamped ? `reset-${resets++}` : ordinal++;
      const requestId = `codex:${forkId ?? sessionId ?? 'unknown'}:${place}`;
      if (replaying) {
        options.onReplayed?.(requestId);
        continue;
      }
      const uncachedIn = Math.max(0, dIn - dCached); // Codex counts cached inside input_tokens
      if (emittedRows >= maxRows) {
        options.onTruncatedRow?.();
        break;
      }
      const row: CodexUsageRow = {
        requestId,
        sessionId: forkId ?? sessionId,
        tsEpochMs: ts,
        provider,
        model: model ?? MODEL_BEFORE_LOGS_NAMED_IT,
        project,
        attributionBasis,
        cwd,
        inputTokens: uncachedIn,
        outputTokens: dOut,
        cacheReadTokens: dCached,
        reasoningTokens: dReason,
        ...(severalRequests ? { severalRequests } : {}),
      };
      emittedRows += 1;
      if (model === null) unnamed.push(row);
      else await emit(row);
    }
  }
  await releaseUnnamed();
  return rows;
}

const REPRICEABLE: Record<string, Provider> = { openai: 'openai', anthropic: 'anthropic' };

/** Import Codex rollout usage into the store. Idempotent; re-run/poll safe. */
/** Imports in periodic commits rather than one commit per row (see Store.importBatch). */
export async function importCodex(store: Store, opts: ImportOptions = {}): Promise<ImportSummary> {
  const batch = store.importBatch();
  try {
    return await importCodexRows(store, opts);
  } finally {
    batch.end();
  }
}

async function importCodexRows(store: Store, opts: ImportOptions): Promise<ImportSummary> {
  const root = opts.root ?? defaultCodexRoot();
  const source = opts.source ?? 'codex';
  const sinceMs = opts.sinceMs ?? 0;
  if (!root || !existsSync(root)) return emptyImportSummary(0);

  const fileScan = codexRolloutFileScan(root);
  const files = fileScan.files;
  const summary = emptyImportSummary(files.length);
  if (fileScan.truncated) markImportTruncated(summary, 'files');
  noteUnreadFiles(summary, fileScan.unsupported);
  // Same subdirectory/collision problem as the Claude Code transcripts: a rollout
  // records the cwd it ran in, which is often not the repository root.
  const resolveProject = createRepoResolver();

  for (const file of files) {
    const stamp = fileStampForImport(store, source, file, opts);
    if (stamp === 'deferred') {
      summary.filesDeferred = (summary.filesDeferred ?? 0) + 1;
      continue;
    }
    if (stamp === 'unchanged') {
      noteFileUnchanged(store, source, file, summary);
      continue;
    }
    const truncationsBefore = truncationMark(summary);
    try {
      await parseCodexRollout(file, {
        onTruncatedLine: () => markImportTruncated(summary, 'lines'),
        onTruncatedRow: () => markImportTruncated(summary, 'rows'),
        onReplayed: (requestId) => {
          try {
            if (store.retractImportedRequest(requestId)) summary.retractedObservations = (summary.retractedObservations ?? 0) + 1;
          } catch (error) {
            if (!(error instanceof EconomicPeriodClosedError)) throw error;
            summary.closedPeriodObservations = (summary.closedPeriodObservations ?? 0) + 1;
          }
        },
        onCommit: (c) => {
          if (c.tsEpochMs >= sinceMs) store.recordObservedCommit({ source, ...c });
        },
        onRateLimit: (e) => {
          if (e.tsEpochMs >= sinceMs) store.recordQuotaEvent(e);
        },
        onRow: async (ev) => {
          if (ev.tsEpochMs < sinceMs) return;
          const attribution = await resolveProject(ev.cwd, 'codex');
          noteRelabel(summary, attribution);
          const prov = REPRICEABLE[ev.provider];
          const c = prov
            ? computeCost(prov, ev.model, {
                inputTokens: ev.inputTokens,
                outputTokens: ev.outputTokens,
                cacheWriteTokens: 0,
                cacheReadTokens: ev.cacheReadTokens,
                severalRequests: ev.severalRequests,
              })
            : { costUsd: 0, estimated: true, pricing: unpricedPricingEvidence(), exact: undefined };

          const row: RequestRow = {
            requestId: ev.requestId,
            sessionId: ev.sessionId,
            tsEpochMs: ev.tsEpochMs,
            provider: ev.provider,
            model: ev.model,
            project: attribution.project,
            attributionBasis: attribution.basis,
            taskWeight: 1,
            inputTokens: ev.inputTokens,
            outputTokens: ev.outputTokens,
            cacheWriteTokens: 0,
            cacheReadTokens: ev.cacheReadTokens,
            reasoningTokens: ev.reasoningTokens,
            ...(ev.severalRequests === true ? { severalRequests: true } : {}),
            costUsd: c.costUsd,
            economicAmount: prov ? c.exact?.total : undefined,
            estimated: c.estimated,
            pricing: c.pricing,
            streamed: true,
            statusCode: 200,
            durationMs: null,
            user: null,
            source,
            cwd: ev.cwd,
          };
          if (ev.sessionId) store.upsertSession(ev.sessionId, attribution.project, source, ev.tsEpochMs);
          recordInsert(store, summary, row, c.estimated, { idIsPosition: true });
        },
      });
    } catch (error) {
      if (!isUnreadableLog(error)) throw error;
      // Unreadable or damaged: the rows before the damage stand, the rest is
      // reported missing, and no cursor is kept, so the next import tries again.
      noteUnreadFiles(summary);
      continue;
    }
    noteFileImported(store, source, file, stamp, opts, truncationsBefore, summary);
  }
  return summary;
}
