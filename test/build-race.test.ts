import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const BUILD = join(ROOT, 'scripts', 'build.mjs');
const CLI = join(ROOT, 'bin', 'fiscus.mjs');
const PUBLICATION_LOCK = join(ROOT, 'bin', 'publication-lock.mjs');

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

function runNode(script: string, args: string[]): Promise<ProcessResult> {
  return spawnNode(script, args).result;
}

test('concurrent builds keep the compiled CLI runnable throughout publication', async () => {
  // The old lifecycle deleted dist/ synchronously before each tsc pass. Start
  // enough overlapping builders and readers to keep that window deterministic
  // on both Windows and POSIX; a reader must continue to see either the prior
  // complete tree or the newly published one, never an absent dist/cli.js.
  const builders = [runNode(BUILD, []), runNode(BUILD, [])];
  await new Promise((resolve) => setTimeout(resolve, 25));
  const readers = Array.from({ length: 8 }, () => runNode(CLI, ['--help']));
  const results = await Promise.all([...builders, ...readers]);

  for (const result of results) {
    assert.equal(result.code, 0, result.stderr || 'concurrent build/CLI process failed');
  }
  assert.equal(existsSync(join(ROOT, 'dist', 'cli.js')), true, 'successful builds must leave the CLI artifact present');
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
