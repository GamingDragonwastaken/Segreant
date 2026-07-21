/**
 * This package's version, read from package.json — the single source of truth.
 * Its own module so it can be shared by the CLI (`fiscus --version`) and the
 * dashboard (Settings view "version" field) without a circular import between
 * cli.ts and src/cli/runCmd.ts.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

export function packageVersion(): string {
  try {
    const pkgPath = join(dirname(fileURLToPath(import.meta.url)), '..', 'package.json');
    return (JSON.parse(readFileSync(pkgPath, 'utf8')) as { version?: string }).version ?? 'unknown';
  } catch {
    // Version is informational only; a missing/garbled package.json must never
    // break the CLI. Return an explicit sentinel rather than crash.
    return 'unknown';
  }
}
