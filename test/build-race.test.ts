import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const BUILD = join(ROOT, 'scripts', 'build.mjs');
const CLI = join(ROOT, 'bin', 'fiscus.mjs');

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
  // still resolves its normal ../dist/cli.js path and its sibling lock.
  const fixture = mkdtempSync(join(ROOT, '.fiscus-build-race-'));
  const fixtureBin = join(fixture, 'bin');
  const fixtureDist = join(fixture, 'dist');
  const fixtureLock = join(fixture, '.fiscus-build.lock');
  mkdirSync(fixtureBin);
  mkdirSync(fixtureDist);
  copyFileSync(CLI, join(fixtureBin, 'fiscus.mjs'));
  writeFileSync(join(fixtureDist, 'cli.js'), "process.stdout.write('fixture-cli-ready\\n');", 'utf8');
  mkdirSync(fixtureLock);
  writeFileSync(join(fixtureLock, 'owner.json'), JSON.stringify({ pid: process.pid, token: 'held-for-test' }), 'utf8');

  const reader = spawnNode(join(fixtureBin, 'fiscus.mjs'), [], fixture);
  try {
    await new Promise((resolve) => setTimeout(resolve, 250));
    assert.equal(reader.child.exitCode, null, 'the launcher imported the runtime before publication completed');
    rmSync(fixtureLock, { recursive: true, force: true });

    const result = await reader.result;
    assert.equal(result.code, 0, result.stderr || 'the launcher failed after publication completed');
    assert.equal(result.stdout, 'fixture-cli-ready\n');
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }

  assert.equal(existsSync(fixtureLock), false, 'the held test lock must not leave residue');
});
