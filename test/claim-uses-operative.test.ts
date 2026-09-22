/**
 * THE USE VOCABULARY IS CONSULTED BY THE SURFACES THAT BAR FIGURES, NOT ONLY BY
 * ITS OWN TESTS.
 *
 * WP-B05 built `admits` / `compareForUse` and left every `excludedFrom` on
 * every surface as a hand-written literal: the registry said what a profile
 * must reach, the literals said what a figure was barred from, and nothing
 * compared the two. Read side by side they disagreed in one live place — a
 * reconciliation record carries `coverage: partial`, `outcome_attribution`
 * requires `complete`, and the record's literal did not bar it.
 *
 * THE RULE. A surface's `excludedFrom` is `barredUses(profile, floor)`: the
 * uses the surface bars IN WRITING (its floor — a definitional bar the profile
 * cannot express, such as a `mixed` comparison being neither the metered
 * figure nor the enforcement figure) united with every use `admits` refuses
 * for the profile the surface's kernel adapter actually issues. The floor can
 * only add; `admits` can only add; nothing here removes a bar.
 *
 * Shown able to fail: RED against the unfixed tree on the reconciliation
 * record (no `outcome_attribution`), and the first test fails if a use is
 * removed from `USE_REQUIREMENTS`' bar for `outcome_attribution`.
 *
 * Recorded at D-228.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CLAIM_USES, USE_REQUIREMENTS, barredUses, excludedUsesFor } from '../src/epistemic/claim-uses.ts';
import { admits } from '../src/epistemic/admissibility.ts';
import { claimProfile } from '../src/epistemic/profile.ts';
import {
  EXACT_ALLOCATION_EXCLUDED_FLOOR,
  applyExactAllocation,
  deserializeExactAllocationRun,
  exactAllocationClaimProfile,
  serializeExactAllocationRun,
  type ExactAllocatableRow,
} from '../src/alloc/exact.ts';
import type { AllocationRule, CostCentre } from '../src/alloc/rules.ts';
import { RECONCILIATION_EXCLUDED_FLOOR, reconcileOpenAiCosts, reconciliationClaimProfile } from '../src/billing/reconcile.ts';
import { OPENAI_COSTS_EXCLUDED_FLOOR, openAiCostsClaimProfile } from '../src/billing/epistemic.ts';
import type { OpenAiCostsObservationLine, OpenAiCostsObservationRun, RequestRow } from '../src/store/db.ts';
import { money } from '../src/economics/money.ts';

const DAY = 24 * 60 * 60 * 1000;
const D0 = Date.UTC(2026, 6, 1);
const SCOPE = 'scope-decl-0001';
const NOW = D0 + 30 * DAY;

function run(): OpenAiCostsObservationRun {
  return {
    observationRunId: 'obs-1', declaredScopeId: SCOPE, providerProjectRef: 'proj_test', periodStartMs: D0, periodEndMs: D0 + 3 * DAY,
    fetchedAtMs: D0 + 4 * DAY, paginationComplete: true, pageCount: 1, pageDigestChainSha256: 'a'.repeat(64), resultState: 'succeeded',
    failureCode: null, sourceKind: 'provider_api_pull', providerFinality: 'undocumented', trust: 'provider_observation_unreconciled',
    rawRetention: 'digest_only', observationsStored: 0,
  };
}
function line(dayIndex: number, amountDecimal: string): OpenAiCostsObservationLine {
  return {
    observationId: `line-${dayIndex}-${amountDecimal}`, observationRunId: 'obs-1', declaredScopeId: SCOPE, providerProjectRef: 'proj_test',
    fetchedAtMs: D0 + 4 * DAY, bucketStartMs: D0 + dayIndex * DAY, bucketEndMs: D0 + (dayIndex + 1) * DAY, lineItem: 'gpt-4o', currency: 'USD', amountDecimal,
  };
}
function req(dayIndex: number, costUsd: number): RequestRow {
  return {
    requestId: `r-${dayIndex}`, sessionId: null, tsEpochMs: D0 + dayIndex * DAY + 6 * 60 * 60 * 1000, provider: 'openai', model: 'gpt-4o', project: 'p',
    taskWeight: 1, inputTokens: 100, outputTokens: 10, cacheWriteTokens: 0, cacheReadTokens: 0, reasoningTokens: 0, costUsd, estimated: false,
    streamed: true, statusCode: 200, durationMs: 100, via: 'proxy', scopeCaptureStatus: 'declared_unverified', providerScopeDeclarationId: SCOPE,
  };
}
const centre = (costCentreId: string): CostCentre => ({ costCentreId, name: costCentreId, owner: null, createdAtMs: 0, archivedAtMs: null });
const RULE: AllocationRule = {
  ruleId: 'api', version: 1, method: 'direct', match: { project: 'api' }, targets: [{ costCentreId: 'eng', ratio: 1 }], priority: 1,
  effectiveFromMs: 0, effectiveToMs: null, revokedAtMs: null, owner: null, note: null, createdAtMs: 0,
};
const ROW: ExactAllocatableRow = {
  sourceEventIds: ['economic:allocation:source'], amount: money('1', 'USD', 'list'), project: 'api', provider: 'anthropic', model: 'claude-opus-4-8',
  source: null, user: null, tsEpochMs: 0,
};

test('the vocabulary itself refuses outcome_attribution to a partial-coverage profile', () => {
  const partial = claimProfile({
    epistemic: 'supported', integrity: 'verified', authenticity: 'self_asserted', scope: 'conditional', coverage: 'partial',
    measurement: 'proxy_unvalidated', causality: 'none', monetaryBasis: 'mixed', finality: 'provisional', decisionFitness: 'not_assessed',
  });
  assert.equal(admits(partial, USE_REQUIREMENTS.outcome_attribution).admitted, false);
  assert.ok(excludedUsesFor(partial).includes('outcome_attribution'));
  // `barredUses` unions and never removes, in vocabulary order.
  const barred = barredUses(partial, ['roi']);
  assert.deepEqual(barred, CLAIM_USES.filter((use) => barred.includes(use)), 'vocabulary order');
  assert.ok(barred.includes('roi') && barred.includes('outcome_attribution'));
});

test('COUNTEREXAMPLE: a reconciliation record bars what its own partial-coverage profile is refused', () => {
  const result = reconcileOpenAiCosts({ requestsPrunedBeforeMs: null, run: run(), observations: [line(0, '10')], requests: [req(0, 10)], now: NOW });
  assert.ok(result && result.status === 'reconciled_with_residual', 'the fixture must produce a run');
  const profile = reconciliationClaimProfile();
  assert.equal(profile.coverage, 'partial');
  assert.deepEqual([...result.excludedFrom], [...barredUses(profile, RECONCILIATION_EXCLUDED_FLOOR)]);
  assert.ok(result.excludedFrom.includes('outcome_attribution'), 'RED against the unfixed tree: the literal omitted it');
  for (const use of excludedUsesFor(profile)) assert.ok(result.excludedFrom.includes(use), `admits refuses ${use}; the record must bar it`);
  // The floor is stricter than the vocabulary here and stays: `mixed` admits
  // the two definitional uses, which is the collapse WP-B05 named for `roi`.
  assert.ok(RECONCILIATION_EXCLUDED_FLOOR.includes('request_metered_spend') && RECONCILIATION_EXCLUDED_FLOOR.includes('budget_enforcement'));
});

test('an exact allocation run bars exactly what its issued profile and floor say, and survives a round trip', () => {
  const result = applyExactAllocation({ rows: [ROW], rules: [RULE], costCentres: [centre('eng')], periodStartMs: 0, periodEndMs: 100, runAtMs: 100 });
  const expected = barredUses(exactAllocationClaimProfile(result.complete), EXACT_ALLOCATION_EXCLUDED_FLOOR);
  assert.deepEqual([...result.excludedFrom], [...expected]);
  const back = deserializeExactAllocationRun(serializeExactAllocationRun(result));
  assert.deepEqual([...back.excludedFrom], [...expected]);
});

test('the OpenAI Costs observation floor is at least what admits refuses its profile, for both source kinds', () => {
  for (const kind of ['provider_api_pull', 'operator_supplied_export'] as const) {
    const refused = excludedUsesFor(openAiCostsClaimProfile(kind));
    for (const use of refused) assert.ok(OPENAI_COSTS_EXCLUDED_FLOOR.includes(use), `${kind}: admits refuses ${use} and the floor does not bar it`);
  }
});
