/**
 * CI's own supply-chain posture is only as good as what actually executes
 * during `npm ci` (WP-H05 GAP2).
 *
 * Before this file, every `npm ci` in `.github/workflows/ci.yml` ran without
 * `--ignore-scripts`, so a lifecycle script belonging to any dependency —
 * `preinstall`/`install`/`postinstall` — would run unattended in CI, along
 * with this package's own `prepare` (`npm run build`). Nothing in this
 * repository's dependency tree currently carries one (checked directly:
 * `package-lock.json` and `team-server/package-lock.json` both have zero
 * packages with `hasInstallScript: true`, across 24 and 39 locked packages
 * respectively), but CI having no barrier against a *future* one is the gap,
 * not today's tree.
 *
 * `--ignore-scripts` on `npm ci` is not free for the root package: its
 * `prepare` script is `npm run build`, and both jobs that run `npm test`
 * relied on that running automatically to produce `dist/` first —
 * `bin/fiscus.mjs` imports `dist/cli.js`, not `src/`, and several tests read
 * the emitted tree rather than the source.
 *
 * `pretest` IS currently the full `node scripts/build.mjs`, so on today's tree
 * `npm test` would rebuild anyway. The explicit step is required regardless,
 * and deliberately: `pretest` has already been silently narrowed to `--web`
 * once and restored, and CLAUDE.md records both the change and the breakage it
 * hid, so a CI job whose build depends on whichever definition `pretest`
 * currently carries is one edit away from testing a stale `dist/`. The build
 * count does not change either way — before this, `prepare` built once at
 * install and `pretest` built again.
 *
 * Separately, `npm pack` still triggers its own `prepack` (again,
 * `npm run build`) regardless of `--ignore-scripts` on an earlier, separate
 * `npm ci`, so the `package-smoke` job needs no extra build step of its own.
 *
 * WHERE THE FLAG RULE LIVES, AND WHY NOT HERE. `--ignore-scripts` on every
 * workflow install is enforced by `scripts/check-supply-chain.mjs`, alongside
 * the lockfile and pinned-action rules it already owns, and exercised against
 * mutated counterexamples in `test/supply-chain-assurance.test.ts`. That
 * auditor reads every workflow file rather than this one, so putting a second
 * copy of the same sweep here would be two mechanisms answering one question
 * and drifting apart on the day a third workflow is added.
 *
 * What is left here is the part the auditor cannot know: the CONSEQUENCE of
 * the flag for this repository's build. Removing the automatic `prepare` build
 * means each job that runs `npm test` must produce `dist/` itself, in that
 * order, and this file reads `.github/workflows/ci.yml` as text (simple enough
 * that a YAML parser buys nothing) to pin exactly that.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const WORKFLOW_PATH = '.github/workflows/ci.yml';
const read = (relative: string) => readFileSync(join(ROOT, relative), 'utf8');

/**
 * The text of one top-level job block (`  <name>:` under `jobs:`, up to the
 * next line at that same two-space indent). Good enough for this file's flat
 * job list; it does not need to understand nested workflow syntax.
 */
function jobBlock(yaml: string, jobName: string): string {
  const header = new RegExp(`^  ${jobName}:\\s*$`, 'm');
  const start = header.exec(yaml);
  assert.ok(start, `no job named "${jobName}" in ${WORKFLOW_PATH}`);
  const from = start!.index + start![0].length;
  const rest = yaml.slice(from);
  const nextJob = /^  [A-Za-z][\w-]*:\s*$/m.exec(rest);
  return nextJob ? rest.slice(0, nextJob.index) : rest;
}

/** Ordered single-line `run: <command>` steps within a job block. */
function orderedRunCommands(block: string): string[] {
  return [...block.matchAll(/^\s*- run:\s*(.+)$/gm)].map((m) => m[1]!.trim());
}

test('every job that runs npm test rebuilds explicitly between its install and that test run', () => {
  // BOTH such jobs, not just `test`. `candidate-head` is the job that proves
  // the PR's actual head commit rather than GitHub's synthetic merge ref, so a
  // stale or absent dist/ there would leave the one run that speaks for the
  // candidate proving less than the matrix does.
  const yaml = read(WORKFLOW_PATH);
  for (const job of ['test', 'candidate-head']) {
    const commands = orderedRunCommands(jobBlock(yaml, job));

    const ciIndex = commands.findIndex((c) => c.startsWith('npm ci'));
    const buildIndex = commands.findIndex((c) => c === 'npm run build');
    const testIndex = commands.findIndex((c) => c === 'npm test');

    assert.notEqual(ciIndex, -1, `${job} must install with npm ci`);
    assert.ok(commands[ciIndex]!.includes('--ignore-scripts'), `${job} must pass --ignore-scripts to npm ci`);
    assert.notEqual(
      buildIndex,
      -1,
      `${job} must explicitly run "npm run build" -- with --ignore-scripts on npm ci, "prepare" no longer `
      + 'builds dist/ automatically, and a job that depends on whichever build "pretest" currently runs is '
      + 'one edit away from testing a stale dist/',
    );
    assert.notEqual(testIndex, -1, `${job} must run npm test`);
    assert.ok(ciIndex < buildIndex, `${job}: the explicit build must come after the install, not before it`);
    assert.ok(buildIndex < testIndex, `${job}: the explicit build must come before npm test, which needs the dist/ it produces`);
  }
});

test('the package-smoke and team-server-test jobs do not need their own extra build step', () => {
  // package-smoke: `npm pack` itself triggers `prepack` (this package's own
  // `npm run build`) as a separate command, unaffected by --ignore-scripts on
  // the earlier npm ci -- confirmed by hand (see file header). team-server:
  // no prepare/prepack script exists at all (start/test/typecheck all run
  // straight against source), so there is nothing for --ignore-scripts to
  // skip past. Both still need their npm ci to carry the flag, which the
  // sweep above already checks; this test only guards against a well-meaning
  // but redundant "npm run build" being added where nothing needs it.
  const yaml = read(WORKFLOW_PATH);
  for (const job of ['package-smoke', 'team-server-test']) {
    const commands = orderedRunCommands(jobBlock(yaml, job));
    assert.equal(
      commands.includes('npm run build'),
      false,
      `${job} should not need an explicit "npm run build" step`,
    );
  }
});

test('the workflow still declares the four jobs this file assumes', () => {
  const yaml = read(WORKFLOW_PATH);
  for (const job of ['test', 'package-smoke', 'team-server-test', 'candidate-head']) {
    assert.match(yaml, new RegExp(`^  ${job}:\\s*$`, 'm'), `expected a "${job}" job in ${WORKFLOW_PATH}`);
  }
});

test('jobBlock() and orderedRunCommands() actually isolate one job\'s steps, not the whole file', () => {
  const yaml = [
    '  first:',
    '    steps:',
    '      - run: npm ci --ignore-scripts',
    '      - run: npm run build',
    '  second:',
    '    steps:',
    '      - run: npm ci --ignore-scripts',
  ].join('\n');

  const firstCommands = orderedRunCommands(jobBlock(yaml, 'first'));
  assert.deepEqual(firstCommands, ['npm ci --ignore-scripts', 'npm run build']);
  const secondCommands = orderedRunCommands(jobBlock(yaml, 'second'));
  assert.deepEqual(secondCommands, ['npm ci --ignore-scripts']);
});
