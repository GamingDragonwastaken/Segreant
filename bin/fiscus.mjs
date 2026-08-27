#!/usr/bin/env node
// Thin launcher for the compiled runtime. Shipping JavaScript is intentional:
// Node does not permit TypeScript type stripping for files in node_modules.
//
// Node emits the "SQLite is an experimental feature" warning from an internal
// path that a userland process.emitWarning override can't intercept, so we
// re-exec ourselves once with --disable-warning to keep output clean. This is
// the only knob that reliably suppresses it for `npx fiscus`.
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

const PUBLICATION_WAIT_MS = 120_000;
const PUBLICATION_POLL_MS = 25;
const waitCell = new Int32Array(new SharedArrayBuffer(4));

function waitForPublication() {
  const lock = join(dirname(fileURLToPath(import.meta.url)), '..', '.fiscus-build.lock');
  const started = Date.now();
  while (existsSync(lock)) {
    if (Date.now() - started >= PUBLICATION_WAIT_MS) {
      throw new Error(`timed out waiting for Fiscus build publication (${PUBLICATION_WAIT_MS}ms)`);
    }
    // This is intentionally synchronous: the launcher must not begin module
    // resolution until the publisher has released its short-lived lock. A
    // bounded wait also turns an abandoned lock into an actionable failure.
    Atomics.wait(waitCell, 0, 0, PUBLICATION_POLL_MS);
  }
}

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
  process.exit(result.status ?? 0);
} else {
  const here = dirname(self);
  waitForPublication();
  await import(pathToFileURL(join(here, '..', 'dist', 'cli.js')).href);
}
