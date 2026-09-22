/**
 * $180.00 of metered OpenAI spend left the report through the gap between a
 * predicate and its own negation.
 *
 * `openAiReconciliationCoverage` splits every OpenAI row into three buckets —
 * on the declared route, natively imported, proxy-but-off-scope — and the
 * third is written as `NOT (<the first>)`. That reads as a partition. It is
 * one only while the predicate is two-valued, and it is not:
 *
 *     provider_scope_declaration_id = ?      -- ? bound to NULL yields NULL
 *     TRUE AND NULL                   -> NULL   (so the row is not ON route)
 *     NOT NULL                        -> NULL   (so the row is not OFF route)
 *
 * **A predicate and its negation stop partitioning the moment either can be
 * NULL, and SQL will not say so.** Both `SUM(CASE WHEN ...)` arms simply skip
 * the row, `COUNT(*)` still counts it, and the report comes back looking
 * complete.
 *
 * MEASURED. Ten proxy requests carrying the declaration, $180.00. With the
 * scope active: `on $180.00/10 req`. After `fiscus billing scope clear`:
 *
 *     on $0.00/0 req   imported $0.00   off-scope $0.00/0 req
 *
 * Ten rows and $180.00 in the ledger, and every bucket empty.
 *
 * AND IT SILENCES THE SAME GUARD D-186 DID, BY THE OPPOSITE ROUTE. The
 * "READ THIS BEFORE GETTING A CREDENTIAL" block fires when nothing is on the
 * declared route AND something uncountable exists. Here nothing is on the
 * declared route and the uncountable spend was deleted from its own bucket, so
 * the condition cannot hold. D-186's null coverage turned the warning off by
 * emptying the report; this turns it off while the report still looks
 * populated, which is harder to notice.
 *
 * CLEARING A SCOPE IS A SUPPORTED, DELIBERATE ACT — `clearOpenAiScope` is
 * documented as "stop attaching the local scope to future OpenAI-proxy rows",
 * and historical rows are immutable by design. The rows did not become
 * unattributable; the query lost the ability to name them.
 *
 * THE SECOND HALF: THE BASIS WAS NOT ON THE FIGURE. These three numbers are
 * computed relative to one declaration id, and the type carried no trace of
 * which. So a reader could not tell "off-scope because these rows carry a
 * different declaration" from "off-scope because there is no declaration to be
 * on" — and the CLI and browser both printed the first, which after a clear is
 * false: the rows carry exactly the declaration that was made, and it is the
 * ROUTE that was withdrawn. **An epistemically correct verdict — none of this
 * would count — carried an epistemically false explanation, and the verdict
 * being right is what stops the sentence being read** (D-182). Hard rule 1
 * says every figure carries its basis; `declaredScopeId` is that basis.
 *
 * WHAT THIS DOES NOT ESTABLISH. That any row's attribution changed: the ledger
 * is untouched and `provider_scope_declarations` still holds the declaration.
 * That reconciliation can run after a clear — it cannot, and saying so is what
 * the off-scope bucket is now for. That the same defect exists in
 * `openAiCostsCaptureCoverage`: that split is done in TypeScript against a
 * non-null `declaredScopeId` from the observation run, where `!==` is
 * two-valued, and it was checked rather than assumed.
 *
 * Recorded at D-187.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.FISCUS_HOME = mkdtempSync(join(tmpdir(), 'fiscus-coverage-partition-'));

import { Store, type RequestRow } from '../src/store/db.ts';
import { reconciliationReadiness } from '../src/billing/readiness.ts';

const NOW = Date.now();
const HOUR = 60 * 60 * 1000;

function declare(store: Store): string {
  return store.setOpenAiScope({
    billingAccountRef: 'org_partition',
    providerProjectRef: 'proj_partition',
    upstreamBase: 'https://api.openai.com',
    declaredAtMs: 1,
    activatedAtMs: 1,
  }).declarationId;
}

function row(id: string, hoursAgo: number, costUsd: number, extra: Partial<RequestRow> = {}): RequestRow {
  return {
    requestId: id, sessionId: null, tsEpochMs: NOW - hoursAgo * HOUR, provider: 'openai', model: 'gpt-5',
    project: 'p', taskWeight: 1, inputTokens: 1, outputTokens: 1, cacheWriteTokens: 0, cacheReadTokens: 0,
    reasoningTokens: 0, costUsd, estimated: false, streamed: false, statusCode: 200, durationMs: 1,
    ...extra,
  };
}

/** The invariant the three buckets exist to state: they cover every OpenAI row. */
function assertPartitions(store: Store, scopeId: string | null, totalUsd: number, totalRequests: number): void {
  const c = store.openAiReconciliationCoverage(scopeId);
  assert.ok(c, 'a non-empty OpenAI ledger must produce a coverage report');
  const usd = c.onDeclaredRouteUsd + c.importedUsd + c.proxyOffScopeUsd;
  const requests = c.onDeclaredRouteRequests + c.importedRequests + c.proxyOffScopeRequests;
  assert.equal(usd, totalUsd, 'every dollar of OpenAI spend lands in exactly one bucket');
  assert.equal(requests, totalRequests, 'and so does every request');
}

test('withdrawing the active route does not delete the spend from every bucket at once', () => {
  const store = new Store(':memory:');
  try {
    const scopeId = declare(store);
    for (let i = 0; i < 10; i += 1) {
      store.insertRequest(row(`r${i}`, i, 18, {
        scopeCaptureStatus: 'declared_unverified',
        providerScopeDeclarationId: scopeId,
      }));
    }

    const before = store.openAiReconciliationCoverage(scopeId);
    assert.ok(before);
    assert.equal(before.onDeclaredRouteUsd, 180, 'the baseline: all of it is on the declared route');
    assert.equal(before.declaredScopeId, scopeId, 'and the figures say which declaration they were split against');
    assertPartitions(store, scopeId, 180, 10);

    assert.equal(store.clearOpenAiScope(), true, 'a supported act: stop attaching the scope to future rows');

    // The rows are untouched and still carry the declaration. What changed is
    // that there is no active route for them to be ON -- so they belong in the
    // off-scope bucket, not in no bucket at all.
    const after = store.openAiReconciliationCoverage(null);
    assert.ok(after, 'ten rows are still in the ledger, so there is still a report to make');
    assert.equal(after.onDeclaredRouteUsd, 0, 'nothing can be on a route that does not exist');
    assert.equal(after.proxyOffScopeUsd, 180, 'and the money has to be somewhere');
    assert.equal(after.proxyOffScopeRequests, 10);
    assert.equal(after.declaredScopeId, null, 'the basis: no declaration was active when this was computed');
    assertPartitions(store, null, 180, 10);
  } finally {
    store.close();
  }
});

test('the credential warning survives a cleared scope, which is when it matters most', () => {
  // Same guard D-186 restored, silenced here by the opposite route: not by an
  // empty report but by a populated-looking one whose uncountable bucket was
  // emptied. An operator with a cleared scope is exactly the operator who
  // should not go and mint an Admin key.
  const store = new Store(':memory:');
  try {
    const scopeId = declare(store);
    store.insertRequest(row('r1', 1, 50, {
      scopeCaptureStatus: 'declared_unverified', providerScopeDeclarationId: scopeId,
    }));
    store.clearOpenAiScope();

    const readiness = reconciliationReadiness(store);
    const c = readiness.coverage;
    assert.ok(c);
    const fires = c.onDeclaredRouteUsd === 0 && (c.importedUsd > 0 || c.proxyOffScopeUsd > 0);
    assert.equal(fires, true, 'you have OpenAI spend and none of it would count -- say so');
    assert.equal(c.declaredScopeId, null, 'and the reason is the missing route, not the rows');
  } finally {
    store.close();
  }
});

test('rows carrying a different declaration are off-scope, and the basis distinguishes them', () => {
  // The case whose explanation the old sentence WAS right about, kept separate
  // so the new one does not overwrite a true statement with another true
  // statement that happens to be about something else.
  const store = new Store(':memory:');
  try {
    const first = declare(store);
    store.insertRequest(row('r-old', 5, 20, {
      scopeCaptureStatus: 'declared_unverified', providerScopeDeclarationId: first,
    }));
    const second = store.setOpenAiScope({
      billingAccountRef: 'org_partition_2',
      providerProjectRef: 'proj_partition_2',
      upstreamBase: 'https://api.openai.com',
      declaredAtMs: 2,
      activatedAtMs: 2,
    }).declarationId;
    assert.notEqual(second, first);
    store.insertRequest(row('r-new', 1, 30, {
      scopeCaptureStatus: 'declared_unverified', providerScopeDeclarationId: second,
    }));

    const c = store.openAiReconciliationCoverage(second);
    assert.ok(c);
    assert.equal(c.onDeclaredRouteUsd, 30);
    assert.equal(c.proxyOffScopeUsd, 20, 'the older declaration is genuinely a different one');
    assert.equal(c.declaredScopeId, second);
    assertPartitions(store, second, 50, 2);
  } finally {
    store.close();
  }
});

test('a ledger that never declared a scope partitions exactly as it always did', () => {
  // The guard that keeps the fix from being a rewrite: unscoped proxy rows and
  // imported rows were always bucketed correctly, because neither predicate
  // touches a NULL parameter when the status is not `declared_unverified`.
  const store = new Store(':memory:');
  try {
    store.insertRequest(row('r-proxy', 2, 7));
    store.insertRequest(row('r-import', 3, 11, { via: 'import' }));

    const c = store.openAiReconciliationCoverage(null);
    assert.ok(c);
    assert.equal(c.onDeclaredRouteUsd, 0);
    assert.equal(c.importedUsd, 11);
    assert.equal(c.proxyOffScopeUsd, 7);
    assert.equal(c.declaredScopeId, null);
    assertPartitions(store, null, 18, 2);
  } finally {
    store.close();
  }
});
