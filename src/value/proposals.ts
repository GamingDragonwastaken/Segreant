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

export interface ProposedFile {
  path: string | null; // null = inline code block with no resolvable path
  addedLines: string[];
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

/** Map one edit tool-call (name + input) to a proposed file, or null if not an edit. */
function fromToolCall(name: string, input: Record<string, unknown>): ProposedFile | null {
  const n = name.toLowerCase();
  const path = str(input.file_path) ?? str(input.path) ?? str(input.filename) ?? null;

  // Whole-file writes: Claude-Code "Write", text-editor "create".
  const whole = str(input.content) ?? str(input.file_text) ?? str(input.text);
  // Targeted edits: "Edit"/str_replace insert the new string only.
  const fragment = str(input.new_string) ?? str(input.new_str) ?? str(input.insert);

  // MultiEdit: edits[].new_string
  if (Array.isArray(input.edits)) {
    const lines: string[] = [];
    for (const e of input.edits) {
      const eo = asObject(e);
      const ns = eo ? str(eo.new_string) ?? str(eo.new_str) : null;
      if (ns) lines.push(...ns.split('\n'));
    }
    if (lines.length) return { path, addedLines: lines };
  }

  const body = whole ?? fragment;
  if (body !== null && (n.includes('write') || n.includes('edit') || n.includes('str_replace') || n.includes('create') || n.includes('file') || whole !== null)) {
    return { path, addedLines: body.split('\n') };
  }
  return null;
}

/** Extract proposed edits from a parsed provider response body. */
export function extractProposals(provider: string, body: unknown): ProposedFile[] {
  const root = asObject(body);
  if (!root) return [];
  const files: ProposedFile[] = [];

  // Anthropic: { content: [ { type:'tool_use', name, input } | { type:'text', text } ] }
  if (Array.isArray(root.content)) {
    for (const block of root.content) {
      const b = asObject(block);
      if (!b) continue;
      if (b.type === 'tool_use') {
        const name = str(b.name) ?? '';
        const input = asObject(b.input);
        if (input) {
          const pf = fromToolCall(name, input);
          if (pf) files.push(pf);
        }
      } else if (b.type === 'text') {
        files.push(...fromFencedCode(str(b.text) ?? ''));
      }
    }
  }

  // OpenAI: { choices: [ { message: { content, tool_calls:[{function:{name,arguments}}] } } ] }
  if (Array.isArray(root.choices)) {
    for (const choice of root.choices) {
      const c = asObject(choice);
      const msg = c ? asObject(c.message) : null;
      if (!msg) continue;
      if (Array.isArray(msg.tool_calls)) {
        for (const tc of msg.tool_calls) {
          const t = asObject(tc);
          const fn = t ? asObject(t.function) : null;
          if (!fn) continue;
          const name = str(fn.name) ?? '';
          let args: Record<string, unknown> | null = asObject(fn.arguments);
          if (!args && typeof fn.arguments === 'string') {
            try {
              args = asObject(JSON.parse(fn.arguments));
            } catch {
              args = null;
            }
          }
          if (args) {
            const pf = fromToolCall(name, args);
            if (pf) files.push(pf);
          }
        }
      }
      if (typeof msg.content === 'string') files.push(...fromFencedCode(msg.content));
    }
  }

  return files;
}

/** Fallback: pull fenced code blocks out of assistant prose (path unresolved). */
function fromFencedCode(text: string): ProposedFile[] {
  const out: ProposedFile[] = [];
  const fence = /```[^\n]*\n([\s\S]*?)```/g;
  for (const m of text.matchAll(fence)) {
    const lines = (m[1] ?? '').split('\n');
    if (lines.length > 1) out.push({ path: null, addedLines: lines });
  }
  return out;
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
