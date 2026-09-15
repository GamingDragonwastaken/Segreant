import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { computeReturnOnIntelligence } from '../src/value/lenses.ts';
import { instrumentationPriority } from '../src/value/instrumentationSensitivity.ts';
import { valueOfInformation } from '../src/decision/engine.ts';
import { gateResultFromVerdict, scoreFunnel, type Gate, type GateResult, type Verdict } from '../src/value/gates.ts';

const read = (path: string): string => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

function gate(g: Gate, verdict: Verdict): GateResult {
  return gateResultFromVerdict(g, verdict, '');
}

function roiFixture() {
  const pass: Record<Gate, GateResult> = {
    proposed: gate('proposed', 'pass'), accepted: gate('accepted', 'pass'), committed: gate('committed', 'pass'),
    tested: gate('tested', 'pass'), merged: gate('merged', 'pass'), shipped: gate('shipped', 'pass'),
    survived: gate('survived', 'pass'), clean: gate('clean', 'pass'),
  };
  const failed: Record<Gate, GateResult> = { ...pass, survived: gate('survived', 'fail') };
  const units = [
    ...Array.from({ length: 7 }, () => ({ maturing: false, acceptance: null, funnel: scoreFunnel(pass) })),
    ...Array.from({ length: 3 }, () => ({ maturing: false, acceptance: null, funnel: scoreFunnel(failed) })),
  ];
  return computeReturnOnIntelligence({
    firstPassAcceptance: null,
    units,
    matured: { realizationRate: 0.7, totalCostUsd: 10, spendOnRealizedUnitsUsd: 7 },
  }, { impact: 0.7, impactHow: 'fixture outcome signal' });
}

test('instrumentation sensitivity is an exposure ranking, not an acquisition-cost decision', () => {
  const priority = instrumentationPriority(roiFixture());
  assert.ok(priority.length > 0);
  assert.deepEqual(Object.keys(priority[0]!).sort(), [
    'deltaAtReference', 'indexAtReference', 'lens', 'reference', 'weight',
  ]);
  assert.equal('measurementCost' in priority[0]!, false);
  assert.equal('acquisitionCost' in priority[0]!, false);

  const sensitivitySource = read('src/value/instrumentationSensitivity.ts');
  assert.doesNotMatch(sensitivitySource, /measurementCost|acquisitionCost|costEffectiveness/i);

  const userFacingSensitivity = [
    read('src/cli/valueCmd.ts'),
    read('docs/FAQ.md'),
    read('docs/RETURN-ON-INTELLIGENCE.md'),
  ].join('\n');
  assert.doesNotMatch(userFacingSensitivity, /\bcheapest\b|\bbuy next\b|\bcost[- ]effectiveness\b/i);
  assert.match(userFacingSensitivity, /largest sensitivity\/measurement exposure/i);
});

test('formal decision VoI remains the only sensitivity-adjacent result with an acquisition cost', () => {
  const voi = valueOfInformation({
    posteriorScenarios: [{ probability: 1, expectedUtilities: { keep: 0, change: 4 } }],
    measurementCost: 1.5,
  });
  assert.equal(voi.measurementCost, 1.5);
  assert.equal(voi.netValue, voi.grossValue - voi.measurementCost);
  assert.match(read('src/decision/engine.ts'), /measurement cost/i);
});
