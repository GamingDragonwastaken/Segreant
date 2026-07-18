/**
 * Ephemeral transcript reading for the judge's full-content tiers.
 *
 * The design doc (LIFT-AI-SIDE-JUDGE-DESIGN.md, the ⚠ note) blocked full-content
 * judging on "transcript capture existing first" — a big privacy decision about
 * data at rest. The resolution here is that no capture is needed: the tools
 * Fiscus imports from already keep their own transcripts on disk (Claude Code
 * writes ~/.claude/projects/<dir>/<sessionId>.jsonl with full message content).
 * This module reads that file AT JUDGE TIME, read-only, and hands bounded
 * excerpts to the caller. Nothing here ever writes: Fiscus's store still never
 * persists prompt or response text, and the excerpt lives only for the duration
 * of one judge call. The decision about where the content GOES (local vs hosted
 * LLM) stays entirely with the trust ladder in tier.ts — this module only makes
 * the payload possible, never sends it anywhere.
 *
 * Scope honesty: Claude Code only. opencode's session DB and Codex rollout logs
 * also hold content, but their formats are less stable and unverified for this
 * purpose — sessions from those sources stay structural, with the orchestrator
 * saying so rather than pretending. Widen deliberately, per source, with tests.
 */

import { createReadStream, readdirSync, statSync, existsSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { join, basename } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { defaultClaudeCodeRoot } from '../connect/claudeCode.ts';
import { defaultOpencodeDbPath } from '../connect/opencode.ts';
import { defaultCodexRoot, codexRolloutFiles } from '../connect/codex.ts';

/** One conversational turn, already truncated to the caps below. */
export interface TranscriptTurn {
  role: 'user' | 'assistant';
  text: string;
}

export interface TranscriptExcerpt {
  sessionId: string;
  /** Chronological, bounded turns — see the caps below. */
  turns: TranscriptTurn[];
  /** Turns whose text was clipped to MAX_TURN_CHARS. */
  clippedTurns: number;
  /** Turns dropped entirely once MAX_TOTAL_CHARS was reached (oldest kept — a
   * session's framing usually lives at the start; the tail is often retry noise). */
  droppedTurns: number;
  /** Where this came from — shown in rationale so the user can audit the source. */
  sourcePath: string;
}

// Bounded by construction: an unbounded transcript in a judge prompt is both a
// cost hazard (the judge call is the user's own credential) and a reliability
// hazard (blowing the judge model's context mid-window). Caps are generous
// enough to show real work-shape, small enough to stay one cheap call.
export const MAX_TURN_CHARS = 1_500;
export const MAX_TOTAL_CHARS = 48_000;

/**
 * Locate the Claude Code transcript for a session: the file is literally named
 * `<sessionId>.jsonl` under ~/.claude/projects/<project-dir>/. Matching on the
 * basename of directory-listed files (never joining the id into a path) makes
 * a hostile session id inert — it can only ever fail to match.
 */
export function findClaudeCodeTranscript(sessionId: string, root = defaultClaudeCodeRoot()): string | null {
  if (!/^[A-Za-z0-9-]{8,}$/.test(sessionId)) return null; // not a Claude Code session id shape
  const wanted = `${sessionId}.jsonl`;
  let entries: string[] = [];
  try {
    entries = readdirSync(root, { recursive: true }) as string[];
  } catch {
    return null; // no Claude Code install — honestly nothing to read
  }
  for (const entry of entries) {
    if (basename(entry) !== wanted) continue;
    const full = join(root, entry);
    try {
      if (statSync(full).isFile()) return full;
    } catch {
      /* raced deletion — keep scanning */
    }
  }
  return null;
}

/** Pull the human-readable text out of one message's `content`, which Claude
 * Code writes either as a plain string or as an array of typed parts. Tool
 * calls/results become short structural markers, not payload — the judge needs
 * the shape of the work, not a second copy of every file the session touched. */
function contentToText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const p of content) {
    if (!p || typeof p !== 'object') continue;
    const part = p as { type?: string; text?: unknown; name?: unknown };
    if (part.type === 'text' && typeof part.text === 'string') parts.push(part.text);
    else if (part.type === 'tool_use') parts.push(`[tool: ${typeof part.name === 'string' ? part.name : 'unknown'}]`);
    else if (part.type === 'tool_result') parts.push('[tool result]');
    else if (part.type === 'thinking') parts.push('[thinking]');
  }
  return parts.join(' ');
}

/**
 * Read one transcript file into a bounded excerpt. Read-only, line-tolerant
 * (a torn tail line from a live session is skipped, same as the importer),
 * and clipped per the module caps with the clipping counted, never hidden.
 */
export async function extractTranscriptTurns(sourcePath: string, sessionId: string): Promise<TranscriptExcerpt> {
  const turns: TranscriptTurn[] = [];
  let clippedTurns = 0;
  let droppedTurns = 0;
  let totalChars = 0;

  const rl = createInterface({ input: createReadStream(sourcePath), crlfDelay: Infinity });
  for await (const line of rl) {
    let o: unknown;
    try {
      o = JSON.parse(line);
    } catch {
      continue; // torn tail line of a live session
    }
    if (!o || typeof o !== 'object') continue;
    const e = o as { type?: string; message?: { content?: unknown; model?: string } };
    if (e.type !== 'user' && e.type !== 'assistant') continue;
    if (e.type === 'assistant' && e.message?.model === '<synthetic>') continue; // error placeholder, not a turn
    const raw = contentToText(e.message?.content).trim();
    if (!raw) continue;

    if (totalChars >= MAX_TOTAL_CHARS) {
      droppedTurns++;
      continue; // keep counting so the disclosure is exact
    }
    let text = raw;
    if (text.length > MAX_TURN_CHARS) {
      text = text.slice(0, MAX_TURN_CHARS) + ' …[clipped]';
      clippedTurns++;
    }
    totalChars += text.length;
    turns.push({ role: e.type, text });
  }

  return { sessionId, turns, clippedTurns, droppedTurns, sourcePath };
}

/**
 * opencode transcript, read ephemerally from its own session database
 * (READ-ONLY — same WAL-snapshot posture as the importer). Text parts become
 * turns; tool parts become structural markers; reasoning/step parts are
 * internal machinery, not conversation, and are skipped entirely.
 */
export function extractOpencodeTranscript(
  sessionId: string,
  dbPath: string | null = defaultOpencodeDbPath(),
): TranscriptExcerpt | null {
  if (!dbPath || !existsSync(dbPath)) return null;
  let db: DatabaseSync;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
  } catch {
    return null; // locked/absent — honest null, never a crash
  }
  try {
    const rows = db
      .prepare(
        `SELECT m.data AS msgData, p.data AS partData
           FROM part p JOIN message m ON m.id = p.message_id
          WHERE p.session_id = ?
          ORDER BY p.time_created ASC, p.id ASC`,
      )
      .all(sessionId) as Array<{ msgData: string; partData: string }>;

    const turns: TranscriptTurn[] = [];
    let clippedTurns = 0;
    let droppedTurns = 0;
    let totalChars = 0;
    for (const r of rows) {
      let role: string | undefined;
      let part: { type?: string; text?: unknown };
      try {
        role = (JSON.parse(r.msgData) as { role?: string }).role;
        part = JSON.parse(r.partData) as { type?: string; text?: unknown };
      } catch {
        continue;
      }
      if (role !== 'user' && role !== 'assistant') continue;
      let raw = '';
      if (part.type === 'text' && typeof part.text === 'string') raw = part.text.trim();
      else if (part.type === 'tool') raw = '[tool]';
      if (!raw) continue;

      if (totalChars >= MAX_TOTAL_CHARS) {
        droppedTurns++;
        continue;
      }
      let text = raw;
      if (text.length > MAX_TURN_CHARS) {
        text = text.slice(0, MAX_TURN_CHARS) + ' …[clipped]';
        clippedTurns++;
      }
      totalChars += text.length;
      // Consecutive same-role parts merge into one turn (a message has many parts).
      const last = turns[turns.length - 1];
      if (last && last.role === role) last.text += ' ' + text;
      else turns.push({ role, text });
    }
    return turns.length > 0 ? { sessionId, turns, clippedTurns, droppedTurns, sourcePath: dbPath } : null;
  } finally {
    db.close();
  }
}

/**
 * Find the rollout file for a Codex session. The filename carries the session
 * uuid as its trailing segment (rollout-<timestamp>-<uuid>.jsonl); when no
 * filename matches (older Codex versions), fall back to reading each file's
 * first line for its session_meta id.
 */
async function findCodexRollout(sessionId: string, root: string): Promise<string | null> {
  const files = codexRolloutFiles(root);
  const byName = files.find((f) => basename(f).endsWith(`-${sessionId}.jsonl`));
  if (byName) return byName;
  for (const f of files) {
    const rl = createInterface({ input: createReadStream(f), crlfDelay: Infinity });
    for await (const lineText of rl) {
      let o: { type?: string; payload?: { id?: string } };
      try {
        o = JSON.parse(lineText);
      } catch {
        break;
      }
      rl.close();
      if (o.type === 'session_meta' && o.payload?.id === sessionId) return f;
      break; // session_meta is the first line; anything else → next file
    }
  }
  return null;
}

/** Codex transcript, read ephemerally from the session's own rollout log. */
export async function extractCodexTranscript(
  sessionId: string,
  root: string | null = defaultCodexRoot(),
): Promise<TranscriptExcerpt | null> {
  if (!root || !existsSync(root)) return null;
  const file = await findCodexRollout(sessionId, root);
  if (!file) return null;

  const turns: TranscriptTurn[] = [];
  let clippedTurns = 0;
  let droppedTurns = 0;
  let totalChars = 0;
  const push = (role: 'user' | 'assistant', raw: string): void => {
    const trimmed = raw.trim();
    if (!trimmed) return;
    if (totalChars >= MAX_TOTAL_CHARS) {
      droppedTurns++;
      return;
    }
    let text = trimmed;
    if (text.length > MAX_TURN_CHARS) {
      text = text.slice(0, MAX_TURN_CHARS) + ' …[clipped]';
      clippedTurns++;
    }
    totalChars += text.length;
    turns.push({ role, text });
  };

  const rl = createInterface({ input: createReadStream(file), crlfDelay: Infinity });
  for await (const lineText of rl) {
    let o: { type?: string; payload?: Record<string, unknown> };
    try {
      o = JSON.parse(lineText);
    } catch {
      continue; // torn tail of a live session
    }
    const p = o.payload ?? {};
    if (o.type === 'event_msg' && p.type === 'user_message' && typeof p.message === 'string') push('user', p.message);
    else if (o.type === 'event_msg' && p.type === 'agent_message' && typeof p.message === 'string') push('assistant', p.message);
    else if (o.type === 'response_item' && p.type === 'function_call')
      push('assistant', `[tool: ${typeof p.name === 'string' ? p.name : 'unknown'}]`);
  }
  return turns.length > 0 ? { sessionId, turns, clippedTurns, droppedTurns, sourcePath: file } : null;
}

/** Per-tool transcript locations, overridable for tests. Each default resolves
 * to the tool's real install location on this machine. */
export interface TranscriptRoots {
  claudeCode?: string;
  opencodeDb?: string | null;
  codexRoot?: string | null;
}

/**
 * The one-call convenience the orchestrator's store wrapper uses: route to the
 * session's tool's own on-disk transcript store and read it, or return null —
 * with the caller saying honestly WHY (unsupported tool vs not found) via
 * `transcriptSupport` below. Every path is ephemeral and read-only; an unknown
 * tool is an honest null, never a guess.
 */
export async function loadTranscriptExcerpt(
  sessionId: string,
  tool: string | null,
  roots: TranscriptRoots | string = {},
): Promise<TranscriptExcerpt | null> {
  // Back-compat: a plain string is the old claude-code root parameter.
  const r: TranscriptRoots = typeof roots === 'string' ? { claudeCode: roots } : roots;
  if (tool === 'claude-code') {
    const path = findClaudeCodeTranscript(sessionId, r.claudeCode);
    if (!path) return null;
    const excerpt = await extractTranscriptTurns(path, sessionId);
    return excerpt.turns.length > 0 ? excerpt : null;
  }
  if (tool === 'opencode') return extractOpencodeTranscript(sessionId, r.opencodeDb ?? defaultOpencodeDbPath());
  if (tool === 'codex') return extractCodexTranscript(sessionId, r.codexRoot ?? defaultCodexRoot());
  return null;
}

/** One line for rationale/notes: is full-content even possible for this tool? */
export function transcriptSupport(tool: string | null): 'supported' | 'unsupported-tool' {
  return tool === 'claude-code' || tool === 'opencode' || tool === 'codex' ? 'supported' : 'unsupported-tool';
}
