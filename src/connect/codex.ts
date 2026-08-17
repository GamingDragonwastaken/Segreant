/**
 * Native metering for Codex CLI — reads its rollout session logs, no routing.
 *
 * Codex appends a JSONL "rollout" per session under ~/.codex/sessions/<Y>/<M>/
 * <D>/rollout-*.jsonl (older ones under ~/.codex/archived_sessions). Each
 * `token_count` event carries the session's CUMULATIVE usage. We record one row
 * per turn as the DELTA of that cumulative total, which telescopes to the exact
 * session total (Codex's own last_token_usage double-counts re-read context, so
 * deltas are the honest basis) and lets a live session append new rows without
 * disturbing old ones.
 *
 * Idempotent: each turn's request_id is `codex:<sessionId>:<ordinal>`, stable
 * across re-imports because rollout files are append-only and ordered.
 */

import { createReadStream, readdirSync, statSync, existsSync } from 'node:fs';
import { createInterface } from 'node:readline';
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
} from './importShared.ts';

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
  if (!u) return null;
  return {
    input: u.input_tokens ?? 0,
    cachedInput: u.cached_input_tokens ?? 0,
    output: u.output_tokens ?? 0,
    reasoning: u.reasoning_output_tokens ?? 0,
  };
}

/** All rollout JSONL files under a Codex home (live sessions + archived). */
export function codexRolloutFiles(root: string): string[] {
  const dirs = [join(root, 'sessions'), join(root, 'archived_sessions')];
  const out: string[] = [];
  for (const dir of dirs) {
    let names: string[] = [];
    try {
      names = readdirSync(dir, { recursive: true }) as string[];
    } catch {
      continue;
    }
    for (const n of names) {
      if (!n.endsWith('.jsonl')) continue;
      const p = join(dir, n);
      try {
        if (statSync(p).isFile()) out.push(p);
      } catch {
        /* vanished mid-scan — skip */
      }
    }
  }
  return out;
}

/**
 * Parse one rollout file into per-turn usage rows (deltas of the cumulative
 * total). Pure over the file's lines; the importer handles I/O and insertion.
 */
export async function parseCodexRollout(file: string): Promise<
  Array<{
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
  }>
> {
  const rl = createInterface({ input: createReadStream(file), crlfDelay: Infinity });
  let sessionId: string | null = null;
  let provider = 'openai';
  let model = 'gpt-5';
  let project = 'codex';
  // A rollout that never emits a cwd keeps the tool-name placeholder, so the
  // basis starts as a fallback and is upgraded only when a real path arrives.
  let attributionBasis: AttributionBasis = 'tool_log_fallback';
  let cwd: string | null = null;
  let ordinal = 0;
  let prev: TokenTotals = { input: 0, cachedInput: 0, output: 0, reasoning: 0 };
  const rows: Awaited<ReturnType<typeof parseCodexRollout>> = [];

  const projFromCwd = (cwd: string) => projectKeyWithBasis(cwd, 'codex');

  for await (const line of rl) {
    let o: { type?: string; timestamp?: string; payload?: Record<string, unknown> };
    try {
      o = JSON.parse(line);
    } catch {
      continue; // torn tail of a live session — next import gets it whole
    }
    const p = o.payload ?? {};
    if (o.type === 'session_meta') {
      sessionId = (p.id as string) ?? sessionId;
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
      continue;
    }
    if (o.type === 'event_msg' && p.type === 'token_count') {
      const info = p.info as { total_token_usage?: Record<string, number> } | undefined;
      const tot = totalsFrom(info?.total_token_usage);
      if (!tot) continue;
      // Delta since the previous token_count; clamp at 0 across a compaction reset.
      const dIn = Math.max(0, tot.input - prev.input);
      const dCached = Math.max(0, tot.cachedInput - prev.cachedInput);
      const dOut = Math.max(0, tot.output - prev.output);
      const dReason = Math.max(0, tot.reasoning - prev.reasoning);
      prev = tot;
      if (dIn === 0 && dOut === 0 && dCached === 0) continue; // no new work this event
      const ts = Date.parse(o.timestamp ?? '');
      if (Number.isNaN(ts)) continue;
      const uncachedIn = Math.max(0, dIn - dCached); // Codex counts cached inside input_tokens
      rows.push({
        requestId: `codex:${sessionId ?? 'unknown'}:${ordinal++}`,
        sessionId,
        tsEpochMs: ts,
        provider,
        model,
        project,
        attributionBasis,
        cwd,
        inputTokens: uncachedIn,
        outputTokens: dOut,
        cacheReadTokens: dCached,
        reasoningTokens: dReason,
      });
    }
  }
  return rows;
}

const REPRICEABLE: Record<string, Provider> = { openai: 'openai', anthropic: 'anthropic' };

/** Import Codex rollout usage into the store. Idempotent; re-run/poll safe. */
export async function importCodex(store: Store, opts: ImportOptions = {}): Promise<ImportSummary> {
  const root = opts.root ?? defaultCodexRoot();
  const source = opts.source ?? 'codex';
  const sinceMs = opts.sinceMs ?? 0;
  if (!root || !existsSync(root)) return emptyImportSummary(0);

  const files = codexRolloutFiles(root);
  const summary = emptyImportSummary(files.length);
  // Same subdirectory/collision problem as the Claude Code transcripts: a rollout
  // records the cwd it ran in, which is often not the repository root.
  const resolveProject = createRepoResolver();

  for (const file of files) {
    let rows: Awaited<ReturnType<typeof parseCodexRollout>>;
    try {
      rows = await parseCodexRollout(file);
    } catch {
      continue; // unreadable file — skip, never abort the whole import
    }
    for (const ev of rows) {
      if (ev.tsEpochMs < sinceMs) continue;
      const attribution = await resolveProject(ev.cwd, 'codex');
      noteRelabel(summary, attribution);
      const prov = REPRICEABLE[ev.provider];
      const c = prov
        ? computeCost(prov, ev.model, {
            inputTokens: ev.inputTokens,
            outputTokens: ev.outputTokens,
            cacheWriteTokens: 0,
            cacheReadTokens: ev.cacheReadTokens,
          })
        : { costUsd: 0, estimated: true, pricing: unpricedPricingEvidence() };

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
        costUsd: c.costUsd,
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
      recordInsert(store, summary, row, c.estimated);
    }
  }
  return summary;
}
