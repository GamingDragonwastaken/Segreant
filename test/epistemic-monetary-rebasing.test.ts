/**
 * The money axis had no derivation rule, and now it has one.
 *
 * THE COUNTEREXAMPLE, MEASURED AT D-151 AND CLOSED HERE. `assessDerivationLegality`
 * requires a witness for every axis a derivation strengthens by iterating
 * `PROFILE_STRENGTH_AXES` and comparing rungs. `monetaryBasis` cannot appear in
 * that table, because it is not a ladder: `mixed` is the honest label for
 * disagreement, not a rung above `billed`. The consequence was that the axis had
 * no rule of ANY kind:
 *
 *   input  monetaryBasis : estimated
 *   output monetaryBasis : billed
 *   allowed              : true
 *   requiredWitnesses    : []
 *
 * and `EpistemicLedger.appendDerivationWithinTransaction`, which checks every
 * input claim, checked it against a rule that never looked at the money axis, so
 * the kernel stored it.
 *
 * `metered usage != provider-billed cost` is the first line of this repository's
 * contract. A local rate-card estimate re-declared as a provider-billed amount,
 * accepted without complaint by the component that exists to prevent exactly
 * that collapse, is the most consequential defect the abstract-interpretation
 * work turned up — and D-151 built a function that refuses it while nothing
 * called that function. This closes it at the boundary that persists.
 *
 * WHY A WITNESS RATHER THAN A REFUSAL. Re-basing is often legitimate: `ledger.ts`
 * already says in as many words that "a claim whose basis differs from its
 * evidence is often a legitimate derivation — allocation is exactly that". A
 * blanket refusal would make an honest allocation impossible to express and push
 * the work outside the kernel, which is worse than the hole. A witness makes the
 * re-basing a declared, evidence-bound act instead of a silent one.
 *
 * Recorded at D-152.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { claim, type Claim } from '../src/epistemic/claim.ts';
import {
  assessDerivationLegality,
  derivation,
  DERIVATION_WITNESS_KINDS,
  type Derivation,
} from '../src/epistemic/derivation.ts';
import { EpistemicLedger } from '../src/epistemic/ledger.ts';
import { claimProfile, type ClaimProfile, type MonetaryBasisStatus } from '../src/epistemic/profile.ts';
import { scope } from '../src/epistemic/scope.ts';
import { grain } from '../src/epistemic/grain.ts';
import { witness } from '../src/epistemic/witness.ts';
import { evidence, type Evidence } from '../src/epistemic/evidence.ts';

const at = '2026-09-08T00:00:00.000Z';
const validTime = { from: '2026-09-01T00:00:00.000Z', to: '2026-09-07T00:00:00.000Z' };
const SCOPE = scope({ ledger: 'rebasing-test' });
const GRAIN = grain(['request']);
const COORDINATE = { grain: GRAIN, scope: SCOPE };
const EVIDENCE_ID = 'evidence:rebasing';

function mk(id: string, monetaryBasis: MonetaryBasisStatus): Claim {
  const profile: ClaimProfile = claimProfile({
    epistemic: 'supported',
    integrity: 'verified',
    authenticity: 'self_asserted',
    scope: 'conditional',
    coverage: 'complete',
    measurement: 'proxy_unvalidated',
    causality: 'none',
    monetaryBasis,
    finality: 'provisional',
    decisionFitness: 'not_assessed',
  });
  return claim({
    id,
    proposition: { predicate: 'cost.amount', value: { id } as never },
    subject: 'rebasing-test',
    scope: SCOPE,
    grain: GRAIN,
    time: { validTime, asOf: at },
    epistemic: 'supported',
    profile,
    measurementModelRef: null,
    evidenceIds: [EVIDENCE_ID],
    derivationRule: 'rebasing.test.v1',
    derivationVersion: 1,
    assumptions: [],
    uncertainty: { kind: 'qualitative', description: 'test fixture' },
    causalStatus: 'none',
    monetaryBasis,
    finality: 'provisional',
    issuedAt: at,
    supersedes: [],
    supersededBy: null,
    revocation: null,
    decisionCertificateIds: [],
    schemaVersion: 1,
  });
}

function step(input: Claim, output: Claim, witnesses: Derivation['witnesses'] = []): Derivation {
  return derivation({
    id: `derivation:${input.id}->${output.id}`,
    inputClaimIds: [input.id],
    inputEvidenceIds: [EVIDENCE_ID],
    transformation: 'rebasing.test.step.v1',
    outputClaimId: output.id,
    outputProposition: output.proposition,
    coordinateChange: { from: COORDINATE, to: COORDINATE },
    witnesses,
    assumptions: [],
    uncertaintyTransformation: 'none',
    version: 1,
    reproducibilityHash: `hash:${input.id}->${output.id}`,
  });
}

test('an estimate re-declared as provider-billed now needs a witness', () => {
  const estimated = mk('claim:estimated', 'estimated');
  const billed = mk('claim:billed', 'billed');
  const legality = assessDerivationLegality(estimated, billed, step(estimated, billed));

  assert.equal(legality.allowed, false);
  assert.deepEqual(legality.missingWitnesses, ['monetary_rebasing']);
});

test('the witness is a distinct kind from monetary_finality, which guards a different axis', () => {
  // `monetary_finality` guards `finality` — provisional to final. Reusing it
  // here would have made one witness answer two unrelated questions, and a
  // caller attesting that a figure is final would have silently also attested
  // that its basis changed legitimately.
  assert.ok(DERIVATION_WITNESS_KINDS.includes('monetary_rebasing'));
  assert.ok(DERIVATION_WITNESS_KINDS.includes('monetary_finality'));

  const estimated = mk('claim:estimated', 'estimated');
  const billed = mk('claim:billed', 'billed');
  const wrongWitness = step(estimated, billed, [
    { id: 'witness:final', kind: 'monetary_finality', evidenceIds: [EVIDENCE_ID], detail: 'the figure is final' },
  ]);
  assert.deepEqual(
    assessDerivationLegality(estimated, billed, wrongWitness).missingWitnesses,
    ['monetary_rebasing'],
  );
});

test('a declared re-basing witness licenses it', () => {
  const estimated = mk('claim:estimated', 'estimated');
  const allocated = mk('claim:allocated', 'allocated');
  const licensed = step(estimated, allocated, [
    {
      id: 'witness:rebasing',
      kind: 'monetary_rebasing',
      evidenceIds: [EVIDENCE_ID],
      detail: 'allocation from the declared rate-card estimate under the recorded allocation rule',
    },
  ]);
  const legality = assessDerivationLegality(estimated, allocated, licensed);
  assert.equal(legality.allowed, true);
  assert.deepEqual(legality.missingWitnesses, []);
});

test('keeping the basis, and dropping it, stay free — both are weakenings', () => {
  const estimated = mk('claim:estimated', 'estimated');
  const same = mk('claim:same', 'estimated');
  const dropped = mk('claim:dropped', 'none');
  const mixed = mk('claim:mixed', 'mixed');

  for (const [output, why] of [
    [same, 'keeping the basis asserts nothing new'],
    [dropped, 'a claim that names no economic quantity cannot misreport one'],
    [mixed, 'mixed is what disagreement produces; declaring it is withholding'],
  ] as const) {
    const legality = assessDerivationLegality(estimated, output, step(estimated, output));
    assert.equal(legality.requiredWitnesses.includes('monetary_rebasing'), false, why);
  }
});

test('resolving a mixture into one basis is a claim, not a weakening', () => {
  // The one direction that is easy to read as tidying up. Declaring that a
  // mixture is really `billed` asserts the disagreement was settled.
  const mixed = mk('claim:mixed', 'mixed');
  const billed = mk('claim:billed', 'billed');
  assert.deepEqual(
    assessDerivationLegality(mixed, billed, step(mixed, billed)).missingWitnesses,
    ['monetary_rebasing'],
  );
});

test('the ledger refuses to persist an unwitnessed re-basing', () => {
  // THE HALF THAT MATTERS. D-151 built a function that refused this and nothing
  // called it. `appendDerivationWithinTransaction` is the only place a
  // Derivation can be persisted, and it now enforces the rule.
  const ledger = new EpistemicLedger(new DatabaseSync(':memory:'));
  const estimated = mk('claim:estimated', 'estimated');
  const billed = mk('claim:billed', 'billed');
  const source: Evidence = evidence({
    id: EVIDENCE_ID,
    evidenceType: 'cost.observation',
    sourceIdentity: 'test',
    sourceClass: 'test',
    payload: { id: EVIDENCE_ID } as never,
    scope: SCOPE,
    grain: GRAIN,
    occurredAt: validTime.from,
    validTime,
    observedAt: at,
    recordedAt: at,
    assertedAt: at,
    finalizedAt: null,
    integrity: 'verified',
    authenticity: 'self_asserted',
    completeness: { status: 'complete', method: 'test', coveredEventTypes: [], coveredScope: null, coveredTime: null },
    measurementModelRef: null,
    monetaryBasis: null,
    assumptions: [],
    supersedes: [],
    supersededBy: null,
    revocation: null,
    schemaVersion: 1,
    sensitivity: 'internal',
    redaction: 'none',
  });

  assert.throws(() => {
    ledger.runInTransaction(() => {
      ledger.appendEvidenceWithinTransaction(source);
      ledger.appendClaimWithinTransaction(estimated);
      ledger.appendClaimWithinTransaction(billed);
      ledger.appendDerivationWithinTransaction(step(estimated, billed));
    });
  }, /monetary_rebasing/);

  // And the same chain WITH the witness persists, so the gate refuses the
  // unwitnessed act rather than the act.
  const licensed = new EpistemicLedger(new DatabaseSync(':memory:'));
  const proof = witness({
    id: 'witness:rebasing',
    kind: 'monetary_rebasing',
    evidenceIds: [EVIDENCE_ID],
    detail: 'allocation from the declared rate-card estimate under the recorded allocation rule',
    issuedAt: at,
    epistemic: 'supported',
    schemaVersion: 1,
  });
  licensed.runInTransaction(() => {
    licensed.appendEvidenceWithinTransaction(source);
    licensed.appendClaimWithinTransaction(estimated);
    licensed.appendClaimWithinTransaction(billed);
    licensed.appendWitnessWithinTransaction(proof);
    licensed.appendDerivationWithinTransaction(step(estimated, billed, [
      { id: proof.id, kind: proof.kind, evidenceIds: proof.evidenceIds, detail: proof.detail },
    ]));
  });
});
