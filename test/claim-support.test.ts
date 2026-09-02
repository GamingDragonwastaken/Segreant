/**
 * The server states its own claims' support, and the four axes reach the wire.
 *
 * WP-B02 replaced the GUI's `established: boolean` with four named axes but left
 * the JUDGEMENT in the browser, inferred from whatever collapsed field the
 * payload happened to carry. These tests pin what moving it to the server fixed,
 * and — more importantly — the three things that were WRONG while it lived in
 * the browser, each of which is a two-branch ternary's worth of missing state:
 *
 *   a reconciliation whose provider snapshots CONTRADICTED each other read as
 *   `supported`, because a count of runs has no branch for conflict;
 *
 *   a window with no spend in it read as COMPLETE pricing coverage, because
 *   `estimatedSpendShare` is 0 when there is nothing to price;
 *
 *   a residual that bounds no off-path spend at all (D-068) read as a
 *   reconciliation with complete coverage.
 *
 * The last test probes a live server rather than the declaration. A payload
 * field that type-checks and is not actually sent is this repository's most
 * expensive recurring defect, and asserting the wire against the wire is the
 * only thing that catches it.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { Store } from '../src/store/db.ts';
import { DEFAULT_CONFIG } from '../src/config.ts';
import { createDashboardServer } from '../src/dashboard/server.ts';
import {
  allocatedClaimSupport,
  billedClaimSupport,
  meteredClaimSupport,
  realizedClaimSupport,
} from '../src/dashboard/claim-support.ts';
import { EPISTEMIC_STATES } from '../src/epistemic/state.ts';
import { COVERAGE, MONETARY_BASIS } from '../src/epistemic/profile.ts';

const FIGURES = ['shown', 'withheld_unsupported', 'withheld_uncosted', 'not_a_money_claim'];

// ---------------------------------------------------------------------------
// Metered
// ---------------------------------------------------------------------------

test('a window with nothing priced does not report complete pricing coverage', () => {
  // `estimatedSpendShare` is 0 when `totalCostUsd` is 0, so the share test the
  // browser used — `share > 0 ? partial : complete` — answered `complete` for a
  // window with no evidence in it at all. A completeness claim with nothing
  // behind it is the defect D-067 and D-069 exist to refuse, one axis over.
  const empty = meteredClaimSupport({ totalCostUsd: 0, estimatedCostUsd: 0 });
  assert.equal(empty.coverage, 'unknown', 'no priced spend is unevidenced coverage, not complete coverage');
  assert.equal(empty.monetaryBasis, 'none');
  assert.match(empty.note ?? '', /unevidenced rather than complete/);

  // And the claim itself still holds: the ledger read, and what it observed is
  // $0.00. Metering nothing is a supported observation, not a missing one.
  assert.equal(empty.epistemic, 'supported');
  assert.equal(empty.figure, 'shown');
});

test('metered coverage distinguishes a matched rate card from an estimate', () => {
  const matched = meteredClaimSupport({ totalCostUsd: 12, estimatedCostUsd: 0 });
  assert.equal(matched.coverage, 'complete');
  assert.equal(matched.monetaryBasis, 'list');
  assert.equal(matched.note, undefined);

  const partly = meteredClaimSupport({ totalCostUsd: 12, estimatedCostUsd: 3 });
  assert.equal(partly.coverage, 'partial', 'a figure exists but does not wholly reach what it claims to measure');
  assert.equal(partly.monetaryBasis, 'mixed');
});

// ---------------------------------------------------------------------------
// Billed — the conflict the browser could not express
// ---------------------------------------------------------------------------

test('provider snapshots that disagree contradict the billed claim rather than establishing it', () => {
  const stable = billedClaimSupport({
    recordCount: 3,
    runCount: 1,
    latest: { snapshotStability: 'stable_across_observations', offPathBound: 'upper_bound_conditional' },
  });
  assert.equal(stable.epistemic, 'supported');
  assert.equal(stable.coverage, 'complete');

  const contradicted = billedClaimSupport({
    recordCount: 3,
    runCount: 1,
    latest: {
      snapshotStability: 'changed_across_observations',
      unstableDayStartMs: [Date.UTC(2026, 7, 1), Date.UTC(2026, 7, 2)],
      offPathBound: 'upper_bound_conditional',
    },
  });
  // Two observations of ONE proposition — what the provider billed on those
  // days — that disagree. `supported` would be the collapse WP-B03 removed from
  // the gate ladder, still standing on the billing claim.
  assert.equal(contradicted.epistemic, 'conflicted');
  assert.notEqual(contradicted.epistemic, 'refuted', 'a contradiction is not a disproof');
  assert.match(contradicted.note ?? '', /disagreed on 2 day\(s\)/);
});

test('a residual that bounds nothing is not a reconciliation with complete coverage', () => {
  // D-068: when the local estimate exceeds the provider total the residual
  // bounds no off-path spend at all, so the reconciled scope is not established
  // to reach what the provider charged.
  const bounded = billedClaimSupport({
    recordCount: 1, runCount: 1,
    latest: { snapshotStability: 'single_observation', offPathBound: 'upper_bound_conditional' },
  });
  assert.equal(bounded.coverage, 'complete');

  const unbounded = billedClaimSupport({
    recordCount: 1, runCount: 1,
    latest: { snapshotStability: 'single_observation', offPathBound: 'none_local_estimate_exceeds_provider' },
  });
  assert.equal(unbounded.coverage, 'partial');
  assert.equal(unbounded.epistemic, 'supported', 'the comparison still happened; what it reaches is the open question');
  assert.match(unbounded.note ?? '', /bounds no off-path spend/);
});

test('holding a provider bill is visible non-emptiness, not a billed claim', () => {
  const none = billedClaimSupport({ recordCount: 0, runCount: 0, latest: null });
  assert.equal(none.epistemic, 'unknown');
  assert.equal(none.coverage, 'unknown');

  const held = billedClaimSupport({ recordCount: 412, runCount: 0, latest: null });
  assert.equal(held.epistemic, 'unknown', '412 imported records establish nothing on their own');
  assert.equal(held.coverage, 'partial', 'but they are not nothing either — held, uncompared');
  assert.equal(held.monetaryBasis, 'none');

  // The band never carries a dollar in any branch: this is an evidence claim
  // about whether a comparison happened, not a second cost figure.
  for (const s of [none, held]) assert.equal(s.figure, 'not_a_money_claim');
});

// ---------------------------------------------------------------------------
// Allocated
// ---------------------------------------------------------------------------

test('cost centres without a run are partial coverage of an unknown claim, never a refuted one', () => {
  const empty = allocatedClaimSupport({ costCentreCount: 0, runCount: 0 });
  assert.deepEqual(
    { epistemic: empty.epistemic, coverage: empty.coverage, monetaryBasis: empty.monetaryBasis, figure: empty.figure },
    { epistemic: 'unknown', coverage: 'unknown', monetaryBasis: 'none', figure: 'not_a_money_claim' },
  );
  // The full profile travels beside the projection now; the axes it adds are
  // checked as a set in `test/claim-support-axes.test.ts`, so naming them again
  // here would pin the same fact in two places and break both on one change.
  assert.equal(empty.profile.integrity, 'unknown', 'nothing has been apportioned, so nothing has been verified');
  const defined = allocatedClaimSupport({ costCentreCount: 4, runCount: 0 });
  assert.equal(defined.epistemic, 'unknown', 'nothing has been apportioned');
  assert.notEqual(defined.epistemic, 'refuted', 'and nothing says it cannot be');
  assert.equal(defined.coverage, 'partial');

  const run = allocatedClaimSupport({ costCentreCount: 4, runCount: 1 });
  assert.equal(run.epistemic, 'supported');
  assert.equal(run.monetaryBasis, 'allocated');
  assert.equal(run.figure, 'not_a_money_claim', 'showback: the claim is whose cost it is, not how much');
});

// ---------------------------------------------------------------------------
// Realized — where a population of contradictions lands, and why it is not here
// ---------------------------------------------------------------------------

test('matured units with no labour rate are a supported claim with no figure', () => {
  const unpriced = realizedClaimSupport({
    maturedUnits: 40, realizedUnits: 40, gateConflicts: null, roiCoverage: 1, valued: false,
  });
  assert.equal(unpriced.epistemic, 'supported', 'the units did mature and ship');
  assert.equal(unpriced.figure, 'withheld_uncosted', 'only the input that would price them is missing');
  assert.equal(unpriced.monetaryBasis, 'none');

  const none = realizedClaimSupport({
    maturedUnits: 0, realizedUnits: 0, gateConflicts: null, roiCoverage: null, valued: false,
  });
  assert.equal(none.epistemic, 'unknown');
  assert.equal(none.figure, 'withheld_unsupported');
  // The two cases the old boolean reported identically, as "not established".
  assert.notEqual(unpriced.figure, none.figure);
});

test('contradicted gate evidence is a hole in coverage, not a contradiction in the aggregate', () => {
  // `informationJoin` combines two observations OF ONE PROPOSITION. Twelve
  // mature units whose gate evidence contradicted itself are twelve DIFFERENT
  // propositions, and a conflicted unit does not realize at all — so the figure
  // is sound for the units it covers and the aggregate under-counts by an
  // unadjudicated amount. That is coverage. Painting the aggregate `conflicted`
  // would assert of the whole a state none of its parts asserts about it.
  const conflicted = realizedClaimSupport({
    maturedUnits: 52, realizedUnits: 40,
    gateConflicts: { clean: 9, survived: 3, shipped: 0 },
    roiCoverage: 1, valued: true,
  });
  assert.equal(conflicted.epistemic, 'supported');
  assert.notEqual(conflicted.epistemic, 'conflicted', 'a population of contradictions is not an aggregate contradiction');
  assert.equal(conflicted.coverage, 'partial', 'the claim does not reach the units that never adjudicated');
  assert.equal(conflicted.figure, 'shown');
  assert.match(conflicted.note ?? '', /12 mature unit\(s\)/);
  assert.match(conflicted.note ?? '', /clean, survived/);
  assert.doesNotMatch(conflicted.note ?? '', /shipped/, 'a gate with zero conflicts is not named');
  assert.match(conflicted.note ?? '', /unadjudicated rather than refuted/);

  // Without conflicts, full RoI coverage is complete — so the assertion above
  // is about the conflicts and not about something else in the fixture.
  const clean = realizedClaimSupport({
    maturedUnits: 52, realizedUnits: 40, gateConflicts: { clean: 0 }, roiCoverage: 1, valued: true,
  });
  assert.equal(clean.coverage, 'complete');
  assert.equal(clean.note, undefined);
});

test('RoI lens coverage that cannot be computed is unknown, never complete', () => {
  const unmeasured = realizedClaimSupport({
    maturedUnits: 5, realizedUnits: 5, gateConflicts: null, roiCoverage: null, valued: true,
  });
  assert.equal(unmeasured.coverage, 'unknown');
  const partial = realizedClaimSupport({
    maturedUnits: 5, realizedUnits: 5, gateConflicts: null, roiCoverage: 0.5, valued: true,
  });
  assert.equal(partial.coverage, 'partial');
});

// ---------------------------------------------------------------------------
// Every axis value is one the kernel declares
// ---------------------------------------------------------------------------

test('nothing invents an axis value the kernel does not declare', () => {
  const samples = [
    meteredClaimSupport({ totalCostUsd: 0, estimatedCostUsd: 0 }),
    meteredClaimSupport({ totalCostUsd: 10, estimatedCostUsd: 1 }),
    meteredClaimSupport({ totalCostUsd: 10, estimatedCostUsd: 0 }),
    billedClaimSupport({ recordCount: 0, runCount: 0, latest: null }),
    billedClaimSupport({ recordCount: 9, runCount: 0, latest: null }),
    billedClaimSupport({ recordCount: 9, runCount: 2, latest: { snapshotStability: 'changed_across_observations' } }),
    billedClaimSupport({ recordCount: 9, runCount: 2, latest: { offPathBound: 'none_local_estimate_exceeds_provider' } }),
    allocatedClaimSupport({ costCentreCount: 0, runCount: 0 }),
    allocatedClaimSupport({ costCentreCount: 2, runCount: 0 }),
    allocatedClaimSupport({ costCentreCount: 2, runCount: 2 }),
    realizedClaimSupport({ maturedUnits: 0, realizedUnits: 0, gateConflicts: null, roiCoverage: null, valued: false }),
    realizedClaimSupport({ maturedUnits: 3, realizedUnits: 3, gateConflicts: { clean: 1 }, roiCoverage: 1, valued: true }),
  ];
  assert.ok(samples.length >= 12, 'the sweep must actually exercise every branch it claims to');

  for (const s of samples) {
    assert.ok(EPISTEMIC_STATES.includes(s.epistemic), `epistemic: ${s.epistemic}`);
    assert.ok((COVERAGE as readonly string[]).includes(s.coverage), `coverage: ${s.coverage}`);
    assert.ok((MONETARY_BASIS as readonly string[]).includes(s.monetaryBasis), `monetaryBasis: ${s.monetaryBasis}`);
    assert.ok(FIGURES.includes(s.figure), `figure: ${s.figure}`);
  }

  // Non-vacuity: at least one sample must reach each of the states the browser
  // inference structurally could not produce, or this file proves nothing.
  assert.ok(samples.some((s) => s.epistemic === 'conflicted'), 'no sample reaches conflicted');
  assert.ok(samples.some((s) => s.coverage === 'unknown'), 'no sample reaches unknown coverage');
});

// ---------------------------------------------------------------------------
// The wire, asserted against the wire
// ---------------------------------------------------------------------------

function boot(store: Store): Promise<{ base: string; close: () => Promise<void> }> {
  const server = createDashboardServer({ store, config: structuredClone(DEFAULT_CONFIG), version: 'test' });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as AddressInfo).port;
      resolve({ base: `http://127.0.0.1:${port}`, close: () => new Promise((r) => server.close(() => r())) });
    });
  });
}

function getJson(url: string): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let body = '';
      res.on('data', (chunk) => { body += String(chunk); });
      res.on('end', () => {
        try { resolve(JSON.parse(body) as Record<string, unknown>); } catch (err) { reject(err); }
      });
    }).on('error', reject);
  });
}

test('every claim route actually sends its support on the wire', async () => {
  const store = new Store(':memory:');
  const { base, close } = await boot(store);
  try {
    for (const route of ['overview', 'billing', 'allocation']) {
      const payload = await getJson(`${base}/api/${route}`);
      const support = payload.claimSupport as Record<string, unknown> | undefined;
      assert.ok(support, `/api/${route} did not send claimSupport — a declared field that is not on the wire`);
      for (const axis of ['epistemic', 'coverage', 'monetaryBasis', 'figure']) {
        assert.equal(typeof support[axis], 'string', `/api/${route} claimSupport.${axis}`);
      }
    }

    // An empty ledger: the point of probing rather than asserting the type is
    // that this is the exact state in which the old browser inference reported
    // complete pricing coverage.
    const overview = await getJson(`${base}/api/overview`);
    const metered = overview.claimSupport as Record<string, unknown>;
    assert.equal(metered.coverage, 'unknown');
    assert.equal(metered.epistemic, 'supported');

    const billing = await getJson(`${base}/api/billing`);
    const billed = billing.claimSupport as Record<string, unknown>;
    assert.equal(billed.epistemic, 'unknown', 'no reconciliation has been recorded');
    assert.equal(billed.figure, 'not_a_money_claim');
  } finally {
    await close();
    store.close();
  }
});
