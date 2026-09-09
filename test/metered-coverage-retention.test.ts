/**
 * The server told the dashboard a window had complete coverage after deleting
 * rows from it.
 *
 * `meteredClaimSupport` states, server-side, what the metered spend claim's
 * evidence reaches. Its coverage axis answered one question -- how much of the
 * spend in this ledger was priced from a matched rate card rather than an
 * estimate -- and answered `complete` whenever every surviving row was matched.
 * Its own docblock said coverage "says nothing about whether the ledger sees
 * every request the organisation made, which no local evidence can establish."
 *
 * THAT SENTENCE IS TRUE OF TRAFFIC THAT NEVER REACHED FISCUS AND FALSE OF ROWS
 * FISCUS DELETED ITSELF. Since D-170 the ledger records its own retention
 * boundary, so there is exactly one case where local evidence DOES establish
 * that the ledger no longer sees requests it once saw. The axis was written
 * before that record existed, and after it the answer `complete` over a pruned
 * window is a claim the evidence contradicts rather than a narrower question
 * honestly answered.
 *
 * WHY THIS IS THE COVERAGE AXIS AND NOT A SEPARATE CAPTION. Coverage asks how
 * completely the evidence covers the claim's own scope. The claim is metered
 * spend OVER THIS WINDOW. Two different facts can make that partial -- rows
 * priced from an estimate, and rows deleted from inside the window -- and both
 * are answers to the same question. Putting the second somewhere else would
 * leave the axis asserting `complete` beside a sentence saying rows were
 * deleted, which is the collapse this project exists to refuse, pointed the
 * other way.
 *
 * THE MOVE IS DOWNWARD, WHICH IS WHAT WIRING AN HONEST RULE LOOKS LIKE. Nothing
 * here strengthens a claim: a window that reported complete coverage now
 * reports partial, and says why. The figures do not change, and neither does
 * the monetary basis -- a deletion says nothing about how surviving rows were
 * priced, and a test below holds that it does not leak into that axis.
 *
 * THREE STATES, PRESERVED (D-170). An intact window says nothing extra. A
 * ledger with NO prune on record says nothing extra either, and that is the
 * unknown state rather than "nothing was pruned". Two tests hold both silences.
 *
 * Recorded at D-175.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.FISCUS_HOME = mkdtempSync(join(tmpdir(), 'fiscus-metered-retention-'));

import { meteredClaimSupport } from '../src/dashboard/claim-support.ts';
import { buildOverview } from '../src/dashboard/routes.ts';
import { DEFAULT_CONFIG } from '../src/config.ts';
import { Store, type RequestRow, type WindowRetentionCoverage } from '../src/store/db.ts';

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.now();

const intact: WindowRetentionCoverage = { truncated: false, prunedBeforeMs: null, rowsRemoved: 0 };
const truncated: WindowRetentionCoverage = { truncated: true, prunedBeforeMs: NOW - 30 * DAY, rowsRemoved: 4 };

function request(id: string, tsEpochMs: number, costUsd: number): RequestRow {
  return {
    requestId: id, sessionId: null, tsEpochMs, provider: 'openai', model: 'gpt-5',
    project: 'p', taskWeight: 1, inputTokens: 10, outputTokens: 10, cacheWriteTokens: 0,
    cacheReadTokens: 0, reasoningTokens: 0, costUsd, estimated: false, streamed: false,
    statusCode: 200, durationMs: 1,
  };
}

test('metered coverage over a window whose rows were deleted is partial, not complete', () => {
  const whole = meteredClaimSupport({ totalCostUsd: 12, estimatedCostUsd: 0, retention: intact });
  assert.equal(whole.profile.coverage, 'complete', 'the baseline: every surviving row priced from a matched card');

  const pruned = meteredClaimSupport({ totalCostUsd: 12, estimatedCostUsd: 0, retention: truncated });
  assert.equal(pruned.profile.coverage, 'partial', 'a window that lost rows is not completely covered by its evidence');
  assert.match(String(pruned.note), /retention|deleted/i, 'and the axis must say which of the two reasons applies');
});

test('a deletion does not leak into the monetary basis', () => {
  // Coverage and basis answer different questions. Retention says nothing about
  // how the surviving rows were priced, and a fix that moved both would be
  // overreach dressed as caution.
  const pruned = meteredClaimSupport({ totalCostUsd: 12, estimatedCostUsd: 0, retention: truncated });
  assert.equal(pruned.profile.monetaryBasis, 'list', 'still priced from a matched rate card');
  assert.equal(pruned.figure, 'shown', 'and the figure is still shown -- this is a caveat, not a withholding');
});

test('an empty truncated window does not report its emptiness as the only fact', () => {
  // The pre-existing note for an unpriced window is right about pricing and
  // silent about deletion, and an operator reading it would conclude nothing
  // was spent. Both facts have to reach them.
  const empty = meteredClaimSupport({ totalCostUsd: 0, estimatedCostUsd: 0, retention: truncated });
  assert.equal(empty.profile.coverage, 'partial', 'unknown pricing over a window known to have lost rows is not unknown coverage alone');
  assert.match(String(empty.note), /retention|deleted/i);
});

test('with no prune on record nothing is asserted about deletion', () => {
  // The third state. Null is "no prune is ON RECORD", not "nothing was pruned",
  // and a disclosure printed on every window is noise that stops being read.
  const support = meteredClaimSupport({ totalCostUsd: 12, estimatedCostUsd: 0, retention: intact });
  assert.equal(support.profile.coverage, 'complete');
  assert.doesNotMatch(String(support.note ?? ''), /retention|deleted/i);
});

test('the overview payload carries the window coverage it was computed over', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fiscus-overview-retention-'));
  const store = new Store(join(dir, 'o.db'));
  try {
    const config = structuredClone(DEFAULT_CONFIG);
    store.insertRequest(request('old', NOW - 20 * DAY, 5));
    store.insertRequest(request('new', NOW - 1 * DAY, 5));

    const before = buildOverview(store, config, '30d');
    assert.equal(before.retention.truncated, false);
    assert.equal(before.retention.prunedBeforeMs, null, 'no prune on record is its own state');
    assert.equal(before.claimSupport.profile.coverage, 'complete');

    assert.equal(store.prune(NOW - 10 * DAY), 1, 'the fixture must lose a row from inside the 30-day window');

    const after = buildOverview(store, config, '30d');
    assert.equal(after.retention.truncated, true);
    assert.equal(after.retention.rowsRemoved, 1);
    assert.equal(after.claimSupport.profile.coverage, 'partial', 'the server states it rather than leaving the browser to infer it');
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a window that starts after the boundary is intact even on a pruned ledger', () => {
  // `prune` deletes rows strictly older than the boundary, so a window starting
  // at or after it lost nothing. Erring the other way would mark every window
  // on a pruned ledger partial forever.
  const dir = mkdtempSync(join(tmpdir(), 'fiscus-overview-intact-'));
  const store = new Store(join(dir, 'o.db'));
  try {
    const config = structuredClone(DEFAULT_CONFIG);
    store.insertRequest(request('old', NOW - 40 * DAY, 5));
    // Inside the local day, so this window has priced spend to be complete
    // ABOUT. Without it the coverage is `unknown` for the unrelated reason that
    // nothing was priced, and the test would pass without exercising the edge.
    store.insertRequest(request('new', NOW - 1_000, 5));
    assert.equal(store.prune(NOW - 35 * DAY), 1);

    const today = buildOverview(store, config, 'today');
    assert.equal(today.retention.truncated, false, 'today starts long after the boundary');
    assert.equal(today.retention.prunedBeforeMs, NOW - 35 * DAY, 'and the boundary still travels, so the states stay distinguishable');
    assert.equal(today.claimSupport.profile.coverage, 'complete');
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
