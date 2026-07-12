#!/usr/bin/env node
// Thin launcher. The CLI is TypeScript, run directly by Node's built-in type
// stripping (Node >= 22.5, stable on 24). No build step.
//
// Node emits the "SQLite is an experimental feature" warning from an internal
// path that a userland process.emitWarning override can't intercept, so we
// re-exec ourselves once with --disable-warning to keep output clean. This is
// the only knob that reliably suppresses it for `npx fiscus`.
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

// Fail fast with a human message on too-old Node, rather than a cryptic
// "Unknown file extension .ts" when built-in type stripping isn't available.
const major = Number(process.versions.node.split('.')[0]);
if (major < 24) {
  console.error(
    `Fiscus needs Node >= 24 (you have ${process.versions.node}).\n` +
    `It runs TypeScript directly via Node's built-in type stripping, stable on 24.\n` +
    `Upgrade Node from https://nodejs.org/ and re-run.`,
  );
  process.exit(1);
}

const self = fileURLToPath(import.meta.url);

if (!process.env.__AEGIS_CHILD) {
  const result = spawnSync(
    process.execPath,
    ['--disable-warning=ExperimentalWarning', self, ...process.argv.slice(2)],
    { stdio: 'inherit', env: { ...process.env, __AEGIS_CHILD: '1' } },
  );
  process.exit(result.status ?? 0);
} else {
  const here = dirname(self);
  await import(pathToFileURL(join(here, '..', 'src', 'cli.ts')).href);
}
