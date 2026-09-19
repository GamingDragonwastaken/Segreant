/**
 * THE FRONTIER PASSES THROUGH THE DECISION ASSURANCE GATE (WP-F05, D-240).
 *
 * `src/decision/CONTEXT.md` said it in so many words: "the frontier and the
 * other advisory surfaces still reach an operator without passing through this
 * module, so an observational separation is refused here and nowhere else yet."
 * A model-switch recommendation is the product's most action-shaped advisory
 * figure, and it carried a `confidence` word with no assurance level behind it.
 *
 * Each recommendation now carries `assurance`, DERIVED — not asserted — by
 * `gateDecisionForConsequence` from (1) a dominance certificate over the two
 * anytime-valid realization intervals the frontier already computed, and
 * (2) the comparison's own honest ten-axis profile: `causality` is
 * `observational` only when the separation held, `coverage` is `partial` when
 * any unit was excluded, the money is `estimated` (local list price), and the
 * outcome is a `proxy_unvalidated` measurement. Two consequence classes are
 * gated: `advisory_only` (DAL-1, which a clean separation reaches) and
 * `changes_spend` (DAL-3, which no observational comparison can reach — AII-025).
 *
 * Checked: a clean separation is DAL-1 with the advisory requirement met and
 * the spend-change requirement refused on `causality`; a trial (overlapping
 * bounds) is DAL-0 with both refused and the `dominance` shortfall named; the
 * gate never authorizes action. Written RED against the frontier before the
 * field existed.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeFrontier } from '../src/value/frontier.ts';
import type { WorkUnit } from '../src/value/realization.ts';
import { GATE_LADDER, gateResultFromVerdict } from '../src/value/gates.ts';

const DAY = 24 * 60 * 60 * 1000;
let seq = 0;

function unit(model: string, realized: boolean, cost: number): WorkUnit {
  seq += 1;
  return {
    hash: `u${seq}`, tsEpochMs: ((seq * 7919) % 997) * DAY, subject: '',
    linesAdded: 10, linesDeleted: 0, filesChanged: 1,
    windowStartMs: 0, windowEndMs: 0, attributedCostUsd: cost, attributedRequests: 1,
    attributedOutputTokens: 0, costPerHundredLines: null,
    spendWindowTruncated: false, spendWindowPrunedBeforeMs: null,
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

function many(model: string, realized: number, failed: number, cost: number): WorkUnit[] {
  return [
    ...Array.from({ length: realized }, () => unit(model, true, cost)),
    ...Array.from({ length: failed }, () => unit(model, false, cost)),
  ];
}

test('a clean observational separation is DAL-1: advisory requirement met, spend change refused on causality, never authorized', () => {
  // Forty realized of forty for the cheap candidate against ten of forty for the
  // incumbent: the anytime-valid bounds separate and survive a flipped outcome.
  const rec = computeFrontier([...many('incumbent', 10, 30, 4), ...many('candidate', 40, 0, 2)]).modelSwitches[0];
  assert.ok(rec, 'the comparison must exist');
  assert.equal(rec.confidence, 'observational_separation');
  assert.equal(rec.assurance.level, 'DAL-1');
  assert.equal(rec.assurance.advisory.meetsRequirement, true);
  assert.equal(rec.assurance.changesSpend.meetsRequirement, false, 'an observational comparison cannot support changing spend (AII-025)');
  assert.ok(rec.assurance.changesSpend.assessment.shortfalls.some((item) => item.axis === 'causality' && item.required === 'randomized'));
  assert.equal(rec.assurance.advisory.authorizesAction, false);
  assert.equal(rec.assurance.changesSpend.authorizesAction, false);
  assert.equal(rec.assurance.inputProfile.causality, 'observational');
  assert.equal(rec.assurance.inputProfile.monetaryBasis, 'estimated');
});

test('a trial with overlapping bounds is DAL-0, and the dominance shortfall is named on both gates', () => {
  // Same realization on both sides: cheaper, but no separation to certify.
  const rec = computeFrontier([...many('incumbent', 6, 2, 4), ...many('candidate', 6, 2, 2)]).modelSwitches[0];
  assert.ok(rec, 'the comparison must exist');
  assert.equal(rec.confidence, 'trial');
  assert.equal(rec.assurance.level, 'DAL-0');
  assert.equal(rec.assurance.advisory.meetsRequirement, false);
  assert.equal(rec.assurance.changesSpend.meetsRequirement, false);
  for (const gate of [rec.assurance.advisory, rec.assurance.changesSpend]) {
    assert.ok(gate.assessment.shortfalls.some((item) => item.axis === 'dominance'), 'overlapping intervals are not dominance');
    assert.ok(gate.refusal !== null && gate.refusal.remedy.length > 0, 'a refusal says what would clear it');
  }
  assert.equal(rec.assurance.inputProfile.causality, 'none', 'no separation held, so no observational reading is claimed');
});

test('a trial names the next evidence to acquire in its one-line recommendation (WP-R09, D-242)', () => {
  const report = computeFrontier([...many('incumbent', 6, 2, 4), ...many('candidate', 6, 2, 2)]);
  const line = report.recommendations[0] ?? '';
  assert.match(line, /decision assurance DAL-0/);
  assert.match(line, /next evidence: The intervals do not separate/);
  assert.doesNotMatch(line, /probab|expected value/i, 'no probability model is invented to rank acquisitions');
});
