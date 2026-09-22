/**
 * A survival scan that runs out of time must say so, not report churn.
 *
 * `computeRealization` measures how many of a commit's added lines are still
 * attributed to it at HEAD, which costs one `git blame --line-porcelain HEAD`
 * per touched file per commit, serialized. Measured on this repository at
 * `limit: 40`: **20.3 seconds for a single commit**, and 416 seconds end to end
 * through `/api/value` — a dashboard route with no timeout of its own, so a
 * hang rather than a slow answer. `test/dashboard-contract.test.ts` eventually
 * failed on it with a fetch headers timeout at 576s.
 *
 * BOUNDING IT INTRODUCES A WORSE HAZARD THAN THE DELAY, AND THAT IS WHAT THESE
 * TESTS ARE FOR. A commit whose blame never ran has NOT been shown to have zero
 * surviving lines. If the scan simply stopped and the arithmetic carried on, the
 * unmeasured commits would each contribute a 0% survival ratio, the `survived`
 * gate would refute them, and the report would state a churn figure that no
 * evidence supports — worse on a slower machine, and silently. The whole point
 * of a budget here is that what it skips becomes UNKNOWN.
 *
 * The budget is reachable from a test because zero means "already exhausted"
 * rather than "unbounded"; a fixture repository fast enough to be a test is by
 * construction never slow enough to exhaust a real budget by waiting.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store/db.ts';
import { computeRealization } from '../src/value/realization.ts';
import type { Gate, GateResult } from '../src/value/gates.ts';

function git(cwd: string, args: string[]): void {
  execFileSync('git', args, { cwd, stdio: 'ignore' });
}

/** A one-commit repository whose single added line demonstrably survives. */
function fixture(): string {
  const repo = mkdtempSync(join(tmpdir(), 'fiscus-scan-budget-'));
  git(repo, ['init', '-q']);
  git(repo, ['config', 'user.email', 'test@example.invalid']);
  git(repo, ['config', 'user.name', 'Fiscus test']);
  writeFileSync(join(repo, 'app.ts'), 'export const answer = 42;\n');
  git(repo, ['add', '.']);
  git(repo, ['commit', '-qm', 'feat: one durable line']);
  return repo;
}

function gateOf(results: readonly GateResult[], gate: Gate): GateResult {
  const found = results.find((candidate) => candidate.gate === gate);
  assert.ok(found, `the ${gate} gate is missing from the funnel`);
  return found;
}

test('an unbounded scan measures survival, so the bounded case below is a real difference', async () => {
  // The control. Without it, a budget test passes just as well against a
  // function that never measures anything.
  const repo = fixture();
  const store = new Store(':memory:');
  try {
    const report = await computeRealization(store, repo, {
      limit: 10,
      windowDays: 0,
      gitScanBudgetMs: Infinity,
    });
    assert.equal(report.units.length, 1);
    assert.equal(report.survivalUnmeasuredUnits, 0, 'an unbounded scan leaves nothing unmeasured');

    const survived = gateOf(report.units[0]!.funnel.results, 'survived');
    assert.equal(survived.verdict, 'pass', 'the single added line is still at HEAD');
    assert.match(survived.detail, /100% of lines survive/);
  } finally {
    store.close();
    rmSync(repo, { recursive: true, force: true });
  }
});

test('a scan that runs out of budget reports unknown survival, never churn', async () => {
  // THE ASSERTION THE BUDGET EXISTS FOR. `refuted` here would mean the report
  // had converted "we did not look" into "these lines were rewritten" — a
  // quality verdict against a commit, produced by a slow machine.
  const repo = fixture();
  const store = new Store(':memory:');
  try {
    const report = await computeRealization(store, repo, {
      limit: 10,
      windowDays: 0,
      gitScanBudgetMs: 0,
    });
    assert.equal(report.units.length, 1, 'the unit still exists; only its git evidence is missing');
    assert.equal(report.survivalUnmeasuredUnits, 1, 'the report states how many units it could not measure');

    const survived = gateOf(report.units[0]!.funnel.results, 'survived');
    assert.equal(survived.verdict, 'unknown', 'unmeasured is unknown');
    assert.notEqual(survived.verdict, 'fail', 'an unmeasured commit must never be reported as churned');
    assert.match(survived.detail, /budget/, 'and the reason must name the budget, not the code');

    // `committed` stays supported: the commit is in the history the attribution
    // already read, and that evidence predates any of the skipped git calls.
    // Only its line and file counts came from them.
    const committed = gateOf(report.units[0]!.funnel.results, 'committed');
    assert.equal(committed.verdict, 'pass', 'the commit exists whether or not its diff was read');
    assert.match(committed.detail, /unmeasured/, 'and says which part of its detail is missing');

    // The unit cannot realize on evidence that was never gathered.
    assert.equal(report.units[0]!.funnel.realized, false);
  } finally {
    store.close();
    rmSync(repo, { recursive: true, force: true });
  }
});

test('the proposal comparison is withheld rather than answered from an empty file list', async () => {
  // Past the budget there are no committed paths to match a proposal against.
  // Matching against an empty list would find nothing and read as "the AI
  // proposed work that was not taken" — an acceptance verdict manufactured from
  // a skipped `git show`.
  const repo = fixture();
  const store = new Store(':memory:');
  try {
    const report = await computeRealization(store, repo, {
      limit: 10,
      windowDays: 0,
      gitScanBudgetMs: 0,
    });
    const results = report.units[0]!.funnel.results;
    assert.equal(gateOf(results, 'proposed').verdict, 'unknown');
    assert.equal(gateOf(results, 'accepted').verdict, 'unknown');
    assert.equal(report.units[0]!.acceptance, null, 'no acceptance figure may be produced from an unread diff');
  } finally {
    store.close();
    rmSync(repo, { recursive: true, force: true });
  }
});
