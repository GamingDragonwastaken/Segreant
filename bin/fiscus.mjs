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
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

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
  // The launcher participates in the same exclusive gate as publication.
  // Acquiring (rather than merely checking) the lock closes the race where a
  // build starts immediately after a reader's old existsSync check. Lock
  // failure is intentionally fatal: bypassing it would make a reader's
  // artifact guarantee depend on an unverified filesystem assumption.
  const release = acquirePublicationLock(join(here, '..'));

  try {
    // Direct imports of dist/* and tools such as npm pack do not participate
    // in this gate; the atomic reader guarantee is intentionally limited to
    // the supported bin launcher and the build protocol.
    await import(pathToFileURL(join(here, '..', 'dist', 'cli.js')).href);
  } finally {
    release?.();
  }
}
