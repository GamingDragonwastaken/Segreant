/**
 * Losing the lock directory before publishing ownership is a lost race.
 *
 * `acquirePublicationLock` creates `.fiscus-build.lock` with `mkdir`, then
 * writes an owner record into it. Between those two steps the directory exists
 * and carries no owner, which makes it indistinguishable from one an
 * interrupted process abandoned. If it is removed in that window, the
 * legitimate creator's `writeFileSync` throws ENOENT.
 *
 * That threw straight out of the CLI. CI run `33502986214` failed
 * `test (windows-latest)` with
 *
 *     Error: ENOENT: ... open '...\.fiscus-build.lock\.owner-<uuid>.tmp'
 *       at acquirePublicationLock (bin/publication-lock.mjs:307)
 *       at bin/fiscus.mjs:53
 *
 * so `fiscus --help` died while two builds were publishing. The launcher is
 * right to treat a lock FAILURE as fatal — bypassing the gate would make a
 * reader's artifact guarantee rest on an unverified filesystem assumption — but
 * this is not a failure. This process did not acquire the lock. It belongs in
 * the wait loop.
 *
 * The second half of the repair matters more than the first. The old catch
 * block, seeing `created === true`, quarantined `buildLock` BY PATHNAME to tidy
 * up after itself. By then the directory is gone, so any directory at that path
 * belongs to someone else — the cleanup took a fresh lock away from another
 * process inside ITS owner-write window and propagated the same ENOENT to it.
 *
 * WHAT THESE TESTS ESTABLISH, AND WHAT THEY DO NOT. They manufacture the
 * condition directly: a second process deletes the canonical lock in a tight
 * loop while a contender acquires and releases. That is the state the CI log
 * shows, and it fails on the unrepaired code. It is NOT a reproduction of the
 * interleaving that produced that state in CI, which was never observed — only
 * its signature. So this covers the RESPONSE to a vanished lock directory, and
 * says nothing about what made one vanish under two concurrent builders.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const LOCK_MODULE = pathToFileURL(join(ROOT, 'bin', 'publication-lock.mjs')).href;

function run(script: string, args: string[]): Promise<{ code: number; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script, ...args], {
      env: { ...process.env, NODE_OPTIONS: '' },
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let stderr = '';
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk: string) => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', (code) => resolve({ code: code ?? 1, stderr }));
  });
}

test('a contender whose own lock directory is removed retries instead of dying', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'fiscus-lock-race-'));

  // The contender: acquire and release, over and over, for a fixed wall-clock
  // budget. Cycles rather than a count, so a slow machine takes fewer laps
  // instead of turning a timing assumption into a hang.
  const contender = join(dir, 'contender.mjs');
  writeFileSync(contender, [
    `import { acquirePublicationLock } from ${JSON.stringify(LOCK_MODULE)};`,
    'const [root, untilMs] = [process.argv[2], Number(process.argv[3])];',
    'let laps = 0;',
    'while (Date.now() < untilMs) {',
    '  const release = acquirePublicationLock(root);',
    '  release();',
    '  laps += 1;',
    '}',
    'process.stdout.write(String(laps));',
  ].join('\n'), 'utf8');

  // The saboteur: delete the canonical lock as fast as the filesystem allows.
  // This is the mkdir-to-owner-write window, entered deliberately rather than
  // waited for. It never touches quarantines, so it cannot mask a cleanup bug.
  const saboteur = join(dir, 'saboteur.mjs');
  writeFileSync(saboteur, [
    "import { rmSync } from 'node:fs';",
    "import { join } from 'node:path';",
    'const [root, untilMs] = [process.argv[2], Number(process.argv[3])];',
    "const lock = join(root, '.fiscus-build.lock');",
    'while (Date.now() < untilMs) {',
    '  try { rmSync(lock, { recursive: true, force: true }); } catch { /* it may already be gone */ }',
    '}',
  ].join('\n'), 'utf8');

  try {
    const until = Date.now() + 3_000;
    const [a, b, sabotage] = await Promise.all([
      run(contender, [dir, String(until)]),
      run(contender, [dir, String(until)]),
      run(saboteur, [dir, String(until)]),
    ]);

    assert.equal(sabotage!.code, 0, sabotage!.stderr);
    for (const result of [a!, b!]) {
      // The specific regression: ENOENT on our own `.owner-<token>.tmp`,
      // thrown out of `acquirePublicationLock` and out of the process.
      assert.doesNotMatch(
        result.stderr,
        /ENOENT/,
        'a contender threw on a lock directory that was taken from it',
      );
      assert.equal(result.code, 0, result.stderr || 'a lock contender exited non-zero');
    }
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 25 });
  }
});

test('ordinary contention leaves no lock residue', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'fiscus-lock-clean-'));
  const worker = join(dir, 'worker.mjs');
  writeFileSync(worker, [
    `import { acquirePublicationLock } from ${JSON.stringify(LOCK_MODULE)};`,
    'const [root, cycles] = [process.argv[2], Number(process.argv[3])];',
    'for (let i = 0; i < cycles; i += 1) acquirePublicationLock(root)();',
  ].join('\n'), 'utf8');

  try {
    const results = await Promise.all(
      Array.from({ length: 8 }, () => run(worker, [dir, '25'])),
    );
    for (const result of results) assert.equal(result.code, 0, result.stderr);

    // Every acquisition was released, so nothing may be left at the canonical
    // path or in a quarantine. A surviving generation would mean one was
    // abandoned rather than cleaned.
    const residue = readdirSync(dir).filter((name) => name.startsWith('.fiscus-build.lock'));
    assert.deepEqual(residue, [], `lock residue left behind: ${residue.join(', ')}`);
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 25 });
  }
});

test('the lost-race branch is not a blanket ENOENT catch', async () => {
  // The retry is reachable ONLY when this process created the directory. An
  // ENOENT from anywhere else — a root that does not exist, say — is a real
  // failure and must still throw rather than spin until the 300s wait timeout.
  const dir = mkdtempSync(join(tmpdir(), 'fiscus-lock-arg-'));
  const worker = join(dir, 'worker.mjs');
  writeFileSync(worker, [
    `import { acquirePublicationLock } from ${JSON.stringify(LOCK_MODULE)};`,
    'try {',
    '  acquirePublicationLock(process.argv[2]);',
    '  process.exit(0);',
    '} catch (error) {',
    '  process.stderr.write(String(error?.code ?? error));',
    '  process.exit(3);',
    '}',
  ].join('\n'), 'utf8');

  try {
    const result = await run(worker, [join(dir, 'no', 'such', 'root')]);
    assert.equal(result.code, 3, 'acquiring under a non-existent root must fail, not retry');
    assert.match(result.stderr, /ENOENT/);
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 25 });
  }
});
