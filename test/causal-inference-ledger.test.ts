/**
 * The estimator is stateless, and that is deliberate — but statelessness is
 * exactly why it cannot tell you that you have now asked it the same question
 * ten times. The first test here is the counterexample rather than a
 * requirement: it constructs ten looks at one accumulating study, watches the
 * tenth earn claim language the ninth refused, and shows that the two results
 * carry byte-identical disclosure. Nothing on the tenth result says nine looks
 * preceded it, so a reader has no way to discount its stated coverage.
 *
 * The rest of the suite pins the reporting boundary that closes it: an
 * inference ledger that records the looks and puts their arithmetic on the
 * result instead of leaving it to a footnote nobody writes.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { completedData, modelDraft, repeatedCostQualityData } from './support/causalStudyFixture.ts';
import { estimateCausalStudy } from '../src/causal/estimate.ts';
import {
  CAUSAL_INFERENCE_LEDGER_TYPE,
  CAUSAL_INFERENCE_LEDGER_VERSION,
  openCausalInferenceLedger,
  reportCausalStudyEstimate,
  summarizeInferenceMultiplicity,
  type CausalInferencePlan,
} from '../src/causal/inference-ledger.ts';
import type { CausalStudyData } from '../src/causal/types.ts';

const UNITS_PER_REPEAT = 4;
const REPORT_BASE_MS = 1_700_000_900_000;

/**
 * The shared fixture emits 250 independent blocked repeats. Truncating whole
 * repeats keeps every event chain resolvable, so a prefix is a genuine earlier
 * look at the same study rather than a different study.
 */
function lookAt(full: CausalStudyData, repeats: number): CausalStudyData {
  const take = repeats * UNITS_PER_REPEAT;
  return {
    protocol: full.protocol,
    decisions: full.decisions.slice(0, take),
    executions: full.executions.slice(0, take),
    outcomes: full.outcomes.slice(0, take),
  };
}

/** Candidate quality is 0.1 above control, which the registered margin only
 * clears once the pre-declared interval has narrowed at the final look. */
function accumulatingStudy(): CausalStudyData {
  return repeatedCostQualityData(1, 0.9, 1, 99);
}

function openLedgerFor(data: CausalStudyData, plan: CausalInferencePlan | null = null) {
  return openCausalInferenceLedger({
    studyId: data.protocol.studyId,
    protocolHash: data.protocol.protocolHash,
    plan,
  });
}

test('counterexample: the bare estimator reports the tenth look exactly like the first', () => {
  const full = accumulatingStudy();
  const looks = [25, 50, 75, 100, 125, 150, 175, 200, 225, 250]
    .map((repeats) => estimateCausalStudy(lookAt(full, repeats)));

  for (const look of looks) assert.equal(look.qualification.state, 'qualified');

  assert.equal(looks[8]!.allowedClaim, 'not_established');
  assert.equal(looks[9]!.allowedClaim, 'comparative_cost_quality_supported');

  assert.deepEqual(looks[9]!.limitations, looks[0]!.limitations);
  assert.equal(
    JSON.stringify(looks[9]!.jointInference),
    JSON.stringify(looks[0]!.jointInference),
  );
  assert.ok(
    !/look|multiplic|repeat/i.test(JSON.stringify(looks[9])),
    'the tenth estimate records nothing about the nine looks that preceded it',
  );
});

test('the ledger records every look and puts its arithmetic on the reported result', () => {
  const full = accumulatingStudy();
  let ledger = openLedgerFor(full);
  let outcome = reportCausalStudyEstimate(ledger, lookAt(full, 25), { reportedAtMs: REPORT_BASE_MS + 1 });
  ledger = outcome.ledger;
  for (let look = 2; look <= 10; look += 1) {
    outcome = reportCausalStudyEstimate(ledger, lookAt(full, look * 25), {
      reportedAtMs: REPORT_BASE_MS + look,
    });
    ledger = outcome.ledger;
  }
  const report = outcome.report;

  assert.equal(ledger.type, CAUSAL_INFERENCE_LEDGER_TYPE);
  assert.equal(ledger.version, CAUSAL_INFERENCE_LEDGER_VERSION);
  assert.equal(report.multiplicity.looks, 10);
  assert.equal(report.multiplicity.intervalReportingActs, 20);
  assert.equal(report.multiplicity.actsInErrorBudget, 20);
  assert.equal(report.multiplicity.identicalRepeatActs, 0);
  assert.ok(Math.abs(report.multiplicity.actAlpha! - 0.025) < 1e-12);
  assert.ok(Math.abs(report.multiplicity.familywiseErrorUpperBound! - 0.5) < 1e-9);
  assert.ok(Math.abs(report.multiplicity.simultaneousConfidenceLowerBound! - 0.5) < 1e-9);
  assert.equal(report.multiplicity.basis, 'recorded_acts_only');

  assert.equal(report.estimate.allowedClaim, 'comparative_cost_quality_supported');
  assert.equal(report.claimAfterMultiplicity, 'not_established');
  assert.ok(
    report.estimate.limitations.some((line) => line.includes('look 10')),
    'the look count belongs on the result, not in a footnote',
  );
  assert.ok(
    report.estimate.limitations.some((line) => /simultaneous confidence/i.test(line)),
    'the degraded simultaneous coverage is stated where the interval is stated',
  );
});

test('an interval reported once is not discounted for multiplicity it does not have', () => {
  const full = accumulatingStudy();
  const ledger = openLedgerFor(full);
  const { report } = reportCausalStudyEstimate(ledger, lookAt(full, 250), { reportedAtMs: REPORT_BASE_MS });

  assert.equal(report.multiplicity.looks, 1);
  assert.equal(report.multiplicity.actsInErrorBudget, 2);
  assert.ok(Math.abs(report.multiplicity.familywiseErrorUpperBound! - 0.05) < 1e-9);
  assert.equal(report.claimAfterMultiplicity, 'comparative_cost_quality_supported');
});

test('re-reading identical evidence is recorded as a look but does not spend error budget', () => {
  const full = accumulatingStudy();
  const data = lookAt(full, 250);
  let ledger = openLedgerFor(full);
  ledger = reportCausalStudyEstimate(ledger, data, { reportedAtMs: REPORT_BASE_MS }).ledger;
  const { report } = reportCausalStudyEstimate(ledger, data, { reportedAtMs: REPORT_BASE_MS + 1 });

  assert.equal(report.multiplicity.looks, 2);
  assert.equal(report.multiplicity.intervalReportingActs, 4);
  assert.equal(report.multiplicity.identicalRepeatActs, 2);
  assert.equal(report.multiplicity.actsInErrorBudget, 2);
  assert.ok(Math.abs(report.multiplicity.familywiseErrorUpperBound! - 0.05) < 1e-9);
  assert.equal(report.claimAfterMultiplicity, 'comparative_cost_quality_supported');
});

test('a subgroup slice is a separate inferential act even on identical evidence', () => {
  const full = accumulatingStudy();
  const data = lookAt(full, 250);
  let ledger = openLedgerFor(full);
  ledger = reportCausalStudyEstimate(ledger, data, { reportedAtMs: REPORT_BASE_MS }).ledger;
  const { report } = reportCausalStudyEstimate(ledger, data, {
    reportedAtMs: REPORT_BASE_MS + 1,
    sliceId: 'slice:repository-a',
  });

  assert.equal(report.multiplicity.slices, 2);
  assert.equal(report.multiplicity.actsInErrorBudget, 4);
  assert.ok(Math.abs(report.multiplicity.familywiseErrorUpperBound! - 0.1) < 1e-9);
  assert.equal(report.claimAfterMultiplicity, 'not_established');
  assert.ok(
    report.estimate.limitations.some((line) => /slice/i.test(line)),
    'the slice count is disclosed on the result',
  );
});

test('a non-estimating read is a recorded look that spends no error budget', () => {
  const full = accumulatingStudy();
  const collecting: CausalStudyData = { ...lookAt(full, 25), outcomes: [] };
  let ledger = openLedgerFor(full);
  const peek = reportCausalStudyEstimate(ledger, collecting, { reportedAtMs: REPORT_BASE_MS });
  ledger = peek.ledger;

  assert.notEqual(peek.report.estimate.qualification.state, 'qualified');
  assert.equal(peek.report.multiplicity.looks, 1);
  assert.equal(peek.report.multiplicity.intervalReportingActs, 0);
  assert.equal(peek.report.multiplicity.actsInErrorBudget, 0);
  assert.equal(peek.report.multiplicity.familywiseErrorUpperBound, null);
  assert.equal(peek.report.multiplicity.simultaneousConfidenceLowerBound, null);

  const { report } = reportCausalStudyEstimate(ledger, lookAt(full, 250), { reportedAtMs: REPORT_BASE_MS + 1 });
  assert.equal(report.multiplicity.looks, 2);
  assert.equal(report.multiplicity.actsInErrorBudget, 2);
  assert.equal(report.claimAfterMultiplicity, 'comparative_cost_quality_supported');
});

test('a pre-registered plan states the per-act error it requires and whether the act met it', () => {
  const full = accumulatingStudy();
  const plan: CausalInferencePlan = {
    declaredAtMs: REPORT_BASE_MS - 1_000,
    maxLooks: 10,
    endpointsPerLook: 2,
    sliceIds: ['slice:registered_population'],
    targetFamilywiseErrorRate: 0.05,
  };
  let ledger = openLedgerFor(full, plan);
  let outcome = reportCausalStudyEstimate(ledger, lookAt(full, 25), { reportedAtMs: REPORT_BASE_MS + 1 });
  ledger = outcome.ledger;
  for (let look = 2; look <= 10; look += 1) {
    outcome = reportCausalStudyEstimate(ledger, lookAt(full, look * 25), {
      reportedAtMs: REPORT_BASE_MS + look,
    });
    ledger = outcome.ledger;
  }
  const report = outcome.report;

  assert.equal(report.multiplicity.basis, 'pre_registered_plan');
  assert.equal(report.multiplicity.plan!.plannedActs, 20);
  assert.ok(Math.abs(report.multiplicity.plan!.requiredActAlpha - 0.0025) < 1e-12);
  assert.ok(Math.abs(report.multiplicity.plan!.requiredActConfidenceLevel - 0.9975) < 1e-12);
  assert.equal(report.multiplicity.plan!.actAlphaMeetsPlan, false);
  assert.equal(report.claimAfterMultiplicity, 'not_established');
  assert.ok(
    report.estimate.limitations.some((line) => /pre-registered/i.test(line) && line.includes('99.7500')),
    'the plan discloses the per-act level it needed and did not get',
  );
});

test('a plan that the reported act actually satisfies preserves the claim', () => {
  const full = accumulatingStudy();
  const plan: CausalInferencePlan = {
    declaredAtMs: REPORT_BASE_MS - 1_000,
    maxLooks: 1,
    endpointsPerLook: 2,
    sliceIds: ['slice:registered_population'],
    targetFamilywiseErrorRate: 0.05,
  };
  const ledger = openLedgerFor(full, plan);
  const { report } = reportCausalStudyEstimate(ledger, lookAt(full, 250), { reportedAtMs: REPORT_BASE_MS });

  assert.equal(report.multiplicity.basis, 'pre_registered_plan');
  assert.equal(report.multiplicity.plan!.actAlphaMeetsPlan, true);
  assert.equal(report.multiplicity.plan!.actsExceedPlan, false);
  assert.equal(report.claimAfterMultiplicity, 'comparative_cost_quality_supported');
});

test('looking more often than the plan registered abandons the plan as a basis', () => {
  const full = accumulatingStudy();
  const plan: CausalInferencePlan = {
    declaredAtMs: REPORT_BASE_MS - 1_000,
    maxLooks: 1,
    endpointsPerLook: 2,
    sliceIds: ['slice:registered_population'],
    targetFamilywiseErrorRate: 0.05,
  };
  let ledger = openLedgerFor(full, plan);
  ledger = reportCausalStudyEstimate(ledger, lookAt(full, 225), { reportedAtMs: REPORT_BASE_MS }).ledger;
  const { report } = reportCausalStudyEstimate(ledger, lookAt(full, 250), { reportedAtMs: REPORT_BASE_MS + 1 });

  assert.equal(report.multiplicity.plan!.actsExceedPlan, true);
  assert.equal(report.multiplicity.basis, 'recorded_acts_only');
  assert.equal(report.claimAfterMultiplicity, 'not_established');
  assert.ok(
    report.estimate.limitations.some((line) => /exceeded the pre-registered/i.test(line)),
    'exceeding the plan is stated, not absorbed',
  );
});

test('the ledger chains its acts so a removed look is detectable', () => {
  const full = accumulatingStudy();
  let ledger = openLedgerFor(full);
  for (let look = 1; look <= 3; look += 1) {
    ledger = reportCausalStudyEstimate(ledger, lookAt(full, look * 50), {
      reportedAtMs: REPORT_BASE_MS + look,
    }).ledger;
  }
  assert.equal(ledger.acts.length, 6);

  const truncated = { ...ledger, acts: [...ledger.acts.slice(0, 2), ...ledger.acts.slice(4)] };
  const summary = summarizeInferenceMultiplicity(truncated);
  assert.equal(summary.chainIntact, false);
  assert.ok(
    summary.limitations.some((line) => /chain/i.test(line)),
    'a broken act chain is disclosed rather than silently summarised',
  );
  assert.equal(summarizeInferenceMultiplicity(ledger).chainIntact, true);
});

test('a ledger refuses evidence from a different committed protocol', () => {
  const full = accumulatingStudy();
  const other = completedData(modelDraft({ studyId: 'study-other' }));
  const ledger = openLedgerFor(full);
  assert.throws(
    () => reportCausalStudyEstimate(ledger, other, { reportedAtMs: REPORT_BASE_MS }),
    /protocol/i,
  );
});
