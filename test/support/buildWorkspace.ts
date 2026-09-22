/**
 * A throwaway copy of the repository that can be built without taking the
 * repository's own publication lock.
 *
 * ONE TEST WAS COSTING THE WHOLE LOCAL SUITE ITS MEANING. `concurrent builds
 * keep the compiled CLI runnable throughout publication` starts two real builds
 * at the repository root, and a real build holds the root publication lock for
 * tens of seconds. Every other file that spawns `bin/fiscus.mjs` — the CLI
 * tests, the package-surface sweep, the issuance-map walk, the home-override
 * end-to-end — takes that same lock as a READER and queues behind it. On the
 * last full run `test/fiscus-home-cli.test.ts` sat in that queue until its own
 * 180-second `execFile` timeout fired and reported `fiscus demo should succeed`,
 * which names the wrong thing entirely: the demo was fine, it never got to run.
 *
 * The lock was doing its job. The test was building in the wrong place.
 *
 * WHAT IS AND IS NOT PRESERVED. The claim under test is about the BUILD's
 * publication protocol — that a reader always sees either the previous complete
 * tree or the new one, never an absent `dist/cli.js` — and that claim is about
 * the protocol, not about this checkout. Running it against a copy tests exactly
 * the same thing, with the same two concurrent builders and the same eight
 * concurrent readers, at the same real `tsc` cost. Nothing is stubbed and no
 * assertion is weakened; only the address changes.
 *
 * `node_modules` is linked rather than copied. Copying it would dominate the
 * runtime and would test nothing — the build reads exactly one thing from it,
 * `typescript/bin/tsc`, and a link gives the same bytes. On Windows the link is
 * a junction, which is the one directory-link kind that does not require
 * elevation.
 */

import { cpSync, existsSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = dirname(dirname(dirname(fileURLToPath(import.meta.url))));

/**
 * Everything `scripts/build.mjs` reads, and nothing else.
 *
 * Deliberately a list rather than a copy-everything-except: a build input that
 * is added and not listed here fails loudly in this workspace while the root
 * build keeps working, which is a far better failure than a copy that silently
 * carries along whatever happens to be in the tree.
 */
const BUILD_INPUTS = [
  'src',
  'scripts',
  'bin',
  'pricing',
  'package.json',
  'tsconfig.json',
  'tsconfig.build.json',
];

export interface BuildWorkspace {
  readonly root: string;
  readonly build: string;
  readonly cli: string;
  /** Whether a previously published `dist/` came across with the copy. */
  readonly seeded: boolean;
  dispose(): void;
}

/** Copy the build inputs into a temp root and link its `node_modules`. */
export function createBuildWorkspace(prefix = '.fiscus-ws-'): BuildWorkspace {
  // BESIDE THE REPOSITORY, NOT IN THE SYSTEM TEMP DIRECTORY. `scripts/build.mjs`
  // already stages beside `dist` on purpose, so that every publication rename is
  // same-volume; the same reasoning applies to the whole workspace, and it is
  // not theoretical here. Measured on this machine: the identical test took
  // 177s with the workspace under `os.tmpdir()` and 95-131s at the repository
  // root before isolation. A sibling directory keeps the isolation and gives the
  // volume back. `.fiscus-ws-*` is gitignored.
  const root = mkdtempSync(join(REPO, prefix));
  try {
    for (const entry of BUILD_INPUTS) {
      const source = join(REPO, entry);
      if (!existsSync(source)) throw new Error(`build input is missing from the repository: ${entry}`);
      cpSync(source, join(root, entry), { recursive: true });
    }
    symlinkSync(join(REPO, 'node_modules'), join(root, 'node_modules'), 'junction');
    // Carry across a published `dist/` when the repository has one. The
    // publication claim under test is that a reader sees the PRIOR complete tree
    // or the new one, so a prior tree is a precondition, not part of the claim —
    // at the root it came from `pretest` and was silently relied upon. Copying
    // one costs a directory copy; building one costs a third full `tsc` pass,
    // which measured at over four minutes in a temp workspace and made the
    // isolation more expensive than the contention it removed.
    if (existsSync(join(REPO, 'dist', 'cli.js'))) {
      cpSync(join(REPO, 'dist'), join(root, 'dist'), { recursive: true });
    }
  } catch (error) {
    rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 25 });
    throw error;
  }
  return {
    root,
    build: join(root, 'scripts', 'build.mjs'),
    cli: join(root, 'bin', 'fiscus.mjs'),
    seeded: existsSync(join(root, 'dist', 'cli.js')),
    dispose(): void {
      // The junction is removed with the tree; `rmSync` does not follow it, so
      // the repository's real `node_modules` is never at risk here.
      rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 25 });
    },
  };
}
