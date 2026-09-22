/**
 * Proposal extraction + acceptance — the signal only an in-path proxy can see.
 *
 * The agent's *proposed* edits live in the response body as tool-call payloads.
 * Git records what was *actually committed*. The overlap measures how much of the
 * AI's raw output a human kept — the "Accepted" gate and First-Pass Acceptance.
 *
 * Extraction is best-effort across client shapes; what it can't parse becomes an
 * `unknown` Proposed/Accepted verdict downstream, never a false signal.
 */

import { RESOURCE_LIMITS, type CaptureCoverage } from '../util/resource-limits.ts';

export interface ProposedFile {
  path: string | null; // null = inline code block with no resolvable path
  addedLines: string[];
}

export interface ProposalExtractionResult {
  /** Complete, bounded proposals only. Partial captures are deliberately empty. */
  files: ProposedFile[];
  captureCoverage: CaptureCoverage;
}

/**
 * Budget used while interpreting an already-parsed provider response. The
 * proxy bounds the wire body, but this second boundary matters because JSON
 * parsing and line splitting can otherwise turn one bounded body into an
 * unbounded number of retained arrays/strings. A truncation is sticky and the
 * result is unusable for acceptance; callers receive an explicit coverage bit.
 */
class ExtractionBudget {
  readonly files: ProposedFile[] = [];
  private capturedBytes = 0;
  private lineCount = 0;
  private fragmentCount = 0;
  truncated = false;

  acceptFragment(): boolean {
    if (this.truncated) return false;
    this.fragmentCount += 1;
    if (this.fragmentCount > RESOURCE_LIMITS.sseFragments) {
      this.truncated = true;
      return false;
    }
    return true;
  }

  /** Count a relevant string once and enforce both field and aggregate caps. */
  acceptString(value: string, fieldLimit: number): boolean {
    const bytes = Buffer.byteLength(value, 'utf8');
    if (bytes > fieldLimit || this.capturedBytes + bytes > RESOURCE_LIMITS.proposalCaptureBytes) {
      this.truncated = true;
      return false;
    }
    this.capturedBytes += bytes;
    return true;
  }

  /** Split without calling String#split, so a line flood cannot allocate a huge array first. */
  lines(value: string, countBytes = true): string[] | null {
    if (countBytes && !this.acceptString(value, RESOURCE_LIMITS.toolArgumentBytes)) return null;
    const out: string[] = [];
    let start = 0;
    for (let i = 0; i <= value.length; i += 1) {
      if (i !== value.length && value.charCodeAt(i) !== 10) continue;
      if (this.lineCount + out.length + 1 > RESOURCE_LIMITS.proposalLines) {
        this.truncated = true;
        return null;
      }
      out.push(value.slice(start, i));
      start = i + 1;
    }
    return out;
  }

  addFile(path: string | null, addedLines: string[]): boolean {
    if (this.truncated) return false;
    if (this.files.length >= RESOURCE_LIMITS.proposalFiles || this.lineCount + addedLines.length > RESOURCE_LIMITS.proposalLines) {
      this.truncated = true;
      return false;
    }
    this.files.push({ path, addedLines });
    this.lineCount += addedLines.length;
    return true;
  }
}

/** Normalize a line for comparison: collapse whitespace, trim, drop if empty. */
function normalizeLines(lines: string[]): string[] {
  const out: string[] = [];
  for (const l of lines) {
    const n = l.replace(/\s+/g, ' ').trim();
    if (n.length > 0) out.push(n);
  }
  return out;
}

/**
 * Fraction of `proposed` lines that appear in `committedAdded` (multiset). 0..1.
 * "How much of what the AI proposed actually shipped, roughly verbatim."
 */
export function acceptanceRatio(proposed: string[], committedAdded: string[]): number {
  const p = normalizeLines(proposed);
  if (p.length === 0) return 0;
  const pool = new Map<string, number>();
  for (const l of normalizeLines(committedAdded)) pool.set(l, (pool.get(l) ?? 0) + 1);
  let hit = 0;
  for (const l of p) {
    const c = pool.get(l) ?? 0;
    if (c > 0) {
      hit += 1;
      pool.set(l, c - 1);
    }
  }
  return hit / p.length;
}

function asObject(v: unknown): Record<string, unknown> | null {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

function str(v: unknown): string | null {
  return typeof v === 'string' ? v : null;
}

/** Map one edit tool-call (name + input) into the bounded extraction budget. */
function fromToolCall(name: string, input: Record<string, unknown>, budget: ExtractionBudget): void {
  const n = name.toLowerCase();
  const path = str(input.file_path) ?? str(input.path) ?? str(input.filename) ?? null;
  if (path !== null && path.length > RESOURCE_LIMITS.metadataFieldChars) {
    budget.truncated = true;
    return;
  }

  // Whole-file writes: Claude-Code "Write", text-editor "create".
  const whole = str(input.content) ?? str(input.file_text) ?? str(input.text);
  // Targeted edits: "Edit"/str_replace insert the new string only.
  const fragment = str(input.new_string) ?? str(input.new_str) ?? str(input.insert);

  // MultiEdit: edits[].new_string
  if (Array.isArray(input.edits)) {
    const lines: string[] = [];
    for (const e of input.edits) {
      if (!budget.acceptFragment()) return;
      const eo = asObject(e);
      const ns = eo ? str(eo.new_string) ?? str(eo.new_str) : null;
      if (ns) {
        const editLines = budget.lines(ns);
        if (editLines === null) return;
        lines.push(...editLines);
      }
    }
    if (lines.length) {
      budget.addFile(path, lines);
      return;
    }
  }

  const body = whole ?? fragment;
  if (body !== null && (n.includes('write') || n.includes('edit') || n.includes('str_replace') || n.includes('create') || n.includes('file') || whole !== null)) {
    const lines = budget.lines(body);
    if (lines !== null) budget.addFile(path, lines);
  }
}

/** Extract proposed edits and retain an explicit capture-coverage result. */
export function extractProposalsWithCoverage(provider: string, body: unknown): ProposalExtractionResult {
  const root = asObject(body);
  if (!root) return { files: [], captureCoverage: 'complete' };
  const budget = new ExtractionBudget();

  // Anthropic: { content: [ { type:'tool_use', name, input } | { type:'text', text } ] }
  if (Array.isArray(root.content)) {
    for (const block of root.content) {
      if (!budget.acceptFragment()) break;
      const b = asObject(block);
      if (!b) continue;
      if (b.type === 'tool_use') {
        const name = str(b.name) ?? '';
        const input = asObject(b.input);
        if (input) fromToolCall(name, input, budget);
      } else if (b.type === 'text') {
        fromFencedCode(str(b.text) ?? '', budget);
      }
    }
  }

  // OpenAI: { choices: [ { message: { content, tool_calls:[{function:{name,arguments}}] } } ] }
  if (Array.isArray(root.choices)) {
    for (const choice of root.choices) {
      if (!budget.acceptFragment()) break;
      const c = asObject(choice);
      const msg = c ? asObject(c.message) : null;
      if (!msg) continue;
      if (Array.isArray(msg.tool_calls)) {
        for (const tc of msg.tool_calls) {
          if (!budget.acceptFragment()) break;
          const t = asObject(tc);
          const fn = t ? asObject(t.function) : null;
          if (!fn) continue;
          const name = str(fn.name) ?? '';
          let args: Record<string, unknown> | null = asObject(fn.arguments);
          if (!args && typeof fn.arguments === 'string') {
            if (!budget.acceptString(fn.arguments, RESOURCE_LIMITS.toolArgumentBytes)) continue;
            try {
              args = asObject(JSON.parse(fn.arguments));
            } catch {
              args = null;
            }
          }
          if (args) fromToolCall(name, args, budget);
        }
      }
      if (typeof msg.content === 'string') fromFencedCode(msg.content, budget);
    }
  }

  return {
    files: budget.truncated ? [] : budget.files,
    captureCoverage: budget.truncated ? 'truncated' : 'complete',
  };
}

/** Backward-compatible files-only adapter for callers that do not need coverage. */
export function extractProposals(provider: string, body: unknown): ProposedFile[] {
  return extractProposalsWithCoverage(provider, body).files;
}

/** Fallback: pull fenced code blocks out of assistant prose (path unresolved). */
function fromFencedCode(text: string, budget: ExtractionBudget): void {
  if (!text || !budget.acceptString(text, RESOURCE_LIMITS.proposalCaptureBytes)) return;
  let cursor = 0;
  while (!budget.truncated) {
    const start = text.indexOf('```', cursor);
    if (start < 0) break;
    const lineEnd = text.indexOf('\n', start + 3);
    if (lineEnd < 0) break;
    const end = text.indexOf('```', lineEnd + 1);
    if (end < 0) break;
    if (!budget.acceptFragment()) break;
    const lines = budget.lines(text.slice(lineEnd + 1, end), false);
    if (lines === null) break;
    if (lines.length > 1) budget.addFile(null, lines);
    cursor = end + 3;
  }
}

/**
 * Overall acceptance of a set of proposals against a commit's added lines.
 * Pools every proposed line and every committed added line, then asks what
 * fraction of proposed lines shipped. Returns null when there is nothing
 * proposed (→ the Accepted gate is `unknown`, not failed).
 */
export function acceptanceForCommit(
  proposals: ProposedFile[],
  committedAddedByFile: Map<string, string[]>,
): number | null {
  const proposedLines: string[] = [];
  for (const pf of proposals) proposedLines.push(...pf.addedLines);
  if (normalizeLines(proposedLines).length === 0) return null;

  const committed: string[] = [];
  for (const lines of committedAddedByFile.values()) committed.push(...lines);

  return acceptanceRatio(proposedLines, committed);
}
