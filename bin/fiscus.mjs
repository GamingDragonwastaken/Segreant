#!/usr/bin/env node
// Thin launcher for the compiled runtime. Shipping JavaScript is intentional:
// Node does not permit TypeScript type stripping for files in node_modules.
//
// Node emits the "SQLite is an experimental feature" warning from an internal
// path that a userland process.emitWarning override can't intercept, so we
// re-exec ourselves once with --disable-warning to keep output clean. This is
// the only knob that reliably suppresses it for `npx fiscus`.
import { spawnSync } from 'node:child_process';
import { acquirePublicationLock } from './publication-lock.mjs';
import { cpSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';

// Fail fast with a human message on too-old Node before Node's SQLite runtime
// dependency reports a less actionable error.
const major = Number(process.versions.node.split('.')[0]);
if (major < 24) {
  console.error(
    `Fiscus needs Node >= 24 (you have ${process.versions.node}).\n` +
    `The packaged runtime targets Node 24 or newer.\n` +
    `Upgrade Node from https://nodejs.org/ and re-run.`,
  );
  process.exit(1);
}

const self = fileURLToPath(import.meta.url);

if (!process.env.__FISCUS_CHILD) {
  const result = spawnSync(
    process.execPath,
    ['--disable-warning=ExperimentalWarning', self, ...process.argv.slice(2)],
    { stdio: 'inherit', env: { ...process.env, __FISCUS_CHILD: '1' } },
  );
  if (result.error) {
    console.error(`Fiscus could not start its runtime: ${result.error.message}`);
    process.exit(1);
  }
  if (typeof result.status === 'number') process.exit(result.status);
  console.error(`Fiscus runtime terminated by signal ${result.signal ?? 'unknown'}`);
  process.exit(1);
} else {
  const here = dirname(self);
  const release = acquirePublicationLock(join(here, '..'));
  const runtimeRoot = join(here, '..', 'dist');
  let snapshotRoot;

  try {
    snapshotRoot = mkdtempSync(join(tmpdir(), 'fiscus-runtime-'));
    const snapshotDist = join(snapshotRoot, 'dist');
    // Copy while the publisher is excluded. Once the lock is released all
    // module resolution happens inside this private tree, so no later build can
    // replace a dependency half-way through the import graph.
    cpSync(runtimeRoot, snapshotDist, { recursive: true, force: true, errorOnExist: false });
    // The compiled runtime intentionally resolves a few package resources
    // relative to the package root (the bundled pricing card, Lift baselines,
    // and package version). Preserve those alongside the copied dist tree so a
    // snapshot is behaviorally equivalent to the checked-out/package layout.
    for (const resource of ['pricing', 'baselines', 'package.json']) {
      const source = join(here, '..', resource);
      if (existsSync(source)) cpSync(source, join(snapshotRoot, resource), { recursive: true, force: true, errorOnExist: false });
    }
  } catch (error) {
    if (snapshotRoot) {
      try { rmSync(snapshotRoot, { recursive: true, force: true, maxRetries: 20, retryDelay: 25 }); } catch { /* preserve the original startup error */ }
    }
    throw error;
  } finally {
    release?.();
  }

  try {
    // Direct imports of dist/* and tools such as npm pack do not participate in
    // this gate; the atomic reader guarantee is intentionally limited to the
    // supported bin launcher and the build protocol.
    const runtime = await import(pathToFileURL(join(snapshotRoot, 'dist', 'cli.js')).href);
    // The production CLI schedules dispatch with setImmediate so the launcher
    // can release the publication lock before command work begins. Await that
    // completion promise before deleting the private snapshot; otherwise a
    // command such as `demo` can start after import() returns and observe its
    // copied pricing/baseline resources disappearing underneath it.
    if (runtime.cliCompletion && typeof runtime.cliCompletion.then === 'function') {
      await runtime.cliCompletion;
    }
  } finally {
    try { rmSync(snapshotRoot, { recursive: true, force: true, maxRetries: 20, retryDelay: 25 }); } catch { /* preserve command result; temp is outside the repository */ }
  }
}
