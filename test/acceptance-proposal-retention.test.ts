/**
 * Fiscus told an operator their proposals were never captured, after deleting them.
 *
 * THE COUNTEREXAMPLE, MEASURED. A repository with one commit, and a captured
 * proposal one hour before it whose added lines are what shipped. The report
 * read `firstPassAcceptance: 1` and the Acceptance lens was instrumented, so no
 * note was printed. `fiscus prune` then deleted the PROPOSAL rows on the
 * operator's own (much shorter) proposal-retention policy, and the same call
 * over the same repository reported `firstPassAcceptance: null` and printed:
 *
 *     Acceptance uninstrumented: no proposals captured (e.g. streaming-only).
 *
 * Both halves of that sentence are false. Proposals WERE captured — Fiscus
 * captured them — and the suggested cause is not the cause. The operator is
 * told to go and instrument something they had already instrumented, which is
 * the D-174 failure ("tag sessions with X-Fiscus-Session-Id" printed to an
 * operator who had tagged them) reached through a second stream.
 *
 * THE STORE ALREADY KNEW. `retentionFloor()` has returned
 * `proposalsPrunedBeforeMs`, `proposalsRowsRemoved` and `proposalsPrunes` since
 * the retention record was built. Before this packet the only reader of any of
 * the three in the entire repository was one assertion in
 * `retention-truncation-disclosure.test.ts`. **The proposal half of the
 * retention record was built and never wired** — the second recurring class of
 * this program, sitting directly underneath an instance of the first.
 *
 * AND THE MOST TOTAL DELETION RECORDED NOTHING AT ALL. `clearProposals()` is a
 * dashboard privacy control ("delete every stored proposal immediately") and it
 * wrote no row to `retention_prunes`, so the deletion it performs was invisible
 * to every consumer of the retention floor. A privacy control that erases the
 * evidence AND the record that evidence was erased makes the emptiness it
 * creates indistinguishable from an emptiness that was always there.
 *
 * THREE STATES, AND WHY ONLY TWO NOTES (D-170, D-176). A proposal prune whose
 * boundary covers the analysed window is a known deletion and says so. A prune
 * whose boundary lies before every window start left this window intact, and the
 * plain note is sound. NO prune on record is unknown — and, exactly as D-176
 * settled for the spend window, `truncated` stays false there rather than
 * hedging every clean ledger into noise, with the boundary carried separately
 * for a caller that wants the third state. A caveat printed always is a caveat
 * nobody reads.
 *
 * THE SAME SENTENCE WAS WRONG IN A SECOND PLACE, AND SEARCHING FOR THAT IS THE
 * POINT. `computeUsageRoI` filters its population to sessions with NO captured
 * proposals and then printed the same note on every run — an instruction the
 * reader cannot act on, because capturing proposals cannot move a report that
 * excludes proposal-bearing sessions by construction. Both callers are fixed
 * here; the last two tests below hold that one.
 *
 * WHAT THIS DOES NOT ESTABLISH. That the Acceptance lens is otherwise sound —
 * edit-distance acceptance carries its own conditions and none is closed here.
 * Nor that the third caller is covered: `computeFrontier` also builds an RoI,
 * but discards its notes entirely (it reads only `roiIndex` and the Impact lens
 * value), so there is no claim there to be wrong — checked, not assumed. Nor
 * anything about proposals that were never captured in the first place.
 *
 * Recorded at D-179.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.FISCUS_HOME = mkdtempSync(join(tmpdir(), 'fiscus-prop-retention-'));

import { Store, type RequestRow, type ProposalRow } from '../src/store/db.ts';
import { valueSpine } from '../src/value/report.ts';
import { projectName } from '../src/git/correlate.ts';
import { DEFAULT_CONFIG } from '../src/config.ts';

const DAY = 24 * 60 * 60 * 1000;
const HOUR = 60 * 60 * 1000;
const NOW = Date.now();
/** Old enough that a thirty-day boundary sits after its whole 8h window. */
const COMMIT_MS = NOW - 60 * DAY;
const LINES = ['export function add(a: number, b: number): number {', '  return a + b;', '}'];
const PLAIN = 'Acceptance uninstrumented: no proposals captured (e.g. streaming-only).';

function makeRepo(): string {
  const repo = mkdtempSync(join(tmpdir(), 'fiscus-prop-repo-'));
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

function proposal(project: string): ProposalRow {
  return {
    proposalId: 'p1', requestId: 'r1', sessionId: null, tsEpochMs: COMMIT_MS - HOUR,
    provider: 'openai', model: 'gpt-5', project,
    files: [{ path: 'app.ts', addedLines: LINES }], captureCoverage: 'complete',
  };
}

async function acceptanceNote(store: Store, repo: string): Promise<{ note: string | undefined; fpa: number | null }> {
  const spine = await valueSpine(store, structuredClone(DEFAULT_CONFIG), { repo, limit: 5, windowDays: 365 });
  assert.ok(spine, 'the repository must produce a spine for this test to mean anything');
  return {
    note: spine.roi.notes.find((n) => n.startsWith('Acceptance uninstrumented')),
    fpa: spine.loaded.report.firstPassAcceptance,
  };
}

test('a proposal prune inside the window is named, not reported as "no proposals captured"', async () => {
  const repo = makeRepo();
  const store = new Store(':memory:');
  try {
    const project = await projectName(repo);
    store.insertRequest(request(project));
    store.insertProposal(proposal(project));

    const before = await acceptanceNote(store, repo);
    assert.equal(before.fpa, 1, 'the baseline: this proposal is exactly what shipped');
    assert.equal(before.note, undefined, 'so the Acceptance lens is instrumented and says nothing');

    assert.equal(store.pruneProposals(NOW - 30 * DAY), 1, 'retention deletes the proposal, not the commit');

    const after = await acceptanceNote(store, repo);
    assert.equal(after.fpa, null, 'acceptance really is unmeasurable now -- that part is honest');
    assert.ok(after.note, 'and the lens must still disclose that it is uninstrumented');
    assert.ok(
      !after.note.includes('no proposals captured'),
      `proposals WERE captured and Fiscus deleted them; saying otherwise sends the operator to instrument what they already instrumented. Got: ${after.note}`,
    );
    assert.ok(
      /delet|retention|prun/i.test(after.note),
      `the note must name the deletion as the reason the lens went dark. Got: ${after.note}`,
    );
  } finally {
    store.close();
    rmSync(repo, { recursive: true, force: true });
  }
});

test('a prune whose boundary is before the window leaves the plain note standing', async () => {
  // The window really was intact, and nothing was captured in it. Marking every
  // report on a pruned ledger "deleted" would be the same collapse in reverse.
  const repo = makeRepo();
  const store = new Store(':memory:');
  try {
    const project = await projectName(repo);
    store.insertRequest(request(project));
    // No proposal at all, and a prune far older than this commit's window.
    assert.equal(store.pruneProposals(COMMIT_MS - 30 * DAY), 0);

    const got = await acceptanceNote(store, repo);
    assert.equal(got.fpa, null);
    assert.equal(got.note, PLAIN);
  } finally {
    store.close();
    rmSync(repo, { recursive: true, force: true });
  }
});

test('with no prune on record the plain note stands rather than hedging', async () => {
  const repo = makeRepo();
  const store = new Store(':memory:');
  try {
    const project = await projectName(repo);
    store.insertRequest(request(project));

    const got = await acceptanceNote(store, repo);
    assert.equal(got.fpa, null);
    assert.equal(got.note, PLAIN);
  } finally {
    store.close();
    rmSync(repo, { recursive: true, force: true });
  }
});

test('clearing every proposal is recorded, so the emptiness it creates can be told from an original one', () => {
  // The dashboard offers this as a privacy control. Before this packet it wrote
  // no row to `retention_prunes`, so the most total deletion available was the
  // one deletion no consumer could see.
  const store = new Store(':memory:');
  try {
    store.insertRequest(request('proj'));
    store.insertProposal(proposal('proj'));
    assert.equal(store.retentionFloor().proposalsPrunedBeforeMs, null, 'nothing on record yet');

    assert.equal(store.clearProposals(), 1);

    const floor = store.retentionFloor();
    assert.ok(
      floor.proposalsPrunedBeforeMs !== null,
      'a control that deletes everything must leave a boundary behind, or the deletion is invisible',
    );
    assert.ok(
      floor.proposalsPrunedBeforeMs >= COMMIT_MS,
      'and the boundary must cover what it deleted, which was everything up to now',
    );
    assert.equal(floor.proposalsRowsRemoved, 1);
    assert.equal(floor.proposalsPrunes, 1);
  } finally {
    store.close();
  }
});

test('clearing an empty proposal table records nothing, because nothing was deleted', () => {
  // The boundary this control writes is NOW, which marks every past window
  // truncated. Writing it when no row was removed would manufacture a deletion
  // claim over the whole ledger -- the exact inverse of the defect above, and
  // worse, because a refutation can be hidden but must never be invented.
  const store = new Store(':memory:');
  try {
    assert.equal(store.clearProposals(), 0);
    const floor = store.retentionFloor();
    assert.equal(floor.proposalsPrunedBeforeMs, null);
    assert.equal(floor.proposalsPrunes, 0);
  } finally {
    store.close();
  }
});

/**
 * The same sentence, one caller over, where it could never have been right.
 *
 * `computeUsageRoI` filters its population to sessions with NO captured
 * proposals -- non-code work, which has no diff to compare -- and then passed
 * `firstPassAcceptance: null` and printed, on every single run:
 *
 *     Acceptance uninstrumented: no proposals captured (e.g. streaming-only).
 *
 * `fiscus usage` prints those notes verbatim. So the report told the operator
 * to close an instrumentation gap that capturing proposals cannot close, because
 * proposal-bearing sessions are excluded from this report ON PURPOSE. **An empty
 * list that also gives an instruction the reader cannot act on is the worst form
 * of this class**, and this is the third place the same sentence asserted a
 * cause it could not see.
 */

import { computeUsageRoI } from '../src/value/usage.ts';

test('the non-code usage report says acceptance is out of scope, not uninstrumented', () => {
  const store = new Store(':memory:');
  try {
    const rep = computeUsageRoI(store, { startMs: NOW - DAY, endMs: NOW + 1000 });
    const note = rep.roi.notes.find((n) => n.startsWith('Acceptance'));
    assert.ok(note, 'the lens is dark and must say so');
    assert.ok(
      !note.includes('no proposals captured (e.g. streaming-only)'),
      `this population EXCLUDES proposal-bearing sessions, so no amount of capture can move it. Got: ${note}`,
    );
    assert.match(note, /by construction/, 'the reason given must be the real one');
  } finally {
    store.close();
  }
});

test('the coding report keeps saying uninstrumented, because there the gap is real', async () => {
  // The guard that keeps the distinction worth making. On the repository path
  // acceptance really is measurable once proposals are captured, so the note
  // must still be the actionable one.
  const repo = makeRepo();
  const store = new Store(':memory:');
  try {
    const project = await projectName(repo);
    store.insertRequest(request(project));
    const got = await acceptanceNote(store, repo);
    assert.equal(got.note, PLAIN);
  } finally {
    store.close();
    rmSync(repo, { recursive: true, force: true });
  }
});
