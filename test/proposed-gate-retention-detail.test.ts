/**
 * The gate ladder said "no complete proposal captured" about a proposal it deleted.
 *
 * D-179 removed that false cause from the Acceptance lens note. It survives one
 * layer further in, on the `proposed` gate itself — the first rung of the
 * realization funnel, and the thing an operator reads when asking why a unit did
 * not realize.
 *
 * THE COUNTEREXAMPLE, MEASURED. The same fixture as D-179: a backdated commit
 * and a captured proposal an hour before it whose added lines are what shipped.
 * Before: `polarity=supported verdict=pass detail="AI proposal captured"`.
 * After `pruneProposals`: `polarity=unknown verdict=unknown detail="no complete
 * proposal captured"`.
 *
 * **The polarity is right and the sentence is wrong, which is why this one is
 * easy to miss.** The gate does not overclaim — it goes to `unknown`, exactly as
 * it should, because the evidence is gone. Only the human-readable detail states
 * a cause, and it states the one cause that is false here. A reader who trusts
 * the ladder concludes their capture is not working and goes to fix
 * instrumentation that was already working.
 *
 * WHY THIS BRANCH AND NOT A NEW GATE STATE. The chain already distinguishes two
 * non-plain causes — a capture that was truncated upstream, and a capture that
 * predates coverage tracking — and both are more specific claims about the
 * CAPTURE than retention is. Retention is a third cause of the same silence and
 * belongs after them in the same chain, so a window whose capture was genuinely
 * truncated keeps saying so. That ordering is held by a test below rather than
 * by the order of the ternaries alone.
 *
 * WHAT THIS DOES NOT ESTABLISH. That every proposal-derived surface is swept.
 * `proposalCoverage` on the realization report is a ratio whose numerator a
 * prune empties while its denominator, coming from git, survives — the D-176
 * divisor shape one stream over — and it is deliberately NOT fixed here, because
 * it is rendered by no view and no CLI surface: it is on the wire and declared,
 * and that is all. The `judge` payload's `proposalCaptureCoverage` reports
 * `'unknown'` for a session whose proposals are gone, which is the correct
 * sentinel and not a false claim, so it is left alone — checked, not assumed.
 * `contributionEvidence` becomes `undefined` for a window whose proposals were
 * deleted, which is also latent, and by the strictest measure: it has no
 * consumer anywhere in the repository, not even a payload declaration.
 *
 * Recorded at D-180.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.FISCUS_HOME = mkdtempSync(join(tmpdir(), 'fiscus-gate-retention-'));

import { Store, type RequestRow, type ProposalRow } from '../src/store/db.ts';
import { computeRealization } from '../src/value/realization.ts';
import { projectName } from '../src/git/correlate.ts';

const DAY = 24 * 60 * 60 * 1000;
const HOUR = 60 * 60 * 1000;
const NOW = Date.now();
const COMMIT_MS = NOW - 60 * DAY;
const LINES = ['export function add(a: number, b: number): number {', '  return a + b;', '}'];
const PLAIN = 'no complete proposal captured';

function makeRepo(): string {
  const repo = mkdtempSync(join(tmpdir(), 'fiscus-gate-repo-'));
  const git = (args: string[], env?: NodeJS.ProcessEnv) =>
    execFileSync('git', args, { cwd: repo, stdio: 'pipe', env: env ?? process.env });
  git(['init', '-q']);
  git(['config', 'user.email', 'test@example.invalid']);
  git(['config', 'user.name', 'Fiscus test']);
  writeFileSync(join(repo, 'app.ts'), LINES.join('\n') + '\n');
  git(['add', '.']);
  const when = new Date(COMMIT_MS).toISOString();
  git(['commit', '-qm', 'feat: add', '--date', when], { ...process.env, GIT_COMMITTER_DATE: when });
  return repo;
}

function request(project: string): RequestRow {
  return {
    requestId: 'r1', sessionId: null, tsEpochMs: COMMIT_MS - HOUR, provider: 'openai', model: 'gpt-5',
    project, taskWeight: 1, inputTokens: 10, outputTokens: 10, cacheWriteTokens: 0, cacheReadTokens: 0,
    reasoningTokens: 0, costUsd: 6, estimated: false, streamed: false, statusCode: 200, durationMs: 1,
  };
}

function proposal(project: string, overrides: Partial<ProposalRow> = {}): ProposalRow {
  return {
    proposalId: 'p1', requestId: 'r1', sessionId: null, tsEpochMs: COMMIT_MS - HOUR,
    provider: 'openai', model: 'gpt-5', project,
    files: [{ path: 'app.ts', addedLines: LINES }], captureCoverage: 'complete',
    ...overrides,
  };
}

async function proposedGate(store: Store, repo: string): Promise<{ verdict: string; polarity: string; detail: string }> {
  const rep = await computeRealization(store, repo, { limit: 5, windowDays: 365 });
  const unit = rep.units[0];
  assert.ok(unit, 'the commit must produce a work unit for this test to mean anything');
  const gate = unit.funnel.results.find((r) => r.gate === 'proposed');
  assert.ok(gate, 'the ladder must always carry its first rung');
  return { verdict: gate.verdict, polarity: gate.polarity, detail: gate.detail };
}

test('a deleted proposal is named as deleted, not reported as never captured', async () => {
  const repo = makeRepo();
  const store = new Store(':memory:');
  try {
    const project = await projectName(repo);
    store.insertRequest(request(project));
    store.insertProposal(proposal(project));

    const before = await proposedGate(store, repo);
    assert.equal(before.verdict, 'pass', 'the baseline: this proposal is exactly what shipped');
    assert.equal(before.detail, 'AI proposal captured');

    assert.equal(store.pruneProposals(NOW - 30 * DAY), 1);

    const after = await proposedGate(store, repo);
    // The gate itself was already honest and must stay that way: this packet
    // changes what the ladder SAYS, never what it concludes.
    assert.equal(after.polarity, 'unknown', 'the evidence is gone, so the rung is unknown -- unchanged');
    assert.equal(after.verdict, 'unknown');
    assert.ok(
      after.detail !== PLAIN,
      'a proposal WAS captured here and Fiscus deleted it; "no complete proposal captured" sends the reader to fix working instrumentation',
    );
    assert.ok(
      /delet|retention|prun/i.test(after.detail),
      `the detail must name the deletion as the reason the rung went dark. Got: ${after.detail}`,
    );
  } finally {
    store.close();
    rmSync(repo, { recursive: true, force: true });
  }
});

test('a genuinely truncated capture keeps saying so, because that is the more specific cause', async () => {
  // Ordering guard, and the two causes really can be live at once -- which took
  // a corrected fixture to establish. A boundary OUTSIDE the window deletes
  // every proposal in it, so the truncated capture disappears with the rest and
  // there is nothing left to order. The overlap needs a boundary INSIDE the
  // window: rows before it go, rows after it survive, and the window still
  // starts before the boundary, so `truncated by retention` and `capture
  // truncated` are both true of the same unit.
  //
  // An upstream capture that was cut short is a claim about the CAPTURE;
  // retention is a claim about the ledger. If the retention branch ran first it
  // would overwrite the sharper answer with the vaguer one.
  const repo = makeRepo();
  const store = new Store(':memory:');
  try {
    const project = await projectName(repo);
    store.insertRequest(request(project));
    // Inside the 8h window and AFTER the boundary below, so it survives.
    // A truncated capture retains no file contents, by the store's own rule.
    store.insertProposal(proposal(project, {
      tsEpochMs: COMMIT_MS - 10 * 60 * 1000,
      files: [],
      captureCoverage: 'truncated',
    }));
    const boundary = COMMIT_MS - 30 * 60 * 1000;
    store.pruneProposals(boundary);

    const got = await proposedGate(store, repo);
    assert.equal(got.detail, 'proposal capture truncated; coverage incomplete');
  } finally {
    store.close();
    rmSync(repo, { recursive: true, force: true });
  }
});

test('a prune whose boundary is before the window leaves the plain detail standing', async () => {
  const repo = makeRepo();
  const store = new Store(':memory:');
  try {
    const project = await projectName(repo);
    store.insertRequest(request(project));
    assert.equal(store.pruneProposals(COMMIT_MS - 30 * DAY), 0);

    const got = await proposedGate(store, repo);
    assert.equal(got.detail, PLAIN, 'this window really was intact and really had nothing in it');
  } finally {
    store.close();
    rmSync(repo, { recursive: true, force: true });
  }
});

test('with no prune on record the plain detail stands rather than hedging', async () => {
  // The silence that keeps the disclosure worth reading. Marking every rung on
  // every ledger "possibly deleted" would make the ladder unreadable.
  const repo = makeRepo();
  const store = new Store(':memory:');
  try {
    const project = await projectName(repo);
    store.insertRequest(request(project));

    const got = await proposedGate(store, repo);
    assert.equal(got.detail, PLAIN);
  } finally {
    store.close();
    rmSync(repo, { recursive: true, force: true });
  }
});
