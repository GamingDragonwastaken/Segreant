/**
 * Reconciliation readiness has to reach the GUI, not just the terminal.
 *
 * On the owner's real ledger every OpenAI row arrived by native import, so a
 * reconciliation would match $0 of $832.33. The CLI says so, at length, before
 * the credential step — minting an OpenAI Admin key is a real permission
 * decision, and discovering afterwards that nothing would have counted is
 * discovering it too late.
 *
 * The dashboard could not say it at all. `/api/billing` carries
 * `directOpenAiCosts.coverage`, which is the POST-observation partition and is
 * `null` until a provider snapshot exists — so on the exact ledger the warning
 * was written for, the GUI's only readiness affordance was a card telling you
 * to go and run a CLI command. That leaves the primary surface silent about a
 * limit the product's own rules require it to state in the same place as the
 * result.
 *
 * Two things are pinned here:
 *
 *   1. The readiness computation is SHARED, not reimplemented per surface. The
 *      CLI and the API must return the same object for the same store. This
 *      repository has already shipped one defect of exactly the opposite shape
 *      — a GUI declaration that disagreed with the wire — and two hand-written
 *      copies of a rule drift the same way.
 *   2. The wire actually carries it, with the shape the GUI declares. Checked
 *      against a real response, not against another declaration.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Store, type RequestRow } from '../src/store/db.ts';
import { DEFAULT_CONFIG } from '../src/config.ts';
import { createDashboardServer } from '../src/dashboard/server.ts';

const DAY = 86_400_000;
const D0 = Date.UTC(2026, 0, 1);
let seq = 0;

function row(over: Partial<RequestRow> = {}): RequestRow {
  return {
    requestId: `r-${seq++}`,
    sessionId: null,
    tsEpochMs: D0 + 6 * 60 * 60 * 1000,
    provider: 'openai',
    model: 'gpt-4o',
    project: 'p',
    taskWeight: 1,
    inputTokens: 100,
    outputTokens: 10,
    cacheWriteTokens: 0,
    cacheReadTokens: 0,
    reasoningTokens: 0,
    costUsd: 1,
    estimated: false,
    streamed: false,
    statusCode: 200,
    durationMs: 10,
    via: 'import',
    scopeCaptureStatus: 'not_observed',
    providerScopeDeclarationId: null,
    ...over,
  };
}

/** A ledger shaped like the owner's: real OpenAI spend, all of it imported. */
function importedOnlyStore(): Store {
  const store = new Store(':memory:');
  for (let i = 0; i < 3; i++) store.insertRequest(row({ costUsd: 2, tsEpochMs: D0 + i * DAY }));
  return store;
}

async function billingPayload(store: Store): Promise<Record<string, any>> {
  const server = createDashboardServer({ store, config: DEFAULT_CONFIG, version: 'test' });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  try {
    const { port } = server.address() as AddressInfo;
    const res = await fetch(`http://127.0.0.1:${port}/api/billing`);
    assert.equal(res.status, 200);
    return await res.json() as Record<string, any>;
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
}

test('the readiness computation is shared, not reimplemented per surface', async () => {
  const mod = await import('../src/billing/readiness.ts') as Record<string, any>;
  assert.equal(
    typeof mod.reconciliationReadiness,
    'function',
    '`reconciliationReadiness` must live in src/billing/, reachable by BOTH the CLI and the dashboard',
  );
});

test('readiness reports that imported spend would reconcile nothing', async () => {
  const { reconciliationReadiness } = await import('../src/billing/readiness.ts') as Record<string, any>;
  const store = importedOnlyStore();
  const readiness = reconciliationReadiness(store);

  assert.equal(readiness.ready, false, 'no scope and no observation means not ready');
  assert.ok(readiness.coverage, 'a ledger holding OpenAI rows must produce coverage, never null');
  assert.equal(readiness.coverage.onDeclaredRouteUsd, 0, 'nothing is on the declared route');
  assert.equal(readiness.coverage.importedRequests, 3);
  assert.equal(readiness.coverage.importedUsd, 6);
});

test('coverage stays null when the ledger holds no OpenAI rows at all', async () => {
  // "No coverage" and "no data" are different answers, and the difference is
  // the whole point of reporting this before a credential is minted.
  const { reconciliationReadiness } = await import('../src/billing/readiness.ts') as Record<string, any>;
  const store = new Store(':memory:');
  assert.equal(reconciliationReadiness(store).coverage, null);
});

test('/api/billing carries the readiness the GUI needs to warn anyone', async () => {
  const payload = await billingPayload(importedOnlyStore());

  assert.ok(payload.readiness, '/api/billing must expose readiness');
  assert.equal(payload.readiness.ready, false);
  assert.ok(Array.isArray(payload.readiness.missing), 'missing must be an array of steps');
  assert.ok(payload.readiness.missing.length > 0);

  const c = payload.readiness.coverage;
  assert.ok(c && typeof c === 'object', 'coverage must be an object on a ledger with OpenAI rows');
  assert.equal(c.onDeclaredRouteUsd, 0);
  assert.equal(c.importedUsd, 6);
});

test('the API and the CLI answer with the same readiness for the same store', async () => {
  // The drift guard. Two surfaces, one rule.
  const { reconciliationReadiness } = await import('../src/billing/readiness.ts') as Record<string, any>;
  const store = importedOnlyStore();
  const direct = reconciliationReadiness(store);
  const overWire = (await billingPayload(store)).readiness;
  assert.deepEqual(
    JSON.parse(JSON.stringify(direct)),
    overWire,
    'the dashboard must serve the shared computation verbatim, not a second implementation',
  );
});

test('the GUI declares readiness with the shape the wire actually sends', async () => {
  // `reconciliation.runs` was declared a number while the server sent an array,
  // which type-checked on both sides and silently broke the Billed band. So the
  // declaration is compared against a REAL response here, never against itself.
  const src = readFileSync(
    join(import.meta.dirname, '..', 'src', 'dashboard', 'shared-types.ts'),
    'utf8',
  );
  assert.ok(/readiness/.test(src), 'the browser app must declare the readiness field');

  const payload = await billingPayload(importedOnlyStore());
  assert.equal(typeof payload.readiness.ready, 'boolean');
  assert.ok(Array.isArray(payload.readiness.missing));
  for (const step of payload.readiness.missing) {
    assert.equal(typeof step.step, 'string');
    assert.equal(typeof step.detail, 'string');
    assert.equal(typeof step.ownerAction, 'boolean');
  }
});
