/**
 * Allocation reported 100% of a period's spend allocated, over a period 95% of
 * whose spend it had deleted.
 *
 * THE COUNTEREXAMPLE, MEASURED. A sixty-day period holding $42.00: $32.00 that
 * two rules route to a cost centre and $10.00 that nothing matches.
 * `fiscus alloc` reported `total=$42.00 allocated=$32.00 (76.2%)
 * unallocated=$10.00`. `fiscus prune` then deleted the rows older than thirty
 * days — a boundary INSIDE the declared period — and the same call over the
 * same period reported:
 *
 *     total=$2.00 allocated=$2.00 (100.0%) unallocated=$0.00
 *
 * An operator reading "100.0% allocated, $0.00 unallocated" concludes their
 * rules cover everything. They cover 76% of it. The uncovered $10.00 did not
 * become allocated; it was deleted, and its absence flattered the coverage
 * figure by ~24 points. **A deletion did not merely shrink a total here; it
 * removed the part of the total that was evidence AGAINST the rules, and the
 * percentage moved in the flattering direction as a result.**
 *
 * `conserves` STAYED TRUE, AND THAT IS THE SHARPEST PART. The run's own
 * integrity check — allocated + unallocated must equal the ledger total to the
 * microdollar, and the CLI refuses to print or record a run that fails it — is
 * satisfied by the truncated input, because it conserves what SURVIVES. **A
 * correct invariant over a truncated input certifies a wrong number**, and the
 * guard that exists to make the run trustworthy is exactly what makes this one
 * look trustworthy. That guard is unchanged here: it is doing its job, which
 * was never to detect a missing input.
 *
 * AND THE RECORD OUTLIVES THE RUN. `fiscus alloc --apply` persists the result
 * as `result_json` and the run is issued into the epistemic kernel. Before this
 * packet that record asserted a period total which was a post-deletion remnant,
 * immutably, with no way for a later reader to tell. The coverage now travels
 * IN the persisted result for that reason, not only in the printed output.
 *
 * THREE STATES (D-170). `retention` absent on a run read back from history is a
 * record written before this field existed — unknown, never "intact" — which is
 * why the field is optional on the interface and always set by
 * `allocatePeriod`. A run whose period starts after the boundary lost nothing.
 * A run whose period starts before it did.
 *
 * WHAT THIS DOES NOT ESTABLISH. That the EXACT allocation path is covered:
 * `allocatePeriodExact` builds `ExactAllocationRunResult`, whose `complete`
 * flag is about basis resolution and not about retention at all, and it is not
 * touched here — named, not fixed. Nor that allocation is otherwise sound: the
 * rules, the proportional pools and the archived-centre handling carry their
 * own conditions and none is closed here.
 *
 * Recorded at D-183.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.FISCUS_HOME = mkdtempSync(join(tmpdir(), 'fiscus-alloc-retention-'));

import { Store, type RequestRow } from '../src/store/db.ts';

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.now();
const FROM = NOW - 60 * DAY;
const TO = NOW + 1000;

function request(id: string, daysAgo: number, project: string, costUsd: number): RequestRow {
  return {
    requestId: id, sessionId: null, tsEpochMs: NOW - daysAgo * DAY, provider: 'openai', model: 'gpt-5',
    project, taskWeight: 1, inputTokens: 10, outputTokens: 10, cacheWriteTokens: 0, cacheReadTokens: 0,
    reasoningTokens: 0, costUsd, estimated: false, streamed: false, statusCode: 200, durationMs: 1,
  };
}

function seed(store: Store): void {
  store.upsertCostCentre({ costCentreId: 'cc-eng', name: 'Engineering', owner: null });
  store.saveAllocationRule({
    ruleId: 'r-eng',
    priority: 10,
    match: { project: 'alpha' },
    method: 'direct',
    targets: [{ costCentreId: 'cc-eng', ratio: 1 }],
    effectiveFromMs: 0,
    effectiveToMs: null,
    revokedAtMs: null,
    owner: null,
    note: null,
  });
  // Inside the period and older than the thirty-day boundary used below.
  store.insertRequest(request('old-alpha', 50, 'alpha', 30));
  store.insertRequest(request('old-beta', 50, 'beta', 10));
  // Survives that boundary.
  store.insertRequest(request('new-alpha', 5, 'alpha', 2));
}

test('a period whose rows retention deleted is not reported as fully allocated', () => {
  const store = new Store(':memory:');
  try {
    seed(store);

    const before = store.allocatePeriod(FROM, TO);
    assert.equal(before.totalMicros, 42_000_000, 'the baseline: $42.00 of ledger spend in this period');
    assert.equal(before.allocatedMicros, 32_000_000);
    assert.equal(before.unallocatedMicros, 10_000_000, 'and $10.00 that no rule matches');
    assert.equal(before.retention?.truncated, false);

    assert.equal(store.prune(NOW - 30 * DAY), 2, 'the boundary sits INSIDE the declared period');

    const after = store.allocatePeriod(FROM, TO);
    // The surviving arithmetic is honest, and that is why the disclosure has to
    // sit beside it: 100% is arithmetically right and substantively false.
    assert.equal(after.totalMicros, 2_000_000);
    assert.equal(after.unallocatedMicros, 0, 'the unmatched spend did not become allocated -- it was deleted');
    assert.equal(after.conserves, true, 'the integrity check still passes, because it conserves what survives');
    assert.equal(
      after.retention?.truncated,
      true,
      'a period 95% of whose spend was deleted must not report an allocation coverage figure as though it were the period’s',
    );
  } finally {
    store.close();
  }
});

test('the run names the boundary it lost rows before', () => {
  const store = new Store(':memory:');
  try {
    seed(store);
    const boundary = NOW - 30 * DAY;
    store.prune(boundary);

    const run = store.allocatePeriod(FROM, TO);
    assert.equal(run.retention?.prunedBeforeMs, boundary, 'a reader has to be able to say which rows are gone');
  } finally {
    store.close();
  }
});

test('the coverage survives being persisted and read back', () => {
  // The printed line is not the durable claim. `--apply` writes `result_json`
  // and the run is issued into the kernel, so a record that says $2.00 was the
  // period total outlives every session that could have qualified it.
  const store = new Store(':memory:');
  try {
    seed(store);
    store.prune(NOW - 30 * DAY);
    const run = store.allocatePeriod(FROM, TO);
    store.saveAllocationRun(run);

    const recorded = store.allocationRuns(5)[0];
    assert.ok(recorded, 'the run must be recorded');
    assert.equal(recorded.result.totalMicros, 2_000_000);
    assert.equal(
      recorded.result.retention?.truncated,
      true,
      'the record must carry its own limit; a later reader has no other way to learn it',
    );
  } finally {
    store.close();
  }
});

test('a period entirely after the boundary reports an untruncated run', () => {
  // The silence that keeps the disclosure worth reading. `prune` deletes rows
  // strictly older than the boundary, so a period starting after it lost
  // nothing, and marking every run on a pruned ledger truncated would be noise.
  const store = new Store(':memory:');
  try {
    seed(store);
    store.prune(NOW - 30 * DAY);

    const run = store.allocatePeriod(NOW - 10 * DAY, TO);
    assert.equal(run.retention?.truncated, false);
    assert.equal(run.totalMicros, 2_000_000, 'and it is the same surviving spend, honestly the whole of this period');
  } finally {
    store.close();
  }
});

test('with no prune on record nothing is asserted about deletion', () => {
  const store = new Store(':memory:');
  try {
    seed(store);
    const run = store.allocatePeriod(FROM, TO);
    assert.equal(run.retention?.truncated, false);
    assert.equal(
      run.retention?.prunedBeforeMs,
      null,
      'null is "no prune is ON RECORD" -- a distinct state from a period known intact',
    );
  } finally {
    store.close();
  }
});
