/**
 * A deletion turned OFF the warning that exists to stop an expensive mistake.
 *
 * `reconciliationReadiness().coverage` is documented, in two places, as meaning
 * one specific thing when it is null. `src/billing/reconcile.ts`: "Null when no
 * OpenAI spend exists at all, so there is nothing to warn about."
 * `src/dashboard/shared-types.ts`: "Null when the ledger holds no OpenAI spend
 * at all — 'no data', not 'no coverage'." The query underneath is
 * `FROM requests WHERE provider = 'openai'` over the WHOLE ledger, with
 * `if (total === 0) return null`.
 *
 * MEASURED. A ledger holding $180.00 of OpenAI spend on the declared route
 * reported that coverage. After `fiscus prune`, the same call returned **null**
 * — which both docblocks say means the machine has no OpenAI spend at all.
 *
 * **This is the class in its strongest form: the false reading is not merely
 * available, it is written down as the intended one.** Every earlier instance
 * had a comment that was silent about the inference; these two name it.
 *
 * AND THE CONSEQUENCE IS A SUPPRESSED WARNING, NOT A WRONG NUMBER. Both the CLI
 * (`printReadiness`) and the browser (`readinessPanel`) gate the entire "READ
 * THIS BEFORE GETTING A CREDENTIAL" block on `coverage` being non-null. That
 * block exists to stop an operator minting a least-privilege Admin key against
 * a real billing account only to discover their local side cannot match a
 * single line. A prune sets `coverage` to null, so the guard goes quiet exactly
 * when it is most needed: the local side is now empty for certain. **A
 * deletion that turns a warning OFF is worse than one that moves a number,
 * because nothing on the screen is wrong — there is simply nothing there.**
 *
 * THE PREDICATE HERE IS NOT A WINDOW, AND THAT IS DELIBERATE. Every other
 * packet in this sweep compares a window start against the prune boundary. This
 * query has no period bound at all — it sums the entire ledger — so the honest
 * condition is simply whether any request prune is ON RECORD. Applying a window
 * predicate to an unwindowed query would be borrowing a form that does not fit.
 *
 * WHAT THIS DOES NOT ESTABLISH. That the reconciliation itself is affected
 * (D-173) or that capture coverage is (D-185); both are separate reports and
 * separately closed. That an operator who sees the new disclosure will act on
 * it. And nothing about OpenAI spend that never reached Fiscus, which no local
 * evidence can establish and which this report has always said it cannot.
 *
 * Recorded at D-186.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.FISCUS_HOME = mkdtempSync(join(tmpdir(), 'fiscus-readiness-retention-'));

import { Store, type RequestRow } from '../src/store/db.ts';
import { reconciliationReadiness } from '../src/billing/readiness.ts';

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.now();
const PROJECT = 'proj_readiness_retention';

function scope(store: Store): string {
  return store.setOpenAiScope({
    billingAccountRef: 'org_readiness_retention',
    providerProjectRef: PROJECT,
    upstreamBase: 'https://api.openai.com',
    declaredAtMs: 1,
    activatedAtMs: 1,
  }).declarationId;
}

function proxyRow(scopeId: string | null, id: string, daysAgo: number, costUsd: number): RequestRow {
  return {
    requestId: id, sessionId: null, tsEpochMs: NOW - daysAgo * DAY, provider: 'openai', model: 'gpt-5',
    project: 'p', taskWeight: 1, inputTokens: 1, outputTokens: 1, cacheWriteTokens: 0, cacheReadTokens: 0,
    reasoningTokens: 0, costUsd, estimated: false, streamed: false, statusCode: 200, durationMs: 1,
    ...(scopeId === null ? {} : { scopeCaptureStatus: 'declared_unverified' as const, providerScopeDeclarationId: scopeId }),
  };
}

function importedRow(id: string, daysAgo: number, costUsd: number): RequestRow {
  return { ...proxyRow(null, id, daysAgo, costUsd), via: 'import' };
}

test('an OpenAI ledger retention emptied is not reported as a machine with no OpenAI spend', () => {
  const store = new Store(':memory:');
  try {
    const scopeId = scope(store);
    for (let i = 0; i < 10; i += 1) store.insertRequest(proxyRow(scopeId, `r${i}`, 50 + i, 18));

    const before = reconciliationReadiness(store);
    assert.ok(before.coverage, 'the baseline: this machine has OpenAI spend on the declared route');
    assert.equal(before.coverage.onDeclaredRouteUsd, 180);
    assert.equal(before.localLedgerRetention.truncated, false);

    assert.ok(store.prune(NOW - 30 * DAY) > 0, 'retention deletes the ledger, not the machine');

    const after = reconciliationReadiness(store);
    // Null is honestly "nothing survives". What it must no longer be read as is
    // the documented "no OpenAI spend exists at all", which is why the coverage
    // cannot be the only thing a consumer looks at.
    assert.equal(after.coverage, null);
    assert.equal(
      after.localLedgerRetention.truncated,
      true,
      'a consumer must be able to tell an emptied ledger from a machine that never metered OpenAI',
    );
    assert.equal(after.localLedgerRetention.prunedBeforeMs, NOW - 30 * DAY, 'and know which rows are gone');
  } finally {
    store.close();
  }
});

test('the credential warning goes quiet on a pruned ledger, and the truncation is what replaces it', () => {
  // THE CONSEQUENCE, MEASURED RATHER THAN ARGUED. Both surfaces gate the whole
  // "READ THIS BEFORE GETTING A CREDENTIAL" block on `coverage` being non-null.
  // Here it fires before the prune and cannot after — so a deletion turns off a
  // guard whose entire job is to prevent an expensive mistake, at the moment
  // the mistake became certain.
  const store = new Store(':memory:');
  try {
    scope(store);
    // Uncountable spend only: on-route is zero, so the warning fires.
    store.insertRequest(importedRow('i1', 50, 40));
    store.insertRequest(importedRow('i2', 51, 10));

    const before = reconciliationReadiness(store);
    assert.ok(before.coverage);
    const firesBefore = before.coverage.onDeclaredRouteUsd === 0
      && (before.coverage.importedUsd > 0 || before.coverage.proxyOffScopeUsd > 0);
    assert.equal(firesBefore, true, 'the baseline: this operator is being warned');

    assert.equal(store.prune(NOW - 30 * DAY), 2);

    const after = reconciliationReadiness(store);
    assert.equal(after.coverage, null, 'so every branch gated on coverage is skipped');
    assert.equal(
      after.localLedgerRetention.truncated,
      true,
      'and the only thing left that can speak is the retention state, which is why it has to exist',
    );
  } finally {
    store.close();
  }
});

test('a machine that genuinely never metered OpenAI still reports a plain empty ledger', () => {
  // The silence that keeps the disclosure worth reading, and the case the old
  // docblocks were written for. It is still exactly right.
  const store = new Store(':memory:');
  try {
    scope(store);
    const readiness = reconciliationReadiness(store);
    assert.equal(readiness.coverage, null);
    assert.equal(readiness.localLedgerRetention.truncated, false);
    assert.equal(readiness.localLedgerRetention.prunedBeforeMs, null);
  } finally {
    store.close();
  }
});

test('a prune that removed nothing is still on record and still says so', () => {
  // The predicate here is "a request prune is ON RECORD", not a window
  // comparison, because the query it qualifies sums the whole ledger with no
  // period bound. A prune that deleted nothing still applied a boundary, and
  // the store records it for that reason (D-170) -- so this ledger is one whose
  // completeness Fiscus can no longer vouch for, even though nothing went.
  const store = new Store(':memory:');
  try {
    const scopeId = scope(store);
    store.insertRequest(proxyRow(scopeId, 'r-recent', 1, 5));
    assert.equal(store.prune(NOW - 400 * DAY), 0, 'nothing in this ledger is that old');

    const readiness = reconciliationReadiness(store);
    assert.ok(readiness.coverage, 'the recent row survives and is reported');
    assert.equal(readiness.localLedgerRetention.truncated, true);
    assert.equal(readiness.localLedgerRetention.prunedBeforeMs, NOW - 400 * DAY);
  } finally {
    store.close();
  }
});
