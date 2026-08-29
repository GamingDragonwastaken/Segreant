/**
 * Native metering for Claude Code — no routing, no key, no config.
 *
 * Claude Code writes a JSONL transcript of every session to
 * ~/.claude/projects/<project>/<session>.jsonl, and each assistant entry
 * carries the EXACT provider-reported usage: model, input/output tokens, and
 * the cache-write split by TTL — richer than what a proxy sees on the wire.
 * Reading those files meters subscription-mode usage that never touches a
 * proxy, which is exactly the traffic a cooperative proxy cannot see.
 *
 * Honesty notes, enforced here rather than assumed:
 *  - One API request streams as SEVERAL transcript lines sharing a requestId
 *    with identical usage — dedupe on requestId, first entry wins.
 *  - Synthetic entries (model "<synthetic>") are Claude Code's own error
 *    placeholders, not billable traffic — skipped.
 *  - The dollar figure is consumption valued at API list rates. On a flat
 *    subscription that is the value consumed, not a bill — callers disclose
 *    this wherever the number is shown.
 */

import { createReadStream, readdirSync, statSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { join } from 'node:path';
import { homedir } from 'node:os';
import type { Store, RequestRow } from '../store/db.ts';
import { computeCost } from '../cost/pricing.ts';
import { projectKeyWithBasis, type AttributionBasis } from '../value/characterization.ts';
import {
  type ImportSummary,
  type ImportOptions,
  emptyImportSummary,
  recordInsert,
  createRepoResolver,
  noteRelabel,
} from './importShared.ts';

export type { ImportSummary, ImportOptions } from './importShared.ts';

export interface TranscriptUsageEvent {
  requestId: string;
  sessionId: string | null;
  tsEpochMs: number;
  model: string;
  /** Basename of the session's working directory — the same notion of "project" the proxy uses. */
  project: string;
  /** Whether that basename came from a real recorded path or from the tool-name fallback. */
  attributionBasis: AttributionBasis;
  /** Full working-directory path — the repo Fiscus can find and auto-correlate. */
  cwd: string | null;
  inputTokens: number;
  outputTokens: number;
  cacheWriteTokens: number;
  cacheReadTokens: number;
  cacheWriteTtl?: '5m' | '1h';
}

/** Default transcript root: ~/.claude/projects (override for tests / unusual installs). */
export function defaultClaudeCodeRoot(): string {
  return join(homedir(), '.claude', 'projects');
}

interface RawUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation?: { ephemeral_5m_input_tokens?: number; ephemeral_1h_input_tokens?: number };
}

/** Parse one transcript line into a usage event, or null for everything that is not billable traffic. */
export function parseTranscriptLine(line: string): TranscriptUsageEvent | null {
  let o: unknown;
  try {
    o = JSON.parse(line);
  } catch {
    return null; // torn tail line of a live session — the next import picks it up whole
  }
  if (!o || typeof o !== 'object') return null;
  const e = o as {
    type?: string;
    uuid?: string;
    requestId?: string;
    timestamp?: string;
    sessionId?: string;
    cwd?: string;
    message?: { model?: string; usage?: RawUsage };
  };
  if (e.type !== 'assistant' || !e.message?.usage) return null;
  const model = e.message.model ?? '';
  if (!model || model === '<synthetic>') return null;
  const ts = Date.parse(e.timestamp ?? '');
  if (Number.isNaN(ts)) return null;
  const id = e.requestId ?? e.uuid;
  if (!id) return null;

  const u = e.message.usage;
  const cacheWrite = u.cache_creation_input_tokens ?? 0;
  const ttl5m = u.cache_creation?.ephemeral_5m_input_tokens ?? 0;
  const ttl1h = u.cache_creation?.ephemeral_1h_input_tokens ?? 0;
  const cwd = e.cwd ?? '';
  const { project, basis: attributionBasis } = projectKeyWithBasis(cwd, 'claude-code');

  return {
    requestId: id,
    sessionId: e.sessionId ?? null,
    tsEpochMs: ts,
    model,
    project,
    attributionBasis,
    cwd: cwd || null,
    inputTokens: u.input_tokens ?? 0,
    outputTokens: u.output_tokens ?? 0,
    cacheWriteTokens: cacheWrite,
    cacheReadTokens: u.cache_read_input_tokens ?? 0,
    cacheWriteTtl: cacheWrite > 0 ? (ttl1h >= ttl5m ? '1h' : '5m') : undefined,
  };
}

/**
 * Scan every transcript under `root` and insert each API request exactly once.
 * Idempotent by construction (request_id is the store's natural key), so
 * re-running after new sessions only picks up the new traffic.
 */
export async function importClaudeCode(store: Store, opts: ImportOptions = {}): Promise<ImportSummary> {
  const root = opts.root ?? defaultClaudeCodeRoot();
  const source = opts.source ?? 'claude-code';
  const sinceMs = opts.sinceMs ?? 0;

  let files: string[] = [];
  try {
    files = (readdirSync(root, { recursive: true }) as string[])
      .filter((f) => f.endsWith('.jsonl'))
      .map((f) => join(root, f))
      .filter((f) => {
        try {
          return statSync(f).isFile();
        } catch {
          return false;
        }
      });
  } catch {
    files = []; // no Claude Code install → an honest empty import, not a crash
  }

  const summary = emptyImportSummary(files.length);
  // Resolve each transcript cwd to its repository root once. A Claude Code
  // session is routinely started inside a package or a subdirectory, and the
  // basename of that directory is not the project — see createRepoResolver.
  const resolveProject = createRepoResolver();

  for (const file of files) {
    const seenInFile = new Set<string>(); // one API request = many transcript lines; first wins
    const rl = createInterface({ input: createReadStream(file), crlfDelay: Infinity });
    for await (const line of rl) {
      const ev = parseTranscriptLine(line);
      if (!ev || ev.tsEpochMs < sinceMs) continue;
      if (seenInFile.has(ev.requestId)) continue;
      seenInFile.add(ev.requestId);

      const attribution = await resolveProject(ev.cwd, 'claude-code');
      noteRelabel(summary, attribution);

      const cost = computeCost('anthropic', ev.model, {
        inputTokens: ev.inputTokens,
        outputTokens: ev.outputTokens,
        cacheWriteTokens: ev.cacheWriteTokens,
        cacheReadTokens: ev.cacheReadTokens,
        cacheWriteTtl: ev.cacheWriteTtl,
      });

      const row: RequestRow = {
        requestId: ev.requestId,
        sessionId: ev.sessionId,
        tsEpochMs: ev.tsEpochMs,
        provider: 'anthropic',
        model: ev.model,
        project: attribution.project,
        attributionBasis: attribution.basis,
        taskWeight: 1,
        inputTokens: ev.inputTokens,
        outputTokens: ev.outputTokens,
        cacheWriteTokens: ev.cacheWriteTokens,
        cacheReadTokens: ev.cacheReadTokens,
        reasoningTokens: 0,
        costUsd: cost.costUsd,
        economicAmount: cost.exact?.total,
        estimated: cost.estimated,
        pricing: cost.pricing,
        streamed: true,
        statusCode: 200,
        durationMs: null,
        user: null,
        source,
        cwd: ev.cwd,
      };
      if (ev.sessionId) store.upsertSession(ev.sessionId, attribution.project, source, ev.tsEpochMs);
      recordInsert(store, summary, row, cost.estimated);
    }
  }
  return summary;
}
