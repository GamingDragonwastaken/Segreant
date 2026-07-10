/**
 * Known-app inventory — the wider, honest half of `scan`.
 *
 * `detectTools()` (scan.ts) answers "which of our 3 NATIVELY SUPPORTED tools are
 * here" — present implies AegisFlow can read its usage data. This module answers
 * a different, narrower question: "which OTHER AI coding tools do we merely SEE
 * evidence of on this machine". Presence here implies nothing about import
 * capability — it is a plain inventory, not a promise. Every signature is a
 * read-only existence check (a config/data directory, or a binary on PATH),
 * exactly the same posture as the 3 supported detectors reuse from their own
 * importers: no process enumeration, no content reads, no network. Process
 * scanning was deliberately rejected — it reads as surveillance of what's
 * RUNNING rather than a plain inventory of what's INSTALLED, which is the one
 * framing risk this feature has to get right (see scan.ts's module doc).
 *
 * Detection is dependency-injected (home/platform/PATH/exists) so it is unit
 * testable without touching the real filesystem or the dev machine's actual
 * installed tools — the same pattern `connect/connectors.ts` uses for opencode
 * config resolution.
 */

import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, delimiter } from 'node:path';

export interface DetectEnv {
  home: string;
  platform: NodeJS.Platform;
  /** Directories on PATH, already split. */
  pathDirs: string[];
  exists: (p: string) => boolean;
}

export interface DetectedApp {
  id: string;
  label: string;
  /** One line describing what the tool is (not whether we support it). */
  blurb: string;
  present: boolean;
  /** The config/data path or PATH binary that proved presence, else null. */
  evidence: string | null;
}

interface KnownAppSignature {
  id: string;
  label: string;
  blurb: string;
  detect: (env: DetectEnv) => string | null;
}

/** First existing path wins; null if none exist. */
function firstExisting(env: DetectEnv, candidates: string[]): string | null {
  for (const p of candidates) if (env.exists(p)) return p;
  return null;
}

/** A binary present on PATH under any of `names`, trying platform-appropriate suffixes. */
function findOnPath(env: DetectEnv, names: string[]): string | null {
  const suffixes = env.platform === 'win32' ? ['.exe', '.cmd', '.bat', ''] : [''];
  for (const dir of env.pathDirs) {
    for (const name of names) {
      for (const suf of suffixes) {
        const p = join(dir, name + suf);
        if (env.exists(p)) return p;
      }
    }
  }
  return null;
}

/** Zed's config dir is genuinely OS-specific (not just an XDG-vs-Windows split). */
function zedConfigDir(env: DetectEnv): string {
  if (env.platform === 'win32') return join(env.home, 'AppData', 'Roaming', 'Zed');
  if (env.platform === 'darwin') return join(env.home, 'Library', 'Application Support', 'Zed');
  return join(env.home, '.config', 'zed');
}

/**
 * The known-app table. Deliberately modest: every entry here is a tool whose
 * config/data location or CLI binary name is well established, not a guess. Add
 * to this list as more locations are verified — a smaller, correct table is more
 * honest than a larger, speculative one.
 */
const KNOWN_APPS: KnownAppSignature[] = [
  {
    id: 'cursor',
    label: 'Cursor',
    blurb: 'AI-first code editor.',
    detect: (env) => firstExisting(env, [join(env.home, '.cursor')]),
  },
  {
    id: 'windsurf',
    label: 'Windsurf',
    blurb: 'AI-first code editor (Codeium).',
    detect: (env) => firstExisting(env, [join(env.home, '.codeium', 'windsurf'), join(env.home, '.windsurf')]),
  },
  {
    id: 'aider',
    label: 'Aider',
    blurb: 'Terminal AI pair-programming CLI.',
    detect: (env) => findOnPath(env, ['aider']) ?? firstExisting(env, [join(env.home, '.aider.conf.yml')]),
  },
  {
    id: 'continue',
    label: 'Continue.dev',
    blurb: 'Open-source AI coding assistant (VS Code / JetBrains extension).',
    detect: (env) => firstExisting(env, [join(env.home, '.continue')]),
  },
  {
    id: 'zed',
    label: 'Zed',
    blurb: 'Editor with built-in AI features.',
    detect: (env) => firstExisting(env, [zedConfigDir(env)]),
  },
];

/**
 * Detect which OTHER known AI coding tools show evidence of being installed —
 * read-only existence checks only. Every env input is optional and defaults to
 * the real machine, so the common call is just `detectKnownApps()`; tests inject
 * a fake home/exists to stay deterministic and independent of what happens to be
 * on the dev machine.
 */
export function detectKnownApps(opts: Partial<DetectEnv> = {}): DetectedApp[] {
  const env: DetectEnv = {
    home: opts.home ?? homedir(),
    platform: opts.platform ?? process.platform,
    pathDirs: opts.pathDirs ?? (process.env.PATH ?? process.env.Path ?? '').split(delimiter).filter(Boolean),
    exists: opts.exists ?? existsSync,
  };
  return KNOWN_APPS.map((sig) => {
    const evidence = sig.detect(env);
    return { id: sig.id, label: sig.label, blurb: sig.blurb, present: evidence !== null, evidence };
  });
}
