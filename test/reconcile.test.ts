/**
 * Provider reconciliation.
 *
 * The point of these tests is not that the arithmetic works — it is that the
 * result refuses to be cleaner than the evidence. A reconciliation that quietly
 * produced a tidy number would be worse than none, so most of what is pinned
 * here is what the engine declines to do.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.FISCUS_HOME = mkdtempSync(join(tmpdir(), 'aegis-home-'));

import {
  reconcileOpenAiCosts,
  isOnDeclaredRoute,
  displayUsd,
  signedUsd,
  SETTLEMENT_LAG_MS,
  DEFAULT_MATERIALITY_USD,
  type ReconciliationRun,
} from '../src/billing/reconcile.ts';
import { Store, type OpenAiCostsObservationLine, type OpenAiCostsObservationRun, type RequestRow } from '../src/store/db.ts';

const DAY = 24 * 60 * 60 * 1000;
// A fixed, long-past UTC day so the settlement-lag guard never depends on when
// the suite runs.
const D0 = Date.UTC(2026, 6, 1);
const SCOPE = 'scope-decl-0001';
const NOW = D0 + 30 * DAY;

function run(over: Partial<OpenAiCostsObservationRun> = {}): OpenAiCostsObservationRun {
  return {
    observationRunId: 'obs-1',
    declaredScopeId: SCOPE,
    providerProjectRef: 'proj_test',
    periodStartMs: D0,
    periodEndMs: D0 + 3 * DAY,
    fetchedAtMs: D0 + 4 * DAY,
    paginationComplete: true,
    pageCount: 1,
    pageDigestChainSha256: 'a'.repeat(64),
    resultState: 'succeeded',
    failureCode: null,
    sourceKind: 'provider_api_pull',
    providerFinality: 'undocumented',
    trust: 'provider_observation_unreconciled',
    rawRetention: 'digest_only',
    observationsStored: 0,
    ...over,
  };
}

function line(dayIndex: number, amountDecimal: string, over: Partial<OpenAiCostsObservationLine> = {}): OpenAiCostsObservationLine {
  return {
    observationId: `line-${dayIndex}-${amountDecimal}-${over.lineItem ?? 'default'}`,
    observationRunId: 'obs-1',
    declaredScopeId: SCOPE,
    providerProjectRef: 'proj_test',
    fetchedAtMs: D0 + 4 * DAY,
    bucketStartMs: D0 + dayIndex * DAY,
    bucketEndMs: D0 + (dayIndex + 1) * DAY,
    lineItem: 'gpt-4o',
    currency: 'USD',
    amountDecimal,
    ...over,
  };
}

let reqSeq = 0;
function req(dayIndex: number, costUsd: number, over: Partial<RequestRow> = {}): RequestRow {
  return {
    requestId: `r-${reqSeq++}`,
    sessionId: null,
    tsEpochMs: D0 + dayIndex * DAY + 6 * 60 * 60 * 1000,
    provider: 'openai',
    model: 'gpt-4o',
    project: 'p',
    taskWeight: 1,
    inputTokens: 100,
    outputTokens: 10,
    cacheWriteTokens: 0,
    cacheReadTokens: 0,
    reasoningTokens: 0,
    costUsd,
    estimated: false,
    streamed: true,
    statusCode: 200,
    durationMs: 100,
    via: 'proxy',
    scopeCaptureStatus: 'declared_unverified',
    providerScopeDeclarationId: SCOPE,
    ...over,
  };
}

function ok(result: ReturnType<typeof reconcileOpenAiCosts> | null): ReconciliationRun {
  assert.ok(result, 'expected a reconciliation, got null');
  assert.equal(result.status, 'reconciled_with_residual', `expected a run, got ${JSON.stringify(result)}`);
  return result as ReconciliationRun;
}

test('reconcile: compares project-day totals and states the residual rather than hiding it', () => {
  const result = ok(reconcileOpenAiCosts({
    run: run(),
    observations: [line(0, '10'), line(1, '20'), line(2, '5')],
    requests: [req(0, 9), req(1, 20), req(2, 4)],
    now: NOW,
  }));

  assert.equal(result.providerReportedMicros, 35_000_000);
  assert.equal(result.localCapturedMicros, 33_000_000);
  // The headline output. A reconciliation that drove this to zero would be
  // fitting the numbers to each other, which is the thing being avoided.
  assert.equal(result.unexplainedVarianceMicros, 2_000_000);
  assert.equal(result.coverage.daysWithBoth, 3);
  assert.equal(result.days.map((d) => d.residualReason).join(','), 'provider_exceeds_local,exact_match,provider_exceeds_local');
  // Never plain "reconciled".
  assert.equal(result.status, 'reconciled_with_residual');
  assert.equal(result.trust, 'scope_conditional_reconciliation');
});

test('reconcile: a day the provider reports and Fiscus never saw is named, not averaged away', () => {
  const result = ok(reconcileOpenAiCosts({
    run: run(),
    observations: [line(0, '10'), line(1, '7.5'), line(2, '3')],
    requests: [req(0, 10)], // days 1 and 2 never reached the proxy
    now: NOW,
  }));

  assert.equal(result.coverage.providerOnlyDays, 2, 'two days of provider-reported spend with no local capture');
  assert.equal(result.coverage.daysWithBoth, 1);
  const reasons = result.days.map((d) => d.residualReason);
  assert.deepEqual(reasons, ['exact_match', 'no_local_capture', 'no_local_capture']);
  assert.equal(result.unexplainedVarianceMicros, 10_500_000);
});

test('reconcile: local spend on a day the provider did not report is equally visible', () => {
  // The direction that suggests the ROUTE DECLARATION is wrong — this traffic
  // was metered as belonging to a project the provider says had no cost.
  const result = ok(reconcileOpenAiCosts({
    run: run(),
    observations: [line(0, '10')],
    requests: [req(0, 10), req(2, 4)],
    now: NOW,
  }));
  assert.equal(result.coverage.localOnlyDays, 1);
  assert.equal(result.days.at(-1)!.residualReason, 'no_provider_report');
  assert.equal(result.unexplainedVarianceMicros, -4_000_000, 'negative: Fiscus metered more than the provider reported');
});

test('reconcile: refuses a period that may still be accruing rather than reporting lag as variance', () => {
  const justEnded = Date.now() - 1 * 60 * 60 * 1000;
  const result = reconcileOpenAiCosts({
    run: run({ periodStartMs: justEnded - DAY, periodEndMs: justEnded }),
    observations: [],
    requests: [],
  });
  assert.equal(result.status, 'refused');
  assert.equal(result.status === 'refused' && result.refusal, 'observation_period_may_still_accrue');
  // …and the boundary is the documented one, not an accident of the fixture.
  const settled = reconcileOpenAiCosts({
    run: run({ periodStartMs: Date.now() - SETTLEMENT_LAG_MS - 2 * DAY, periodEndMs: Date.now() - SETTLEMENT_LAG_MS - DAY }),
    observations: [],
    requests: [],
  });
  assert.equal(settled.status, 'reconciled_with_residual');
});

test('reconcile: refuses a non-USD or mixed-currency snapshot instead of applying a rate', () => {
  const eur = reconcileOpenAiCosts({
    run: run(),
    observations: [line(0, '10', { currency: 'EUR' })],
    requests: [req(0, 10)],
    now: NOW,
  });
  assert.equal(eur.status === 'refused' && eur.refusal, 'provider_currency_is_not_usd');

  const mixed = reconcileOpenAiCosts({
    run: run(),
    observations: [line(0, '10'), line(0, '5', { currency: 'EUR', lineItem: 'other' })],
    requests: [req(0, 10)],
    now: NOW,
  });
  assert.equal(mixed.status === 'refused' && mixed.refusal, 'provider_reported_multiple_currencies');
});

test('reconcile: refuses an incomplete or failed observation', () => {
  for (const over of [{ resultState: 'failed' as const, paginationComplete: false }, { paginationComplete: false }]) {
    const result = reconcileOpenAiCosts({ run: run(over), observations: [], requests: [], now: NOW });
    assert.equal(result.status === 'refused' && result.refusal, 'no_provider_observation');
  }
});

test('reconcile: only rows on the exact declared route are compared', () => {
  const result = ok(reconcileOpenAiCosts({
    run: run(),
    observations: [line(0, '10')],
    requests: [
      req(0, 4),
      req(0, 100, { via: 'import' }),                                  // subscription spend, unobservable by the provider snapshot
      req(0, 100, { provider: 'anthropic' }),                          // another provider entirely
      req(0, 100, { providerScopeDeclarationId: 'other-scope' }),      // a different declared OpenAI project
      req(0, 100, { scopeCaptureStatus: 'unscoped', providerScopeDeclarationId: null }), // pre-declaration proxy traffic
    ],
    now: NOW,
  }));
  assert.equal(result.localCapturedMicros, 4_000_000, 'the four excluded rows must not enter the variance');
  // The inclusion test must be the same one the coverage report applies, or a
  // row could be excluded from coverage and included in a variance.
  assert.equal(isOnDeclaredRoute(req(0, 1), SCOPE), true);
  assert.equal(isOnDeclaredRoute(req(0, 1, { via: 'import' }), SCOPE), false);
});

test('reconcile: rows outside the observed period never leak in', () => {
  const result = ok(reconcileOpenAiCosts({
    run: run(),
    observations: [line(0, '10')],
    requests: [req(0, 10), req(-1, 50), req(3, 50)],
    now: NOW,
  }));
  assert.equal(result.localCapturedMicros, 10_000_000);
  assert.equal(result.unexplainedVarianceMicros, 0);
});

test('reconcile: materiality flags days without pretending small ones agree', () => {
  const result = ok(reconcileOpenAiCosts({
    run: run(),
    observations: [line(0, '10'), line(1, '10')],
    requests: [req(0, 9.99), req(1, 5)],
    now: NOW,
    materialityUsd: 1,
  }));
  assert.equal(result.coverage.materialDays, 1, 'only the $5 gap is material at a $1 threshold');
  // …but the immaterial day still reports its real difference and a real reason.
  assert.equal(result.days[0]!.differenceMicros, 10_000);
  assert.equal(result.days[0]!.residualReason, 'provider_exceeds_local', 'never relabelled as a match');
  assert.equal(result.materialityUsd, 1, 'the threshold ships with the result it shaped');
});

test('reconcile: an independent snapshot of the same period is what makes finality observable', () => {
  const base = { run: run(), observations: [line(0, '10'), line(1, '20')], requests: [req(0, 10), req(1, 20)], now: NOW };

  const single = ok(reconcileOpenAiCosts(base));
  assert.equal(single.snapshotStability, 'single_observation', 'one snapshot proves nothing about finality');

  const stable = ok(reconcileOpenAiCosts({ ...base, priorDayTotals: new Map([[D0, 10_000_000], [D0 + DAY, 20_000_000]]) }));
  assert.equal(stable.snapshotStability, 'stable_across_observations');
  assert.deepEqual(stable.unstableDayStartMs, []);

  const changed = ok(reconcileOpenAiCosts({ ...base, priorDayTotals: new Map([[D0, 8_000_000], [D0 + DAY, 20_000_000]]) }));
  assert.equal(changed.snapshotStability, 'changed_across_observations');
  assert.deepEqual(changed.unstableDayStartMs, [D0], 'the day that moved is named');

  // A day that vanished between snapshots is a change too, not an absence.
  const dropped = ok(reconcileOpenAiCosts({
    ...base,
    priorDayTotals: new Map([[D0, 10_000_000], [D0 + DAY, 20_000_000], [D0 + 2 * DAY, 3_000_000]]),
  }));
  assert.deepEqual(dropped.unstableDayStartMs, [D0 + 2 * DAY]);
});

test('reconcile: every result carries the conditions it can never discharge', () => {
  const result = ok(reconcileOpenAiCosts({
    run: run(), observations: [line(0, '10')], requests: [req(0, 10)], now: NOW,
  }));
  // These are properties of the method, not of this data — an exactly matching
  // day does not earn a cleaner label.
  assert.deepEqual([...result.conditions], [
    'local_route_scope_is_not_provider_verified',
    'off_path_provider_usage_is_not_observable',
    'provider_line_items_do_not_join_to_requests_or_models',
    'local_request_amounts_are_rate_card_estimates',
  ]);
  assert.deepEqual([...result.excludedFrom], ['request_metered_spend', 'budget_enforcement', 'roi', 'model_recommendations']);
});

test('reconcile: provider amounts are summed exactly, never through a float', () => {
  // Three amounts that lose a cent through naive float addition.
  const result = ok(reconcileOpenAiCosts({
    run: run(),
    observations: [line(0, '0.1', { lineItem: 'a' }), line(0, '0.2', { lineItem: 'b' }), line(0, '0.3', { lineItem: 'c' })],
    requests: [],
    now: NOW,
  }));
  assert.equal(result.providerReportedMicros, 600_000, 'exact integer microdollars');
  assert.deepEqual(result.days[0]!.providerLineItems, ['a', 'b', 'c']);
});

test('signedUsd: the direction of a residual is never ambiguous, and money reads as money', () => {
  assert.equal(signedUsd(2_500_000), '+$2.50');
  assert.equal(signedUsd(-2_500_000), '-$2.50');
  assert.equal(signedUsd(0), '$0.00');
  // Two decimals minimum so a column of residuals aligns, but never at the cost
  // of a digit the amount actually has.
  assert.equal(displayUsd(70_200_000), '70.20');
  assert.equal(displayUsd(1_234_567), '1.234567');
  assert.equal(DEFAULT_MATERIALITY_USD, 0.5);
});

test('reconcile: the store path picks the newest snapshot and finds the independent one', () => {
  const store = new Store(':memory:');
  const scope = store.setOpenAiScope({
    billingAccountRef: 'org_test',
    providerProjectRef: 'proj_test',
    upstreamBase: 'https://api.openai.com',
  });

  // Two independent observations of the SAME period, the later one revising a day.
  const record = (fetchedAtMs: number, dayOneDecimal: string) => store.recordOpenAiCostsObservation({
    declaredScopeId: scope.declarationId,
    providerProjectRef: 'proj_test',
    periodStartMs: D0,
    periodEndMs: D0 + 2 * DAY,
    fetchedAtMs,
    paginationComplete: true,
    pageCount: 1,
    pageDigestChainSha256: 'b'.repeat(64),
    resultState: 'succeeded',
    failureCode: null,
    observations: [
      { providerProjectRef: 'proj_test', bucketStartMs: D0, bucketEndMs: D0 + DAY, lineItem: 'gpt-4o', currency: 'USD', amountDecimal: dayOneDecimal },
      { providerProjectRef: 'proj_test', bucketStartMs: D0 + DAY, bucketEndMs: D0 + 2 * DAY, lineItem: 'gpt-4o', currency: 'USD', amountDecimal: '20' },
    ],
  });
  record(D0 + 3 * DAY, '8');
  record(D0 + 5 * DAY, '10');

  store.insertRequest(req(0, 9, { providerScopeDeclarationId: scope.declarationId }));
  store.insertRequest(req(1, 20, { providerScopeDeclarationId: scope.declarationId }));
  // A row on the same days that the snapshot cannot see, to prove the store's
  // request window and route filter are both applied on the real path.
  store.insertRequest(req(1, 500, { via: 'import', providerScopeDeclarationId: scope.declarationId }));

  const result = ok(store.reconcileOpenAiCosts({ now: NOW }));
  assert.equal(result.providerReportedMicros, 30_000_000, 'the NEWEST snapshot is the one reconciled');
  assert.equal(result.localCapturedMicros, 29_000_000, 'the imported row is excluded on the store path too');
  assert.equal(result.unexplainedVarianceMicros, 1_000_000);
  // The earlier snapshot said $8 for day one; that day is named as unstable.
  assert.equal(result.snapshotStability, 'changed_across_observations');
  assert.deepEqual(result.unstableDayStartMs, [D0]);
  store.close();
});

test('reconcile: the store round-trips a run immutably and reports no reconciliation without one', () => {
  const store = new Store(':memory:');
  // Nothing observed yet: the store must say so rather than invent an empty run.
  assert.equal(store.reconcileOpenAiCosts({ now: NOW }), null);

  const result = ok(reconcileOpenAiCosts({
    run: run(), observations: [line(0, '10')], requests: [req(0, 9)], now: NOW,
  }));
  const id = store.saveReconciliationRun(result, NOW);
  const stored = store.reconciliationRuns();
  assert.equal(stored.length, 1);
  assert.equal(stored[0]!.reconciliationRunId, id);
  assert.equal(stored[0]!.result.unexplainedVarianceMicros, 1_000_000);

  // A second run is a new record, never an update — the history of what was
  // claimed when has to stay inspectable.
  store.saveReconciliationRun(result, NOW + 1000);
  assert.equal(store.reconciliationRuns().length, 2);
  store.close();
});
