import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createBuildWorkspace } from './support/buildWorkspace.ts';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const BUILD = join(ROOT, 'scripts', 'build.mjs');
const CLI = join(ROOT, 'bin', 'fiscus.mjs');
const PUBLICATION_LOCK = join(ROOT, 'bin', 'publication-lock.mjs');
const RUNTIME_SNAPSHOT = join(ROOT, 'bin', 'runtime-snapshot.mjs');

interface ProcessResult {
  code: number;
  stderr: string;
  stdout: string;
}

function spawnNode(script: string, args: string[], cwd = ROOT) {
  let resolveResult!: (result: ProcessResult) => void;
  let rejectResult!: (error: Error) => void;
  const result = new Promise<ProcessResult>((resolve, reject) => {
    resolveResult = resolve;
    rejectResult = reject;
  });

  const child = spawn(process.execPath, [script, ...args], {
    cwd,
    env: { ...process.env, NODE_OPTIONS: '' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout?.setEncoding('utf8');
  child.stderr?.setEncoding('utf8');
  child.stdout?.on('data', (chunk: string) => { stdout += chunk; });
  child.stderr?.on('data', (chunk: string) => { stderr += chunk; });
  child.once('error', rejectResult);
  child.once('close', (code) => resolveResult({ code: code ?? 1, stderr, stdout }));
  return { child, result };
}

function runNode(script: string, args: string[], cwd = ROOT): Promise<ProcessResult> {
  return spawnNode(script, args, cwd).result;
}

test('concurrent builds keep the compiled CLI runnable throughout publication', async (t) => {
  // The old lifecycle deleted dist/ synchronously before each tsc pass. Start
  // enough overlapping builders and readers to keep that window deterministic
  // on both Windows and POSIX; a reader must continue to see either the prior
  // complete tree or the newly published one, never an absent dist/cli.js.
  //
  // IN A COPY OF THE REPOSITORY, NOT THE REPOSITORY. A real build holds the
  // root publication lock for tens of seconds, and every other file that spawns
  // `bin/fiscus.mjs` takes that lock as a reader and queues behind it — which is
  // how `test/fiscus-home-cli.test.ts` came to fail a full local run with
  // `fiscus demo should succeed` after sitting in the queue for its own 180s
  // timeout. The claim here is about the BUILD's publication protocol, which is
  // a property of the protocol and not of this checkout, so it holds identically
  // against a copy. Same two builders, same eight readers, same real `tsc`; only
  // the address changes. See `test/support/buildWorkspace.ts`.
  const workspace = createBuildWorkspace();
  t.after(() => { workspace.dispose(); });

  // The precondition, made explicit rather than inherited: a reader sees the
  // PRIOR complete tree or the new one, so there must BE a prior tree. At the
  // root that came from `pretest`; here it comes across with the copy, and if
  // the repository has not been built there is nothing to copy and we build one.
  // A reader arriving before any build has ever finished is a different state
  // with a different correct answer — the launcher's snapshot ENOENTs — and
  // testing it here would be testing something else.
  if (!workspace.seeded) {
    const seed = await runNode(workspace.build, [], workspace.root);
    assert.equal(seed.code, 0, seed.stderr || 'the workspace seed build failed');
  }

  // The repository's published artifact, as it stood before any of this ran. An
  // isolated build publishes into the workspace, so this must not move.
  const rootArtifact = join(ROOT, 'dist', 'cli.js');
  const publishedBefore = existsSync(rootArtifact) ? statSync(rootArtifact).mtimeMs : null;

  const builders = [spawnNode(workspace.build, [], workspace.root), spawnNode(workspace.build, [], workspace.root)];
  await new Promise((resolve) => setTimeout(resolve, 25));
  const readers = Array.from({ length: 8 }, () => spawnNode(workspace.cli, ['--help'], workspace.root));
  const spawned = [...builders, ...readers];
  // Captured while they are alive; by assertion time every one of them has
  // exited, which is what makes the ownership check below decidable.
  const ours = new Set(spawned.map((entry) => entry.child.pid).filter((pid): pid is number => typeof pid === 'number'));
  const results = await Promise.all(spawned.map((entry) => entry.result));

  for (const result of results) {
    assert.equal(result.code, 0, result.stderr || 'concurrent build/CLI process failed');
  }
  assert.equal(existsSync(join(workspace.root, 'dist', 'cli.js')), true, 'successful builds must leave the CLI artifact present');

  // ISOLATION IS "NONE OF OURS TOUCHED IT", NOT "THE PATH IS ABSENT" (WP-C04).
  //
  // This assertion used to read `existsSync(ROOT/.fiscus-build.lock) === false`,
  // and it was not a statement about this test at all. As the comment at the top
  // of this file records, EVERY test file that spawns `bin/fiscus.mjs` takes the
  // repository lock as a reader — and `node --test` runs files in parallel. So
  // the old line asked "is any other test file holding the repository lock right
  // now", and answered a question about the harness schedule. It passed in
  // isolation (6s) and failed inside a full local run (45s) for that reason
  // alone: a real reader was legitimately holding a real lock.
  //
  // Deleting it would have removed a behavioural claim to make a run green. The
  // claim is kept and made decidable instead, in two halves that a concurrent
  // reader cannot forge:
  //
  //   1. The repository's own published artifact did not move. A build that
  //      escaped into the checkout would have republished dist/cli.js here.
  //      Nothing else in the suite builds at ROOT — `pretest` finishes before
  //      any test starts — so this is stable under parallelism.
  //   2. No lock at ROOT is owned by a process THIS test spawned. All of ours
  //      have exited, so a lock naming one of their pids is our residue; a lock
  //      naming anything else belongs to somebody else's live reader and says
  //      nothing about our isolation.
  if (publishedBefore !== null) {
    assert.equal(statSync(rootArtifact).mtimeMs, publishedBefore, 'an isolated build must not republish the repository artifact');
  }
  const rootOwner = join(ROOT, '.fiscus-build.lock', 'owner.json');
  let residueOwner: number | null = null;
  if (existsSync(rootOwner)) {
    try {
      const owner = JSON.parse(readFileSync(rootOwner, 'utf8')) as { pid?: unknown };
      if (typeof owner.pid === 'number' && ours.has(owner.pid)) residueOwner = owner.pid;
    } catch {
      // A lock caught mid-write belongs to whoever is writing it, and that is
      // not us — every process this test spawned has already exited.
    }
  }
  assert.equal(residueOwner, null, `an isolated build must not leave the repository lock held (pid ${residueOwner})`);
});

test('the supported CLI launcher waits for publication and leaves no lock residue', async () => {
  // Use a tiny fixture runtime so the assertion is about lock observation, not
  // the startup cost of Fiscus's real SQLite-backed CLI. The copied launcher
  // still resolves its normal ../dist/cli.js path and its sibling lock. The
  // delayed completion also proves the launcher keeps the private snapshot
  // alive until deferred command work has actually finished.
  const fixture = mkdtempSync(join(ROOT, '.fiscus-build-race-'));
  const fixtureBin = join(fixture, 'bin');
  const fixtureDist = join(fixture, 'dist');
  const fixtureLock = join(fixture, '.fiscus-build.lock');
  mkdirSync(fixtureBin);
  mkdirSync(fixtureDist);
  mkdirSync(join(fixture, 'pricing'));
  copyFileSync(CLI, join(fixtureBin, 'fiscus.mjs'));
  copyFileSync(PUBLICATION_LOCK, join(fixtureBin, 'publication-lock.mjs'));
  copyFileSync(RUNTIME_SNAPSHOT, join(fixtureBin, 'runtime-snapshot.mjs'));
  writeFileSync(join(fixture, 'pricing', 'models.json'), 'fixture-resource-ready\n', 'utf8');
  writeFileSync(join(fixtureDist, 'cli.js'), `
import { readFileSync } from 'node:fs';
export const cliCompletion = new Promise((resolve, reject) => setTimeout(() => {
  try {
    process.stdout.write(readFileSync(new URL('../pricing/models.json', import.meta.url), 'utf8'));
    resolve();
  } catch (error) {
    reject(error);
  }
}, 75));
`, 'utf8');
  mkdirSync(fixtureLock);
  writeFileSync(join(fixtureLock, 'owner.json'), JSON.stringify({ pid: process.pid, token: 'held-for-test' }), 'utf8');

  const reader = spawnNode(join(fixtureBin, 'fiscus.mjs'), [], fixture);
  try {
    await new Promise((resolve) => setTimeout(resolve, 250));
    assert.equal(reader.child.exitCode, null, 'the launcher imported the runtime before publication completed');
    rmSync(fixtureLock, { recursive: true, force: true });

    const result = await reader.result;
    assert.equal(result.code, 0, result.stderr || 'the launcher failed after publication completed');
    assert.equal(result.stdout, 'fixture-resource-ready\n');
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }

  assert.equal(existsSync(fixtureLock), false, 'the held test lock must not leave residue');
});

test('the launcher cannot turn a spawn or publication-lock failure into exit 0', () => {
  const source = readFileSync(CLI, 'utf8');
  assert.doesNotMatch(source, /result\.status \?\? 0/, 'a signaled or failed child must never become success');
  assert.doesNotMatch(source, /\['EACCES', 'EPERM', 'EROFS'\]\.includes\(error\?\.code\)/, 'an inaccessible publication lock must fail closed');
});

test('publication lock reclaims a dead creator whose owner rename was interrupted', async () => {
  const fixture = mkdtempSync(join(ROOT, '.fiscus-build-orphan-'));
  const lock = join(fixture, '.fiscus-build.lock');
  mkdirSync(lock);
  // The owner record is valid but remains under the atomic temp name. A PID
  // outside the process table makes the recovery assertion deterministic on
  // supported Windows and POSIX runners.
  writeFileSync(
    join(lock, '.owner-00000000-0000-0000-0000-000000000000.tmp'),
    JSON.stringify({ pid: 2_147_483_647, token: 'dead-owner-token' }),
    'utf8',
  );
  try {
    const lockModule = await import(pathToFileURL(PUBLICATION_LOCK).href) as unknown as {
      acquirePublicationLock: (root: string) => () => void;
    };
    const release = lockModule.acquirePublicationLock(fixture);
    assert.equal(typeof release, 'function', 'a dead temp owner must not hold the queue');
    release();
    assert.equal(existsSync(lock), false, 'recovery and release must leave no canonical lock');
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});

test('source generation fingerprints distinguish changed build inputs', async () => {
  const fixture = mkdtempSync(join(ROOT, '.fiscus-build-generation-'));
  try {
    const source = join(fixture, 'src');
    mkdirSync(source);
    writeFileSync(join(source, 'generation.ts'), 'export const generation = "A";\n', 'utf8');
    const { sourceFingerprint } = await import('../scripts/build-integrity.mjs') as {
      sourceFingerprint: (root: string, inputPaths: string[]) => string;
    };
    const first = sourceFingerprint(fixture, ['src']);
    writeFileSync(join(source, 'generation.ts'), 'export const generation = "B";\n', 'utf8');
    const second = sourceFingerprint(fixture, ['src']);
    assert.notEqual(second, first, 'a changed source generation must not reuse the previous fingerprint');
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});

test('the runtime snapshot outlives a command that keeps running after its completion promise', async () => {
  // `fiscus start` resolves its command promise the moment the proxy and
  // dashboard sockets are listening, and then serves requests for hours. The
  // dashboard reads the bundled pricing card per request rather than at import,
  // so a snapshot deleted at completion is deleted out from under a live
  // server: `/api/overview` answers ENOENT on its own copied pricing card and
  // `/app/main.js` 404s. The whole local suite stays green while that happens,
  // because nothing else drives the packaged launcher past completion.
  const fixture = mkdtempSync(join(ROOT, '.fiscus-runtime-life-'));
  const fixtureBin = join(fixture, 'bin');
  const fixtureDist = join(fixture, 'dist');
  mkdirSync(fixtureBin);
  mkdirSync(fixtureDist);
  mkdirSync(join(fixture, 'pricing'));
  copyFileSync(CLI, join(fixtureBin, 'fiscus.mjs'));
  copyFileSync(PUBLICATION_LOCK, join(fixtureBin, 'publication-lock.mjs'));
  copyFileSync(RUNTIME_SNAPSHOT, join(fixtureBin, 'runtime-snapshot.mjs'));
  writeFileSync(join(fixture, 'pricing', 'models.json'), 'fixture-resource-ready\n', 'utf8');
  // Completion settles immediately; the work that still resolves a package
  // resource happens afterwards, exactly like a served dashboard request.
  writeFileSync(join(fixtureDist, 'cli.js'), `
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
console.log(fileURLToPath(new URL('../', import.meta.url)));
export const cliCompletion = Promise.resolve();
setTimeout(() => {
  process.stdout.write(readFileSync(new URL('../pricing/models.json', import.meta.url), 'utf8'));
}, 150);
`, 'utf8');

  try {
    const result = await runNode(join(fixtureBin, 'fiscus.mjs'), []);
    assert.equal(result.code, 0, result.stderr || 'a command outliving its completion promise lost its runtime snapshot');
    const [snapshotRoot = '', resource] = result.stdout.split('\n');
    assert.equal(`${resource}\n`, 'fixture-resource-ready\n', 'the post-completion resource read must still resolve inside the snapshot');
    assert.notEqual(snapshotRoot, '', 'the fixture runtime must report the snapshot it was imported from');
    assert.equal(existsSync(snapshotRoot), false, 'the snapshot must be removed when the process that owns it exits');
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});

test('orphan runtime snapshots are reaped by owner liveness, never by pathname', async () => {
  // A process killed outright (SIGKILL, a closed terminal) never runs its exit
  // handler, so the reaper is what keeps temp from accumulating 2.8 MB copies.
  // It must still refuse to delete a snapshot whose owner is alive — a running
  // `fiscus start` would lose its module tree to another CLI invocation.
  const parent = mkdtempSync(join(ROOT, '.fiscus-runtime-reap-'));
  const dead = join(parent, 'fiscus-runtime-dead');
  const live = join(parent, 'fiscus-runtime-live');
  const foreign = join(parent, 'unrelated-directory');
  for (const path of [dead, live, foreign]) mkdirSync(path);
  writeFileSync(join(dead, 'owner.json'), JSON.stringify({ pid: 2_147_483_647 }), 'utf8');
  writeFileSync(join(live, 'owner.json'), JSON.stringify({ pid: process.pid }), 'utf8');

  try {
    const snapshotModule = await import(pathToFileURL(RUNTIME_SNAPSHOT).href) as unknown as {
      reapOrphanRuntimeSnapshots: (parent: string) => void;
    };
    snapshotModule.reapOrphanRuntimeSnapshots(parent);
    assert.equal(existsSync(dead), false, 'a snapshot whose owner is gone must be reaped');
    assert.equal(existsSync(live), true, 'a snapshot whose owner is still running must be preserved');
    assert.equal(existsSync(foreign), true, 'reaping must not reach outside the snapshot naming convention');
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});
