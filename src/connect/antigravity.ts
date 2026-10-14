/**
 * Native metering for Google Antigravity (the IDE agent and the `agy` CLI).
 *
 * Antigravity keeps one SQLite file per conversation under
 * ~/.gemini/antigravity/conversations and ~/.gemini/antigravity-cli/conversations.
 * Each model call is a row of `gen_metadata` holding a protobuf
 * `CortexStepGeneratorMetadata`; its `chat_model` (field 1) carries the call's
 * `ModelUsageStats` (field 4) and the model that answered (`response_model`,
 * field 19). Field numbers follow the published Windsurf/Antigravity schema
 * (`exa.cortex_pb` and `exa.codeium_common_pb`, as mirrored in open-source
 * Antigravity tooling); nothing is guessed from values.
 *
 *   ModelUsageStats: 2 input_tokens · 3 output_tokens · 4 cache_write_tokens ·
 *                    5 cache_read_tokens · 9 thinking_output_tokens
 *
 * The same usage is repeated in each step's metadata and in `retry_infos`; only
 * the generator's own usage is counted, once. The call's time is its first
 * step's `created_at`; the workspace folder comes from the trajectory metadata.
 *
 * Read-only: each database is opened read-only, so Antigravity keeps writing.
 * Antigravity prices nothing locally, so every row is list cost from the rate
 * card; a model the card does not carry (Gemini 3.x today) gets the labelled
 * fallback estimate, never an invented price.
 */
import { existsSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import type { Store, RequestRow } from '../store/db.ts';
import { computeCost } from '../cost/pricing.ts';
import {
  type ImportSummary,
  type ImportOptions,
  emptyImportSummary,
  recordInsert,
  createRepoResolver,
  noteRelabel,
  markImportTruncated,
  fileStampForImport,
  noteFileImported,
  noteFileUnchanged,
  truncationMark,
} from './importShared.ts';
import { pbFields, pbMessage, pbString, pbTimestampMs, pbUint, pbUints } from './protobuf.ts';
import { RESOURCE_LIMITS } from '../util/resource-limits.ts';

/** ~/.gemini, where Antigravity keeps its data. null = not installed. */
export function defaultAntigravityRoot(): string | null {
  const root = join(homedir(), '.gemini');
  return ['antigravity', 'antigravity-cli'].some((d) => existsSync(join(root, d, 'conversations'))) ? root : null;
}

export interface AntigravityCall {
  requestId: string;
  sessionId: string;
  tsEpochMs: number;
  model: string;
  provider: 'google' | 'anthropic' | 'openai';
  cwd: string | null;
  inputTokens: number;
  outputTokens: number;
  cacheWriteTokens: number;
  cacheReadTokens: number;
  reasoningTokens: number;
}

/** Opt-in elapsed phase observations for synthetic performance diagnosis. */
export interface AntigravityImportProfile {
  filesRead: number;
  stepRows: number;
  generatorRows: number;
  decodedCalls: number;
  eligibleCalls: number;
  insertedRows: number;
  readMs: number;
  decodeMs: number;
  filterMs: number;
  attributionMs: number;
  pricingMs: number;
  persistMs: number;
  totalMs: number;
}

export interface AntigravityImportOptions extends ImportOptions {
  /** Aggregate only: never includes paths, payloads, or individual usage. */
  onProfile?: (profile: Readonly<AntigravityImportProfile>) => void;
}

function measureRead<T>(profile: AntigravityImportProfile | undefined, read: () => T): T {
  if (profile === undefined) return read();
  const start = performance.now();
  try { return read(); } finally { profile.readMs += performance.now() - start; }
}

function providerFor(model: string): AntigravityCall['provider'] {
  const m = model.toLowerCase();
  if (m.startsWith('claude')) return 'anthropic';
  if (/^(gpt|o\d)/.test(m)) return 'openai';
  return 'google';
}

function workspacePath(uri: string | null): string | null {
  if (uri === null || !uri.startsWith('file://')) return null;
  try {
    return fileURLToPath(uri);
  } catch {
    return null;
  }
}

/** Every model call in one conversation database. Pure over the database's rows. */
export function readAntigravityConversation(db: DatabaseSync, fallbackId: string, profile?: AntigravityImportProfile): AntigravityCall[] {
  const tableNames = new Set(measureRead(profile, () => db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>).map((t) => t.name));
  if (!tableNames.has('gen_metadata')) return [];

  let trajectoryId = fallbackId;
  let cwd: string | null = null;
  let startedMs: number | null = null;
  if (tableNames.has('trajectory_metadata_blob')) {
    const meta = measureRead(profile, () => db.prepare('SELECT data FROM trajectory_metadata_blob LIMIT 1').get() as { data: Uint8Array } | undefined);
    if (meta?.data) {
      const decodeStart = profile === undefined ? 0 : performance.now();
      const f = pbFields(meta.data);
      const workspace = pbMessage(f, 1);
      cwd = workspace === null ? null : workspacePath(pbString(workspace, 1));
      startedMs = pbTimestampMs(pbMessage(f, 2));
      trajectoryId = pbString(f, 3) ?? trajectoryId;
      if (profile !== undefined) profile.decodeMs += performance.now() - decodeStart;
    }
  }

  const stepTimes = new Map<number, number>();
  if (tableNames.has('steps')) {
    const steps = measureRead(profile, () => db.prepare('SELECT idx, metadata FROM steps').all() as Array<{ idx: number; metadata: Uint8Array | null }>);
    if (profile !== undefined) profile.stepRows += steps.length;
    const decodeStart = profile === undefined ? 0 : performance.now();
    for (const s of steps) {
      if (!s.metadata) continue;
      const t = pbTimestampMs(pbMessage(pbFields(s.metadata), 1));
      if (t !== null) stepTimes.set(s.idx, t);
    }
    if (profile !== undefined) profile.decodeMs += performance.now() - decodeStart;
  }

  const calls: AntigravityCall[] = [];
  const generators = measureRead(profile, () => db.prepare('SELECT idx, data FROM gen_metadata ORDER BY idx').all() as Array<{ idx: number; data: Uint8Array | null }>);
  if (profile !== undefined) profile.generatorRows += generators.length;
  const decodeStart = profile === undefined ? 0 : performance.now();
  for (const g of generators) {
    if (!g.data) continue;
    const gen = pbFields(g.data);
    const chat = pbMessage(gen, 1);
    if (chat === null) continue; // an injected response: no model call
    const usage = pbMessage(chat, 4);
    if (usage === null) continue;
    const inputTokens = pbUint(usage, 2);
    const outputTokens = pbUint(usage, 3);
    const cacheWriteTokens = pbUint(usage, 4);
    const cacheReadTokens = pbUint(usage, 5);
    if (inputTokens + outputTokens + cacheWriteTokens + cacheReadTokens === 0) continue;
    const model = pbString(chat, 19) || `antigravity-model-${pbUint(chat, 3)}`;
    const firstStep = pbUints(gen, 2)[0];
    const ts = (firstStep !== undefined ? stepTimes.get(firstStep) : undefined) ?? startedMs;
    if (ts === null || ts === undefined) continue;
    calls.push({
      requestId: `antigravity:${trajectoryId}:${g.idx}`,
      sessionId: trajectoryId,
      tsEpochMs: ts,
      model,
      provider: providerFor(model),
      cwd,
      inputTokens,
      outputTokens,
      cacheWriteTokens,
      cacheReadTokens,
      reasoningTokens: pbUint(usage, 9),
    });
  }
  if (profile !== undefined) {
    profile.decodeMs += performance.now() - decodeStart;
    profile.decodedCalls += calls.length;
  }
  return calls;
}

function conversationFiles(root: string): string[] {
  const out: string[] = [];
  for (const sub of ['antigravity', 'antigravity-cli']) {
    const dir = join(root, sub, 'conversations');
    let names: string[] = [];
    try { names = readdirSync(dir); } catch { continue; }
    for (const n of names) if (n.endsWith('.db')) out.push(join(dir, n));
  }
  return out;
}

/** Imports in periodic commits rather than one commit per row (see Store.importBatch). */
export async function importAntigravity(store: Store, opts: AntigravityImportOptions = {}): Promise<ImportSummary> {
  const batch = store.importBatch();
  try {
    return await importAntigravityRows(store, opts);
  } finally {
    batch.end();
  }
}

async function importAntigravityRows(store: Store, opts: AntigravityImportOptions): Promise<ImportSummary> {
  const started = performance.now();
  const profile: AntigravityImportProfile | undefined = opts.onProfile === undefined ? undefined : {
    filesRead: 0, stepRows: 0, generatorRows: 0, decodedCalls: 0, eligibleCalls: 0,
    insertedRows: 0, readMs: 0, decodeMs: 0, filterMs: 0,
    attributionMs: 0, pricingMs: 0, persistMs: 0, totalMs: 0,
  };
  const root = opts.root ?? defaultAntigravityRoot();
  const source = opts.source ?? 'antigravity';
  const sinceMs = opts.sinceMs ?? 0;
  if (root === null) {
    const empty = emptyImportSummary(0);
    if (profile !== undefined) {
      profile.totalMs = performance.now() - started;
      opts.onProfile?.(profile);
    }
    return empty;
  }
  const files = conversationFiles(root);
  const summary = emptyImportSummary(files.length);
  const resolveProject = createRepoResolver();
  let rows = 0;

  for (const file of files) {
    // A live conversation writes to its WAL first; the main file's size and time
    // do not move until a checkpoint, so such a file is always read again.
    let walLive = false;
    try { walLive = statSync(`${file}-wal`).size > 0; } catch { walLive = false; }
    const stamp = fileStampForImport(store, source, file, walLive ? { ...opts, rescan: true } : opts);
    if (stamp === 'deferred') {
      summary.filesDeferred = (summary.filesDeferred ?? 0) + 1;
      continue;
    }
    if (stamp === 'unchanged') {
      noteFileUnchanged(store, source, file, summary);
      continue;
    }
    const truncationsBefore = truncationMark(summary);
    let db: DatabaseSync;
    try {
      db = new DatabaseSync(file, { readOnly: true });
    } catch {
      continue; // locked or not a database: skipped, never a crash
    }
    if (profile !== undefined) profile.filesRead += 1;
    let calls: AntigravityCall[] = [];
    try {
      calls = readAntigravityConversation(db, file.replace(/^.*[\\/]/, '').replace(/\.db$/, ''), profile);
    } catch {
      calls = [];
    } finally {
      db.close();
    }
    for (const c of calls) {
      const filterStart = profile === undefined ? 0 : performance.now();
      const tooOld = c.tsEpochMs < sinceMs;
      if (profile !== undefined) profile.filterMs += performance.now() - filterStart;
      if (tooOld) continue;
      if (++rows > RESOURCE_LIMITS.importRows) {
        markImportTruncated(summary, 'rows');
        break;
      }
      if (profile !== undefined) profile.eligibleCalls += 1;
      const attributionStart = profile === undefined ? 0 : performance.now();
      const attribution = await resolveProject(c.cwd, 'antigravity');
      if (profile !== undefined) profile.attributionMs += performance.now() - attributionStart;
      noteRelabel(summary, attribution);
      // The rate card's lookup follows the model across providers (rateFor), so a
      // Gemini row finds the Google table through any named provider.
      const pricingStart = profile === undefined ? 0 : performance.now();
      const cost = computeCost(c.provider === 'anthropic' ? 'anthropic' : 'openai', c.model, {
        inputTokens: c.inputTokens,
        outputTokens: c.outputTokens,
        cacheWriteTokens: c.cacheWriteTokens,
        cacheReadTokens: c.cacheReadTokens,
      });
      if (profile !== undefined) profile.pricingMs += performance.now() - pricingStart;
      const row: RequestRow = {
        requestId: c.requestId,
        sessionId: c.sessionId,
        tsEpochMs: c.tsEpochMs,
        provider: c.provider,
        model: c.model,
        project: attribution.project,
        attributionBasis: attribution.basis,
        taskWeight: 1,
        inputTokens: c.inputTokens,
        outputTokens: c.outputTokens,
        cacheWriteTokens: c.cacheWriteTokens,
        cacheReadTokens: c.cacheReadTokens,
        reasoningTokens: c.reasoningTokens,
        costUsd: cost.costUsd,
        economicAmount: cost.exact?.total,
        estimated: cost.estimated,
        pricing: cost.pricing,
        streamed: true,
        statusCode: 200,
        durationMs: null,
        user: null,
        source,
        cwd: c.cwd,
      };
      const persistStart = profile === undefined ? 0 : performance.now();
      store.upsertSession(c.sessionId, attribution.project, source, c.tsEpochMs);
      recordInsert(store, summary, row, cost.estimated);
      if (profile !== undefined) profile.persistMs += performance.now() - persistStart;
    }
    const cursorStart = profile === undefined ? 0 : performance.now();
    noteFileImported(store, source, file, stamp, opts, truncationsBefore, summary);
    if (profile !== undefined) profile.persistMs += performance.now() - cursorStart;
  }
  if (profile !== undefined) {
    profile.insertedRows = summary.inserted;
    profile.totalMs = performance.now() - started;
    opts.onProfile?.(profile);
  }
  return summary;
}
