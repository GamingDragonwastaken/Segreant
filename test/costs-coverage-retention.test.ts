/**
 * The report that decides whether to go and get a provider credential said the
 * local side was empty, over a period whose local rows it had deleted.
 *
 * THE COUNTEREXAMPLE, MEASURED. A fully paginated OpenAI Costs observation over
 * a past month, and ten live proxy requests on the declared route inside it
 * totalling $180.00. `fiscus billing costs coverage` reported `Declared route
 * 10 live proxy request(s), $180.00`. `fiscus prune` then deleted rows older
 * than the middle of that period, and the same report read:
 *
 *     Declared route 0 live proxy request(s), $0.00 local rate-card estimate
 *
 * **with the blocker list byte-for-byte identical.** Not one of the five named
 * a deletion, because all five are permanent conditions and this one is not.
 *
 * WHY THIS SURFACE AND NOT ANOTHER. Capture coverage exists to answer one
 * question before an operator spends anything: is the local side ready, or
 * would a reconciliation come back empty? `printReadiness` on the same command
 * prints "READ THIS BEFORE GETTING A CREDENTIAL. You have OpenAI spend, and
 * none of it would count toward a reconciliation." **So this is the emptiness-
 * followed-by-advice class attached to the most expensive errand in the
 * product** — minting an Admin credential against a real billing account — and
 * the advice is derived from a number retention emptied.
 *
 * WHY NOT A SIXTH BLOCKER. `blockers` is a fixed-length tuple of five
 * conditions that hold ALWAYS: an unverified scope, unobservable off-path
 * usage, undocumented finality, line items that do not join, and rate-card
 * estimates. Retention truncation holds SOMETIMES. Putting a conditional fact
 * in a list whose meaning is "these are permanent" would either make it read as
 * permanent or make the tuple's promise false, so the coverage carries it as
 * its own field — the same separation D-173 made between the permanent
 * reconciliation conditions and `local_ledger_truncated_by_retention`.
 *
 * WHAT THIS DOES NOT ESTABLISH. That the reconciliation itself is affected:
 * D-173 already closed that path, and this is the READINESS report that runs
 * before it. That the provider side is complete — `providerFinality` is
 * `undocumented` and stays so. That the other two absence sentences on this
 * command are affected: `'No direct provider observation runs recorded.'` and
 * `'No OpenAI billing export has been imported.'` read observation and import
 * tables, and no `DELETE` in the store touches either — traced per sentence,
 * which is what frontier item 12(b) asked for, and they are sound.
 *
 * Recorded at D-185.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.FISCUS_HOME = mkdtempSync(join(tmpdir(), 'fiscus-costs-retention-'));

import { Store, type RequestRow } from '../src/store/db.ts';

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.now();
/** A past month: exactly the range a retention boundary bites into. */
const P0 = NOW - 60 * DAY;
const P1 = NOW - 30 * DAY;
const PROJECT = 'proj_costs_retention';

function seed(store: Store): string {
  const scopeId = store.setOpenAiScope({
    billingAccountRef: 'org_costs_retention',
    providerProjectRef: PROJECT,
    upstreamBase: 'https://api.openai.com',
    declaredAtMs: 1,
    activatedAtMs: 1,
  }).declarationId;

  store.recordOpenAiCostsObservation({
    declaredScopeId: scopeId,
    providerProjectRef: PROJECT,
    periodStartMs: P0,
    periodEndMs: P1,
    fetchedAtMs: NOW,
    paginationComplete: true,
    pageCount: 1,
    pageDigestChainSha256: 'a'.repeat(64),
    resultState: 'succeeded',
    failureCode: null,
    observations: [{
      providerProjectRef: PROJECT,
      bucketStartMs: P0,
      bucketEndMs: P0 + DAY,
      lineItem: 'completions',
      currency: 'USD',
      amountDecimal: '180.000000',
    }],
  });

  for (let i = 0; i < 10; i += 1) {
    const row: RequestRow = {
      requestId: `r${i}`, sessionId: null, tsEpochMs: P0 + i * DAY, provider: 'openai', model: 'gpt-5',
      project: 'p', taskWeight: 1, inputTokens: 1, outputTokens: 1, cacheWriteTokens: 0, cacheReadTokens: 0,
      reasoningTokens: 0, costUsd: 18, estimated: false, streamed: false, statusCode: 200, durationMs: 1,
      scopeCaptureStatus: 'declared_unverified', providerScopeDeclarationId: scopeId,
    };
    store.insertRequest(row);
  }
  return scopeId;
}

test('a local side retention emptied is not reported as a local side that was never there', () => {
  const store = new Store(':memory:');
  try {
    seed(store);

    const before = store.openAiCostsCaptureCoverage();
    assert.ok(before, 'a complete snapshot must produce a coverage report');
    assert.equal(before.capturedOnDeclaredRoute.requestCount, 10, 'the baseline: ten requests on the declared route');
    assert.equal(before.capturedOnDeclaredRoute.costUsd, 180);
    assert.equal(before.localLedgerRetention.truncated, false);

    assert.equal(store.prune(NOW - 45 * DAY), 10, 'the boundary sits inside the observed period');

    const after = store.openAiCostsCaptureCoverage();
    assert.ok(after);
    // The surviving count is honestly zero, and that is exactly why the report
    // has to say the rows were deleted: the next thing this operator does with
    // a zero here is decide not to reconcile, or mint a credential expecting a
    // local side that no longer exists.
    assert.equal(after.capturedOnDeclaredRoute.requestCount, 0);
    assert.equal(
      after.localLedgerRetention.truncated,
      true,
      'an empty local side over a period whose rows were deleted is not evidence the route captured nothing',
    );
    assert.equal(after.localLedgerRetention.prunedBeforeMs, NOW - 45 * DAY, 'and it must name which rows are gone');
  } finally {
    store.close();
  }
});

test('the permanent blocker list stays exactly five and unchanged', () => {
  // The guard on the design decision. `blockers` promises "these five hold
  // always"; a conditional fact appended to it would either read as permanent
  // or make the promise false. This test fails if a later change smuggles the
  // retention state in there instead of leaving it beside.
  const store = new Store(':memory:');
  try {
    seed(store);
    store.prune(NOW - 45 * DAY);
    const coverage = store.openAiCostsCaptureCoverage();
    assert.ok(coverage);
    assert.deepEqual([...coverage.blockers], [
      'local_route_scope_is_not_provider_verified',
      'off_path_provider_usage_is_not_observable',
      'provider_finality_is_undocumented',
      'provider_line_items_do_not_join_to_requests_or_models',
      'local_request_amounts_are_rate_card_estimates',
    ]);
  } finally {
    store.close();
  }
});

test('an observation period entirely after the boundary reports an intact local side', () => {
  // The silence that keeps the disclosure worth reading.
  const store = new Store(':memory:');
  try {
    seed(store);
    assert.equal(store.prune(P0 - 10 * DAY), 0, 'nothing in this ledger is older than the period');

    const coverage = store.openAiCostsCaptureCoverage();
    assert.ok(coverage);
    assert.equal(coverage.localLedgerRetention.truncated, false);
    assert.equal(coverage.capturedOnDeclaredRoute.requestCount, 10, 'and the local side is still all there');
  } finally {
    store.close();
  }
});

test('with no prune on record nothing is asserted about deletion', () => {
  const store = new Store(':memory:');
  try {
    seed(store);
    const coverage = store.openAiCostsCaptureCoverage();
    assert.ok(coverage);
    assert.equal(coverage.localLedgerRetention.truncated, false);
    assert.equal(
      coverage.localLedgerRetention.prunedBeforeMs,
      null,
      'null is "no prune is ON RECORD" -- a distinct state from a period known intact',
    );
  } finally {
    store.close();
  }
});
