/**
 * A REFUTED witness discharged the obligation it was refuted about.
 *
 * `Witness` is a node like any other in this kernel: it carries an
 * `EpistemicState`, it can be appended, replayed and revoked, and the state
 * says whether the proof it represents is supported, refuted, conflicted or
 * unknown. `assessDerivationLegality` matches a required witness kind against
 * the derivation's inline references — `hasWitness` compares `kind` and nothing
 * else — and `DerivationWitness` carries no `epistemic` field at all. The
 * ledger then checks that each inline reference matches the REGISTERED witness
 * on id, kind, evidenceIds, detail and coordinates. Every one of those five
 * fields, and not the sixth.
 *
 * So a witness whose own record says `epistemic: 'refuted'` — the kernel's way
 * of saying this proof was checked and does not hold — lifted an observational
 * claim to a randomized one, and the ledger stored it. The obligation was
 * discharged by the existence of the refutation.
 *
 * WHY THIS IS THE WORST PLACE FOR IT. The witness mechanism is the whole reason
 * a derivation may strengthen a claim at all. D-152 recorded that a money-axis
 * derivation with no rule was "the most consequential defect the abstract-
 * interpretation work turned up", and the fix was to require a witness. This
 * defect is one level up: the requirement was met by an object the kernel
 * itself had already recorded as not holding. A gate that accepts its own
 * counterexample as a pass is weaker than no gate, because the record now
 * reads as witnessed.
 *
 * ONLY `supported` DISCHARGES, AND THE OTHER THREE ARE NOT THE SAME REFUSAL.
 * `refuted` means the proof was checked and failed. `conflicted` means it was
 * checked and both polarities are present, which is a live disagreement and not
 * a licence. `unknown` means nothing is known about it, which is precisely the
 * state hard rule 2 says must stay itself rather than be read as assent. Three
 * different reasons, one refusal, and the error names the id and the state so a
 * reader can tell which they are in.
 *
 * WHAT THIS DOES NOT ESTABLISH, AND IT IS THE LARGER HALF. That a `supported`
 * witness proves anything about its own CONTENT. The kernel still does not
 * check that a `causal_identification` witness describes an identification
 * strategy, that its evidence supports the strategy, or that the strategy fits
 * the claims either side of the derivation. `detail` is a free string. This
 * packet closes the case where the kernel's own record contradicts the
 * discharge; deciding what a witness must CONTAIN is a design question about
 * per-kind obligations and is deliberately not answered here.
 *
 * Nor that a witness refuted AFTER a derivation was stored invalidates it: the
 * check is at append, where the ledger resolves the witness from storage, and
 * `graph()`'s stored-derivation integrity pass is left alone on purpose —
 * turning a later revocation into a read-time throw would make the whole ledger
 * unreadable rather than reporting the withdrawal, which is what
 * `revocationProjection` is for.
 *
 * Recorded at D-190.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { claim, type Claim } from '../src/epistemic/claim.ts';
import { derivation, type Derivation } from '../src/epistemic/derivation.ts';
import { EpistemicLedger } from '../src/epistemic/ledger.ts';
import { claimProfile, type CausalityStatus, type ClaimProfile } from '../src/epistemic/profile.ts';
import { scope } from '../src/epistemic/scope.ts';
import { grain } from '../src/epistemic/grain.ts';
import type { EpistemicState } from '../src/epistemic/state.ts';
import { witness, type Witness } from '../src/epistemic/witness.ts';
import { evidence, type Evidence } from '../src/epistemic/evidence.ts';

const at = '2026-09-09T00:00:00.000Z';
const validTime = { from: '2026-09-01T00:00:00.000Z', to: '2026-09-07T00:00:00.000Z' };
const SCOPE = scope({ ledger: 'witness-discharge-test' });
const GRAIN = grain(['request']);
const COORDINATE = { grain: GRAIN, scope: SCOPE };
const EVIDENCE_ID = 'evidence:witness-discharge';

function source(): Evidence {
  return evidence({
    id: EVIDENCE_ID,
    evidenceType: 'effect.observation',
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
}

function mk(id: string, causality: CausalityStatus): Claim {
  const profile: ClaimProfile = claimProfile({
    epistemic: 'supported',
    integrity: 'verified',
    authenticity: 'self_asserted',
    scope: 'conditional',
    coverage: 'complete',
    measurement: 'proxy_unvalidated',
    causality,
    monetaryBasis: 'none',
    finality: 'provisional',
    decisionFitness: 'not_assessed',
  });
  return claim({
    id,
    proposition: { predicate: 'effect.size', value: { id } as never },
    subject: 'witness-discharge-test',
    scope: SCOPE,
    grain: GRAIN,
    time: { validTime, asOf: at },
    epistemic: 'supported',
    profile,
    measurementModelRef: null,
    evidenceIds: [EVIDENCE_ID],
    derivationRule: 'witness-discharge.test.v1',
    derivationVersion: 1,
    assumptions: [],
    uncertainty: { kind: 'qualitative', description: 'test fixture' },
    causalStatus: causality,
    monetaryBasis: 'none',
    finality: 'provisional',
    issuedAt: at,
    supersedes: [],
    supersededBy: null,
    revocation: null,
    decisionCertificateIds: [],
    schemaVersion: 1,
  });
}

function proof(state: EpistemicState): Witness {
  return witness({
    id: `witness:identification:${state}`,
    kind: 'causal_identification',
    evidenceIds: [EVIDENCE_ID],
    detail: 'assignment was randomized under the recorded protocol',
    issuedAt: at,
    epistemic: state,
    schemaVersion: 1,
  });
}

function step(input: Claim, output: Claim, witnesses: Derivation['witnesses']): Derivation {
  return derivation({
    id: `derivation:${input.id}->${output.id}`,
    inputClaimIds: [input.id],
    inputEvidenceIds: [EVIDENCE_ID],
    transformation: 'witness-discharge.test.step.v1',
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

/** Append the whole chain in one transaction, as every product issuance does. */
function append(registered: Witness): void {
  const ledger = new EpistemicLedger(new DatabaseSync(':memory:'));
  const observed = mk('claim:observational', 'observational');
  const lifted = mk('claim:randomized', 'randomized');
  ledger.runInTransaction(() => {
    ledger.appendEvidenceWithinTransaction(source());
    ledger.appendClaimWithinTransaction(observed);
    ledger.appendClaimWithinTransaction(lifted);
    ledger.appendWitnessWithinTransaction(registered);
    ledger.appendDerivationWithinTransaction(step(observed, lifted, [
      { id: registered.id, kind: registered.kind, evidenceIds: registered.evidenceIds, detail: registered.detail },
    ]));
  });
}

test('a refuted witness cannot lift an observational claim to a randomized one', () => {
  // The kernel checked this proof and recorded that it does not hold. Reading
  // that record as a discharge makes the gate accept its own counterexample.
  assert.throws(
    () => append(proof('refuted')),
    /witness:identification:refuted[\s\S]*refuted/,
    'the refusal must name the witness and the state it is in',
  );
});

test('a conflicted witness cannot discharge either', () => {
  // Conflict is a live disagreement, not a licence. `conflicted` is what
  // `informationJoin` produces from evidence pointing both ways, and resolving
  // it by taking the supporting half is exactly the overwrite state.ts refuses.
  assert.throws(() => append(proof('conflicted')), /witness:identification:conflicted[\s\S]*conflicted/);
});

test('an unknown witness cannot discharge either', () => {
  // Hard rule 2 in its narrowest form: nothing is known about this proof, and
  // nothing known is not assent.
  assert.throws(() => append(proof('unknown')), /witness:identification:unknown[\s\S]*unknown/);
});

test('a supported witness still discharges exactly as before', () => {
  // The guard. The refusal must fall on the state of the proof and not on the
  // act, or this packet would have removed the kernel's only way to express a
  // legitimate causal derivation.
  append(proof('supported'));
});

test('the same derivation with no witness at all is refused for the missing kind, not the state', () => {
  // The two refusals stay distinguishable: an absent obligation reads as
  // missing, a present-but-unsupported one reads as unsupported. Collapsing
  // them would tell an operator to go and register a witness they already have.
  const ledger = new EpistemicLedger(new DatabaseSync(':memory:'));
  const observed = mk('claim:observational', 'observational');
  const lifted = mk('claim:randomized', 'randomized');
  assert.throws(() => {
    ledger.runInTransaction(() => {
      ledger.appendEvidenceWithinTransaction(source());
      ledger.appendClaimWithinTransaction(observed);
      ledger.appendClaimWithinTransaction(lifted);
      ledger.appendDerivationWithinTransaction(step(observed, lifted, []));
    });
  }, /causal_identification/);
});

test('a witness is only required for the axis it guards, and a weakening needs none', () => {
  // Guard on the untouched half of the rule: descending the causality ladder
  // asserts nothing new, so it needs no witness before or after this change.
  const ledger = new EpistemicLedger(new DatabaseSync(':memory:'));
  const randomized = mk('claim:randomized', 'randomized');
  const observed = mk('claim:observational', 'observational');
  ledger.runInTransaction(() => {
    ledger.appendEvidenceWithinTransaction(source());
    ledger.appendClaimWithinTransaction(randomized);
    ledger.appendClaimWithinTransaction(observed);
    ledger.appendDerivationWithinTransaction(step(randomized, observed, []));
  });
});
