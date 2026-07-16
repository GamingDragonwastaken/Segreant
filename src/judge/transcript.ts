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

import { createReadStream, readdirSync, statSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { join, basename } from 'node:path';
import { defaultClaudeCodeRoot } from '../connect/claudeCode.ts';

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
 * The one-call convenience the orchestrator's store wrapper uses: find the
 * session's on-disk transcript for a supported tool and read it, or return
 * null — with the caller saying honestly WHY (unsupported tool vs not found)
 * via `transcriptSupport` below.
 */
export async function loadTranscriptExcerpt(
  sessionId: string,
  tool: string | null,
  root?: string,
): Promise<TranscriptExcerpt | null> {
  if (tool !== 'claude-code') return null;
  const path = findClaudeCodeTranscript(sessionId, root);
  if (!path) return null;
  const excerpt = await extractTranscriptTurns(path, sessionId);
  return excerpt.turns.length > 0 ? excerpt : null;
}

/** One line for rationale/notes: is full-content even possible for this tool? */
export function transcriptSupport(tool: string | null): 'supported' | 'unsupported-tool' {
  return tool === 'claude-code' ? 'supported' : 'unsupported-tool';
}
