/**
 * A claim could cite a measurement model that none of its evidence carried.
 *
 * WHAT THE KERNEL ALREADY DID. `claim()` refuses a null `measurementModelRef`
 * once `profile.measurement` rises above `proxy_unvalidated`. That rule checks
 * a reference was WRITTEN. `src/measurement/registry.ts` says exactly what is
 * wrong with stopping there — "naming a model and having one were the same
 * act" — and provides `assessMeasurementBacking` to resolve one. It has one
 * production caller, inside the causal adapter, resolving a registry the
 * adapter assembles for itself. The kernel that persists every claim in the
 * product resolved nothing.
 *
 * WHY THE FIX IS NOT "RESOLVE IT IN `claim()`". There is no repository-wide
 * registry of Fiscus's measurement models to resolve against, and there cannot
 * straightforwardly be one: the only reference the product actually writes,
 * `causal:quality-metric:<metric>@<protocolHash>`, names a model SYNTHESIZED
 * from a protocol, so a static list could never contain it. Building a resolver
 * that reaches the protocol table would put the kernel's constructor behind a
 * database.
 *
 * THE RULE THAT NEEDS NO REGISTRY, AND THE ONE THE BOUNDARY WAS ALREADY MAKING.
 * `assertClaimWithinItsEvidence` already refuses a claim that declares more
 * integrity, more authenticity or more coverage than the weakest evidence it
 * cites, and a grain or scope no cited evidence carries. A measurement backing
 * is the same kind of thing and was the one such field not checked: if no cited
 * evidence was collected under the model, the claim's citation appeared at the
 * claim layer out of nothing. So the reference must be carried by at least one
 * cited evidence. That is decidable from what the ledger already stores, it
 * needs no registry, and it moves the reference from an unbacked assertion to
 * one that at minimum names something a record of the measurement declared.
 *
 * WHY THIS IS NOT THE FOURTH CEILING THE BOUNDARY REFUSES TO ADD. That method
 * says in as many words that it stops at three axes and that `monetaryBasis` is
 * deliberately not a fourth: basis is not a ladder, `mergeClaimProfiles`
 * refuses to rank `billed` against `allocated`, and a claim whose basis differs
 * from its evidence is often a legitimate derivation -- allocation is exactly
 * that -- so refusing it would need the derivation registry rather than a
 * comparison. None of that applies here. A measurement model reference is an
 * identity, not a rung: there is no ordering to invent, and no derivation
 * transforms a reference to one model into a reference to another. So this is a
 * containment check, not a ceiling, and it does not reopen the question that
 * paragraph settled.
 *
 * AT LEAST ONE, DELIBERATELY. A claim cites the assignment record and the
 * outcome record; only the outcome record is an observation of the quality
 * metric. Requiring EVERY cited evidence to carry the reference would force the
 * assignment record to claim it was measured under a quality model it has
 * nothing to do with, which is the same laundering pointed the other way.
 *
 * THE PRODUCTION INSTANCE. `src/causal/epistemic.ts` set both claims'
 * `measurementModelRef` to the protocol's quality model while both evidence
 * records carried `measurementModelRef: null`. The outcome record IS the
 * observation of the pre-registered metric, so the honest repair is for it to
 * declare the model it was collected under; the assignment record keeps `null`,
 * because assignment is not a measurement of quality.
 *
 * WHAT THIS DOES NOT ESTABLISH. That the reference RESOLVES to a registered
 * model — the evidence could carry a reference to nothing just as the claim
 * could, and this rule only stops the claim from inventing one the evidence
 * never made. Resolution against an assembled registry is still open, and so is
 * the measurement AXIS: `Evidence` records `measurementModelRef` but no
 * validation strength, so there is no evidence-side ceiling for
 * `profile.measurement` the way there is for integrity, authenticity and
 * coverage. Nothing here checks that the model's procedure measures what it
 * says.
 *
 * Recorded at D-168.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { claim, type Claim } from '../src/epistemic/claim.ts';
import { evidence, type Evidence } from '../src/epistemic/evidence.ts';
import { EpistemicLedger } from '../src/epistemic/ledger.ts';
import { claimProfile } from '../src/epistemic/profile.ts';
import { grain } from '../src/epistemic/grain.ts';
import { scope } from '../src/epistemic/scope.ts';
import { buildCausalStudyKernelIssuance } from '../src/causal/epistemic.ts';
import { estimateCausalStudy } from '../src/causal/estimate.ts';
import { causalQualityMeasurementModelRef } from '../src/causal/measurement.ts';
import { repeatedCostQualityData } from './support/causalStudyFixture.ts';

const VALID_FROM = '2026-08-01T00:00:00.000Z';
const VALID_TO = '2026-08-02T00:00:00.000Z';
const ISSUED = '2026-08-02T00:00:01.000Z';
const ISSUED_AT_MS = 1_700_100_000_000;

function ledger(): EpistemicLedger {
  return new EpistemicLedger(new DatabaseSync(':memory:'));
}

function measuredEvidence(id: string, measurementModelRef: string | null): Evidence {
  return evidence({
    id,
    evidenceType: 'quality.observation',
    sourceIdentity: 'fiscus:local',
    sourceClass: 'fiscus_local_records',
    payload: { value: '1' },
    scope: scope({ account: 'acct-1' }),
    grain: grain(['day', 'project']),
    occurredAt: VALID_FROM,
    observedAt: VALID_FROM,
    integrity: 'verified',
    authenticity: 'self_asserted',
    completeness: { status: 'complete', method: 'local_scan' },
    measurementModelRef,
    monetaryBasis: null,
    schemaVersion: 1,
    sensitivity: 'internal',
    redaction: 'none',
  });
}

function citingClaim(evidenceIds: readonly string[], measurementModelRef: string | null): Claim {
  return claim({
    id: 'claim:quality',
    proposition: { predicate: 'quality.observed', value: { value: '1' } },
    subject: 'project:api',
    scope: scope({ account: 'acct-1' }),
    grain: grain(['day', 'project']),
    time: { validTime: { from: VALID_FROM, to: VALID_TO }, asOf: ISSUED },
    epistemic: 'supported',
    profile: claimProfile({
      epistemic: 'supported', integrity: 'verified', authenticity: 'self_asserted',
      scope: 'established', coverage: 'complete', measurement: 'proxy_unvalidated',
      causality: 'none', monetaryBasis: 'none', finality: 'provisional', decisionFitness: 'not_assessed',
    }),
    measurementModelRef,
    evidenceIds,
    derivationRule: 'quality.observe.v1',
    derivationVersion: 1,
    causalStatus: 'none',
    issuedAt: ISSUED,
    schemaVersion: 1,
  });
}

test('a claim cannot cite a measurement model none of its evidence carries', () => {
  // THE COUNTEREXAMPLE. Before this rule the append succeeded and every reader
  // of the stored claim saw a measurement citation with nothing under it.
  const value = ledger();
  assert.equal(value.appendEvidence(measuredEvidence('evidence:a', null)), 'inserted');

  assert.throws(
    () => value.appendClaim(citingClaim(['evidence:a'], 'model:invented')),
    /measurement model/i,
    'a measurement reference no cited evidence carries must be refused at the boundary that persists it',
  );
});

test('the refusal names the reference the claim made and what its evidence actually carries', () => {
  // A refusal that does not say what was expected instead sends the reader back
  // to the source to find out, and the two references differ by a protocol hash
  // in the real case -- exactly the difference a message has to spell out.
  const value = ledger();
  assert.equal(value.appendEvidence(measuredEvidence('evidence:a', 'model:real')), 'inserted');

  assert.throws(
    () => value.appendClaim(citingClaim(['evidence:a'], 'model:other')),
    (error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      assert.match(message, /model:other/, 'the refusal must name the reference the claim made');
      assert.match(message, /model:real/, 'the refusal must name what the cited evidence carries');
      return true;
    },
  );
});

test('a claim whose evidence declares the same model is accepted', () => {
  const value = ledger();
  assert.equal(value.appendEvidence(measuredEvidence('evidence:a', 'model:real')), 'inserted');
  assert.equal(value.appendClaim(citingClaim(['evidence:a'], 'model:real')), 'inserted');
});

test('one cited evidence carrying the model is enough, and the others need not claim it', () => {
  // Stated as its own case because the alternative -- every cited evidence must
  // carry it -- would force a record that measured something else to declare a
  // model it has nothing to do with. The causal issuance is exactly this shape:
  // an assignment record and an outcome record, one of which is the quality
  // measurement.
  const value = ledger();
  assert.equal(value.appendEvidence(measuredEvidence('evidence:a', null)), 'inserted');
  assert.equal(value.appendEvidence(measuredEvidence('evidence:b', 'model:real')), 'inserted');
  assert.equal(value.appendClaim(citingClaim(['evidence:a', 'evidence:b'], 'model:real')), 'inserted');
});

test('a claim that cites no measurement model is unaffected, in either direction', () => {
  // The rule bounds what a claim may ASSERT by what its evidence declared. A
  // claim leaning on nothing is not asserting anything to bound, and evidence
  // that was measured under a model the claim does not lean on is not a defect
  // in the claim. Inventing a requirement in either direction here would make
  // every honest weak boundary in the codebase name a model to keep working.
  const value = ledger();
  assert.equal(value.appendEvidence(measuredEvidence('evidence:a', null)), 'inserted');
  assert.equal(value.appendEvidence(measuredEvidence('evidence:b', 'model:real')), 'inserted');
  assert.equal(value.appendClaim(citingClaim(['evidence:a', 'evidence:b'], null)), 'inserted');
});

test('the rule lives at the append boundary, not in the claim constructor', () => {
  // VACUITY GUARD, AND A STATEMENT ABOUT WHERE THE RULE BELONGS. `claim()` is a
  // pure constructor with no access to the evidence it names, so it cannot
  // decide this; if these tests started passing because construction threw,
  // they would be testing an unrelated refusal. This is also why the counter-
  // example above has to reach a real ledger over a real database.
  assert.doesNotThrow(() => citingClaim(['evidence:a'], 'model:invented'));
});

test('the causal issuance carries its quality model on the record that measured it', () => {
  // THE PRODUCTION INSTANCE. Both causal claims cite the protocol's quality
  // model; both cited evidence records carried `null`. The outcome record is
  // the observation of the pre-registered metric, so it declares the model. The
  // assignment record is not a quality measurement and keeps `null` -- which is
  // the "at least one" rule doing the work it exists for.
  const data = repeatedCostQualityData(0.95, 0.8);
  const issuance = buildCausalStudyKernelIssuance(data, estimateCausalStudy(data), ISSUED_AT_MS);
  const expected = causalQualityMeasurementModelRef(data.protocol);

  assert.equal(issuance.outcomeEvidence.measurementModelRef, expected);
  assert.equal(issuance.assignmentEvidence.measurementModelRef, null);
  assert.equal(issuance.armDifference.measurementModelRef, expected);
  assert.equal(issuance.effect?.measurementModelRef, expected);
});

test('the causal issuance still appends to a real ledger under the new rule', () => {
  // The rule is only worth having if the product passes it, and only worth
  // trusting if that is checked against the ledger rather than against the
  // adapter's own return value.
  const data = repeatedCostQualityData(0.95, 0.8);
  const issuance = buildCausalStudyKernelIssuance(data, estimateCausalStudy(data), ISSUED_AT_MS);
  const value = ledger();

  assert.equal(value.appendEvidence(issuance.assignmentEvidence), 'inserted');
  assert.equal(value.appendEvidence(issuance.outcomeEvidence), 'inserted');
  assert.equal(value.appendClaim(issuance.armDifference), 'inserted');
});
