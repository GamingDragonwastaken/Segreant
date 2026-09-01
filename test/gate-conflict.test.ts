/**
 * Conflict survives the gate ladder (AII-003, WP-B03).
 *
 * `signalVerdict` used to return on the first `fail`, so a gate fed by a
 * passing CI run AND a failing one reported plain `fail`. That is a defensible
 * decision recorded as though it were an observation: two sources disagreeing
 * is not the same evidential situation as one source failing, and the
 * difference was being discarded at the gate that decides whether work
 * realized.
 *
 * These tests pin the four properties that make the fix real rather than
 * cosmetic: conflict is detected, conflict never becomes `pass`, conflict is
 * surfaced rather than only resolved, and the kernel refuses to issue on it for
 * its own stated reason.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store/db.ts';
import { computeRealization, realizationFromStore } from '../src/value/realization.ts';
import { projectName, resolveCommit } from '../src/git/correlate.ts';
import {
  GATE_LADDER,
  aggregatePolarity,
  gateResultFromVerdict,
  polarityFromVerdict,
  scoreFunnel,
  verdictFromPolarity,
  type Gate,
  type GateResult,
} from '../src/value/gates.ts';
import { EPISTEMIC_STATES, type EpistemicState } from '../src/epistemic/state.ts';

function git(cwd: string, args: string[]): void {
  execFileSync('git', args, { cwd, stdio: 'ignore' });
}

function ladder(overrides: Partial<Record<Gate, GateResult>> = {}): Record<Gate, GateResult> {
  const out = {} as Record<Gate, GateResult>;
  for (const gate of GATE_LADDER) out[gate] = gateResultFromVerdict(gate, 'pass', '');
  return { ...out, ...overrides };
}

function gateAt(gate: Gate, polarity: EpistemicState): GateResult {
  return { gate, polarity, verdict: verdictFromPolarity(polarity), detail: '' };
}

test('two sources that disagree produce conflicted, not "the bad one wins"', () => {
  assert.equal(aggregatePolarity([true, false]), 'conflicted');
  assert.equal(aggregatePolarity([false, true]), 'conflicted');
  assert.equal(aggregatePolarity([false, false]), 'refuted');
  assert.equal(aggregatePolarity([true, true]), 'supported');
  // Nothing observed is unknown, never a negative.
  assert.equal(aggregatePolarity([]), 'unknown');
});

test('the projection is total, and conflicted is never pass', () => {
  // Total over the kernel's four states, so a new state cannot silently fall
  // through to a default.
  for (const state of EPISTEMIC_STATES) {
    const verdict = verdictFromPolarity(state);
    assert.ok(['pass', 'fail', 'unknown'].includes(verdict), `${state} projected to ${verdict}`);
  }
  assert.equal(verdictFromPolarity('supported'), 'pass');
  assert.equal(verdictFromPolarity('refuted'), 'fail');
  assert.equal(verdictFromPolarity('unknown'), 'unknown');

  // The load-bearing line. Not `pass`, because a contradiction is not a
  // demonstration; and not `unknown`, because that would launder an observed
  // failure into an absence of evidence.
  assert.equal(verdictFromPolarity('conflicted'), 'fail');
  assert.notEqual(verdictFromPolarity('conflicted'), 'pass');
});

test('a conflicted gate is surfaced, not merely resolved into a verdict', () => {
  const outcome = scoreFunnel(ladder({ tested: gateAt('tested', 'conflicted') }));

  assert.deepEqual(outcome.conflicts, ['tested'], 'the disagreement must be readable without reconstructing it');
  assert.equal(outcome.realized, false, 'terminal realization cannot be reached through a contradiction');
  assert.equal(outcome.results[3]!.verdict, 'fail', 'the legacy projection still answers');
  assert.equal(outcome.results[3]!.polarity, 'conflicted', 'and the truth is still there beside it');
});

test('a fully passing ladder has no conflicts and still realizes', () => {
  // Non-vacuity: the conflict check must not be refusing everything.
  const outcome = scoreFunnel(ladder());
  assert.deepEqual(outcome.conflicts, []);
  assert.equal(outcome.realized, true);
});

test('terminal realization is refused by the conflict condition itself, not only by the projection', () => {
  // If someone later changed `conflicted` to project to `unknown`, `realized`
  // must still be false. This asserts the independence of the two conditions
  // rather than trusting their current agreement.
  const verdicts = ladder({ merged: gateAt('merged', 'conflicted') });
  const forced = { ...verdicts, merged: { ...verdicts.merged, verdict: 'pass' as const } };
  const outcome = scoreFunnel(forced);
  assert.equal(outcome.realized, false, 'a conflicted gate must block realization even if its verdict says pass');
  assert.deepEqual(outcome.conflicts, ['merged']);
});

test('a legacy three-valued row cannot be read back as a conflict', () => {
  // The stored form has no way to express disagreement. Reading `fail` back as
  // `refuted` is the only honest option; inventing `conflicted` from it — or
  // the reverse — would be exactly the inference the four-valued state refuses.
  assert.equal(polarityFromVerdict('pass'), 'supported');
  assert.equal(polarityFromVerdict('fail'), 'refuted');
  assert.equal(polarityFromVerdict('unknown'), 'unknown');
  for (const verdict of ['pass', 'fail', 'unknown'] as const) {
    assert.notEqual(polarityFromVerdict(verdict), 'conflicted');
  }
});

// ---------------------------------------------------------------------------
// End to end: two real CI signals disagreeing about one commit.
// ---------------------------------------------------------------------------

test('two recorded CI runs that disagree leave the tested gate conflicted, not failed', async () => {
  const repo = mkdtempSync(join(tmpdir(), 'fiscus-gate-conflict-'));
  const store = new Store(':memory:');
  try {
    git(repo, ['init', '-q']);
    git(repo, ['config', 'user.email', 'test@example.invalid']);
    git(repo, ['config', 'user.name', 'Fiscus test']);
    writeFileSync(join(repo, 'app.ts'), 'export const answer = 42;\n');
    git(repo, ['add', '.']);
    git(repo, ['commit', '-qm', 'feat: a real commit']);

    const hash = (await resolveCommit(repo, 'HEAD'))!;
    const project = await projectName(repo);
    const now = Date.now();

    // The situation the old aggregator erased: one run said the suite passed,
    // a later one said it failed. Both are real observations of the same
    // proposition about the same commit.
    store.insertSignal({
      signalId: 'ci-run-green', kind: 'tested', commitHash: hash, project,
      tsEpochMs: now, verdict: 'pass', detail: null, evidenceSource: 'manual',
    });
    store.insertSignal({
      signalId: 'ci-run-red', kind: 'tested', commitHash: hash, project,
      tsEpochMs: now + 1000, verdict: 'fail', detail: null, evidenceSource: 'manual',
    });

    const report = await computeRealization(store, repo, { limit: 10, windowDays: 365 });
    const unit = report.units.find((candidate) => candidate.hash === hash)!;
    assert.ok(unit, 'the committed work unit is present');

    const tested = unit.funnel.results.find((gate) => gate.gate === 'tested')!;
    assert.equal(tested.polarity, 'conflicted', 'both directions were observed');
    assert.equal(tested.verdict, 'fail', 'the legacy projection stays conservative');
    assert.ok(unit.funnel.conflicts.includes('tested'), 'and the disagreement is listed, not only projected');
    assert.equal(unit.funnel.realized, false);
  } finally {
    store.close();
    rmSync(repo, { recursive: true, force: true });
  }
});

test('two recorded runs that agree are not a conflict', async () => {
  // Non-vacuity for the case above: the aggregator must not call every
  // multi-signal gate conflicted.
  const repo = mkdtempSync(join(tmpdir(), 'fiscus-gate-agree-'));
  const store = new Store(':memory:');
  try {
    git(repo, ['init', '-q']);
    git(repo, ['config', 'user.email', 'test@example.invalid']);
    git(repo, ['config', 'user.name', 'Fiscus test']);
    writeFileSync(join(repo, 'app.ts'), 'export const answer = 42;\n');
    git(repo, ['add', '.']);
    git(repo, ['commit', '-qm', 'feat: a real commit']);

    const hash = (await resolveCommit(repo, 'HEAD'))!;
    const project = await projectName(repo);
    const now = Date.now();
    store.insertSignal({
      signalId: 'ci-run-a', kind: 'tested', commitHash: hash, project,
      tsEpochMs: now, verdict: 'pass', detail: null, evidenceSource: 'manual',
    });
    store.insertSignal({
      signalId: 'ci-run-b', kind: 'tested', commitHash: hash, project,
      tsEpochMs: now + 1000, verdict: 'pass', detail: null, evidenceSource: 'manual',
    });

    const report = await computeRealization(store, repo, { limit: 10, windowDays: 365 });
    const unit = report.units.find((candidate) => candidate.hash === hash)!;
    const tested = unit.funnel.results.find((gate) => gate.gate === 'tested')!;
    assert.equal(tested.polarity, 'supported');
    assert.equal(tested.verdict, 'pass');
    assert.deepEqual(unit.funnel.conflicts, []);
  } finally {
    store.close();
    rmSync(repo, { recursive: true, force: true });
  }
});

test('a snapshot persisted before four-valued gates still rehydrates', () => {
  // The fields are required, and a legacy row has neither. `conflicts` being
  // undefined threw on `.length` in the waste rollup and in the CLI status line
  // the moment anything read one — a crash introduced by the type, not by the
  // data. Reproduced before the normalization was added.
  const store = new Store(':memory:');
  try {
    const legacy = {
      hash: 'a'.repeat(40), subject: 'legacy unit', tsEpochMs: 1, ageDays: 30, maturing: false,
      survivalRatio: 1, reverted: false, hadProposal: true, acceptance: 0.9, taskType: 'feature',
      dominantModel: null, dominantModelCostUsd: null, attributedCostUsd: 1,
      linesAdded: 1, linesDeleted: 0, filesChanged: 1,
      funnel: {
        // The full ladder as it was stored: no `polarity` on any gate, no
        // `conflicts` on the funnel.
        results: GATE_LADDER.map((gate) => ({ gate, verdict: 'pass', detail: '' })),
        reachedIndex: GATE_LADDER.length - 1, reached: 'clean', diedAt: null, diedAtIndex: null,
        realized: true, passes: GATE_LADDER.length, fails: 0, unknowns: 0,
        instrumented: GATE_LADDER.length, realizationScore: 1,
      },
    };
    (store as unknown as { db: { prepare(q: string): { run(...args: unknown[]): void } } }).db
      .prepare('INSERT INTO realization_units (commit_hash, project, ts_epoch_ms, computed_at_ms, unit_json, cost_scope, cost_stale) VALUES (?,?,?,?,?,?,0)')
      .run('a'.repeat(40), 'legacy-project', 1, 2, JSON.stringify(legacy), 'project');

    const report = realizationFromStore(store, { project: 'legacy-project' });
    const unit = report.units[0]!;

    assert.equal(unit.funnel.results[0]!.polarity, 'supported', 'a stored pass reads as supported');
    assert.deepEqual(unit.funnel.conflicts, [], 'and a three-valued row can report no conflict');
    // Not an assertion that none occurred — only the one thing this row can say.
    assert.ok(report.matured, 'the rollup completes rather than throwing');
  } finally {
    store.close();
  }
});
