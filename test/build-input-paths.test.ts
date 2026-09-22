/**
 * The build fingerprint's inputs are relative to a root it is handed.
 *
 * `sourceFingerprint(root, inputPaths)` joins each input onto the root. An
 * ABSOLUTE input therefore becomes `<root>/<absolute>` — on Windows literally
 * `C:\repo\C:\repo\src\...` — and the build dies with an ENOENT naming a path
 * nobody wrote.
 *
 * That shipped. Commit `e00f7f9` put the absolute `sharedDashboardTypes` into
 * the `--web` input list beside four relative siblings, and `node
 * scripts/build.mjs --web` has failed on every platform ever since. Nothing
 * caught it because nothing runs it: `pretest` and `build` are both full builds
 * (`d23245f` moved `pretest` off `--web`), so the only broken mode is the one
 * the workflow never takes. It was found by running the command that CLAUDE.md
 * claimed `pretest` used.
 *
 * A test that ran the real `--web` build would be the direct regression, and it
 * is deliberately not what this file does: that build takes the repository-root
 * publication lock, and this suite already has one file running real builds at
 * the root while four others queue behind it for the CLI. Adding a sixth
 * contender to catch a path-shape bug is the wrong trade. The guard below is
 * what actually prevents recurrence, because it protects EVERY caller rather
 * than the one mode that happened to break — so that is what gets pinned.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const INTEGRITY = pathToFileURL(join(ROOT, 'scripts', 'build-integrity.mjs')).href;

/**
 * Exercise the module in a child, because `scripts/` ships no declarations and a
 * typed import of a `.mjs` from a `.ts` test is an implicit `any` under this
 * config. Returns whatever the snippet writes to stdout.
 */
function probe(body: string): { status: number; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', [
    `import { sourceFingerprint } from ${JSON.stringify(INTEGRITY)};`,
    `const ROOT = ${JSON.stringify(ROOT)};`,
    body,
  ].join('\n')], { encoding: 'utf8', env: { ...process.env, NODE_OPTIONS: '' } });
  return { status: result.status ?? 1, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

test('an absolute build input is refused by name, not joined into a path nobody wrote', () => {
  // The exact value that broke `--web`: this file, named absolutely, in a list
  // whose other entries are relative.
  const absolute = join(ROOT, 'src', 'dashboard', 'shared-types.ts');
  const result = probe([
    `try {`,
    `  sourceFingerprint(ROOT, [${JSON.stringify(absolute)}]);`,
    `  process.stdout.write('NO THROW');`,
    `} catch (error) {`,
    `  process.stdout.write(String(error?.message ?? error));`,
    `}`,
  ].join('\n'));

  assert.equal(result.status, 0, result.stderr);
  assert.match(
    result.stdout,
    /must be relative to the root/,
    `an absolute input must be named as the problem; got: ${result.stdout}`,
  );
  // The pre-fix behaviour was an ENOENT for a doubled path. If that is what
  // comes back, the guard is gone and the error again describes a path that
  // exists nowhere in the repository.
  assert.doesNotMatch(result.stdout, /ENOENT/, 'the doubled-path failure is back');
});

test('a relative build input is still fingerprinted', () => {
  // The refusal above must not be satisfied by refusing everything: the same
  // file, named relatively, is exactly what the `--web` build passes.
  const result = probe([
    `const a = sourceFingerprint(ROOT, ['src/dashboard/shared-types.ts']);`,
    `const b = sourceFingerprint(ROOT, ['src/dashboard/shared-types.ts']);`,
    `process.stdout.write(JSON.stringify({ a, b }));`,
  ].join('\n'));

  assert.equal(result.status, 0, result.stderr);
  const { a, b } = JSON.parse(result.stdout) as { a: string; b: string };
  assert.ok(typeof a === 'string' && a.length > 0, 'a relative input must produce a fingerprint');
  assert.equal(a, b, 'the fingerprint covers bytes and relative paths, so it must be stable');
});
