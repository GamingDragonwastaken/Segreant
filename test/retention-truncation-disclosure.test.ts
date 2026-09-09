/**
 * Pruning the ledger left no trace, so a deleted history read as a history
 * that never happened.
 *
 * WHAT `fiscus prune` DID. `Store.prune(beforeMs)` runs one `DELETE FROM
 * requests WHERE ts_epoch_ms < ?`, vacuums, and returns a row count that is
 * printed once and then gone. Nothing durable recorded that a boundary had
 * ever been applied. Retention defaults to 180 days and the operator can set
 * it to anything, so the deletion is policy working as intended — the defect
 * is that afterwards nothing can tell a period Fiscus never observed from a
 * period Fiscus observed and then deleted.
 *
 * THE OPERATOR-FACING INSTANCE, WHICH IS THE SHARPEST ONE IN THE PROGRAM SO
 * FAR. `GuideFacts.requestsAllTime` comes from `store.summary(0, now)` and
 * `buildGuide` reads it as `f.requestsAllTime > 0 ? "N requests metered" :
 * "no traffic yet"`, and sets the metering step's `done` from the same
 * comparison. Prune a ledger past every row it holds and `fiscus guide` — and
 * `/api/guide`, which builds from the same function — tells the operator they
 * have no traffic yet and sends them off to configure a proxy they configured
 * months ago. The most confident thing this surface can say arrives exactly
 * when Fiscus knows least, which is the thirteenth instance of the class this
 * program has been chasing since D-140: **an absence of a result reported as a
 * result.** Here it is not an empty list rendered as a clean bill; it is a step
 * marked NOT DONE because the evidence that it was done has been deleted.
 *
 * WHAT IS RECORDED, AND WHAT IS DELIBERATELY NOT INFERRED. A prune now writes
 * its boundary, its row count and its time into `retention_prunes`, and the
 * retention floor is the newest boundary ever applied. A ledger with no such
 * row reports `prunedBeforeMs: null`, and that means "no prune is on record" —
 * NOT "nothing was ever pruned". Every ledger pruned before this packet is in
 * exactly that state, and backfilling a boundary from the oldest surviving row
 * would be inventing provenance, which is the one thing this repository's
 * second hard rule forbids by name. So the null is a third state and the
 * surfaces say so rather than resolving it in either direction.
 *
 * A ZERO-ROW PRUNE IS STILL RECORDED. It applied a boundary; that a boundary
 * removed nothing this time is a fact about the data, not about the policy,
 * and a later query still needs to know the boundary was in force.
 *
 * WHY NO REFUTING COMPLETENESS WITNESS IS EMITTED HERE. AII-002's remainder
 * asks for one, and a prune is the first thing in this repository that could
 * honestly produce one: it establishes that a source did NOT completely cover
 * a period, which is the `refuted` state `assessCompleteness` already handles
 * and nothing has ever produced. It is not emitted, because a completeness
 * witness exists to qualify a NEGATIVE CLAIM and no negative claim is made
 * over the request stream — `src/epistemic/claim.ts`'s `negativeClaim` has no
 * production caller at all. Emitting one would be another mechanism with no
 * consumer, which is this program's other recurring class. The disclosure goes
 * where the reading actually happens instead.
 *
 * WHAT THIS DOES NOT ESTABLISH. That every surface reading `requests`
 * discloses truncation. This packet covers the prune record, the retention
 * floor, and the guide — the one place that turns a count into a statement
 * about whether something ever happened. `fiscus today/week/month`,
 * `report`, `usage` and `export` still print window totals with no coverage
 * line; their windows are recent enough that the default 180-day floor rarely
 * reaches them, which is a reason to do them next and not a reason they are
 * correct. Nor does it establish anything about `proposals`: those are pruned
 * on a separate, much shorter policy and are recorded separately here, but no
 * surface reads their floor yet.
 *
 * Recorded at D-170.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store/db.ts';
import { buildGuide, type GuideFacts } from '../src/guide.ts';

const DAY = 24 * 60 * 60 * 1000;

function requestAt(id: string, tsEpochMs: number) {
  return {
    requestId: id,
    sessionId: null,
    tsEpochMs,
    provider: 'anthropic',
    model: 'claude-test',
    project: 'retention-test',
    taskWeight: 1,
    inputTokens: 10,
    outputTokens: 10,
    cacheWriteTokens: 0,
    cacheReadTokens: 0,
    reasoningTokens: 0,
    costUsd: 0.01,
    estimated: false,
    streamed: false,
    statusCode: 200,
    durationMs: 1,
  };
}

/** A ledger holding three requests, the oldest two beyond a 30-day boundary. */
function seeded(now: number): Store {
  const store = new Store(':memory:');
  store.insertRequest(requestAt('old-1', now - 90 * DAY));
  store.insertRequest(requestAt('old-2', now - 60 * DAY));
  store.insertRequest(requestAt('recent', now - 1 * DAY));
  return store;
}

function facts(over: Partial<GuideFacts> = {}): GuideFacts {
  return {
    demo: false,
    port: 8787,
    dashboardPort: 8788,
    proxyUp: false,
    requestsAllTime: 0,
    spend30dUsd: 0,
    dailyCapUsd: null,
    outcomeSignals: 0,
    realizationUnits: 0,
    laborRateSet: false,
    ...over,
  };
}

test('an unpruned ledger reports no retention record, which is not the same as no pruning', () => {
  const store = seeded(Date.now());
  try {
    const floor = store.retentionFloor();
    assert.equal(floor.requestsPrunedBeforeMs, null, 'a ledger with no recorded prune must say so with null');
    assert.equal(floor.requestsPrunes, 0);
    assert.equal(floor.requestsRowsRemoved, 0);
  } finally {
    store.close();
  }
});

test('pruning records the boundary it applied, the rows it removed, and when', () => {
  const now = Date.now();
  const store = seeded(now);
  try {
    const boundary = now - 30 * DAY;
    const removed = store.prune(boundary);
    // VACUITY: a prune that deleted nothing would make every assertion below
    // true of a ledger nothing happened to.
    assert.equal(removed, 2, 'the fixture must actually lose rows, or this file tests an empty operation');

    const floor = store.retentionFloor();
    assert.equal(floor.requestsPrunedBeforeMs, boundary);
    assert.equal(floor.requestsRowsRemoved, 2);
    assert.equal(floor.requestsPrunes, 1);
    assert.ok(floor.requestsLastPrunedAtMs !== null && floor.requestsLastPrunedAtMs >= now);
  } finally {
    store.close();
  }
});

test('a prune that removed nothing is still recorded, because the boundary was applied', () => {
  // The boundary is a fact about the policy in force. That it happened to
  // delete nothing on this run says something about the data and nothing about
  // what a later query over that period can rely on.
  const now = Date.now();
  const store = seeded(now);
  try {
    const boundary = now - 365 * DAY;
    assert.equal(store.prune(boundary), 0);
    const floor = store.retentionFloor();
    assert.equal(floor.requestsPrunedBeforeMs, boundary);
    assert.equal(floor.requestsRowsRemoved, 0);
    assert.equal(floor.requestsPrunes, 1);
  } finally {
    store.close();
  }
});

test('the floor is the newest boundary ever applied, and rows removed accumulate', () => {
  const now = Date.now();
  const store = seeded(now);
  try {
    store.prune(now - 80 * DAY);
    store.prune(now - 30 * DAY);
    // Deliberately out of order: an older boundary applied later must not move
    // the floor backwards, because the newer deletion already happened.
    store.prune(now - 120 * DAY);
    const floor = store.retentionFloor();
    assert.equal(floor.requestsPrunedBeforeMs, now - 30 * DAY);
    assert.equal(floor.requestsRowsRemoved, 2);
    assert.equal(floor.requestsPrunes, 3);
  } finally {
    store.close();
  }
});

test('proposal pruning is recorded separately and does not move the request floor', () => {
  const now = Date.now();
  const store = seeded(now);
  try {
    store.pruneProposals(now - 30 * DAY);
    const floor = store.retentionFloor();
    assert.equal(floor.requestsPrunedBeforeMs, null, 'pruning proposals says nothing about request coverage');
    assert.equal(floor.proposalsPrunedBeforeMs, now - 30 * DAY);
  } finally {
    store.close();
  }
});

test('the guide does not call a pruned history no traffic', () => {
  // THE COUNTEREXAMPLE. Prune past every row and `requestsAllTime` is 0, which
  // `buildGuide` read as "no traffic yet" with the metering step NOT DONE --
  // telling an operator who metered for months to go and configure a proxy.
  const now = Date.now();
  const store = seeded(now);
  let report;
  try {
    store.prune(now + DAY);
    assert.equal(store.summary(0, now + DAY).requests, 0, 'the fixture must leave an empty ledger');
    const floor = store.retentionFloor();
    report = buildGuide(facts({ requestsAllTime: 0, requestsRetention: floor }));
  } finally {
    store.close();
  }

  const meter = report.steps.find((step) => step.id === 'meter');
  assert.ok(meter, 'the guide must still have a metering step');
  assert.match(
    meter.state,
    /delet|prun|retention/i,
    'an empty ledger behind a recorded retention boundary must not be described as no traffic',
  );
  assert.doesNotMatch(meter.state, /no traffic yet/i);
});

test('the guide still says no traffic when there is genuinely no record of any', () => {
  // The other direction, and the reason the null state exists. A ledger with no
  // prune on record and no requests is an honest "no traffic yet"; softening
  // that too would trade one wrong answer for another.
  const report = buildGuide(facts({ requestsAllTime: 0 }));
  const meter = report.steps.find((step) => step.id === 'meter');
  assert.ok(meter);
  assert.match(meter.state, /no traffic yet/i);
});

test('a surviving count behind a retention boundary is not presented as all time', () => {
  // Two rows deleted, one left. "1 request metered" is true of what remains and
  // false of what happened, and the difference is exactly what the boundary
  // records.
  const now = Date.now();
  const store = seeded(now);
  let report;
  try {
    store.prune(now - 30 * DAY);
    report = buildGuide(facts({ requestsAllTime: store.summary(0, now + DAY).requests, requestsRetention: store.retentionFloor() }));
  } finally {
    store.close();
  }

  const meter = report.steps.find((step) => step.id === 'meter');
  assert.ok(meter);
  assert.equal(meter.done, true, 'one surviving request is still evidence that metering happened');
  assert.match(meter.state, /retention|prun|delet/i, 'a count behind a boundary must say so');
});
