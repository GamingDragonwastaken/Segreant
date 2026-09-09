/**
 * The surface built to say WHY a channel is dark gave the wrong reason.
 *
 * `alertCoverage` exists for one purpose: to state, for each alert channel, why
 * it could not have fired, so an empty alert list means something. Its
 * spend-spike row said:
 *
 *     no prior active day exists yet, so there is no baseline to exceed
 *
 * MEASURED. A ledger with twenty-six consecutive active days, then
 * `fiscus prune` on the operator's own retention policy: the row goes
 * `live: false` with exactly that sentence. The word "yet" tells someone who
 * metered for a month that they have not accumulated history. They have. Fiscus
 * deleted it. **This is the false-cause defect on the one surface whose entire
 * job is to give causes**, which makes it the sharpest place in the product for
 * it to happen.
 *
 * AND THE QUIETER HALF, ALSO MEASURED. `gatherAlertInputs` takes the p90 over
 * the prior thirty days, so a shorter retention narrows the population without
 * narrowing the sentence. Same ledger, pruned to the last three days: the
 * baseline moved from **$3.16 over twenty-five samples to $3.39 over two**, and
 * the alert still read "your p90 day" as though it were a month's typical. A
 * p90 over two points is very nearly a maximum.
 *
 * WHY THE ALERT STILL FIRES, WHICH IS D-173'S RULE AND NOT A COMPROMISE.
 * Suppressing a spike warning because retention narrowed its baseline would
 * withhold a live overspend signal on account of a privacy setting. D-173
 * settled the shape: withdraw the half of a claim that deletion undermines, not
 * the whole claim. What deletion undermines here is the baseline's claim to
 * represent a typical month — not the observation that today is far above what
 * survives. So the alert fires and the comparison says what it is computed
 * over. No direction is claimed either: deleting the oldest days can move a p90
 * up or down, and asserting which would be inventing a fact.
 *
 * WHAT THIS DOES NOT ESTABLISH. That the other alert channels are swept —
 * budget-cap, runaway, throttling and pricing-trust read today's and this
 * week's rows, which a retention policy long enough to be plausible does not
 * reach; that is an argument, not a measurement, and it is not closed here.
 * Nor that a p90 over few points is otherwise sound: this packet makes the
 * sample size visible, it does not make it adequate.
 *
 * Recorded at D-182.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.FISCUS_HOME = mkdtempSync(join(tmpdir(), 'fiscus-alert-retention-'));

import { Store, type RequestRow } from '../src/store/db.ts';
import { computeAlerts, computeAlertCoverage } from '../src/alerts/detect.ts';
import { DEFAULT_CONFIG } from '../src/config.ts';

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.now();
const DARK_WITHOUT_HISTORY = 'no prior active day exists yet, so there is no baseline to exceed';

function request(daysAgo: number, costUsd: number): RequestRow {
  return {
    requestId: `r${daysAgo}`, sessionId: null, tsEpochMs: NOW - daysAgo * DAY - 60 * 60 * 1000,
    provider: 'openai', model: 'gpt-5', project: 'p', taskWeight: 1,
    inputTokens: 10, outputTokens: 10, cacheWriteTokens: 0, cacheReadTokens: 0,
    reasoningTokens: 0, costUsd, estimated: false, streamed: false, statusCode: 200, durationMs: 1,
  };
}

/** Twenty-six consecutive active days, today far above the rest. */
function seed(store: Store): void {
  for (let d = 25; d >= 0; d -= 1) store.insertRequest(request(d, d === 0 ? 40 : 1 + (25 - d) * 0.1));
}

function look(store: Store): { metric: string | null; detail: string | null; live: boolean; darkBecause: string | null } {
  const config = structuredClone(DEFAULT_CONFIG);
  const spike = computeAlerts(store, config, { now: NOW }).find((a) => a.id === 'spend-spike') ?? null;
  const row = computeAlertCoverage(store, config, { now: NOW }).channels.find((c) => c.channel === 'spend-spike');
  assert.ok(row, 'the spend-spike channel must always be enumerated');
  return { metric: spike?.metric ?? null, detail: spike?.detail ?? null, live: row.live, darkBecause: row.darkBecause };
}

test('a baseline retention emptied is not reported as history never accumulated', () => {
  const store = new Store(':memory:');
  try {
    seed(store);
    assert.equal(look(store).darkBecause, null, 'the baseline: twenty-six active days, channel live');

    // Deletes every prior active day and leaves today.
    assert.ok(store.prune(NOW - 0.5 * DAY) > 0, 'retention deletes the history, not the day');

    const after = look(store);
    assert.equal(after.live, false, 'there really is no baseline now -- that part is honest');
    assert.ok(after.darkBecause, 'and a dark channel must always say why');
    assert.notEqual(
      after.darkBecause,
      DARK_WITHOUT_HISTORY,
      '"yet" tells an operator who metered for a month that they have not started; they had, and Fiscus deleted it',
    );
    assert.ok(
      /delet|retention|prun/i.test(after.darkBecause),
      `the reason given must be the real one. Got: ${after.darkBecause}`,
    );
  } finally {
    store.close();
  }
});

test('a spike compared against a narrowed baseline says what it was computed over', () => {
  const store = new Store(':memory:');
  try {
    seed(store);
    const before = look(store);
    assert.ok(before.metric, 'the baseline: the spike fires against a month of history');
    assert.ok(!/retention|surviv/i.test(before.detail ?? ''), 'and says nothing extra about coverage');

    assert.ok(store.prune(NOW - 3 * DAY) > 0);

    const after = look(store);
    assert.ok(after.metric, 'the spike still fires -- withholding a live overspend signal over a privacy setting would be worse');
    assert.ok(
      /retention|surviv|delet/i.test(after.detail ?? ''),
      `a p90 over the days that survive retention is not "your typical day", and must say so. Got: ${after.detail}`,
    );
  } finally {
    store.close();
  }
});

test('a genuinely new ledger still says the history has not accumulated', () => {
  // The silence that keeps the disclosure worth reading, and the guard that
  // stops this fix from replacing one wrong reason with another. Today only,
  // no prior days, and no prune on record: the original sentence is the true
  // one and must survive unchanged.
  const store = new Store(':memory:');
  try {
    store.insertRequest(request(0, 40));
    const got = look(store);
    assert.equal(got.live, false);
    assert.equal(got.darkBecause, DARK_WITHOUT_HISTORY);
  } finally {
    store.close();
  }
});

test('a prune that predates the baseline window changes nothing', () => {
  // `prune` deletes strictly older than the boundary. A boundary before the
  // thirty-day window took nothing out of the population this percentile is
  // over, so the ordinary sentences stand.
  const store = new Store(':memory:');
  try {
    seed(store);
    assert.equal(store.prune(NOW - 400 * DAY), 0, 'nothing in this ledger is that old');

    const got = look(store);
    assert.equal(got.darkBecause, null);
    assert.ok(got.metric);
    assert.ok(!/retention|surviv/i.test(got.detail ?? ''), 'an untruncated baseline says nothing extra');
  } finally {
    store.close();
  }
});
