/**
 * The four claims, derived from payloads, with their evidence.
 *
 * `buildClaimLayers` is where this product actually makes its claims, so it is
 * the one piece of the GUI that must be reachable without a browser. These
 * tests exercise it as a pure function over fixtures: no server, no socket, no
 * ledger. What they pin is not the wording but the REFUSALS —
 *
 *     metered usage != provider-billed cost != allocated cost != realized value
 *
 * — each of which has a specific way of collapsing, and each of which has
 * collapsed here before.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildClaimLayers, type ClaimInputs } from '../src/dashboard/web/app/core/claimLayers.ts';
import type { Overview, BillingPayload, AllocationPayload, ValuePayload, ReconciliationRunRecord } from '../src/dashboard/web/app/core/api.ts';

const NOTHING: ClaimInputs = { overview: null, billing: null, allocation: null, value: null };

const anOverview = (costUsd: number, requests: number): Overview => ({
  demo: false,
  range: '30d',
  generatedAt: '2026-08-01T00:00:00.000Z',
  summary: { requests, costUsd },
  pricing: { status: { fresh: true }, autoRefresh: false, estimatedCostUsd: 0, estimatedSpendShare: 0, provenance: [] },
  budget: { dailyUsd: null, dailySoftUsd: null, todaySpendUsd: 0, todayImportedUsd: 0, capExcludesImported: true, remainingDailyUsd: null },
  byModel: [], byProject: [], attributionEvidence: [], bySource: [], byUser: [],
  characterization: { byProject: [], byModel: [], bySource: [], byUser: [] }, dimensions: [], series: [], recent: [],
});

const aBilling = (recordCount: number, runs: ReconciliationRunRecord[] = []): BillingPayload => ({
  demo: false,
  evidence: { reconciliationStatus: 'not_reconciled' },
  summary: { recordCount },
  reconciliation: { runs },
});

test('every claim answers all six evidence dimensions, and an unanswered one says so', () => {
  const layers = buildClaimLayers(NOTHING, '30d');
  assert.deepEqual(layers.map((l) => l.id), ['metered', 'billed', 'allocated', 'realized']);

  for (const layer of layers) {
    assert.equal(layer.established, false, `${layer.id} cannot be established with no payload`);
    assert.equal(layer.valueUsd, null, `${layer.id} must be null, never 0 — an absence is not a measurement`);
    for (const dim of ['provenance', 'scope', 'freshness', 'coverage', 'enforceability', 'evidenceSource'] as const) {
      assert.equal(typeof layer.inspection[dim], 'string');
      assert.ok(layer.inspection[dim].length > 0, `${layer.id}.${dim} must state something, even if it is "not established"`);
    }
    assert.ok(layer.inspection.missingEvidence.length > 0, `${layer.id} must name what would establish it`);
    assert.ok(layer.nextStep, `${layer.id} must tell the operator what to do`);
  }
});

test('freshness is never invented — with nothing recorded it is "not established", not now', () => {
  const layers = buildClaimLayers(NOTHING, '30d');
  const before = Date.now();
  for (const layer of layers) {
    assert.equal(
      Number.isNaN(Date.parse(layer.inspection.freshness)),
      true,
      `${layer.id} freshness parsed as a real instant with no evidence behind it: ${layer.inspection.freshness}`,
    );
  }
  // Guard against the test passing because the clock did something odd.
  assert.ok(Date.now() >= before);
});

test('metered evidence never promotes itself into billed evidence', () => {
  const [metered, billed] = buildClaimLayers(
    { ...NOTHING, overview: anOverview(1.25, 3), billing: aBilling(0) },
    '30d',
  );
  assert.equal(metered!.established, true);
  assert.equal(metered!.valueUsd, 1.25);
  assert.equal(billed!.established, false);
  assert.equal(billed!.valueUsd, null);
  assert.match(metered!.inspection.enforceability, /does not become billed cost/);
});

test('holding a provider bill is not the same claim as reconciling against it', () => {
  const [, billed] = buildClaimLayers({ ...NOTHING, billing: aBilling(412) }, '30d');
  assert.equal(billed!.established, false, '412 imported records establish nothing on their own');
  assert.match(billed!.basis, /412 provider records held, none reconciled yet/);
  assert.match(billed!.inspection.provenance, /unreconciled/);
  assert.deepEqual(billed!.inspection.missingEvidence, [
    'a compatible provider observation or export',
    'a completed reconciliation run',
  ]);
});

test('a recorded run establishes Billed, and carries the provider report conditions as assumptions', () => {
  const [, billed] = buildClaimLayers({
    ...NOTHING,
    billing: aBilling(412, [{
      reconciliationRunId: 'rec-1',
      computedAtMs: Date.UTC(2026, 7, 1),
      result: {
        providerSourceKind: 'operator_supplied_export',
        conditions: ['provider_report_is_operator_supplied_and_unverified'],
      },
    }]),
  }, '30d');

  assert.equal(billed!.established, true);
  assert.equal(billed!.inspection.freshness, '2026-08-01T00:00:00.000Z');
  assert.equal(billed!.inspection.scope, 'reconciliation run rec-1');
  // An operator-typed export and a provider-authenticated pull are both
  // "reconciled". Only this line distinguishes them, so it must not be empty.
  assert.deepEqual(billed!.inspection.assumptions, ['provider_report_is_operator_supplied_and_unverified']);
  assert.deepEqual(billed!.inspection.missingEvidence, []);
});

test('the realized figure is the VALUE produced, never the spend attributed to it', () => {
  // The payload carries two fields spelled `realizedValueUsd`. `matured` holds
  // the attributed COST of the units that realized; `roi.returnRatio` holds the
  // manual-equivalent VALUE they produced. Reading the first one renders a cost
  // in the band whose entire job is to not be a cost.
  const value = {
    demo: false,
    allocation: null,
    valueSource: 'git',
    gitRepo: true,
    projectScoped: true,
    realization: { matured: { units: 4, realizedUnits: 2, realizationRate: 0.5, totalCostUsd: 9, realizedValueUsd: 2 } },
    roi: { coverage: 0.5, notes: ['lift is uninstrumented'], returnRatio: { basis: 'usd', realizedValueUsd: 40 } },
  } as unknown as ValuePayload;

  const realized = buildClaimLayers({ ...NOTHING, value }, '30d')[3]!;
  assert.equal(realized.established, true);
  assert.equal(realized.valueUsd, 40, 'must be the value claim, not the 2 dollars of attributed spend');
  assert.equal(realized.inspection.coverage, '50% RoI lens coverage');
  assert.deepEqual(realized.inspection.assumptions, ['lift is uninstrumented']);
});

test('matured units with no labour rate are units, not dollars', () => {
  const value = {
    demo: false, allocation: null, valueSource: 'git', gitRepo: true, projectScoped: true,
    realization: { matured: { units: 4, realizedUnits: 2, realizationRate: 0.5, totalCostUsd: 9, realizedValueUsd: 2 } },
    roi: { coverage: 0.5, returnRatio: { basis: 'ratio', grossRatio: 3 } },
  } as unknown as ValuePayload;

  const realized = buildClaimLayers({ ...NOTHING, value }, '30d')[3]!;
  assert.equal(realized.established, false, 'a ratio is not a dollar figure');
  assert.equal(realized.valueUsd, null);
  assert.deepEqual(realized.inspection.missingEvidence, ['a labour rate, so realized work can be priced']);
});

test('allocation and realized state the boundary of what they can enforce', () => {
  const allocation: AllocationPayload = {
    demo: false, kind: 'showback', trust: 'local_rule', basis: 'metered_request_cost',
    excludedFrom: ['provider_invoice'], costCentres: [{ id: 'a' }], rules: [],
    runs: [{ allocationRunId: 'run-1', computedAtMs: Date.UTC(2026, 7, 2) }],
    reconciliation: { everRun: false, latestComputedAtMs: null },
  };
  const layers = buildClaimLayers({ ...NOTHING, allocation }, '30d');

  assert.equal(layers[2]!.established, true, 'one immutable run establishes the allocation claim');
  assert.match(layers[2]!.inspection.enforceability, /showback claim; an allocation moves no money/);
  assert.equal(layers[2]!.inspection.coverage, 'excluded from: provider_invoice');
  assert.equal(layers[2]!.inspection.freshness, '2026-08-02T00:00:00.000Z', 'dated by the allocation run itself');
  assert.match(layers[3]!.inspection.enforceability, /never evidence that a provider bill or a local budget was enforced/);
});

test('the allocation claim is never dated by the billing reconciliation', () => {
  // `/api/allocation` carries `reconciliation.latestComputedAtMs` as a
  // deliberate cross-reference to the BILLING run — it is filled from
  // `store.reconciliationRuns(1)`. It sits next to the allocation runs and
  // looks like the freshness answer. It is not: reading it here dated an
  // allocation with zero recorded runs by the moment someone reconciled a
  // provider bill, which is one claim's evidence presented as another's.
  const billingRunMs = Date.UTC(2026, 7, 21);
  const allocation: AllocationPayload = {
    demo: false, kind: 'derived_cost_allocation', trust: 'derived_allocation_of_local_estimates',
    basis: 'showback_only', excludedFrom: ['request_metered_spend'],
    costCentres: [], rules: [], runs: [],
    reconciliation: { everRun: true, latestComputedAtMs: billingRunMs },
  };
  const allocated = buildClaimLayers({ ...NOTHING, allocation }, '30d')[2]!;

  assert.equal(allocated.established, false, 'zero allocation runs establishes nothing');
  assert.equal(allocated.inspection.freshness, 'not established');
  assert.equal(
    allocated.inspection.freshness.includes('2026-08-21'),
    false,
    'the billing reconciliation timestamp must not surface as allocation freshness',
  );
  // It is still worth stating — as something the claim RESTS on.
  assert.ok(
    allocated.inspection.assumptions.some((s) => s.includes('metered estimates last reconciled')),
    'the cross-reference belongs in assumptions, not in freshness',
  );
});

test('an unreconciled allocation says its inputs were never checked against a bill', () => {
  const allocation: AllocationPayload = {
    demo: false, kind: 'derived_cost_allocation', trust: 'derived_allocation_of_local_estimates',
    basis: 'showback_only', excludedFrom: [], costCentres: [], rules: [],
    runs: [{ allocationRunId: 'run-1', computedAtMs: Date.UTC(2026, 7, 2) }],
    reconciliation: { everRun: false, latestComputedAtMs: null },
  };
  const allocated = buildClaimLayers({ ...NOTHING, allocation }, '30d')[2]!;
  assert.equal(allocated.established, true);
  assert.equal(allocated.inspection.freshness, '2026-08-02T00:00:00.000Z');
  assert.ok(allocated.inspection.assumptions.some((s) => /residual against a provider bill has never been checked/.test(s)));
});

test('a dead endpoint degrades its own layer, and reads as missing evidence rather than zero', () => {
  // What `chain.ts` hands over when one of the four reads rejects.
  const layers = buildClaimLayers({ ...NOTHING, overview: anOverview(5, 10) }, '30d');
  assert.equal(layers[0]!.established, true);
  assert.equal(layers[1]!.inspection.coverage, 'billing endpoint unavailable');
  assert.equal(layers[2]!.inspection.coverage, 'allocation endpoint unavailable');
  assert.equal(layers[3]!.inspection.provenance, 'no outcome source established');
  for (const l of layers.slice(1)) assert.equal(l.valueUsd, null);
});
