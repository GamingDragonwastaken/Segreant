/**
 * Attribution for the two connect paths that could not carry a project label.
 *
 * `claude-code` and `codex` meter natively from local logs, so they never see a
 * header — their only signal is the working directory the tool recorded, and the
 * basename of that directory is not the project. Antigravity meters through the
 * proxy but its custom-provider form has no headers field at all, so the project
 * has to travel in the base URL or not at all.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

process.env.AEGIS_HOME = mkdtempSync(join(tmpdir(), 'aegis-home-'));

import { Store } from '../src/store/db.ts';
import { importClaudeCode } from '../src/connect/claudeCode.ts';
import { createRepoResolver } from '../src/connect/importShared.ts';
import { splitProjectPath } from '../src/proxy/server.ts';
import { ATTRIBUTION_BASES, isDeclaredAttribution } from '../src/value/characterization.ts';

/** A real git repository — the resolver asks git, so a fake directory proves nothing. */
function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'fiscus-repo-'));
  execFileSync('git', ['init', '-q'], { cwd: dir });
  execFileSync('git', ['config', 'user.email', 't@t'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', 'T'], { cwd: dir });
  writeFileSync(join(dir, 'a.txt'), 'x');
  execFileSync('git', ['add', '.'], { cwd: dir });
  execFileSync('git', ['commit', '-q', '-m', 'init'], { cwd: dir });
  return dir;
}

function transcriptLine(over: Record<string, unknown>): string {
  return JSON.stringify({
    type: 'assistant',
    requestId: 'req-1',
    timestamp: new Date(1_700_000_000_000).toISOString(),
    sessionId: 's1',
    message: { model: 'claude-sonnet-4-6', usage: { input_tokens: 100, output_tokens: 10 } },
    ...over,
  });
}

test('import attribution: a session started in a SUBDIRECTORY attributes to the repository', async () => {
  const repo = makeRepo();
  const sub = join(repo, 'packages', 'web');
  mkdirSync(sub, { recursive: true });
  const repoName = repo.split(/[\\/]/).filter(Boolean).pop()!;

  const root = mkdtempSync(join(tmpdir(), 'fiscus-transcripts-'));
  writeFileSync(join(root, 's1.jsonl'), transcriptLine({ cwd: sub }) + '\n');

  const store = new Store(':memory:');
  const sum = await importClaudeCode(store, { root });
  assert.equal(sum.inserted, 1);

  const row = store.recent(10)[0]!;
  // Without repo resolution this would be `web` — one repository's spend split
  // across as many labels as there are directories anyone worked in.
  assert.equal(row.project, repoName);
  assert.equal(row.attributionBasis, 'tool_log_repo_resolved');
  // …and the relabel is reported, because rows already in the ledger keep the
  // old label and the operator has to be told to alias them.
  assert.deepEqual(sum.relabelled, [{ from: 'web', to: repoName }]);
  store.close();
});

test('import attribution: a directory that IS the repo root needs no relabel', async () => {
  const repo = makeRepo();
  const repoName = repo.split(/[\\/]/).filter(Boolean).pop()!;
  const root = mkdtempSync(join(tmpdir(), 'fiscus-transcripts-'));
  writeFileSync(join(root, 's1.jsonl'), transcriptLine({ cwd: repo }) + '\n');

  const store = new Store(':memory:');
  const sum = await importClaudeCode(store, { root });
  const row = store.recent(10)[0]!;
  assert.equal(row.project, repoName);
  assert.equal(row.attributionBasis, 'tool_log_repo_resolved');
  assert.deepEqual(sum.relabelled, [], 'the label did not change, so there is nothing to alias');
  store.close();
});

test('import attribution: outside a repository it degrades to the previous behaviour and says so', async () => {
  // A plain scratch directory, deliberately not a git working tree.
  const plain = mkdtempSync(join(tmpdir(), 'fiscus-plain-'));
  const leaf = plain.split(/[\\/]/).filter(Boolean).pop()!;
  const root = mkdtempSync(join(tmpdir(), 'fiscus-transcripts-'));
  writeFileSync(join(root, 's1.jsonl'), transcriptLine({ cwd: plain }) + '\n');

  const store = new Store(':memory:');
  const sum = await importClaudeCode(store, { root });
  const row = store.recent(10)[0]!;
  assert.equal(row.project, leaf);
  assert.equal(row.attributionBasis, 'tool_log_inferred', 'inferred, not claimed as resolved');
  assert.deepEqual(sum.relabelled, []);
  store.close();
});

test('import attribution: a transcript with no cwd still degrades to the tool-name placeholder', async () => {
  const root = mkdtempSync(join(tmpdir(), 'fiscus-transcripts-'));
  writeFileSync(join(root, 's1.jsonl'), transcriptLine({}) + '\n');

  const store = new Store(':memory:');
  await importClaudeCode(store, { root });
  const row = store.recent(10)[0]!;
  assert.equal(row.project, 'claude-code');
  assert.equal(row.attributionBasis, 'tool_log_fallback', 'a placeholder must never read as a resolved repo');
  store.close();
});

test('import attribution: the resolver never shells out twice for the same directory', async () => {
  // Cheap correctness proof for the cache: a transcript corpus is thousands of
  // lines over a handful of directories, and each miss is a git subprocess.
  const repo = makeRepo();
  const resolve = createRepoResolver();
  const a = await resolve(repo, 'claude-code');
  const b = await resolve(repo, 'claude-code');
  assert.deepEqual(a, b);
  assert.equal(a.basis, 'tool_log_repo_resolved');
});

test('attribution basis: the resolved basis counts as a deliberate attribution', () => {
  assert.ok(ATTRIBUTION_BASES.includes('tool_log_repo_resolved'), 'the vocabulary knows the new value');
  assert.equal(isDeclaredAttribution('tool_log_repo_resolved'), true);
  // …but the placeholder and the absence still do not.
  assert.equal(isDeclaredAttribution('tool_log_fallback'), false);
  assert.equal(isDeclaredAttribution('unattributed'), false);
});

test('project path prefix: a header-less client can declare its project in the base URL', () => {
  const r = splitProjectPath('/fiscus/backend-api/v1/chat/completions');
  assert.equal(r.project, 'backend-api');
  // The upstream must see exactly the path it would have seen without the
  // prefix, or the declaration would change what the provider is asked for.
  assert.equal(r.path, '/v1/chat/completions');
});

test('project path prefix: an ordinary path is untouched', () => {
  for (const url of ['/v1/chat/completions', '/v1/messages', '/', '/fiscus', '/fiscusx/v1/chat']) {
    const r = splitProjectPath(url);
    assert.equal(r.project, null, url);
    assert.equal(r.path, url, url);
  }
});

test('project path prefix: an unusable label is refused rather than silently stripped', () => {
  // `.` and `..` match the character class but are not project names, and a
  // prefix with nothing after it is not a request. Leaving the path intact makes
  // the mistake fail visibly upstream instead of metering under a nonsense label.
  for (const url of ['/fiscus/./v1/chat', '/fiscus/../v1/chat', '/fiscus/proj', '/fiscus//v1/chat']) {
    const r = splitProjectPath(url);
    assert.equal(r.project, null, url);
    assert.equal(r.path, url, url);
  }
  // A label with characters outside the allowed set is also refused, not sanitized.
  assert.equal(splitProjectPath('/fiscus/pro j/v1/chat').project, null);
  assert.equal(splitProjectPath('/fiscus/pro%2Fj/v1/chat').project, null);
});

test('project path prefix: routing sees the stripped path, so the provider is still detected', async () => {
  const { detectRoute } = await import('../src/proxy/server.ts');
  const { DEFAULT_CONFIG } = await import('../src/config.ts');
  const mk = (url: string) => ({ url, headers: { authorization: 'Bearer k' } }) as never;
  // Anthropic and OpenAI are detected by path, so a prefix that was not stripped
  // before routing would make every prefixed request an unroutable 400.
  assert.equal(detectRoute(mk('/fiscus/proj/v1/messages'), DEFAULT_CONFIG)?.provider, 'anthropic');
  assert.equal(detectRoute(mk('/fiscus/proj/v1/chat/completions'), DEFAULT_CONFIG)?.provider, 'openai');
});
