/**
 * The one list of native importers.
 *
 * The CLI and the dashboard each kept their own list. The CLI's gained
 * Antigravity; the dashboard's did not, so "import all" from the dashboard
 * silently skipped a tool the CLI read and `scan` reported (H008). Every
 * surface now builds from this list: adding a tool is adding one entry here.
 */

import { existsSync } from 'node:fs';
import type { Store } from '../store/db.ts';
import { IMPORTERS, type ImportSummary } from './importShared.ts';
import { importClaudeCode, defaultClaudeCodeRoot } from './claudeCode.ts';
import { importOpencode, defaultOpencodeDbPath } from './opencode.ts';
import { importCodex, defaultCodexRoot } from './codex.ts';
import { importAntigravity, defaultAntigravityRoot } from './antigravity.ts';

export interface ImportOptions {
  root?: string;
  sinceMs?: number;
  rescan?: boolean;
  modifiedSinceMs?: number;
}

export interface ImporterEntry {
  id: 'claude-code' | 'opencode' | 'codex' | 'antigravity';
  label: string;
  blurb: string;
  /** What people type: `segreant import <alias>`. */
  aliases: readonly string[];
  /** Where this tool keeps its data on this machine, or null when it is not here. */
  locate: () => string | null;
  run: (store: Store, opts: ImportOptions) => ImportSummary | Promise<ImportSummary>;
  /** Whether a recent pass and a backfill split this source (file-based sources). */
  recentFirst: boolean;
}

const info = (id: ImporterEntry['id']) => {
  const found = IMPORTERS.find((i) => i.id === id);
  if (!found) throw new Error(`importer ${id} has no description in importShared IMPORTERS`);
  return { label: found.label, blurb: found.blurb };
};

export const IMPORT_REGISTRY: readonly ImporterEntry[] = [
  {
    id: 'claude-code', ...info('claude-code'), aliases: ['claude-code', 'claudecode', 'claude'],
    locate: () => (existsSync(defaultClaudeCodeRoot()) ? defaultClaudeCodeRoot() : null),
    run: (store, opts) => importClaudeCode(store, opts), recentFirst: true,
  },
  {
    id: 'opencode', ...info('opencode'), aliases: ['opencode'],
    locate: () => defaultOpencodeDbPath(),
    run: (store, opts) => importOpencode(store, opts), recentFirst: false,
  },
  {
    id: 'codex', ...info('codex'), aliases: ['codex', 'codex-cli'],
    locate: () => defaultCodexRoot(),
    run: (store, opts) => importCodex(store, opts), recentFirst: true,
  },
  {
    id: 'antigravity', ...info('antigravity'), aliases: ['antigravity', 'agy', 'gemini'],
    locate: () => defaultAntigravityRoot(),
    run: (store, opts) => importAntigravity(store, opts), recentFirst: true,
  },
];

export function importerFor(what: string): ImporterEntry | null {
  const w = what.toLowerCase();
  return IMPORT_REGISTRY.find((e) => e.aliases.includes(w)) ?? null;
}
