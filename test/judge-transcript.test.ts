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
import { DatabaseSync } from 'node:sqlite';
import {
  findClaudeCodeTranscript,
  extractTranscriptTurns,
  extractOpencodeTranscript,
  extractCodexTranscript,
  loadTranscriptExcerpt,
  transcriptSupport,
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

test('extractTranscriptTurns: giant JSONL lines are skipped before parsing and disclosed as truncated', async () => {
  const root = makeRoot();
  const file = join(root, 'giant.jsonl');
  try {
    writeFileSync(file,
      JSON.stringify({ type: 'user', message: { content: 'x'.repeat(3 * 1024 * 1024) } }) + '\n' +
      JSON.stringify({ type: 'assistant', message: { content: 'small response' } }) + '\n',
    );
    const ex = await extractTranscriptTurns(file, 's');
    assert.equal(ex.turns.length, 1);
    assert.equal(ex.turns[0]!.text, 'small response');
    assert.equal(ex.captureCoverage, 'truncated');
    assert.equal(ex.truncatedLines, 1);
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

test('loadTranscriptExcerpt: routes by tool — claude-code, opencode, codex all supported; unknown tools honest null', async () => {
  const root = makeRoot();
  try {
    const ccDir = join(root, 'cc', 'proj');
    mkdirSync(ccDir, { recursive: true });
    writeFileSync(join(ccDir, 'abcd1234-ef56-7890-abcd-1234567890ab.jsonl'), userLine('cc content'));
    const dbPath = makeOpencodeDb(root); // has ses_abc
    const cxDir = join(root, 'cx', 'sessions', '2026', '07', '18');
    mkdirSync(cxDir, { recursive: true });
    const sid = '019dee5a-91ee-7ce1-8891-db48d6d052fd';
    writeFileSync(
      join(cxDir, `rollout-x-${sid}.jsonl`),
      line({ type: 'session_meta', payload: { id: sid } }) +
        line({ type: 'event_msg', payload: { type: 'user_message', message: 'cx content' } }),
    );

    const roots = { claudeCode: join(root, 'cc'), opencodeDb: dbPath, codexRoot: join(root, 'cx') };
    assert.equal((await loadTranscriptExcerpt('abcd1234-ef56-7890-abcd-1234567890ab', 'claude-code', roots))!.turns[0]!.text, 'cc content');
    assert.equal((await loadTranscriptExcerpt('ses_abc', 'opencode', roots))!.turns[0]!.text, 'refactor the login flow');
    assert.equal((await loadTranscriptExcerpt(sid, 'codex', roots))!.turns[0]!.text, 'cx content');
    assert.equal(await loadTranscriptExcerpt('anything', 'cursor', roots), null, 'unknown tool → null');
    assert.equal(await loadTranscriptExcerpt('ffff0000-0000-0000-0000-000000000000', 'claude-code', roots), null, 'supported tool but no file → null');
    assert.equal(transcriptSupport('opencode'), 'supported');
    assert.equal(transcriptSupport('codex'), 'supported');
    assert.equal(transcriptSupport('proxy'), 'unsupported-tool');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── opencode + Codex extractors (plan Tasks 1–2) ────────────────────────────

function makeOpencodeDb(dir: string): string {
  const p = join(dir, 'opencode.db');
  const db = new DatabaseSync(p);
  db.exec(`CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, data TEXT);
           CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT, session_id TEXT, time_created INTEGER, data TEXT);`);
  const msg = db.prepare('INSERT INTO message VALUES (?,?,?,?)');
  const part = db.prepare('INSERT INTO part VALUES (?,?,?,?,?)');
  msg.run('m1', 'ses_abc', 1000, JSON.stringify({ role: 'user' }));
  part.run('p1', 'm1', 'ses_abc', 1000, JSON.stringify({ type: 'text', text: 'refactor the login flow' }));
  msg.run('m2', 'ses_abc', 2000, JSON.stringify({ role: 'assistant' }));
  part.run('p2', 'm2', 'ses_abc', 2000, JSON.stringify({ type: 'text', text: 'Extracted the auth guard.' }));
  part.run('p3', 'm2', 'ses_abc', 2100, JSON.stringify({ type: 'tool', tool: 'edit' }));
  part.run('p4', 'm2', 'ses_abc', 2200, JSON.stringify({ type: 'reasoning', text: 'hidden chain' }));
  // A different session that must NOT leak in:
  msg.run('m3', 'ses_other', 3000, JSON.stringify({ role: 'user' }));
  part.run('p5', 'm3', 'ses_other', 3000, JSON.stringify({ type: 'text', text: 'OTHER-SESSION-SENTINEL' }));
  db.close();
  return p;
}

test('opencode transcript: session-scoped user/assistant text, tool markers, reasoning skipped', () => {
  const dir = makeRoot();
  try {
    const dbPath = makeOpencodeDb(dir);
    const ex = extractOpencodeTranscript('ses_abc', dbPath);
    assert.ok(ex);
    assert.equal(ex!.turns.length, 2);
    assert.deepEqual(ex!.turns[0], { role: 'user', text: 'refactor the login flow' });
    assert.ok(ex!.turns[1]!.text.includes('Extracted the auth guard.'));
    assert.ok(ex!.turns[1]!.text.includes('[tool]'), 'tool parts appear as structural markers');
    assert.ok(!ex!.turns[1]!.text.includes('hidden chain'), 'reasoning parts never ride along');
    assert.ok(!JSON.stringify(ex).includes('OTHER-SESSION-SENTINEL'), 'strictly session-scoped');
    assert.equal(extractOpencodeTranscript('ses_missing', dbPath), null);
    assert.equal(extractOpencodeTranscript('ses_abc', join(dir, 'nope.db')), null, 'missing DB is an honest null');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('codex transcript: finds the rollout by session id, extracts user/agent messages + tool markers', async () => {
  const root = makeRoot();
  try {
    const dir = join(root, 'sessions', '2026', '07', '18');
    mkdirSync(dir, { recursive: true });
    const sid = '019dee5a-91ee-7ce1-8891-db48d6d052fd';
    writeFileSync(
      join(dir, `rollout-2026-07-18T10-00-00-${sid}.jsonl`),
      line({ type: 'session_meta', payload: { id: sid, cwd: 'C:/proj' } }) +
        line({ type: 'event_msg', payload: { type: 'user_message', message: 'port the importer to streaming' } }) +
        line({ type: 'response_item', payload: { type: 'function_call', name: 'shell' } }) +
        line({ type: 'event_msg', payload: { type: 'agent_message', message: 'Done — reads line by line now.' } }) +
        line({ type: 'event_msg', payload: { type: 'token_count', info: {} } }),
    );
    // A decoy rollout for another session:
    writeFileSync(
      join(dir, 'rollout-2026-07-18T11-00-00-ffffffff-0000-0000-0000-000000000000.jsonl'),
      line({ type: 'session_meta', payload: { id: 'ffffffff-0000-0000-0000-000000000000' } }) +
        line({ type: 'event_msg', payload: { type: 'user_message', message: 'DECOY-SENTINEL' } }),
    );

    const ex = await extractCodexTranscript(sid, root);
    assert.ok(ex);
    assert.equal(ex!.turns.length, 3);
    assert.deepEqual(ex!.turns[0], { role: 'user', text: 'port the importer to streaming' });
    assert.equal(ex!.turns[1]!.text, '[tool: shell]');
    assert.equal(ex!.turns[1]!.role, 'assistant');
    assert.ok(!JSON.stringify(ex).includes('DECOY-SENTINEL'));
    assert.equal(await extractCodexTranscript('00000000-aaaa-bbbb-cccc-000000000000', root), null);
    assert.equal(await extractCodexTranscript(sid, join(root, 'nope')), null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
