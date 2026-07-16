/**
 * judge/transcript.ts: the ephemeral transcript reader behind the judge's
 * full-content tiers. The properties that matter:
 *
 *   1. Finding is by exact `<sessionId>.jsonl` basename under the Claude Code
 *      root — a hostile session id can only fail to match, never traverse.
 *   2. Extraction is read-only, line-tolerant (torn tail lines skipped, same
 *      as the importer), and skips Claude Code's synthetic error placeholders.
 *   3. The excerpt is BOUNDED — per-turn and total caps — and every clip/drop
 *      is counted in the result, never hidden.
 *   4. loadTranscriptExcerpt only reads for supported tools; anything else is
 *      an honest null (the orchestrator then says why).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  findClaudeCodeTranscript,
  extractTranscriptTurns,
  loadTranscriptExcerpt,
  MAX_TURN_CHARS,
  MAX_TOTAL_CHARS,
} from '../src/judge/transcript.ts';

function line(o: unknown): string {
  return JSON.stringify(o) + '\n';
}

function userLine(text: string): string {
  return line({ type: 'user', message: { role: 'user', content: text } });
}

function assistantLine(parts: unknown[], model = 'claude-opus-4-8'): string {
  return line({ type: 'assistant', message: { model, content: parts } });
}

function makeRoot(): string {
  return mkdtempSync(join(tmpdir(), 'fiscus-transcript-'));
}

test('transcript: finds <sessionId>.jsonl under nested project dirs; hostile ids and absent installs are inert nulls', () => {
  const root = makeRoot();
  try {
    const dir = join(root, 'C--Users-someone-proj');
    mkdirSync(dir, { recursive: true });
    const file = join(dir, 'abcd1234-ef56-7890-abcd-1234567890ab.jsonl');
    writeFileSync(file, userLine('hello'));

    assert.equal(findClaudeCodeTranscript('abcd1234-ef56-7890-abcd-1234567890ab', root), file);
    assert.equal(findClaudeCodeTranscript('no-such-session-id-here', root), null);
    // Path-shaped ids never reach the filesystem as paths — the shape gate rejects them.
    assert.equal(findClaudeCodeTranscript('../../etc/passwd', root), null);
    assert.equal(findClaudeCodeTranscript('a', root), null, 'too short to be a session id');
    // A root that does not exist (no Claude Code install) is an honest null, not a crash.
    assert.equal(findClaudeCodeTranscript('abcd1234-ef56-7890-abcd-1234567890ab', join(root, 'nope')), null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('transcript: extracts user/assistant text chronologically, marks tool activity structurally, skips synthetic + torn lines', async () => {
  const root = makeRoot();
  try {
    const file = join(root, 's.jsonl');
    writeFileSync(
      file,
      userLine('fix the login bug') +
        assistantLine([
          { type: 'text', text: 'Looking at the auth module.' },
          { type: 'tool_use', name: 'Read', input: { file: 'auth.ts' } },
        ]) +
        assistantLine([{ type: 'text', text: 'placeholder' }], '<synthetic>') + // error placeholder — not a turn
        line({ type: 'summary', summary: 'meta line, not a turn' }) +
        userLine('') + // empty content — dropped
        '{"type":"assistant","message":{"mo', // torn tail of a live session
    );

    const ex = await extractTranscriptTurns(file, 's');
    assert.equal(ex.turns.length, 2);
    assert.deepEqual(ex.turns[0], { role: 'user', text: 'fix the login bug' });
    assert.equal(ex.turns[1]!.role, 'assistant');
    assert.ok(ex.turns[1]!.text.includes('Looking at the auth module.'));
    assert.ok(ex.turns[1]!.text.includes('[tool: Read]'), 'tool calls appear as structural markers, not payload');
    assert.ok(!ex.turns[1]!.text.includes('auth.ts'), 'tool INPUTS never ride along');
    assert.equal(ex.clippedTurns, 0);
    assert.equal(ex.droppedTurns, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('transcript: per-turn and total caps are enforced and DISCLOSED — clipped and dropped turns are counted', async () => {
  const root = makeRoot();
  try {
    const file = join(root, 's.jsonl');
    const bigTurn = 'x'.repeat(MAX_TURN_CHARS + 500);
    // Enough clipped-size turns to blow the total cap, plus stragglers after it.
    const turnsToFillTotal = Math.ceil(MAX_TOTAL_CHARS / MAX_TURN_CHARS) + 3;
    let content = '';
    for (let i = 0; i < turnsToFillTotal; i++) content += userLine(bigTurn);
    writeFileSync(file, content);

    const ex = await extractTranscriptTurns(file, 's');
    assert.ok(ex.droppedTurns > 0, 'turns past the total cap must be counted as dropped');
    assert.equal(ex.turns.length + ex.droppedTurns, turnsToFillTotal, 'every input turn is either kept or counted');
    assert.ok(ex.clippedTurns >= ex.turns.length, 'every kept turn here exceeded the per-turn cap and must count as clipped');
    for (const t of ex.turns) {
      assert.ok(t.text.length <= MAX_TURN_CHARS + ' …[clipped]'.length, 'no kept turn may exceed the per-turn cap');
    }
    const total = ex.turns.reduce((s, t) => s + t.text.length, 0);
    assert.ok(total <= MAX_TOTAL_CHARS + MAX_TURN_CHARS + 20, 'total payload stays within one turn of the cap');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('loadTranscriptExcerpt: reads only for supported tools; unknown tools and missing files are honest nulls', async () => {
  const root = makeRoot();
  try {
    const dir = join(root, 'proj');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'abcd1234-ef56-7890-abcd-1234567890ab.jsonl'), userLine('real content'));

    const found = await loadTranscriptExcerpt('abcd1234-ef56-7890-abcd-1234567890ab', 'claude-code', root);
    assert.ok(found);
    assert.equal(found!.turns[0]!.text, 'real content');

    assert.equal(await loadTranscriptExcerpt('abcd1234-ef56-7890-abcd-1234567890ab', 'opencode', root), null, 'unsupported tool → null, even when a file with that name exists');
    assert.equal(await loadTranscriptExcerpt('abcd1234-ef56-7890-abcd-1234567890ab', null, root), null);
    assert.equal(await loadTranscriptExcerpt('ffff0000-0000-0000-0000-000000000000', 'claude-code', root), null, 'supported tool but no file → null');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
