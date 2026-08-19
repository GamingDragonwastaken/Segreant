import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { canonicalJson, executionPlanKey } from '../src/economics/execution.ts';
import { appendDecision, readDecisionLedger, type DecisionBody } from '../src/economics/decisionLedger.ts';
import { evidenceConstrainedFrontier, evidenceDominates, type EvidencePlan } from '../src/economics/frontier.ts';
import { summarizeBudgetRisk, updateScarcityDual } from '../src/economics/budgetRisk.ts';
import { promotionDecision, type PromotionEvidence } from '../src/economics/promotion.ts';
import { assessMetricUse } from '../src/economics/metricSafety.ts';
import { applyCapitalTransaction, createCapitalState, totalAvailableCapital, validateCapitalHierarchy } from '../src/economics/capital.ts';
import { exactShapleyDecomposition, opportunityGap, standardizedSpendDiagnostic } from '../src/economics/decomposition.ts';
import { doublyRobustEstimate, selfNormalizedIps } from '../src/economics/offPolicy.ts';
import {
  buildComplexityProfile,
  interactionFailureProbability,
  irt2pl,
  modelSensitivity,
  multidimensionalIrt,
  summarizeComputeDistribution,
} from '../src/research/complexity/lab.ts';
import { brierScore, complexityCalibrationGate, expectedCalibrationError } from '../src/research/complexity/calibration.ts';

test('execution plans have stable content addresses and canonical JSON refuses non-finite evidence', () => {
  assert.equal(canonicalJson({ b: 2, a: 1 }), '{"a":1,"b":2}');
  const first = executionPlanKey({ provider: 'openai', model: 'gpt-x', retryPolicy: 'none', outputLimit: 1000 });
  const second = executionPlanKey({ outputLimit: 1000, model: 'gpt-x', provider: 'openai', retryPolicy: 'none' });
  assert.equal(first, second);
  assert.equal(first.length, 64);
  assert.throws(() => canonicalJson({ bad: Number.NaN }), /non-finite/);
  assert.throws(() => executionPlanKey({ provider: '', model: 'x' }), /requires provider and model/);
});

function decision(decisionId: string, selectedPlanKey = 'plan-a'): DecisionBody {
  return {
    decisionId,
    decidedAtMs: 1_700_000_000_000,
    contextHash: 'context-sha',
    candidatePlans: [
      {
        planKey: 'plan-a', qualityLower: 0.9, costUpperMicros: 2_000_000,
        latencyUpperMs: 1000, riskUpper: 0.02, valueLowerMicros: 5_000_000, assumptions: [],
      },
      {
        planKey: 'plan-b', qualityLower: 0.88, costUpperMicros: 1_000_000,
        latencyUpperMs: 900, riskUpper: 0.02, valueLowerMicros: 4_000_000, assumptions: ['observational'],
      },
    ],
    selectedPlanKey,
    policyVersion: 'policy-v1',
    selectionProbability: 0.7,
    constraints: { minQuality: 0.85 },
    remainingBudgetMicros: 100_000_000,
    stage: 'simulate',
    evidenceGrade: 'C',
  };
}

test('Decision Ledger is append-only/hash-chained and detects tampering or invalid selections', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fiscus-decisions-'));
  const path = join(dir, 'decisions.jsonl');
  try {
    const one = appendDecision(path, decision('d-1'));
    const two = appendDecision(path, decision('d-2', 'plan-b'));
    assert.equal(one.sequence, 1);
    assert.equal(two.sequence, 2);
    assert.equal(two.prevHash, one.recordHash);
    assert.equal(readDecisionLedger(path).length, 2);
    assert.throws(() => appendDecision(path, decision('d-2')), /already exists/);
    assert.throws(() => appendDecision(join(dir, 'bad.jsonl'), decision('d-bad', 'missing')), /selectedPlanKey/);

    const rows = readFileSync(path, 'utf8').trim().split('\n');
    const parsed = JSON.parse(rows[0]!) as { body: { policyVersion: string } };
    parsed.body.policyVersion = 'tampered';
    rows[0] = JSON.stringify(parsed);
    writeFileSync(path, `${rows.join('\n')}\n`, 'utf8');
    assert.throws(() => readDecisionLedger(path), /hash mismatch/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

function plan(overrides: Partial<EvidencePlan> & Pick<EvidencePlan, 'planKey'>): EvidencePlan {
  return {
    qualityLower: 0.9,
    costUpperMicros: 2_000_000,
    latencyUpperMs: 1000,
    riskUpper: 0.02,
    valueLowerMicros: null,
    policyAllowed: true,
    ...overrides,
  };
}

test('Evidence-Constrained Frontier proves dominance only through known active dimensions', () => {
  const incumbent = plan({ planKey: 'incumbent', costUpperMicros: 2_000_000, latencyUpperMs: 1000 });
  const better = plan({ planKey: 'better', costUpperMicros: 1_000_000, latencyUpperMs: 900 });
  assert.equal(evidenceDominates(better, incumbent, ['quality', 'cost', 'latency', 'risk']), true);

  const unknown = plan({ planKey: 'unknown', costUpperMicros: null, latencyUpperMs: 500 });
  assert.equal(evidenceDominates(unknown, incumbent, ['quality', 'cost', 'latency', 'risk']), false);

  const result = evidenceConstrainedFrontier([incumbent, better, unknown], { minQuality: 0.85, dimensions: ['quality', 'cost', 'latency', 'risk'] });
  assert.deepEqual(result.frontier.map((item) => item.planKey).sort(), ['better', 'unknown']);
  assert.deepEqual(result.unresolvedDimensions.unknown, ['cost']);

  const constrained = evidenceConstrainedFrontier([unknown], { maxCostMicros: 2_000_000 });
  assert.equal(constrained.feasible.length, 0);
  assert.match(constrained.excluded[0]!.reasons.join(' '), /unknown/);
});

test('budget-risk keeps empty evidence unknown and exposes tail/breach risk', () => {
  const empty = summarizeBudgetRisk([], 10_000);
  assert.equal(empty.expectedMicros, null);
  assert.equal(empty.breachProbability, null);

  const report = summarizeBudgetRisk([
    { costMicros: 1_000, weight: 90 },
    { costMicros: 5_000, weight: 9 },
    { costMicros: 50_000, weight: 1 },
  ], 10_000);
  assert.equal(report.scenarioCount, 3);
  assert.ok((report.expectedMicros ?? 0) > 0);
  assert.equal(report.p99Micros, 5_000);
  assert.equal(report.cvar99Micros, 50_000);
  assert.ok(Math.abs((report.breachProbability ?? 0) - 0.01) < 1e-12);
  assert.throws(() => summarizeBudgetRisk([{ costMicros: -1 }], 100), /non-negative/);
});

test('scarcity dual rises when ahead of budget trajectory and never goes below zero', () => {
  assert.ok(updateScarcityDual(1, 120, 100, 0.5) > 1);
  assert.ok(updateScarcityDual(0.01, 0, 100, 1) >= 0);
  assert.throws(() => updateScarcityDual(0, 1, 0), /target/);
});

function promotionEvidence(overrides: Partial<PromotionEvidence> = {}): PromotionEvidence {
  return {
    lowerBoundNetImprovementMicros: 100,
    qualityRegretUpper: 0.01,
    maxQualityRegret: 0.02,
    breachProbability: 0.01,
    maxBreachProbability: 0.05,
    independentSamples: 200,
    minSamples: 100,
    explorationBudgetMicros: 1_000_000,
    driftAlarm: false,
    policyAllowed: true,
    canarySamples: 150,
    minCanarySamples: 100,
    ...overrides,
  };
}

test('policy promotion is one-stage, evidence-gated, and never equates eligibility with enforcement', () => {
  assert.deepEqual(promotionDecision('observe', promotionEvidence()).nextEligible, 'simulate');
  assert.equal(promotionDecision('simulate', promotionEvidence()).nextEligible, 'recommend');
  assert.equal(promotionDecision('recommend', promotionEvidence()).nextEligible, 'canary');
  assert.equal(promotionDecision('canary', promotionEvidence()).nextEligible, 'enforce');
  assert.equal(promotionDecision('simulate', promotionEvidence({ lowerBoundNetImprovementMicros: null })).promotable, false);
  assert.equal(promotionDecision('recommend', promotionEvidence({ explorationBudgetMicros: 0 })).promotable, false);
  assert.equal(promotionDecision('canary', promotionEvidence({ canarySamples: 2 })).promotable, false);
  assert.equal(promotionDecision('simulate', promotionEvidence({ driftAlarm: true })).promotable, false);
});

test('Metric Safety refuses token-maxxing and compensation endorsement', () => {
  const bad = assessMetricUse('token_count', 'individual_performance');
  assert.equal(bad.allowed, false);
  assert.ok(bad.classes.includes('resource_accounting'));
  assert.ok(bad.classes.includes('incentive_unsafe'));
  assert.match(bad.reason, /token-maxxing/);

  const accounting = assessMetricUse('token_count', 'resource_accounting');
  assert.equal(accounting.allowed, true);
  assert.match(accounting.reason, /not output or productivity/);

  const compensation = assessMetricUse('incremental_value', 'compensation');
  assert.equal(compensation.allowed, false);
  assert.ok(compensation.classes.includes('compensation_prohibited'));
});

test('AI capital accounts conserve transfers, protect exploration, and keep outcome value outside budget arithmetic', () => {
  let state = createCapitalState([
    { id: 'org', parentId: null, productionMicros: 10_000, explorationMicros: 2_000, reserveMicros: 1_000 },
    { id: 'team', parentId: 'org', productionMicros: 0, explorationMicros: 0, reserveMicros: 0 },
  ]);
  const before = totalAvailableCapital(state);
  state = applyCapitalTransaction(state, { kind: 'transfer', from: 'org', to: 'team', bucket: 'production', amountMicros: 4_000, reason: 'base budget' });
  assert.equal(totalAvailableCapital(state), before);
  state = applyCapitalTransaction(state, { kind: 'spend', account: 'team', bucket: 'production', amountMicros: 1_500, reason: 'production run' });
  assert.equal(totalAvailableCapital(state), before - 1_500);
  assert.equal(state.consumedByAccount.team?.productionMicros, 1_500);
  assert.equal(state.accounts.find((item) => item.id === 'org')?.explorationMicros, 2_000);
  assert.throws(
    () => applyCapitalTransaction(state, { kind: 'spend', account: 'team', bucket: 'production', amountMicros: 9_000, reason: 'cannot raid exploration' }),
    /insufficient production/,
  );
  assert.throws(
    () => validateCapitalHierarchy([
      { id: 'a', parentId: 'b', productionMicros: 0, explorationMicros: 0, reserveMicros: 0 },
      { id: 'b', parentId: 'a', productionMicros: 0, explorationMicros: 0, reserveMicros: 0 },
    ]),
    /cycle/,
  );
});

test('exact Shapley decomposition explains modeled spend and withholds unidentified counterfactuals', () => {
  const result = exactShapleyDecomposition(
    { volume: 10, price: 2, retries: 1 },
    { volume: 15, price: 3, retries: 2 },
    (x) => x.volume! * x.price! + 4 * x.retries!,
  );
  assert.equal(result.identified, true);
  assert.ok(Math.abs(result.residual ?? 1) < 1e-10);
  assert.ok(result.contributions.every((item) => item.contribution !== null));

  const unknown = exactShapleyDecomposition(
    { a: 0, b: 0 },
    { a: 1, b: 1 },
    (x) => x.a === 1 && x.b === 0 ? null : x.a! + x.b!,
  );
  assert.equal(unknown.identified, false);
  assert.ok(unknown.missingCoalitions > 0);
});

test('spend residual and opportunity gap are diagnostics, not inferred productivity/savings', () => {
  const diag = standardizedSpendDiagnostic(120, 100);
  assert.equal(diag.residual, 20);
  assert.equal(diag.standardizedSpendRatio, 1.2);
  assert.equal(diag.label, 'process_diagnostic_not_productivity');
  assert.equal(opportunityGap(120, 80, false), null);
  assert.equal(opportunityGap(120, null, true), null);
  assert.equal(opportunityGap(120, 80, true), 40);
});

test('off-policy evaluation withholds without overlap and reports weight diagnostics when enabled', () => {
  const rows = [
    { reward: 1, behaviorProbability: 0.5, targetProbability: 0.5, directObservedAction: 0.8, directTargetPolicy: 0.8 },
    { reward: 0, behaviorProbability: 0.5, targetProbability: 0.5, directObservedAction: 0.2, directTargetPolicy: 0.2 },
  ];
  assert.equal(selfNormalizedIps(rows).estimate, null);
  const snips = selfNormalizedIps(rows, { overlapAsserted: true });
  assert.equal(snips.estimate, 0.5);
  assert.equal(snips.effectiveSampleSize, 2);
  const dr = doublyRobustEstimate(rows, { overlapAsserted: true });
  assert.ok(dr.estimate !== null);
  assert.equal(dr.clippedWeights, 0);
});

test('Complexity Lab stays vector-valued and exposes model-conditioned research primitives', () => {
  const compute = summarizeComputeDistribution([10, 20, 30, 40, 1000]);
  const profile = buildComplexityProfile({
    structural: 0.4,
    informational: null,
    interaction: 0.2,
    execution: 0.6,
    epistemic: 0.3,
    economic: 0.5,
    modelSensitivity: 0.2,
    predictedCompute: compute,
    confidence: 0.7,
    provenance: ['local_structural_features'],
  });
  assert.equal(profile.informational, null);
  assert.equal(profile.predictedCompute?.p99, 1000);
  assert.throws(() => buildComplexityProfile({ ...profile, structural: 2 }), /\[0,1\]/);

  assert.ok(irt2pl(1, 0, 1) > irt2pl(0, 1, 1));
  assert.ok(multidimensionalIrt([1, 1], [0, 0], [1, 2]) > 0.5);
  assert.equal(modelSensitivity([0.2, 0.8, 0.5]), 0.6000000000000001);
  const p = interactionFailureProbability([1, 1], {
    intercept: -1,
    linear: [0.5, 0.5],
    pairwise: [{ i: 0, j: 1, weight: 1 }],
  });
  assert.ok(p > 0.5);
  assert.deepEqual(summarizeComputeDistribution([]), { count: 0, mean: null, p50: null, p90: null, p99: null, cvar99: null });
});

test('Complexity calibration must beat a simple held-out baseline before becoming a routing input', () => {
  assert.equal(brierScore([]), null);
  assert.equal(expectedCalibrationError([]), null);
  const observations = Array.from({ length: 400 }, (_, index) => {
    const outcome = (index % 2 === 0 ? 1 : 0) as 0 | 1;
    return {
      outcome,
      baselineProbability: 0.8,
      candidateProbability: outcome === 1 ? 0.9 : 0.1,
    };
  });
  const good = complexityCalibrationGate(observations, { minSamples: 200, minBrierImprovement: 0.1, maxEceRegression: 0 });
  assert.equal(good.eligibleForRoutingInput, true);
  assert.ok((good.brierImprovement ?? 0) > 0.1);
  assert.ok((good.pairedLossUpperBound ?? 1) < -0.1);

  const thin = complexityCalibrationGate(observations.slice(0, 10), { minSamples: 200 });
  assert.equal(thin.eligibleForRoutingInput, false);
  assert.match(thin.reasons.join(' '), /held-out sample/);

  const worse = observations.map((row) => ({ ...row, candidateProbability: row.outcome === 1 ? 0.1 : 0.9 }));
  assert.equal(complexityCalibrationGate(worse, { minSamples: 200 }).eligibleForRoutingInput, false);
});
