#!/usr/bin/env node
// Thin launcher for the compiled runtime. Shipping JavaScript is intentional:
// Node does not permit TypeScript type stripping for files in node_modules.
//
// Node emits the "SQLite is an experimental feature" warning from an internal
// path that a userland process.emitWarning override can't intercept, so we
// re-exec ourselves once with --disable-warning to keep output clean. This is
// the only knob that reliably suppresses it for `npx fiscus`.
import { spawnSync } from 'node:child_process';
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
  process.exit(result.status ?? 0);
} else {
  const here = dirname(self);
  await import(pathToFileURL(join(here, '..', 'dist', 'cli.js')).href);
}
