/**
 * COVERAGE DOES NOT COMPOSE FROM PARTIAL EVIDENCE, AND THAT IS THE RULE, NOT A
 * GAP (WP-R05, D-235).
 *
 * WP-R05 left one item open: "two partial exports that tile a scope are
 * refused rather than unioned, which needs a CompletenessWitness". Read
 * against the producers, the refusal is correct and the union would be an
 * escalation. `src/billing/epistemic.ts` emits `status: 'partial'` with
 * `coveredTime: validTime` — the covered bounds are the EXTENT of a partial
 * capture, not a region inside which the capture is complete. Two such
 * records whose bounds tile a period say "partial here" and "partial there";
 * nothing in either says the period is whole. The only thing that can say so
 * is a record that declares `complete` over the union, and the ledger already
 * accepts that (a negative claim needs exactly such a witness, checked at
 * `assertClaimWithinItsEvidence`).
 *
 * This test pins the property so it is asserted rather than assumed: a claim
 * of `coverage: 'complete'` citing only partial evidence is refused even when
 * the cited `coveredTime`s tile its validTime exactly and their `coveredScope`
 * contains its scope; the same claim citing one `complete` witness over the
 * union is accepted; and the ceiling is per-axis (the partial pair still
 * supports `coverage: 'partial'`).
 *
 * Shown able to fail: with the coverage ceiling removed from
 * `assertClaimWithinItsEvidence` the first assertion passes the claim.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { EpistemicLedger } from '../src/epistemic/ledger.ts';
import { evidence } from '../src/epistemic/evidence.ts';
import { claim } from '../src/epistemic/claim.ts';
import { claimProfile, type ClaimProfile } from '../src/epistemic/profile.ts';
import { grain } from '../src/epistemic/grain.ts';
import { scope } from '../src/epistemic/scope.ts';

const T0 = '2026-08-01T00:00:00.000Z';
const T1 = '2026-08-02T00:00:00.000Z';
const T2 = '2026-08-03T00:00:00.000Z';
const SCOPE = scope({ account: 'acct-1' });
const GRAIN = grain(['day']);

function exportRecord(id: string, status: 'partial' | 'complete', from: string, to: string) {
  return evidence({
    id, evidenceType: 'billing.export', sourceIdentity: 'provider:test', sourceClass: 'provider_export',
    payload: { rows: 1 }, scope: SCOPE, grain: GRAIN, occurredAt: from, validTime: { from, to }, observedAt: to, finalizedAt: null,
    integrity: 'verified', authenticity: 'pinned',
    completeness: { status, method: 'declared_export', coveredEventTypes: ['billing.charge'], coveredScope: SCOPE, coveredTime: { from, to } },
    measurementModelRef: null, monetaryBasis: null, schemaVersion: 1, sensitivity: 'internal', redaction: 'none',
  });
}

function totalClaim(id: string, evidenceIds: string[], coverage: ClaimProfile['coverage']) {
  return claim({
    id, proposition: { predicate: 'billing.total', value: { amount: '10.00' } }, subject: 'account:acct-1', scope: SCOPE, grain: GRAIN,
    time: { validTime: { from: T0, to: T2 }, asOf: T2 }, epistemic: 'supported',
    profile: claimProfile({ epistemic: 'supported', integrity: 'verified', authenticity: 'pinned', scope: 'conditional', coverage, measurement: 'proxy_unvalidated', causality: 'none', monetaryBasis: 'none', finality: 'provisional', decisionFitness: 'not_assessed' }),
    measurementModelRef: null, evidenceIds, derivationRule: 'billing.total.v1', derivationVersion: 1, causalStatus: 'none', issuedAt: T2, schemaVersion: 1,
  });
}

test('two partial exports that tile the claim period do not compose into complete coverage', () => {
  const ledger = new EpistemicLedger(new DatabaseSync(':memory:'));
  ledger.appendEvidence(exportRecord('evidence:first-half', 'partial', T0, T1));
  ledger.appendEvidence(exportRecord('evidence:second-half', 'partial', T1, T2));
  assert.throws(
    () => ledger.appendClaim(totalClaim('claim:tiled', ['evidence:first-half', 'evidence:second-half'], 'complete')),
    /declares coverage complete, above the partial of the weakest evidence it cites/,
    'partial + partial tiling a period is still partial: neither record says its interval is whole',
  );
  assert.equal(ledger.readClaim('claim:tiled'), null, 'a refused claim must not land');
});

test('the same pair supports a partial claim, and one complete witness over the union supports a complete one', () => {
  const ledger = new EpistemicLedger(new DatabaseSync(':memory:'));
  ledger.appendEvidence(exportRecord('evidence:first-half', 'partial', T0, T1));
  ledger.appendEvidence(exportRecord('evidence:second-half', 'partial', T1, T2));
  ledger.appendEvidence(exportRecord('evidence:whole', 'complete', T0, T2));
  ledger.appendClaim(totalClaim('claim:partial', ['evidence:first-half', 'evidence:second-half'], 'partial'));
  ledger.appendClaim(totalClaim('claim:whole', ['evidence:whole'], 'complete'));
  assert.equal(ledger.readClaim('claim:partial')?.profile.coverage, 'partial');
  assert.equal(ledger.readClaim('claim:whole')?.profile.coverage, 'complete', 'completeness is asserted by a record that declares it, never composed');
});
