import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  renameSync,
  rmSync,
} from 'node:fs';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { acquirePublicationLock, LOCK_POLL_MS } from '../bin/publication-lock.mjs';
import { sourceFingerprint } from './build-integrity.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dist = join(root, 'dist');
const tsc = join(root, 'node_modules', 'typescript', 'bin', 'tsc');
const RENAME_RETRY_MS = 5_000;
const waitCell = new Int32Array(new SharedArrayBuffer(4));
const sharedDashboardContract = join(root, 'src', 'dashboard', 'contracts.ts');
const sharedDashboardTypes = join(root, 'src', 'dashboard', 'shared-types.ts');
const generatedBrowserDashboardContract = join(root, 'src', 'dashboard', 'web', 'app', 'core', 'generated-contract.ts');
const dashboardPayloadContractGenerator = join(root, 'scripts', 'generate-dashboard-payload-contract.mjs');

/** Keep the browser's no-node copy byte-identical to the server contract. */
function syncSharedDashboardContract() {
  // Builders start concurrently in the supported workflow. The generated
  // target is a source input for both TypeScript passes, so even a byte-identical
  // copy must be serialized: Windows can reject a second copy while the first
  // process still has the destination open. Reuse the same gate as publication
  // and the launcher; this is deliberately before source fingerprint capture.
  const release = acquirePublicationLock(root);
  try {
    copyFileSync(sharedDashboardContract, generatedBrowserDashboardContract);
    const generated = spawnSync(process.execPath, [dashboardPayloadContractGenerator], {
      cwd: root,
      stdio: 'inherit',
    });
    if (generated.error) throw generated.error;
    if (generated.status !== 0) throw new Error(`dashboard payload contract generation failed (${generated.status ?? 1})`);
  } finally {
    release();
  }
}

syncSharedDashboardContract();

class BuildFailure extends Error {
  constructor(label, exitCode) {
    super(`build failed: ${label}`);
    this.label = label;
    this.exitCode = exitCode;
  }
}

class SourceChangedFailure extends Error {
  constructor(phase) {
    super(`build inputs changed ${phase}; refusing to publish a mixed source generation`);
    this.name = 'SourceChangedFailure';
  }
}

function sleep(milliseconds) {
  Atomics.wait(waitCell, 0, 0, milliseconds);
}

function compile(project, label, outDir) {
  const result = spawnSync(process.execPath, [tsc, '-p', project, '--outDir', outDir], {
    cwd: root,
    stdio: 'inherit',
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new BuildFailure(label, result.status ?? 1);
}

function stagedFiles(directory) {
  const files = [];

  function walk(current, relative = '') {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const childRelative = relative ? join(relative, entry.name) : entry.name;
      const child = join(current, entry.name);
      if (entry.isDirectory()) {
        walk(child, childRelative);
      } else if (entry.isFile()) {
        files.push(childRelative);
      } else {
        throw new Error(`unsupported build artifact type: ${child}`);
      }
    }
  }

  if (existsSync(directory)) walk(directory);
  return files;
}

function renameWithRetry(source, target) {
  const started = Date.now();
  let lastError;
  while (Date.now() - started < RENAME_RETRY_MS) {
    try {
      renameSync(source, target);
      return;
    } catch (error) {
      // Windows can briefly deny replacement while a concurrent reader (for
      // example npm pack) still has the old file open. Keep the destination
      // untouched and retry; a real shape/permission error is surfaced after
      // the bounded window rather than falling back to a delete-and-gap.
      if (!['EACCES', 'EBUSY', 'EPERM'].includes(error?.code)) throw error;
      lastError = error;
      sleep(LOCK_POLL_MS);
    }
  }
  throw lastError;
}

function replaceFileAtomically(source, target, temporaryDirectory) {
  mkdirSync(dirname(target), { recursive: true });
  // Keep the temporary sibling on the same filesystem as dist while keeping
  // it outside dist itself. npm pack and other readers therefore never see an
  // in-flight artifact, and renameSync remains an atomic same-volume move on
  // both Windows and POSIX.
  const temporary = join(temporaryDirectory, `.publish-${process.pid}-${randomUUID()}.tmp`);
  try {
    // The copy completes outside the published path. renameSync then replaces
    // one existing file in one filesystem operation on Windows and POSIX.
    copyFileSync(source, temporary);
    renameWithRetry(temporary, target);
  } finally {
    rmSync(temporary, { force: true });
  }
}

function removeEmptyDirectories(directory) {
  if (!existsSync(directory)) return;
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const child = join(directory, entry.name);
    removeEmptyDirectories(child);
    if (readdirSync(child).length === 0) rmSync(child, { recursive: true, force: true });
  }
}

function assertSourceGeneration(inputPaths, expected, phase) {
  const actual = sourceFingerprint(root, inputPaths);
  if (actual !== expected) throw new SourceChangedFailure(phase);
}

function publish(stage, { prune, inputPaths, sourceGeneration }) {
  const release = acquirePublicationLock(root);
  try {
    // The source can change while a stage is compiling and while another
    // publisher is holding the gate. Check inside the exclusive gate as the
    // final pre-publication decision, so an older build cannot publish after a
    // newer source generation has become visible.
    assertSourceGeneration(inputPaths, sourceGeneration, 'before publication');
    mkdirSync(dist, { recursive: true });

    // Keep the entrypoint until every dependency is ready. The supported bin
    // launcher holds the same gate while resolving this tree, so it cannot
    // observe a newly-written entrypoint with a missing dependency.
    const files = stagedFiles(stage).sort((a, b) => {
      if (a === 'cli.js') return 1;
      if (b === 'cli.js') return -1;
      return a.localeCompare(b);
    });
    for (const relative of files) {
      replaceFileAtomically(join(stage, relative), join(dist, relative), stage);
    }

    if (prune) {
      const expected = new Set(files);
      for (const relative of stagedFiles(dist)) {
        if (!expected.has(relative)) rmSync(join(dist, relative), { force: true });
      }
      removeEmptyDirectories(dist);
    }
  } finally {
    release();
  }
}

/**
 * `--web` emits only the browser app and its static assets — the targeted
 * slice used when iterating on GUI output. The ordinary `npm test` pretest
 * uses the full build because package-boundary tests also inspect the Node
 * runtime artifacts in dist/.
 *
 * Every pass is built in a unique temporary tree. A successful full build is
 * then published file-by-file under a short publication lock, with each file
 * copied to a temporary sibling before replacement. This preserves the
 * previous complete dist/ tree during compilation and prevents the old
 * rmSync(dist) race from exposing an empty or partially-created runtime. The
 * supported bin launcher acquires that same gate before module resolution;
 * direct dist/* imports remain outside this reader protocol.
 *
 * `--web` still skips the node-runtime pass and does not prune dist/; it merges
 * the browser output only, preserving the documented partial-iteration
 * behavior and the existing node runtime.
 */
const webOnly = process.argv.includes('--web');
const sourceInputs = webOnly
  ? ['src/dashboard/web', sharedDashboardTypes]
  : ['src', 'tsconfig.json', 'tsconfig.build.json'];
const SOURCE_RETRY_LIMIT = 1;
let exitCode = 0;

function buildOnce() {
  // Capture one source generation before either compiler pass. A concurrent
  // build that started from an older generation will fail the final check
  // instead of rolling a newer publication back.
  const sourceGeneration = sourceFingerprint(root, sourceInputs);
  // Stage beside dist so every publication rename is same-volume even on a
  // machine whose system temp directory is mounted elsewhere.
  const stage = mkdtempSync(join(root, '.fiscus-build-'));
  try {

    // Pass 1 — the Node runtime (CLI, proxy, store, dashboard server).
    if (!webOnly) compile(join(root, 'tsconfig.build.json'), 'node runtime', stage);

    // Pass 2 — the browser app. Its own config carries the DOM lib and no node
    // types, so server code cannot reach a browser global and the GUI cannot
    // reach a node one. Same compiler, no bundler: emitted files are plain,
    // inspectable ES modules.
    const webApp = join(root, 'src', 'dashboard', 'web', 'app');
    if (!existsSync(webApp)) throw new Error('Web app sources are missing from src/dashboard/web/app.');
    const webOutput = join(stage, 'dashboard', 'web', 'app');
    compile(join(webApp, 'tsconfig.json'), 'browser app', webOutput);

    // Static assets: everything under web/ that is NOT a TypeScript source or a
    // tsconfig. The .ts files became .js in pass 2; copying them too would ship
    // the same code twice and let a stale copy be served.
    const dashboardSource = join(root, 'src', 'dashboard', 'web');
    const dashboardOutput = join(stage, 'dashboard', 'web');
    if (!existsSync(dashboardSource)) throw new Error('Dashboard static assets are missing from src/dashboard/web.');
    cpSync(dashboardSource, dashboardOutput, {
      recursive: true,
      filter: (source) => !source.endsWith('.ts') && !source.endsWith('tsconfig.json'),
    });

    // This catches edits that happened after the initial capture but before the
    // publication gate. publish() repeats the same check under the gate to
    // close the final check/acquire window.
    assertSourceGeneration(sourceInputs, sourceGeneration, 'during compilation');
    publish(stage, { prune: !webOnly, inputPaths: sourceInputs, sourceGeneration });
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
}

try {
  let retries = 0;
  while (true) {
    try {
      buildOnce();
      break;
    } catch (error) {
      if (error instanceof SourceChangedFailure && retries < SOURCE_RETRY_LIMIT) {
        retries += 1;
        console.error(`  ${error.message}; retrying build (${retries}/${SOURCE_RETRY_LIMIT})`);
        continue;
      }
      throw error;
    }
  }
} catch (error) {
  if (error instanceof BuildFailure) {
    console.error(`  ${error.message}`);
    exitCode = error.exitCode;
  } else {
    console.error(error);
    exitCode = 1;
  }
}

process.exitCode = exitCode;
