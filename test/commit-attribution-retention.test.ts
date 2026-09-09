/**
 * Retention made a commit that cost $6.00 look free.
 *
 * THE COUNTEREXAMPLE, MEASURED. A repository with one commit, and $6.00 of
 * metered spend one hour before it — inside the eight-hour attribution window
 * `attributeCommits` uses. `computeRealization` reported the commit with
 * `attributedCostUsd: 6`. `fiscus prune` then deleted the requests on the
 * operator's own retention policy, and the same call over the same repository
 * reported the same commit with `attributedCostUsd: 0`.
 *
 * The unit did not disappear: work units come from git history, which retention
 * does not touch. Only its cost did. So a commit that cost money is reported as
 * having cost nothing, and that number is a DENOMINATOR — `costPerHundredLines`
 * divides by it, and the Return-on-Intelligence ratio divides value by it. **A
 * deletion does not merely hide spend here; it makes AI look free, and then
 * makes the return on it look better.**
 *
 * WHY THE WINDOW IS REACHABLE. The window is `[commit − 8h, commit]`, bounded
 * by the previous commit. Any commit older than the retention boundary has its
 * whole attribution window behind that boundary, so this is not an edge case
 * under a short retention policy: it is every commit older than it. The default
 * 180-day retention makes it rare rather than impossible, and retention is
 * configurable — the rule cannot rest on the default (D-171).
 *
 * WHAT IS FIXED AND WHAT IS DELIBERATELY NOT. `attributedCostUsd` keeps
 * reporting the SURVIVING spend, because that is what it honestly is, and
 * because nulling a number used in a dozen sums would trade one silent wrong
 * answer for a scattering of them. What changes is that the window now says
 * whether it was truncated, and the DERIVED claims refuse rather than divide:
 * `costPerHundredLines` is null over a truncated window, and the realization
 * report counts the units whose spend window lost rows, so a reader of a
 * ratio can see that its denominator is understated by an unknown amount.
 *
 * THREE STATES, PRESERVED (D-170). A window entirely after the boundary is
 * intact. NO prune on record is unknown, not "nothing was pruned", and asserts
 * nothing. Both silences are held by tests below, because a warning on every
 * commit is noise and noise stops being read.
 *
 * WHAT THIS DOES NOT ESTABLISH. That the RoI figure is otherwise sound — the
 * lenses carry their own conditions and none is closed here. Nor that the
 * dashboard says any of this: `/api/value` carries no coverage field, which
 * stays open. Nor anything about spend that never reached Fiscus, which is the
 * permanent limit of a local meter and a different claim entirely.
 *
 * Recorded at D-176.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.FISCUS_HOME = mkdtempSync(join(tmpdir(), 'fiscus-attr-retention-'));

import { Store, type RequestRow } from '../src/store/db.ts';
import { attributeCommits, projectName } from '../src/git/correlate.ts';
import { rollupRealization } from '../src/value/realization.ts';
import type { WorkUnit } from '../src/value/realization.ts';
import { GATE_LADDER, gateResultFromVerdict } from '../src/value/gates.ts';

const DAY = 24 * 60 * 60 * 1000;
const HOUR = 60 * 60 * 1000;
const NOW = Date.now();
/** Old enough that a thirty-day boundary sits after its whole 8h window. */
const COMMIT_MS = NOW - 60 * DAY;

function makeRepo(): string {
  const repo = mkdtempSync(join(tmpdir(), 'fiscus-attr-repo-'));
  const git = (args: string[], env?: NodeJS.ProcessEnv) =>
    execFileSync('git', args, { cwd: repo, stdio: 'pipe', env: env ?? process.env });
  git(['init', '-q']);
  git(['config', 'user.email', 'test@example.invalid']);
  git(['config', 'user.name', 'Fiscus test']);
  writeFileSync(join(repo, 'app.ts'), 'export const answer = 42;\n');
  git(['add', '.']);
  const when = new Date(COMMIT_MS).toISOString();
  git(['commit', '-qm', 'feat: work that cost money', '--date', when], {
    ...process.env,
    GIT_COMMITTER_DATE: when,
  });
  return repo;
}

function request(id: string, project: string, tsEpochMs: number, costUsd: number): RequestRow {
  return {
    requestId: id, sessionId: null, tsEpochMs, provider: 'openai', model: 'gpt-5',
    project, taskWeight: 1, inputTokens: 10, outputTokens: 10, cacheWriteTokens: 0,
    cacheReadTokens: 0, reasoningTokens: 0, costUsd, estimated: false, streamed: false,
    statusCode: 200, durationMs: 1,
  };
}

test('a prune inside a commit attribution window is disclosed rather than making the commit free', async () => {
  const repo = makeRepo();
  const store = new Store(':memory:');
  try {
    const project = await projectName(repo);
    // One hour before the commit: inside the eight-hour attribution window.
    store.insertRequest(request('in-window', project, COMMIT_MS - HOUR, 6));

    const before = (await attributeCommits(store, repo, { limit: 5 }))[0]!;
    assert.equal(before.attributedCostUsd, 6, 'the baseline: this commit cost $6.00');
    assert.equal(before.spendWindowTruncated, false);
    assert.ok(before.costPerHundredLines !== null, 'and a cost per hundred lines can be computed from it');

    assert.equal(store.prune(NOW - 30 * DAY), 1, 'retention deletes the spend, not the commit');

    const after = (await attributeCommits(store, repo, { limit: 5 }))[0]!;
    assert.equal(after.attributedCostUsd, 0, 'the surviving spend really is zero -- that part is honest');
    assert.equal(
      after.spendWindowTruncated,
      true,
      'but zero over a window whose rows were deleted is not evidence the work was free',
    );
    assert.equal(
      after.costPerHundredLines,
      null,
      'and a cost-per-work figure divided by a denominator retention emptied must not be reported',
    );
  } finally {
    store.close();
    rmSync(repo, { recursive: true, force: true });
  }
});

test('the boundary the truncation names is the recorded one', async () => {
  const repo = makeRepo();
  const store = new Store(':memory:');
  try {
    const project = await projectName(repo);
    store.insertRequest(request('in-window', project, COMMIT_MS - HOUR, 6));
    const boundary = NOW - 30 * DAY;
    store.prune(boundary);

    const after = (await attributeCommits(store, repo, { limit: 5 }))[0]!;
    assert.equal(after.spendWindowPrunedBeforeMs, boundary, 'a caller has to be able to say which rows are gone');
  } finally {
    store.close();
    rmSync(repo, { recursive: true, force: true });
  }
});

test('a commit whose window starts after the boundary is not truncated', async () => {
  // `prune` deletes rows strictly older than the boundary, and the window is
  // [commit - 8h, commit]. A commit well after the boundary lost nothing, and
  // marking every commit on a pruned ledger truncated would be noise.
  const repo = mkdtempSync(join(tmpdir(), 'fiscus-attr-recent-'));
  const store = new Store(':memory:');
  try {
    const git = (args: string[]) => execFileSync('git', args, { cwd: repo, stdio: 'pipe' });
    git(['init', '-q']);
    git(['config', 'user.email', 'test@example.invalid']);
    git(['config', 'user.name', 'Fiscus test']);
    writeFileSync(join(repo, 'app.ts'), 'export const answer = 42;\n');
    git(['add', '.']);
    git(['commit', '-qm', 'feat: recent work']);

    const project = await projectName(repo);
    store.insertRequest(request('recent', project, Date.now() - 60_000, 4));
    store.insertRequest(request('ancient', project, NOW - 90 * DAY, 9));
    assert.equal(store.prune(NOW - 30 * DAY), 1, 'only the ancient row goes');

    const attribution = (await attributeCommits(store, repo, { limit: 5 }))[0]!;
    assert.equal(attribution.spendWindowTruncated, false, 'this window is entirely after the boundary');
    assert.ok(attribution.costPerHundredLines !== null, 'so its cost-per-work figure survives');
  } finally {
    store.close();
    rmSync(repo, { recursive: true, force: true });
  }
});

test('with no prune on record nothing is asserted about deletion', async () => {
  const repo = makeRepo();
  const store = new Store(':memory:');
  try {
    const project = await projectName(repo);
    store.insertRequest(request('in-window', project, COMMIT_MS - HOUR, 6));
    const attribution = (await attributeCommits(store, repo, { limit: 5 }))[0]!;
    assert.equal(attribution.spendWindowTruncated, false);
    assert.equal(
      attribution.spendWindowPrunedBeforeMs,
      null,
      'null is "no prune is ON RECORD" -- a distinct state from a window known intact',
    );
  } finally {
    store.close();
    rmSync(repo, { recursive: true, force: true });
  }
});

/** A mature, realized unit whose spend window has the given coverage. */
function unit(hash: string, cost: number, truncated: boolean | null): WorkUnit {
  return {
    hash, tsEpochMs: COMMIT_MS, subject: '', linesAdded: 10, linesDeleted: 0, filesChanged: 1,
    windowStartMs: 0, windowEndMs: 0, attributedCostUsd: cost, attributedRequests: 1,
    attributedOutputTokens: 0, costPerHundredLines: null,
    spendWindowTruncated: truncated, spendWindowPrunedBeforeMs: truncated === true ? COMMIT_MS : null,
    ageDays: 30, maturing: false, survivalRatio: 1, reverted: false, hadProposal: false, acceptance: null,
    taskType: 'feature', dominantModel: 'gpt-5', dominantModelCostUsd: cost, dominantModelCostShare: 1,
    costStale: false, dominantModelCostBasis: 'local_list_price', dominantModelRateCard: 'card-a',
    funnel: {
      realized: true,
      // One result per gate: the rollup walks the ladder by index, so a short
      // array is a fixture bug rather than a shape the product can produce.
      results: GATE_LADDER.map((gate) => gateResultFromVerdict(gate, 'pass', '')),
      conflicts: [], reachedIndex: GATE_LADDER.length - 1, reached: GATE_LADDER[GATE_LADDER.length - 1] ?? null,
      diedAt: null, diedAtIndex: null,
      passes: GATE_LADDER.length, fails: 0, unknowns: 0, instrumented: GATE_LADDER.length, realizationScore: 1,
    },
  } as WorkUnit;
}

test('the rollup counts truncated and unknown spend windows separately, and does not merge them', () => {
  // THE AGGREGATION IS WHERE THE DENOMINATOR LIVES. `totalCostUsd` and
  // `spendOnRealizedUnitsUsd` are divided by, so a reader has to be able to see
  // how many of the units behind them contributed a cost retention had emptied.
  //
  // The third state is the reason there are two counts. A unit persisted before
  // this field existed says NOTHING about its window; folding it in with the
  // intact ones would report "none affected" from a report that could not tell,
  // which is the inference this whole line of work exists to refuse.
  const report = rollupRealization(
    [unit('intact', 6, false), unit('pruned', 0, true), unit('legacy', 6, null)],
    { windowDays: 365, acceptanceThreshold: 0.5, survivalThreshold: 0.5 },
  );

  assert.equal(report.matured.units, 3);
  assert.equal(report.matured.spendWindowTruncatedUnits, 1, 'exactly the one whose window lost rows');
  assert.equal(report.matured.spendWindowUnknownUnits, 1, 'and the legacy snapshot is unknown, not intact');
  // Non-vacuous: the totals really are the ones a reader would divide.
  assert.equal(report.matured.totalCostUsd, 12, 'the pruned unit contributes nothing, which is the whole problem');
});
