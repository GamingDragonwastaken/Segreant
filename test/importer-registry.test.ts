/**
 * One importer list for every surface (H008). The dashboard's own copy lacked
 * Antigravity, so its "import all" skipped a tool the CLI read.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { IMPORT_REGISTRY, importerFor } from '../src/connect/registry.ts';
import { IMPORTERS } from '../src/connect/importShared.ts';

test('the registry and the importer descriptions name the same tools', () => {
  assert.deepEqual(IMPORT_REGISTRY.map((e) => e.id).sort(), IMPORTERS.map((i) => i.id).sort());
  assert.ok(IMPORT_REGISTRY.some((e) => e.id === 'antigravity'));
});

test('every alias people type resolves, and only to one tool', () => {
  for (const [typed, id] of [['claude', 'claude-code'], ['codex-cli', 'codex'], ['agy', 'antigravity'], ['gemini', 'antigravity'], ['opencode', 'opencode']] as const) {
    assert.equal(importerFor(typed)?.id, id);
  }
  assert.equal(importerFor('cursor'), null);
  const all = IMPORT_REGISTRY.flatMap((e) => e.aliases);
  assert.equal(new Set(all).size, all.length);
});

test('no surface keeps its own list of importers', () => {
  for (const file of ['src/dashboard/routes.ts', 'src/cli/importCmd.ts']) {
    const src = readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
    assert.match(src, /IMPORT_REGISTRY/, `${file} builds from the registry`);
    assert.doesNotMatch(src, /importCodex\(|importOpencode\(|importClaudeCode\(|importAntigravity\(/, `${file} calls no importer directly`);
  }
});
