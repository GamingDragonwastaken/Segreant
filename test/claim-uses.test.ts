/**
 * What a claim may be USED for, and who gets to answer (WP-B05).
 *
 * Four surfaces in this repository bar a figure from a set of downstream uses,
 * and every one of them does it with a hand-written array literal:
 *
 *   `src/alloc/exact.ts`        four names, and a validator that rejects any
 *                               other four
 *   `src/billing/reconcile.ts`  the same four
 *   `src/billing/openaiCosts.ts` the same four again
 *   `src/billing/mapping.ts`    three
 *   `src/dashboard/routes.ts`   five, twice — the extra one, `outcome_attribution`,
 *                               appears nowhere else under `src/`
 *
 * Three vocabularies. Each is pinned by a passing test, and nothing compares
 * them to each other, so the disagreement is asserted twice and detected never.
 * That is what an inert list does: it cannot be wrong, because there is nothing
 * it has to agree with.
 *
 * None of them says WHY. An operator reading `Excluded from budget_enforcement`
 * learns that a door is shut and nothing about which property of the evidence
 * shuts it, or what would have to change to open it — which is the same defect
 * WP-B04 found in the residual's conditions, one surface along.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { admits, compareForUse, ORDERED_AXES, UNORDERED_AXES, useRequirement } from '../src/epistemic/admissibility.ts';
import { isClaimUse, USE_REQUIREMENTS } from '../src/epistemic/claim-uses.ts';
import { claimProfile, type ClaimProfile } from '../src/epistemic/profile.ts';
import { Store, type RequestRow } from '../src/store/db.ts';
import { DEFAULT_CONFIG } from '../src/config.ts';
import { createDashboardServer } from '../src/dashboard/server.ts';

const DAY = 24 * 60 * 60 * 1000;
const D0 = Date.UTC(2026, 6, 1);
const NOW = D0 + 30 * DAY;

function boot(store: Store): Promise<{ base: string; close: () => Promise<void> }> {
  const server = createDashboardServer({ store, config: structuredClone(DEFAULT_CONFIG), version: 'test' });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as AddressInfo).port;
      resolve({ base: `http://127.0.0.1:${port}`, close: () => new Promise((r) => server.close(() => r())) });
    });
  });
}

let seq = 0;
function request(scopeId: string, dayIndex: number, costUsd: number): RequestRow {
  return {
    requestId: `r-uses-${seq++}`,
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
    providerScopeDeclarationId: scopeId,
  };
}

/** A store carrying one recorded reconciliation run. */
function storeWithReconciliation(): Store {
  const store = new Store(':memory:');
  const scope = store.setOpenAiScope({
    billingAccountRef: 'org_test',
    providerProjectRef: 'proj_test',
    upstreamBase: 'https://api.openai.com',
  });
  store.recordOpenAiCostsObservation({
    declaredScopeId: scope.declarationId,
    providerProjectRef: 'proj_test',
    periodStartMs: D0,
    periodEndMs: D0 + 2 * DAY,
    fetchedAtMs: D0 + 3 * DAY,
    paginationComplete: true,
    pageCount: 1,
    pageDigestChainSha256: 'd'.repeat(64),
    resultState: 'succeeded',
    failureCode: null,
    observations: [
      { providerProjectRef: 'proj_test', bucketStartMs: D0, bucketEndMs: D0 + DAY, lineItem: 'gpt-4o', currency: 'USD', amountDecimal: '10' },
      { providerProjectRef: 'proj_test', bucketStartMs: D0 + DAY, bucketEndMs: D0 + 2 * DAY, lineItem: 'gpt-4o', currency: 'USD', amountDecimal: '20' },
    ],
  });
  store.insertRequest(request(scope.declarationId, 0, 9));
  store.insertRequest(request(scope.declarationId, 1, 20));
  const result = store.reconcileOpenAiCosts({ now: NOW });
  assert.ok(result && result.status === 'reconciled_with_residual', 'the fixture must produce a run to compare against');
  store.saveReconciliationRun(result, NOW);
  return store;
}

test('the dashboard bars a reconciliation from the same uses the run itself does', async () => {
  // THE DISAGREEMENT, AT ITS SHARPEST. The route's own comment says
  // reconciliation is "a DERIVED, immutable record — read here, never computed
  // here", because serving a freshly computed answer would let the page
  // disagree with the recorded evidence. It then reads the record and
  // hand-writes an `excludedFrom` beside it that disagrees with the one the
  // record carries.
  //
  // Which of the two is right is a separate question, and a defensible case
  // exists for the longer list. What cannot be defended is the page and the
  // record answering the same question differently with nothing to notice.
  const store = storeWithReconciliation();
  const { base, close } = await boot(store);
  try {
    const res = await fetch(new URL('/api/billing', base));
    assert.equal(res.status, 200);
    const body = await res.json() as {
      reconciliation: { runs: { result: { excludedFrom: string[] } }[]; excludedFrom: string[] };
    };
    assert.equal(body.reconciliation.runs.length, 1, 'the fixture run must reach the payload');

    const recorded = body.reconciliation.runs[0]!.result.excludedFrom;
    assert.deepEqual(
      [...body.reconciliation.excludedFrom].sort(),
      [...recorded].sort(),
      'the page and the record it is displaying must bar the same uses',
    );
  } finally {
    await close();
    store.close();
  }
});

// ---------------------------------------------------------------------------
// One vocabulary
// ---------------------------------------------------------------------------

test('every surface that bars a figure draws from the one declared vocabulary', async () => {
  // The check that makes the registry load-bearing rather than decorative. It
  // reads what the surfaces actually EMIT rather than scanning source for
  // literals: a regex over array literals would keep passing the day someone
  // builds the list some other way, which is exactly when it would matter.
  const store = storeWithReconciliation();
  const { base, close } = await boot(store);
  try {
    const billing = await (await fetch(new URL('/api/billing', base))).json() as {
      evidence: { excludedFrom: string[] };
      mapping: { excludedFrom: string[] };
      reconciliation: { runs: { result: { excludedFrom: string[] } }[]; excludedFrom: string[] };
    };
    const allocation = await (await fetch(new URL('/api/allocation', base))).json() as { excludedFrom: string[] };

    const emitted = new Map<string, readonly string[]>([
      ['billing evidence', billing.evidence.excludedFrom],
      ['billing mapping', billing.mapping.excludedFrom],
      ['reconciliation payload', billing.reconciliation.excludedFrom],
      ['reconciliation record', billing.reconciliation.runs[0]!.result.excludedFrom],
      ['allocation', allocation.excludedFrom],
    ]);

    for (const [surface, names] of emitted) {
      assert.ok(names.length > 0, `${surface} emitted no exclusions, so this check would be vacuous for it`);
      const unknown = names.filter((name) => !isClaimUse(name));
      assert.deepEqual(unknown, [], `${surface} names a use no registry declares: ${unknown.join(', ')}`);
    }

    // And the sweep must reach more than one vocabulary, or it would pass while
    // checking a single list against itself.
    const shapes = new Set([...emitted.values()].map((names) => [...names].sort().join(',')));
    assert.ok(shapes.size >= 2, 'the surfaces still differ in what they bar, which is what makes one vocabulary necessary');
  } finally {
    await close();
    store.close();
  }
});

test('the ordered and unordered axes together are exactly the profile axes', () => {
  // Two hand-written lists that have to partition one thing. `ORDERS` is
  // exhaustive over `ORDERED_AXES` by type; nothing but this says the pair
  // covers the profile, so an axis added to `ClaimProfile` would otherwise be
  // silently unrequireable — present on every claim and impossible to bar on.
  const source = readFileSync(join(import.meta.dirname, '..', 'src', 'epistemic', 'profile.ts'), 'utf8');
  const declared = [...source.matchAll(/^\s{2}readonly (\w+):/gm)].map((match) => match[1]!);
  assert.ok(declared.length >= 10, `expected the full profile, read ${declared.length} axes`);

  assert.deepEqual([...ORDERED_AXES, ...UNORDERED_AXES].sort(), [...new Set(declared)].sort());
});

// ---------------------------------------------------------------------------
// The machinery
// ---------------------------------------------------------------------------

const BILLED: ClaimProfile = claimProfile({
  epistemic: 'supported', integrity: 'verified', authenticity: 'self_asserted', scope: 'conditional',
  coverage: 'complete', measurement: 'proxy_unvalidated', causality: 'none', monetaryBasis: 'billed',
  finality: 'provisional', decisionFitness: 'not_assessed',
});
const METERED: ClaimProfile = claimProfile({ ...BILLED, integrity: 'unknown', monetaryBasis: 'list' });
const ALLOCATED: ClaimProfile = claimProfile({ ...BILLED, monetaryBasis: 'allocated' });

test('a bar cannot be stated as a minimum on an axis that has no order', () => {
  // THE ASSERTION THIS MODULE EXISTS FOR. `mergeClaimProfiles` refuses to rank
  // monetary bases because they name different economic semantics rather than
  // degrees of one thing. A requirement reading `atLeast: billed` would assert
  // that ranking anyway, in the one place nobody would think to look for it.
  assert.throws(
    () => useRequirement({
      id: 'invented', requires: [{ axis: 'monetaryBasis', atLeast: 'billed' } as never], because: 'a test bar',
    }),
    /has no declared ordering; state the acceptable values with oneOf instead/,
  );
  // And the reverse, so the two kinds cannot be swapped for one another.
  assert.throws(
    () => useRequirement({
      id: 'invented', requires: [{ axis: 'integrity', oneOf: ['verified'] } as never], because: 'a test bar',
    }),
    /which is ordered; state a minimum with atLeast/,
  );
});

test('a use nobody has stated a bar for admits nothing, and says which of the two it is', () => {
  // The same rule `assessAssumptionFragility` applies to an unexamined claim.
  // `admitted: false` with an empty `unmet` would read as "failed nothing in
  // particular"; `stated` is what separates unexamined from refused.
  const unstated = admits(BILLED, USE_REQUIREMENTS.roi);
  assert.equal(unstated.stated, false);
  assert.equal(unstated.admitted, false, 'an unasked question is not a passed test');
  assert.deepEqual([...unstated.unmet], []);
  assert.match(unstated.because, /unstated requirement is not a satisfied one/);

  // A stated bar has to behave like one in both directions, or the flag above
  // would be the only outcome this module ever produced.
  assert.equal(admits(METERED, USE_REQUIREMENTS.request_metered_spend).admitted, true);
  const refused = admits(BILLED, USE_REQUIREMENTS.request_metered_spend);
  assert.equal(refused.stated, true);
  assert.equal(refused.admitted, false);
  assert.deepEqual([...refused.unmet], [{ axis: 'monetaryBasis', needed: 'one of list, mixed', actual: 'billed' }]);
});

test('budget enforcement fails closed on a figure whose own sources disagree', () => {
  // Not a new policy: the fail-closed rule is already stated, and
  // `billedClaimSupport` already returns `conflicted` when snapshots of one
  // period disagree. What is new is that the rule is checkable against a profile
  // instead of being a sentence somebody has to remember.
  const conflicted = claimProfile({ ...METERED, epistemic: 'conflicted' });
  const verdict = admits(conflicted, USE_REQUIREMENTS.budget_enforcement);
  assert.equal(verdict.admitted, false);
  assert.deepEqual([...verdict.unmet], [{ axis: 'epistemic', needed: 'one of supported', actual: 'conflicted' }]);
  assert.equal(admits(METERED, USE_REQUIREMENTS.budget_enforcement).admitted, true);
});

test('two claims that satisfy different things are INCOMPARABLE, not ranked', () => {
  // THE POINT OF WP-B05. Billed and allocated are different economic semantics,
  // and a module that ranked them would have invented the ladder this one exists
  // to avoid.
  assert.equal(
    compareForUse(BILLED, ALLOCATED, USE_REQUIREMENTS.request_metered_spend),
    'incomparable',
    'billed and allocated are different economic semantics, not two rungs of one',
  );

  // Ordered where an ordering genuinely exists, so `incomparable` is a finding
  // rather than this function's only answer.
  const integrityBar = useRequirement({
    id: 'integrity-only', requires: [{ axis: 'integrity', atLeast: 'unverifiable' }], because: 'a test bar',
  });
  assert.equal(compareForUse(BILLED, METERED, integrityBar), 'better');
  assert.equal(compareForUse(METERED, BILLED, integrityBar), 'worse');
  assert.equal(compareForUse(BILLED, ALLOCATED, integrityBar), 'equivalent');

  // A use with no stated bar orders nothing. `equivalent` would say the two are
  // interchangeable for it, which is a claim nobody has made.
  assert.equal(compareForUse(BILLED, METERED, USE_REQUIREMENTS.roi), 'incomparable');
});
