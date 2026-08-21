/**
 * Cost-centre allocation.
 *
 * Two things carry the weight here. Money must be conserved to the microdollar —
 * an allocation layer that loses or invents cents is worse than none, because
 * the whole point is auditability. And spend that no rule claimed must stay
 * UNALLOCATED with a reason: a rule set that swept the remainder into a fallback
 * would report full coverage of an organization it never described.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.FISCUS_HOME = mkdtempSync(join(tmpdir(), 'aegis-home-'));

import {
  applyAllocation,
  type AllocationRunResult,
} from '../src/alloc/apply.ts';
import {
  distributeMicros,
  orderRules,
  ruleAppliesAt,
  validateRule,
  validateCostCentre,
  RATIO_SCALE,
  type AllocatableRow,
  type AllocationRule,
  type CostCentre,
} from '../src/alloc/rules.ts';
import { Store, type RequestRow } from '../src/store/db.ts';

const DAY = 24 * 60 * 60 * 1000;
const T0 = Date.UTC(2026, 6, 1);

function rule(over: Partial<AllocationRule> = {}): AllocationRule {
  return {
    ruleId: 'r1',
    version: 1,
    method: 'direct',
    match: {},
    targets: [{ costCentreId: 'eng', ratio: 1 }],
    priority: 100,
    effectiveFromMs: 0,
    effectiveToMs: null,
    revokedAtMs: null,
    owner: null,
    note: null,
    createdAtMs: 0,
    ...over,
  };
}

function centre(id: string, archivedAtMs: number | null = null): CostCentre {
  return { costCentreId: id, name: id, owner: null, createdAtMs: 0, archivedAtMs };
}

let rowSeq = 0;
function row(costUsd: number, over: Partial<AllocatableRow> = {}): AllocatableRow {
  return {
    project: 'backend-api',
    provider: 'openai',
    model: 'gpt-4o',
    source: 'cursor',
    user: 'alice@team',
    tsEpochMs: T0 + (rowSeq++ % 5) * DAY,
    costUsd,
    costBasis: 'local_list_price',
    ...over,
  };
}

function run(input: {
  rows: AllocatableRow[];
  rules?: AllocationRule[];
  costCentres?: CostCentre[];
}): AllocationRunResult {
  return applyAllocation({
    rows: input.rows,
    rules: input.rules ?? [],
    costCentres: input.costCentres ?? [centre('eng'), centre('platform'), centre('data')],
    periodStartMs: T0,
    periodEndMs: T0 + 30 * DAY,
    runAtMs: T0 + 31 * DAY,
  });
}

test('alloc: a direct rule places the whole matched slice, and money is conserved exactly', () => {
  const result = run({
    rows: [row(10), row(5.5), row(0.25)],
    rules: [rule({ match: { project: 'backend-api' } })],
  });
  assert.equal(result.totalMicros, 15_750_000);
  assert.equal(result.allocatedMicros, 15_750_000);
  assert.equal(result.unallocatedMicros, 0);
  assert.equal(result.conserves, true);
  assert.equal(result.byCostCentre[0]!.costCentreId, 'eng');
  assert.equal(result.lines[0]!.ruleVersion, 1, 'the line names the rule version that placed it');
  assert.equal(result.lines[0]!.sourceBasis, 'local_list_price', 'and the basis it was placed on');
});

test('alloc: unmatched spend stays unallocated with a reason and is never swept', () => {
  const result = run({
    rows: [row(10, { project: 'backend-api' }), row(4, { project: 'web-frontend' })],
    rules: [rule({ match: { project: 'backend-api' } })],
  });
  assert.equal(result.allocatedMicros, 10_000_000);
  assert.equal(result.unallocatedMicros, 4_000_000);
  assert.equal(result.conserves, true);
  assert.equal(result.unallocated.length, 1);
  assert.equal(result.unallocated[0]!.reason, 'no_matching_rule');
  // Actionable: an operator has to know WHICH spend to write a rule for.
  assert.deepEqual(result.unallocated[0]!.topProjects, [{ project: 'web-frontend', micros: 4_000_000 }]);
});

test('alloc: a fixed split conserves cents that do not divide evenly', () => {
  // $100 across three near-equal shares is the canonical case where rounding
  // each share independently loses a microdollar.
  const result = run({
    rows: [row(100)],
    rules: [rule({
      method: 'fixed_split',
      targets: [
        { costCentreId: 'eng', ratio: 0.333333 },
        { costCentreId: 'platform', ratio: 0.333333 },
        { costCentreId: 'data', ratio: 0.333334 },
      ],
    })],
  });
  assert.equal(result.conserves, true);
  assert.equal(result.allocatedMicros, 100_000_000, 'the parts sum to exactly the whole');
  const shares = result.lines.map((l) => l.allocatedMicros).sort((a, b) => a - b);
  assert.deepEqual(shares, [33_333_300, 33_333_300, 33_333_400], 'the declared policy, distributed exactly');
});

test('alloc: an odd total is distributed by largest remainder, losing nothing', () => {
  // 1 microdollar across three equal weights: two centres get 0, one gets 1,
  // and the total is still 1. Rounding each share would have produced 0.
  const result = run({
    rows: [row(0.000001)],
    rules: [rule({
      method: 'fixed_split',
      targets: [
        { costCentreId: 'eng', ratio: 0.333333 },
        { costCentreId: 'platform', ratio: 0.333333 },
        { costCentreId: 'data', ratio: 0.333334 },
      ],
    })],
  });
  assert.equal(result.totalMicros, 1);
  assert.equal(result.allocatedMicros, 1);
  assert.equal(result.conserves, true);
  assert.deepEqual(result.lines.map((l) => l.allocatedMicros).sort(), [0, 0, 1]);
});

test('alloc: a shared pool follows the direct allocations', () => {
  const result = run({
    rows: [
      row(30, { project: 'backend-api' }),
      row(10, { project: 'web-frontend' }),
      row(20, { project: 'shared-infra' }),
    ],
    rules: [
      rule({ ruleId: 'a', priority: 10, match: { project: 'backend-api' }, targets: [{ costCentreId: 'eng', ratio: 1 }] }),
      rule({ ruleId: 'b', priority: 11, match: { project: 'web-frontend' }, targets: [{ costCentreId: 'platform', ratio: 1 }] }),
      rule({ ruleId: 'pool', priority: 50, method: 'proportional_to_direct', match: { project: 'shared-infra' }, targets: [{ costCentreId: 'eng', ratio: 0 }] }),
    ],
  });
  assert.equal(result.conserves, true);
  assert.equal(result.unallocatedMicros, 0);
  const byCentre = new Map(result.byCostCentre.map((c) => [c.costCentreId, c.allocatedMicros]));
  // Direct: eng 30, platform 10 → the $20 pool splits 3:1.
  assert.equal(byCentre.get('eng'), 30_000_000 + 15_000_000);
  assert.equal(byCentre.get('platform'), 10_000_000 + 5_000_000);
});

test('alloc: a pool with no driver stays unallocated rather than splitting evenly', () => {
  // Splitting evenly would INVENT the driver the method exists to read.
  const result = run({
    rows: [row(20, { project: 'shared-infra' })],
    rules: [rule({ ruleId: 'pool', method: 'proportional_to_direct', match: { project: 'shared-infra' }, targets: [{ costCentreId: 'eng', ratio: 0 }] })],
  });
  assert.equal(result.allocatedMicros, 0);
  assert.equal(result.unallocatedMicros, 20_000_000);
  assert.equal(result.unallocated[0]!.reason, 'no_driver_for_proportional_pool');
  assert.equal(result.conserves, true);
});

test('alloc: rules match the instant the SPEND happened, not the instant of the run', () => {
  // Re-running a closed period after writing a new rule must not restate it
  // under rules that were not in force at the time.
  const early = row(10, { tsEpochMs: T0 + 1 * DAY });
  const late = row(10, { tsEpochMs: T0 + 20 * DAY });
  const result = run({
    rows: [early, late],
    rules: [rule({ effectiveFromMs: T0 + 10 * DAY })],
  });
  assert.equal(result.allocatedMicros, 10_000_000, 'only the spend inside the effective window');
  assert.equal(result.unallocatedMicros, 10_000_000);

  // The window is half-open, like every other window in the codebase.
  assert.equal(ruleAppliesAt(rule({ effectiveFromMs: 100, effectiveToMs: 200 }), 100), true);
  assert.equal(ruleAppliesAt(rule({ effectiveFromMs: 100, effectiveToMs: 200 }), 200), false);
  // A revoked rule stops applying from its revocation instant forward.
  assert.equal(ruleAppliesAt(rule({ revokedAtMs: 150 }), 149), true);
  assert.equal(ruleAppliesAt(rule({ revokedAtMs: 150 }), 150), false);
});

test('alloc: rule order is deterministic and first match wins', () => {
  const ordered = orderRules([
    rule({ ruleId: 'z', priority: 10 }),
    rule({ ruleId: 'a', priority: 10 }),
    rule({ ruleId: 'm', priority: 1 }),
  ]);
  assert.deepEqual(ordered.map((r) => r.ruleId), ['m', 'a', 'z'], 'priority, then id — never insertion order');

  const result = run({
    rows: [row(10)],
    rules: [
      rule({ ruleId: 'specific', priority: 1, match: { project: 'backend-api' }, targets: [{ costCentreId: 'eng', ratio: 1 }] }),
      rule({ ruleId: 'catch-all', priority: 99, match: {}, targets: [{ costCentreId: 'platform', ratio: 1 }] }),
    ],
  });
  assert.equal(result.byCostCentre.length, 1);
  assert.equal(result.byCostCentre[0]!.costCentreId, 'eng', 'the higher-priority rule claims it, once');
  assert.equal(result.allocatedMicros, 10_000_000, 'and it is not double-counted by the catch-all');
});

test('alloc: spend aimed at an archived cost centre is reported, not quietly dropped', () => {
  const result = run({
    rows: [row(7)],
    rules: [rule({ targets: [{ costCentreId: 'gone', ratio: 1 }] })],
    costCentres: [centre('gone', T0 + 5 * DAY)],
  });
  assert.equal(result.allocatedMicros, 0);
  assert.equal(result.unallocated[0]!.reason, 'target_cost_centre_archived');
  assert.equal(result.conserves, true);
});

test('alloc: a mixed-basis cohort says mixed rather than picking one', () => {
  const result = run({
    rows: [row(5, { costBasis: 'local_list_price' }), row(5, { costBasis: 'fallback_estimate' })],
    rules: [rule()],
  });
  assert.equal(result.lines[0]!.sourceBasis, 'mixed');
  assert.deepEqual(result.sourceBases, ['fallback_estimate', 'local_list_price']);
  // The trust label never upgrades itself on the strength of the rules.
  assert.equal(result.trust, 'derived_allocation_of_local_estimates');
  assert.deepEqual([...result.excludedFrom], ['request_metered_spend', 'budget_enforcement', 'roi', 'model_recommendations']);
});

test('alloc: an empty rule set allocates nothing and still conserves', () => {
  const result = run({ rows: [row(3), row(4)] });
  assert.equal(result.allocatedMicros, 0);
  assert.equal(result.unallocatedMicros, 7_000_000);
  assert.equal(result.conserves, true);
  assert.equal(result.byCostCentre.length, 0);
});

test('alloc: rule validation refuses what could not be applied truthfully', () => {
  // Ratios that do not sum to 1 are the headline gate.
  assert.throws(() => validateRule(rule({
    method: 'fixed_split',
    targets: [{ costCentreId: 'eng', ratio: 0.6 }, { costCentreId: 'platform', ratio: 0.3 }],
  })), /sum to exactly 1/);
  // An exact third is not a six-decimal ratio, so it is refused — and the error
  // tells the author what to write instead, because "1/3 is invalid" without a
  // remedy is where a policy author gives up and rounds badly on their own.
  assert.throws(() => validateRule(rule({
    method: 'fixed_split',
    targets: [
      { costCentreId: 'eng', ratio: 1 / 3 },
      { costCentreId: 'platform', ratio: 1 / 3 },
      { costCentreId: 'data', ratio: 1 / 3 },
    ],
  })), /0\.333333, 0\.333333, 0\.333334/);
  // The spelled-out version passes.
  assert.doesNotThrow(() => validateRule(rule({
    method: 'fixed_split',
    targets: [
      { costCentreId: 'eng', ratio: 0.333333 },
      { costCentreId: 'platform', ratio: 0.333333 },
      { costCentreId: 'data', ratio: 0.333334 },
    ],
  })));
  assert.throws(() => validateRule(rule({ targets: [{ costCentreId: 'eng', ratio: 1 }, { costCentreId: 'p', ratio: 1 }] })), /exactly one cost centre/);
  assert.throws(() => validateRule(rule({ targets: [] })), /at least one cost centre/);
  assert.throws(() => validateRule(rule({ targets: [{ costCentreId: 'eng', ratio: 1 }, { costCentreId: 'eng', ratio: 0 }] })), /twice/);
  assert.throws(() => validateRule(rule({ effectiveFromMs: 200, effectiveToMs: 100 })), /after effectiveFrom/);
  // A proportional rule derives its shares, so a declared ratio would be a
  // number the author believes and the engine ignores.
  assert.throws(() => validateRule(rule({ method: 'proportional_to_direct', targets: [{ costCentreId: 'eng', ratio: 0.5 }] })), /derives its shares/);
  assert.throws(() => validateCostCentre({ costCentreId: 'Not Valid', name: 'x' }), /cost centre id/);
  assert.doesNotThrow(() => validateCostCentre({ costCentreId: 'eng-platform', name: 'Platform Engineering' }));
});

test('alloc: distributeMicros conserves for awkward weights and is stable', () => {
  for (const total of [1, 7, 100, 999_999, 1_000_000_001]) {
    for (const weights of [
      [{ key: 'a', weight: 1 }, { key: 'b', weight: 1 }, { key: 'c', weight: 1 }],
      [{ key: 'a', weight: 7 }, { key: 'b', weight: 11 }, { key: 'c', weight: 13 }],
      [{ key: 'a', weight: 1 }],
    ]) {
      const split = distributeMicros(total, weights);
      const sum = [...split.values()].reduce((s, v) => s + v, 0);
      assert.equal(sum, total, `conserved for ${total} across ${weights.length}`);
    }
  }
  // No weight at all cannot be distributed, and returns nothing rather than zeros.
  assert.equal(distributeMicros(100, []).size, 0);
  assert.equal(distributeMicros(100, [{ key: 'a', weight: 0 }]).size, 0);
  assert.equal(RATIO_SCALE, 1_000_000);
});

// ── Store path ──────────────────────────────────────────────────────────────

function meteredRow(over: Partial<RequestRow> = {}): RequestRow {
  return {
    requestId: `req-${rowSeq++}`, sessionId: null, tsEpochMs: T0 + DAY, provider: 'openai', model: 'gpt-4o',
    project: 'backend-api', taskWeight: 1, inputTokens: 10, outputTokens: 1, cacheWriteTokens: 0,
    cacheReadTokens: 0, reasoningTokens: 0, costUsd: 12, estimated: false, streamed: true,
    statusCode: 200, durationMs: 10, source: 'cursor', user: 'alice@team', ...over,
  };
}

test('alloc store: a new rule version closes the old one and both are retained', () => {
  const store = new Store(':memory:');
  store.upsertCostCentre({ costCentreId: 'eng', name: 'Engineering' });
  store.upsertCostCentre({ costCentreId: 'platform', name: 'Platform' });

  const v1 = store.saveAllocationRule({
    ruleId: 'backend', method: 'direct', match: { project: 'backend-api' },
    targets: [{ costCentreId: 'eng', ratio: 1 }], priority: 10,
    effectiveFromMs: 0, effectiveToMs: null, revokedAtMs: null, owner: null, note: null,
  });
  assert.equal(v1.version, 1);

  const v2 = store.saveAllocationRule({
    ruleId: 'backend', method: 'direct', match: { project: 'backend-api' },
    targets: [{ costCentreId: 'platform', ratio: 1 }], priority: 10,
    effectiveFromMs: T0 + 10 * DAY, effectiveToMs: null, revokedAtMs: null, owner: null, note: null,
  });
  assert.equal(v2.version, 2);

  const rules = store.allocationRules();
  assert.equal(rules.length, 2, 'the old version is retained, never overwritten');
  const stored1 = rules.find((r) => r.version === 1)!;
  assert.equal(stored1.effectiveToMs, T0 + 10 * DAY, 'and is closed at the new version’s start');
  assert.deepEqual(stored1.targets, [{ costCentreId: 'eng', ratio: 1 }], 'with its own targets intact');

  // Spend before and after the switch allocates under the version in force then.
  store.insertRequest(meteredRow({ tsEpochMs: T0 + 1 * DAY, costUsd: 12 }));
  store.insertRequest(meteredRow({ tsEpochMs: T0 + 20 * DAY, costUsd: 8 }));
  const result = store.allocatePeriod(T0, T0 + 30 * DAY);
  const byCentre = new Map(result.byCostCentre.map((c) => [c.costCentreId, c.allocatedMicros]));
  assert.equal(byCentre.get('eng'), 12_000_000);
  assert.equal(byCentre.get('platform'), 8_000_000);
  assert.equal(result.conserves, true);
  store.close();
});

test('alloc store: revoking retains the rule and stops it applying', () => {
  const store = new Store(':memory:');
  store.upsertCostCentre({ costCentreId: 'eng', name: 'Engineering' });
  store.saveAllocationRule({
    ruleId: 'all', method: 'direct', match: {}, targets: [{ costCentreId: 'eng', ratio: 1 }],
    priority: 10, effectiveFromMs: 0, effectiveToMs: null, revokedAtMs: null, owner: null, note: null,
  });
  store.insertRequest(meteredRow({ tsEpochMs: T0 + 1 * DAY, costUsd: 5 }));
  store.insertRequest(meteredRow({ tsEpochMs: T0 + 20 * DAY, costUsd: 5 }));

  assert.equal(store.revokeAllocationRule('all', T0 + 10 * DAY), 1);
  assert.equal(store.allocationRules().length, 1, 'retained, not deleted');

  const result = store.allocatePeriod(T0, T0 + 30 * DAY);
  assert.equal(result.allocatedMicros, 5_000_000, 'only spend before the revocation');
  assert.equal(result.unallocatedMicros, 5_000_000);
  store.close();
});

test('alloc store: a run is immutable, and a non-conserving one is refused', () => {
  const store = new Store(':memory:');
  store.upsertCostCentre({ costCentreId: 'eng', name: 'Engineering' });
  store.saveAllocationRule({
    ruleId: 'all', method: 'direct', match: {}, targets: [{ costCentreId: 'eng', ratio: 1 }],
    priority: 10, effectiveFromMs: 0, effectiveToMs: null, revokedAtMs: null, owner: null, note: null,
  });
  store.insertRequest(meteredRow({ costUsd: 9 }));

  const result = store.allocatePeriod(T0, T0 + 30 * DAY);
  const id = store.saveAllocationRun(result, T0 + 31 * DAY);
  store.saveAllocationRun(result, T0 + 32 * DAY);
  const runs = store.allocationRuns();
  assert.equal(runs.length, 2, 'a re-run is a new record, never an update');
  assert.equal(runs[0]!.result.allocatedMicros, 9_000_000);
  assert.ok(id);

  // The conservation invariant is a refusal, not a warning: an unauditable
  // number must never reach a budget owner.
  assert.throws(
    () => store.saveAllocationRun({ ...result, conserves: false }),
    /does not conserve/,
  );
  store.close();
});

test('alloc store: allocation totals agree with byProject through project aliases', () => {
  const store = new Store(':memory:');
  store.upsertCostCentre({ costCentreId: 'eng', name: 'Engineering' });
  // Two labels for one repository, merged at query time.
  store.insertRequest(meteredRow({ project: 'web', costUsd: 4 }));
  store.insertRequest(meteredRow({ project: 'myrepo', costUsd: 6 }));
  store.setProjectAlias('web', 'myrepo');
  store.saveAllocationRule({
    ruleId: 'repo', method: 'direct', match: { project: 'myrepo' },
    targets: [{ costCentreId: 'eng', ratio: 1 }], priority: 10,
    effectiveFromMs: 0, effectiveToMs: null, revokedAtMs: null, owner: null, note: null,
  });

  const result = store.allocatePeriod(T0, T0 + 30 * DAY);
  // If allocation read the raw label, the aliased $4 would fall out as
  // unallocated and the cost centre would silently under-report.
  assert.equal(result.allocatedMicros, 10_000_000);
  assert.equal(result.unallocatedMicros, 0);
  store.close();
});
