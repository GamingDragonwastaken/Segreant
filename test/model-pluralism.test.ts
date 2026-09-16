import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeFrontier } from '../src/value/frontier.ts';
import type { WorkUnit } from '../src/value/realization.ts';
import { GATE_LADDER, gateResultFromVerdict } from '../src/value/gates.ts';
import { canonicalModelAttribution, type EffectiveRequestRow } from '../src/store/economicReadModel.ts';
import { money } from '../src/economics/money.ts';

let sequence = 0;

function frontierUnit(provider: string, model: string): WorkUnit {
  sequence += 1;
  return {
    hash: `model-pluralism-${sequence}`,
    tsEpochMs: sequence * 86_400_000,
    subject: '',
    linesAdded: 10,
    linesDeleted: 0,
    filesChanged: 1,
    windowStartMs: 0,
    windowEndMs: 0,
    attributedCostUsd: 1,
    attributedRequests: 1,
    attributedOutputTokens: 0,
    costPerHundredLines: null,
    spendWindowTruncated: false,
    spendWindowPrunedBeforeMs: null,
    ageDays: 30,
    maturing: false,
    survivalRatio: 1,
    reverted: false,
    hadProposal: false,
    acceptance: null,
    taskType: 'feature',
    dominantProvider: provider,
    dominantModel: model,
    dominantModelCostUsd: 1,
    dominantModelCostShare: 1,
    dominantModelCostBasis: 'local_list_price',
    dominantModelRateCard: 'card-a',
    costStale: false,
    funnel: {
      realized: true,
      results: GATE_LADDER.map((gate) => gateResultFromVerdict(gate, 'pass', '')),
      conflicts: [],
      reachedIndex: GATE_LADDER.length - 1,
      reached: GATE_LADDER[GATE_LADDER.length - 1] ?? null,
      diedAt: null,
      diedAtIndex: null,
      passes: GATE_LADDER.length,
      fails: 0,
      unknowns: 0,
      instrumented: GATE_LADDER.length,
      realizationScore: 1,
    },
  } as WorkUnit;
}

function economicRow(
  requestId: string,
  provider: string,
  model: string,
): EffectiveRequestRow {
  return {
    requestId,
    tsEpochMs: 1_000,
    sessionId: null,
    provider,
    model,
    project: 'fiscus',
    projectCanonical: 'fiscus',
    source: 'proxy',
    user: null,
    via: 'proxy',
    compatibilityCostUsd: 1,
    effectiveAmount: money('1', 'USD', 'effective'),
    fxTranslation: null,
    sourceBases: ['list'],
    sourceEventIds: [`economic:request:${requestId}:charge`],
    unresolvedReason: null,
  };
}

test('frontier keeps separator-bearing provider/model identities distinct', () => {
  const report = computeFrontier([
    frontierUnit('provider', 'model\u0000x'),
    frontierUnit('provider', 'model\u0000x'),
    frontierUnit('provider', 'model\u0000x'),
    frontierUnit('provider\u0000model', 'x'),
    frontierUnit('provider\u0000model', 'x'),
    frontierUnit('provider\u0000model', 'x'),
  ]);

  assert.equal(report.byModel.length, 2);
  assert.deepEqual(
    report.byModel.map((cell) => [cell.provider, cell.model]).sort(),
    [
      ['provider', 'model\u0000x'],
      ['provider\u0000model', 'x'],
    ].sort(),
  );
});

test('canonical exact attribution keeps separator-bearing provider/model groups distinct', () => {
  const result = canonicalModelAttribution([
    economicRow('left', 'provider', 'model\u0000x'),
    economicRow('right', 'provider\u0000model', 'x'),
  ]);

  assert.equal(result.coverage, 'exact');
  assert.equal(result.groups.length, 2);
  assert.deepEqual(
    result.groups.map((group) => [group.provider, group.model]).sort(),
    [
      ['provider', 'model\u0000x'],
      ['provider\u0000model', 'x'],
    ].sort(),
  );
});
