import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildClaimLayers } from '../src/dashboard/web/app/core/claimLayers.ts';

const empty = () => buildClaimLayers({ overview: null, billing: null, allocation: null, value: null }, '30d');

test('Claim Inspector metadata exists for all four independent claims and missing claims remain missing, never zero', () => {
  const layers = empty();
  assert.deepEqual(layers.map((x) => x.id), ['metered', 'billed', 'allocated', 'realized']);
  for (const layer of layers) {
    assert.equal(layer.established, false);
    assert.equal(layer.valueUsd, null);
    assert.ok(layer.inspection.provenance);
    assert.ok(layer.inspection.scope);
    assert.ok(layer.inspection.freshness);
    assert.ok(layer.inspection.coverage);
    assert.ok(layer.inspection.enforceability);
    assert.ok(layer.inspection.evidenceSource);
    assert.ok(layer.inspection.missingEvidence.length > 0);
  }
});

test('metered evidence never promotes itself into billed evidence', () => {
  const [metered, billed] = buildClaimLayers({
    overview: { demo:false, range:'30d', generatedAt:'now', summary:{requests:3,costUsd:1.25}, pricing:{status:{fresh:true},estimatedCostUsd:0,estimatedSpendShare:0}, byModel:[],byProject:[],bySource:[],series:[],recent:[] },
    billing: { demo:false, evidence:{reconciliationStatus:'never'}, summary:{recordCount:0}, reconciliation:{runs:[]} },
    allocation:null, value:null,
  }, '30d');
  assert.equal(metered?.established, true);
  assert.equal(metered?.valueUsd, 1.25);
  assert.equal(billed?.established, false);
  assert.equal(billed?.valueUsd, null);
});

test('allocation and realized inspections state their non-enforcement boundaries explicitly', () => {
  const layers = buildClaimLayers({
    overview:null, billing:null,
    allocation:{demo:false,kind:'showback',trust:'local_rule',basis:'metered',excludedFrom:['provider bill'],costCentres:[{id:'a'}],rules:[],runs:[{}],reconciliation:{everRun:false,latestComputedAtMs:null}},
    value:{demo:false,allocation:null,valueSource:'store',gitRepo:false,projectScoped:true,realization:{matured:{units:2,realizedUnits:1,realizationRate:.5,totalCostUsd:2,realizedValueUsd:1}},roi:{coverage:.5,returnRatio:{basis:'usd',realizedValueUsd:4}}},
  }, '30d');
  assert.match(layers[2]!.inspection.enforceability, /showback/i);
  assert.match(layers[3]!.inspection.enforceability, /outcome\/value claim/i);
});
