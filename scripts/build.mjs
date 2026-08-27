import { cpSync, existsSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dist = join(root, 'dist');
const tsc = join(root, 'node_modules', 'typescript', 'bin', 'tsc');

function compile(project, label) {
  const result = spawnSync(process.execPath, [tsc, '-p', project], { cwd: root, stdio: 'inherit' });
  if (result.status !== 0) {
    console.error(`  build failed: ${label}`);
    process.exit(result.status ?? 1);
  }
}

/**
 * `--web` emits only the browser app and its static assets — the targeted
 * slice used when iterating on GUI output. The ordinary `npm test` pretest
 * uses the full build because package-boundary tests also inspect the Node
 * runtime artifacts in dist/.
 *
 * The artifact dependency is real but must not be inherited from `npm ci`'s
 * prepare side effect: a contributor running `npm test` straight after a
 * clean install must receive the same prerequisites as CI.
 *
 * `--web` still skips the node-runtime pass and the dist/ wipe so a partial
 * iteration cannot delete the half it was not asked to produce. The full
 * pretest build is intentionally slower, but it is the reproducible contract.
 */
const webOnly = process.argv.includes('--web');

if (!webOnly) {
  rmSync(dist, { recursive: true, force: true });

  // Pass 1 — the Node runtime (CLI, proxy, store, dashboard server).
  compile(join(root, 'tsconfig.build.json'), 'node runtime');
}

// Pass 2 — the browser app. Its own config carries the DOM lib and no node
// types, so server code cannot reach a browser global and the GUI cannot reach
// a node one. Same compiler, no bundler, no new dependency: the emitted files
// are plain unminified ES modules a human can read in view-source, which is the
// same inspectability promise the product makes about its numbers.
const webApp = join(root, 'src', 'dashboard', 'web', 'app');
if (!existsSync(webApp)) throw new Error('Web app sources are missing from src/dashboard/web/app.');
compile(join(webApp, 'tsconfig.json'), 'browser app');

// Static assets: everything under web/ that is NOT a TypeScript source or a
// tsconfig. The .ts files became .js in pass 2; copying them too would ship the
// same code twice and let a stale copy be served.
const dashboardSource = join(root, 'src', 'dashboard', 'web');
const dashboardOutput = join(dist, 'dashboard', 'web');
if (!existsSync(dashboardSource)) throw new Error('Dashboard static assets are missing from src/dashboard/web.');
cpSync(dashboardSource, dashboardOutput, {
  recursive: true,
  filter: (src) => !src.endsWith('.ts') && !src.endsWith('tsconfig.json'),
});
