/**
 * THE ABSTRACT PRESERVATION CHECKER AND THE LEDGER'S CONCRETE DIRECT-PATH
 * GUARD AGREE ON EVERY POINT OF THE EVIDENCE-COMPARABLE GRID (WP-R02, D-235).
 *
 * WP-R02 left "product-wide integration" open. What is wired into the product
 * is the ledger: `assertClaimWithinItsEvidence` bounds a direct claim by the
 * weakest cited evidence on the three axes an Evidence record carries
 * (integrity, authenticity, completeness -> coverage), `assessDerivationLegality`
 * bounds each derivation step, and `analyzeDerivationChain` bounds whole
 * chains (D-222). `assessPreservation` in `preservation.ts` is the abstract
 * statement of the same rule and has no production caller — which made it a
 * specification the code was never held to.
 *
 * This test holds it. Over the full grid of evidence axis values
 * (3 x 4 x 3 = 36) against the full grid of claim axis values (36), and over
 * every evidence PAIR (1296) against the strongest claim, the ledger accepts a
 * direct claim if and only if the abstract checker allows it. Where the two
 * disagree the test names the point, so a rule added to one side and not the
 * other cannot drift silently. Neither side is truth: both compare a claim to
 * what its evidence can support.
 *
 * Shown able to fail: with the ledger's coverage ceiling removed, the
 * abstract checker refuses points the ledger accepts and the grid test names
 * them.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { EpistemicLedger } from '../src/epistemic/ledger.ts';
import { evidence } from '../src/epistemic/evidence.ts';
import { claim } from '../src/epistemic/claim.ts';
import { AUTHENTICITY, COVERAGE, INTEGRITY, claimProfile, type ClaimProfile } from '../src/epistemic/profile.ts';
import { grain } from '../src/epistemic/grain.ts';
import { scope } from '../src/epistemic/scope.ts';
import { assessPreservation, type CitedEvidenceAbstract } from '../src/epistemic/preservation.ts';

const T0 = '2026-08-01T00:00:00.000Z';
const T1 = '2026-08-02T00:00:00.000Z';
const SCOPE = scope({ account: 'acct-1' });
const GRAIN = grain(['day']);

type Axes = { integrity: ClaimProfile['integrity']; authenticity: ClaimProfile['authenticity']; coverage: ClaimProfile['coverage'] };

const GRID: readonly Axes[] = INTEGRITY.flatMap((integrity) => AUTHENTICITY.flatMap((authenticity) => COVERAGE.map((coverage) => ({ integrity, authenticity, coverage }))));

/** The axes an Evidence record cannot carry are held at the floor on both sides, so only the comparable three vary. */
function profileOf(axes: Axes): ClaimProfile {
  return claimProfile({
    epistemic: 'supported', integrity: axes.integrity, authenticity: axes.authenticity, scope: 'conditional', coverage: axes.coverage,
    measurement: 'proxy_unvalidated', causality: 'none', monetaryBasis: 'none', finality: 'provisional', decisionFitness: 'not_assessed',
  });
}

function record(id: string, axes: Axes) {
  return evidence({
    id, evidenceType: 'billing.export', sourceIdentity: 'provider:test', sourceClass: 'provider_export', payload: { id },
    scope: SCOPE, grain: GRAIN, occurredAt: T0, validTime: { from: T0, to: T1 }, observedAt: T1, finalizedAt: null,
    integrity: axes.integrity, authenticity: axes.authenticity, completeness: { status: axes.coverage, method: 'declared_export' },
    measurementModelRef: null, monetaryBasis: null, schemaVersion: 1, sensitivity: 'internal', redaction: 'none',
  });
}

function cited(id: string, axes: Axes): CitedEvidenceAbstract {
  return { id, profile: profileOf(axes), coordinates: { grain: GRAIN, scope: SCOPE } };
}

function ledgerAccepts(evidenceAxes: readonly Axes[], claimAxes: Axes): boolean {
  const ledger = new EpistemicLedger(new DatabaseSync(':memory:'));
  const ids = evidenceAxes.map((axes, index) => { const id = `evidence:${index}`; ledger.appendEvidence(record(id, axes)); return id; });
  try {
    ledger.appendClaim(claim({
      id: 'claim:probe', proposition: { predicate: 'billing.total', value: { amount: '1.00' } }, subject: 'account:acct-1', scope: SCOPE, grain: GRAIN,
      time: { validTime: { from: T0, to: T1 }, asOf: T1 }, epistemic: 'supported', profile: profileOf(claimAxes),
      measurementModelRef: null, evidenceIds: ids, derivationRule: 'billing.total.v1', derivationVersion: 1, causalStatus: 'none', issuedAt: T1, schemaVersion: 1,
    }));
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    assert.match(message, /above the .* of the weakest evidence it cites/, `only the ceiling may refuse a grid point: ${message}`);
    return false;
  }
}

function abstractAllows(evidenceAxes: readonly Axes[], claimAxes: Axes): boolean {
  return assessPreservation({
    proposed: { profile: profileOf(claimAxes), coordinates: { grain: GRAIN, scope: SCOPE } },
    citedEvidence: evidenceAxes.map((axes, index) => cited(`evidence:${index}`, axes)),
  }).allowed;
}

const label = (axes: Axes): string => `${axes.integrity}/${axes.authenticity}/${axes.coverage}`;

test('one cited record: the ledger accepts a direct claim exactly when the abstract checker allows it, over the whole grid', () => {
  const disagreements: string[] = [];
  let accepted = 0;
  for (const source of GRID) {
    for (const proposed of GRID) {
      const concrete = ledgerAccepts([source], proposed);
      const abstract = abstractAllows([source], proposed);
      if (concrete) accepted += 1;
      if (concrete !== abstract) disagreements.push(`evidence ${label(source)} claim ${label(proposed)}: ledger ${concrete ? 'accepts' : 'refuses'}, checker ${abstract ? 'allows' : 'refuses'}`);
    }
  }
  assert.equal(GRID.length * GRID.length, 1296, 'the corpus is the full grid');
  assert.ok(accepted > 0 && accepted < 1296, `the grid must contain both outcomes; accepted ${accepted}`);
  assert.deepEqual(disagreements, []);
});

test('two cited records: both sides bound by the weakest, over every evidence pair against the strongest claim', () => {
  const top: Axes = { integrity: 'verified', authenticity: 'provider_authenticated', coverage: 'complete' };
  const disagreements: string[] = [];
  let accepted = 0;
  for (const a of GRID) {
    for (const b of GRID) {
      const concrete = ledgerAccepts([a, b], top);
      const abstract = abstractAllows([a, b], top);
      if (concrete) accepted += 1;
      if (concrete !== abstract) disagreements.push(`${label(a)} + ${label(b)}: ledger ${concrete ? 'accepts' : 'refuses'}, checker ${abstract ? 'allows' : 'refuses'}`);
    }
  }
  assert.equal(accepted, 1, 'only the pair of two top records supports the top claim; one strong record launders nothing');
  assert.deepEqual(disagreements, []);
});
