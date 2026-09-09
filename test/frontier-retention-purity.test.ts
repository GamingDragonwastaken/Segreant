/**
 * A model-switch recommendation must not be priced from spend retention deleted.
 *
 * D-176 established the mechanism: a commit whose eight-hour attribution window
 * lost its request rows to `fiscus prune` reports `attributedCostUsd: 0` while
 * the unit itself survives, because work units come from git history. Following
 * that record's own ranking rule — hunt this class wherever the absent number is
 * a DIVISOR — the frontier is the next surface, and it is the one that gives
 * advice.
 *
 * WHAT THE FRONTIER DOES WITH THE NUMBER. `makeSwitchCell` computes
 * `costPerUnit = modelCostUsd / units` and `costPerHundredLines`, and
 * `buildModelSwitchRecommendations` picks the incumbent as the highest
 * `costPerUnit` and the candidate as a cheaper one. A model whose units had
 * spend deleted is cheaper by exactly the deleted amount, so **retention can
 * make Fiscus recommend switching to a model on the strength of dollars it
 * deleted** — a recommendation, not merely a report, produced by a privacy
 * setting.
 *
 * WHY THIS IS THE EXISTING GATE AND NOT A NEW ONE. `isPriceable` already
 * refuses a unit whose price "has been superseded by a reprice", for the
 * reason that a model comparison is a price difference and a wrong price on one
 * side moves the headroom for reasons that have nothing to do with the models.
 * A price that is a known undercount is the same objection with a different
 * cause, so it belongs in the same gate, checked in the same partition, and
 * reported in the same `unitsExcluded*` family rather than deleted quietly.
 *
 * THE UNKNOWN STATE IS DELIBERATELY NOT EXCLUDED, AND IS COUNTED INSTEAD.
 * `spendWindowTruncated` is null on any realization snapshot written before
 * D-176 — genuinely unknown, never "intact". Excluding those would empty the
 * frontier on every existing store, which is a large behavioural change made
 * on no evidence about those units. Including them silently would read unknown
 * as fine. So they stay eligible and are COUNTED, and a reader can see how much
 * of a comparison rests on coverage nobody recorded. That is the same shape as
 * `unitsExcludedUnknownAttribution`, one axis over.
 *
 * WHAT THIS DOES NOT ESTABLISH. That the frontier is otherwise sound — the
 * Bonferroni correction, the purity bar and the anytime-valid intervals carry
 * their own conditions and none is closed here. Nor that the dashboard reports
 * the new counts: `/api/value` exposes only `frontier.modelSwitches`, which
 * remains the open remainder named at D-175.
 *
 * Recorded at D-177.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.FISCUS_HOME = mkdtempSync(join(tmpdir(), 'fiscus-frontier-retention-'));

import { computeFrontier } from '../src/value/frontier.ts';
import type { WorkUnit } from '../src/value/realization.ts';
import { GATE_LADDER, gateResultFromVerdict } from '../src/value/gates.ts';

const DAY = 24 * 60 * 60 * 1000;
let seq = 0;

function unit(
  model: string,
  realized: boolean,
  cost: number,
  spendWindowTruncated: boolean | null = false,
): WorkUnit {
  seq += 1;
  return {
    hash: `u${seq}`, tsEpochMs: ((seq * 7919) % 997) * DAY, subject: '',
    linesAdded: 10, linesDeleted: 0, filesChanged: 1,
    windowStartMs: 0, windowEndMs: 0, attributedCostUsd: cost, attributedRequests: 1,
    attributedOutputTokens: 0, costPerHundredLines: null,
    spendWindowTruncated,
    spendWindowPrunedBeforeMs: spendWindowTruncated === true ? 1 : null,
    ageDays: 30, maturing: false, survivalRatio: 1, reverted: false, hadProposal: false,
    acceptance: null, taskType: 'feature', dominantModel: model,
    dominantModelCostUsd: cost, dominantModelCostShare: 1, costStale: false,
    dominantModelCostBasis: 'local_list_price', dominantModelRateCard: 'card-a',
    funnel: {
      realized,
      results: GATE_LADDER.map((gate) => gateResultFromVerdict(gate, realized ? 'pass' : 'fail', '')),
      conflicts: [], reachedIndex: 0, reached: null, diedAt: null, diedAtIndex: null,
      passes: 0, fails: 0, unknowns: 0, instrumented: 0, realizationScore: 0,
    },
  } as WorkUnit;
}

/** Six units per model: enough for the frontier's minimum cell size. */
function cell(model: string, cost: number, truncated: boolean | null = false): WorkUnit[] {
  return Array.from({ length: 6 }, () => unit(model, true, cost, truncated));
}

test('a partly truncated model is priced from its surviving units, not from the deleted ones', () => {
  // THE COUNTEREXAMPLE, AND IT IS NARROWER THAN THE OBVIOUS ONE. A model whose
  // spend was deleted OUTRIGHT is already refused: `costPerUnit > 0` filters a
  // zero-cost cell out, so the naive case never reaches a recommendation. The
  // live defect is PARTIAL contamination -- some of a model's units keep their
  // spend and some lost it -- which produces a positive per-unit cost that is
  // lower than the model's real one by exactly the deleted amount, and reads as
  // a price difference between the models.
  //
  // Here both models are priced identically per surviving unit ($3.50 against
  // $4.00, a real but modest gap). Four of the candidate's twelve units had
  // their spend deleted, which drags its apparent cost to $2.33 and roughly
  // doubles the headroom Fiscus would report for switching.
  const units = [
    ...Array.from({ length: 8 }, () => unit('incumbent-model', true, 4)),
    ...Array.from({ length: 8 }, () => unit('candidate-model', true, 3.5)),
    ...Array.from({ length: 4 }, () => unit('candidate-model', true, 0, true)),
  ];
  const rec = (computeFrontier(units).modelSwitches ?? [])[0];
  assert.ok(rec, 'the two models still compare on their surviving units');
  assert.equal(rec.candidateModel, 'candidate-model');
  assert.ok(
    Math.abs(rec.candidateCostPerUnitUsd - 3.5) < 1e-9,
    `the candidate must be priced at $3.50 from its eight surviving units, not $${rec.candidateCostPerUnitUsd.toFixed(2)} from twelve of which four had their spend deleted`,
  );
});

test('the excluded units are counted rather than quietly dropped', () => {
  // The file's own convention: units below a bar are "counted and reported as
  // excluded". A silent shrink would leave a reader unable to tell a thin
  // sample from a filtered one.
  const both = computeFrontier([
    ...cell('model-a', 4),
    ...cell('model-b', 2),
    ...cell('model-b', 0, true),
  ]);
  const rec = (both.modelSwitches ?? [])[0];
  assert.ok(rec, 'two intact cells still produce a comparison');
  assert.equal(rec.unitsExcludedTruncatedSpend, 6, 'and the six truncated units are reported, not forgotten');
});

test('a unit whose coverage is unknown stays eligible and is counted as unknown', () => {
  // Snapshots written before D-176 carry null. Excluding them would empty the
  // frontier on every existing store on no evidence about those units;
  // including them silently would read unknown as intact. They are eligible
  // and counted.
  const legacy = computeFrontier([
    ...cell('model-a', 4, null),
    ...cell('model-b', 2, null),
  ]);
  const rec = (legacy.modelSwitches ?? [])[0];
  assert.ok(rec, 'a legacy store still gets its comparison');
  assert.equal(rec.unitsExcludedTruncatedSpend, 0, 'nothing was excluded for truncation');
  assert.equal(rec.unitsUnknownSpendCoverage, 12, 'but the comparison rests entirely on unrecorded coverage, and says so');
});

test('an intact comparison reports zero on both counts', () => {
  // The silence that keeps the disclosure worth reading.
  const clean = computeFrontier([...cell('model-a', 4), ...cell('model-b', 2)]);
  const rec = (clean.modelSwitches ?? [])[0];
  assert.ok(rec);
  assert.equal(rec.unitsExcludedTruncatedSpend, 0);
  assert.equal(rec.unitsUnknownSpendCoverage, 0);
});
