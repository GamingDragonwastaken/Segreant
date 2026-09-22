/**
 * A SIGNED team rollup declared `coverage: 'complete'` over spend it had deleted.
 *
 * THE COUNTEREXAMPLE, MEASURED. A repository with one commit and $6.00 of spend
 * inside its attribution window. `computeRealization(..., { persist: true })`
 * wrote the snapshot, and `fiscus team push --dry-run --json` minted a body
 * carrying `units: 1, costUsd: 6`. `fiscus prune` then deleted the request rows
 * on the operator's retention policy. The snapshot is NOT rewritten by a prune,
 * so nothing changed yet — and that is the trap. The next
 * `computeRealization(..., { persist: true })`, which every `fiscus realize` and
 * every dashboard load performs, re-derives the unit against the pruned ledger
 * and persists `attributedCostUsd: 0` with `spendWindowTruncated: true`. The
 * rollup then reads:
 *
 *     v=2 coverage=complete projects=1 costUsd=0 units=1
 *
 * One intact work unit, at $0.00, that cost $6.00, in a SIGNED artifact
 * declaring itself complete, pushed to a server that sums it into a shared
 * total beside other developers' numbers. This is D-175's defect —
 * `coverage: 'complete'` over a window with deleted rows — on an artifact that
 * leaves the machine, and D-101's failure mode (a total a receiver cannot
 * qualify) through a different cause.
 *
 * THE MECHANISM WAS ALREADY THERE AND NOTHING SET IT. `RollupBodyV1.coverage`
 * has been part of the signed body all along, `validateRollupBody` checks it,
 * `normalizeRollupCoverage` reads legacy absence as `unknown`, and
 * `verifyRollup` returns it to the receiver. Both mint call sites in
 * `teamCmd.ts` omit the argument, so both take the default — and the default is
 * `'complete'`. **A mechanism built and never wired is the second recurring
 * class of this program; one whose unwired default is the most confident value
 * it can take is the worst instance of it yet.** No protocol change is needed
 * or made here: the field exists, is validated, and is read by the receiver.
 *
 * THE UNIT ALREADY CARRIED THE ANSWER. D-176 put `spendWindowTruncated` on every
 * work unit and D-176's rollup counts `spendWindowTruncatedUnits` and
 * `spendWindowUnknownUnits` beside them. Nothing in the team path read either.
 *
 * THREE STATES ONTO THREE STATES. `RollupCoverage` is exactly `complete |
 * partial | unknown`, which is the same three-valued shape this sweep has been
 * carrying since D-170, so the mapping is total and needs no new vocabulary:
 * any unit known truncated makes the body `partial`; otherwise any unit whose
 * coverage is unknown makes it `unknown`; only a body every one of whose units
 * is known intact may say `complete`. Truncated outranks unknown because
 * "some of this is missing" is a stronger and more useful statement to a
 * receiver than "I cannot tell".
 *
 * WHAT THIS DOES NOT ESTABLISH. That the receiver acts on it — `coverage` is
 * explicitly non-authoritative, and what the team server does with a `partial`
 * body is that project's own question, not this one. Nor that the numbers are
 * right in any other way: coverage is a statement about what the signer
 * INCLUDED, never that what was included is true or provider-billed. Nor
 * anything about spend that never reached Fiscus.
 *
 * Recorded at D-181.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Store, type RequestRow } from '../src/store/db.ts';
import { computeRealization, rollupSpendCoverage } from '../src/value/realization.ts';
import { projectName } from '../src/git/correlate.ts';
import { money } from '../src/economics/money.ts';

const CLI = join(import.meta.dirname, '..', 'src', 'cli.ts');
const DAY = 24 * 60 * 60 * 1000;
const HOUR = 60 * 60 * 1000;
const NOW = Date.now();
/** Older than the 14-day maturity window, so the unit is mature and pushable. */
const COMMIT_MS = NOW - 60 * DAY;

function runCli(args: string[], home: string, db: string): Promise<{ code: number; stdout: string }> {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [CLI, ...args],
      { env: { ...process.env, FISCUS_HOME: home, FISCUS_DB: db, NODE_OPTIONS: '' } },
      (err, stdout, stderr) => {
        const code = err && typeof (err as NodeJS.ErrnoException & { code?: unknown }).code === 'number'
          ? (err as unknown as { code: number }).code
          : err ? 1 : 0;
        resolve({ code, stdout: String(stdout) + String(stderr) });
      },
    );
  });
}

function makeRepo(): string {
  const repo = mkdtempSync(join(tmpdir(), 'fiscus-team-repo-'));
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

function request(project: string): RequestRow {
  return {
    requestId: 'r1', sessionId: null, tsEpochMs: COMMIT_MS - HOUR, provider: 'openai', model: 'gpt-5',
    project, taskWeight: 1, inputTokens: 10, outputTokens: 10, cacheWriteTokens: 0, cacheReadTokens: 0,
    reasoningTokens: 0, costUsd: 6, estimated: false, streamed: false, statusCode: 200, durationMs: 1,
    // Exact Money beside the float, as real proxy traffic carries it. Without
    // it the v2 mint guard refuses the body outright -- `costUsd: 6` against an
    // exact attribution of nothing -- which is the guard working, and was the
    // first fixture's bug rather than a finding.
    economicAmount: money('6.00', 'USD', 'list'),
  };
}

interface Fixture { home: string; db: string; repo: string; project: string }

async function seed(prune: boolean): Promise<Fixture> {
  const home = mkdtempSync(join(tmpdir(), 'fiscus-team-home-'));
  const db = join(home, 'fiscus.db');
  const repo = makeRepo();
  const store = new Store(db);
  try {
    const project = await projectName(repo);
    store.insertRequest(request(project));
    // Persist once against the intact ledger, exactly as `fiscus realize` does.
    await computeRealization(store, repo, { limit: 5, persist: true });
    if (prune) {
      assert.equal(store.prune(NOW - 30 * DAY), 1, 'retention deletes the spend, not the unit');
      // The re-derivation every later `realize` performs. THIS is what bakes the
      // understated cost into the snapshot the rollup reads.
      await computeRealization(store, repo, { limit: 5, persist: true });
    }
    return { home, db, repo, project };
  } finally {
    store.close();
  }
}

function cleanup(f: Fixture): void {
  rmSync(f.repo, { recursive: true, force: true });
  rmSync(f.home, { recursive: true, force: true });
}

async function dryRunBody(f: Fixture): Promise<{ coverage?: string; projects: Array<{ units: number; costUsd: number }> }> {
  const { code, stdout } = await runCli(['team', 'push', '--dry-run', '--json'], f.home, f.db);
  assert.equal(code, 0, `team push --dry-run must succeed. Output: ${stdout}`);
  const signed = JSON.parse(stdout) as { body: { coverage?: string; projects: Array<{ units: number; costUsd: number }> } };
  return signed.body;
}

test('a rollup over spend retention deleted is not signed as complete', async () => {
  const f = await seed(true);
  try {
    const body = await dryRunBody(f);
    assert.equal(body.projects.length, 1, 'the unit survives the prune -- it comes from git history');
    assert.equal(body.projects[0]!.units, 1);
    // The number the receiver would sum. It is honestly the surviving spend, and
    // that is precisely why the body has to say the window is not complete.
    assert.equal(body.projects[0]!.costUsd, 0, 'and its attributed cost is now zero, having been $6.00');
    assert.notEqual(
      body.coverage,
      'complete',
      'a signed artifact must not declare complete coverage over a window whose rows it deleted',
    );
    assert.equal(body.coverage, 'partial', 'the signer knows some of this window is missing, which is more than "unknown"');
  } finally {
    cleanup(f);
  }
});

test('an intact ledger still signs as complete', async () => {
  // The silence that keeps the disclosure worth reading. If every rollup said
  // "partial", a receiver would learn nothing from the ones that mean it.
  const f = await seed(false);
  try {
    const body = await dryRunBody(f);
    assert.equal(body.projects.length, 1);
    assert.equal(body.projects[0]!.costUsd, 6, 'the baseline: this unit cost $6.00 and the ledger still says so');
    assert.equal(body.coverage, 'complete');
  } finally {
    cleanup(f);
  }
});

test('truncated outranks unknown, and unknown outranks complete', () => {
  // The mapping onto RollupCoverage, held directly because the third state
  // cannot be reached through the CLI: a snapshot with NO coverage recorded is
  // one persisted before D-176, which this checkout can no longer produce.
  //
  // "Some of this is missing" is a stronger statement than "I cannot tell", so
  // a body carrying both says `partial`. A body that merely cannot tell must
  // never round up to `complete`.
  assert.equal(rollupSpendCoverage([{ spendWindowTruncatedUnits: 0, spendWindowUnknownUnits: 0 }]), 'complete');
  assert.equal(rollupSpendCoverage([{ spendWindowTruncatedUnits: 1, spendWindowUnknownUnits: 0 }]), 'partial');
  assert.equal(rollupSpendCoverage([{ spendWindowTruncatedUnits: 0, spendWindowUnknownUnits: 1 }]), 'unknown');
  assert.equal(rollupSpendCoverage([{ spendWindowTruncatedUnits: 1, spendWindowUnknownUnits: 3 }]), 'partial');
  // Across projects, not only within one: a clean project cannot launder a
  // truncated one, which is the whole reason a rollup total needs the flag.
  assert.equal(
    rollupSpendCoverage([
      { spendWindowTruncatedUnits: 0, spendWindowUnknownUnits: 0 },
      { spendWindowTruncatedUnits: 2, spendWindowUnknownUnits: 0 },
    ]),
    'partial',
  );
  // An absent count is a report that predates the counts, which is unknown --
  // never zero. Reading `undefined` as "none affected" is the inference this
  // entire line of work exists to refuse.
  assert.equal(rollupSpendCoverage([{}]), 'unknown');
  // And an empty push has nothing to qualify. `fiscus team push` refuses to
  // mint an empty body before this is ever consulted; `complete` here is the
  // vacuous truth, not a claim.
  assert.equal(rollupSpendCoverage([]), 'complete');
});
