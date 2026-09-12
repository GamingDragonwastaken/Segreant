/**
 * A `supported` witness of the right KIND proved nothing about its own content.
 *
 * D-190 closed the case where the kernel's own record contradicts the
 * discharge: a witness whose stored `epistemic` reads `refuted`, `conflicted`
 * or `unknown` no longer satisfies the obligation it was refuted about. It
 * recorded, in as many words, what it did not close — "that a `supported`
 * witness proves anything about its own CONTENT" — and named this the larger
 * half. This is that half.
 *
 * THE MEASUREMENT. `hasWitness` compares `kind` and nothing else, and the
 * ledger's reference check compares id, kind, evidenceIds, detail and
 * coordinates against the registered record. None of those five asks whether
 * the witness has anything to do with the claims it bridges. So:
 *
 *   - a `causal_identification` witness grounded entirely in evidence that the
 *     claim it licenses never cites lifted that claim from `observational` to
 *     `randomized`, and the ledger stored it. The identification was about
 *     some other study;
 *   - a `measurement_validation` witness grounded in a record collected under
 *     a DIFFERENT measurement model licensed a rung asserted for this one;
 *   - a `monetary_rebasing` witness did not have to say which basis it moved
 *     from or to. `detail` is a free string, so "allocation from the declared
 *     rate-card estimate" licensed `estimated -> billed` exactly as well as it
 *     licensed the allocation it describes. `metered usage !=
 *     provider-billed cost` is the first line of this repository's contract,
 *     and the witness D-152 added to defend it named neither side.
 *
 * WHAT AN OBLIGATION CAN HONESTLY BE. Only what the record types can decide.
 * Three kinds have a checkable one and get it here. The rest keep the
 * kind-only match they have always had, and `WITNESS_OBLIGATIONS` says which
 * are which by name rather than leaving a reader to infer it from an absent
 * check — an unstated obligation is honest, a fabricated one is not.
 *
 * Recorded at D-201.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { claim, type Claim } from '../src/epistemic/claim.ts';
import { derivation, type Derivation } from '../src/epistemic/derivation.ts';
import { EpistemicLedger } from '../src/epistemic/ledger.ts';
import { claimProfile, type ClaimProfile, type MonetaryBasisStatus } from '../src/epistemic/profile.ts';
import { scope } from '../src/epistemic/scope.ts';
import { grain } from '../src/epistemic/grain.ts';
import { witness, type Witness } from '../src/epistemic/witness.ts';
import { evidence, type Evidence } from '../src/epistemic/evidence.ts';

const at = '2026-09-09T00:00:00.000Z';
const validTime = { from: '2026-09-01T00:00:00.000Z', to: '2026-09-07T00:00:00.000Z' };
const SCOPE = scope({ ledger: 'witness-obligation-test' });
const GRAIN = grain(['request']);
const COORDINATE = { grain: GRAIN, scope: SCOPE };

/** The study these claims are about. */
const STUDY_EVIDENCE = 'evidence:this-study';
/** A record of a different study entirely; nothing here cites it but a witness. */
const OTHER_EVIDENCE = 'evidence:some-other-study';

const THIS_MODEL = 'model:quality-surrogate:this';
const OTHER_MODEL = 'model:quality-surrogate:other';

function record(id: string, measurementModelRef: string | null): Evidence {
  return evidence({
    id,
    evidenceType: 'effect.observation',
    sourceIdentity: 'test',
    sourceClass: 'test',
    payload: { id } as never,
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
    measurementModelRef,
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

interface Shape {
  readonly causality?: ClaimProfile['causality'];
  readonly measurement?: ClaimProfile['measurement'];
  readonly monetaryBasis?: MonetaryBasisStatus;
  readonly measurementModelRef?: string | null;
  readonly evidenceIds?: readonly string[];
}

function mk(id: string, shape: Shape = {}): Claim {
  const causality = shape.causality ?? 'observational';
  const monetaryBasis = shape.monetaryBasis ?? 'none';
  const profile: ClaimProfile = claimProfile({
    epistemic: 'supported',
    integrity: 'verified',
    authenticity: 'self_asserted',
    scope: 'conditional',
    coverage: 'complete',
    measurement: shape.measurement ?? 'proxy_unvalidated',
    causality,
    monetaryBasis,
    finality: 'provisional',
    decisionFitness: 'not_assessed',
  });
  return claim({
    id,
    proposition: { predicate: 'effect.size', value: { id } as never },
    subject: 'witness-obligation-test',
    scope: SCOPE,
    grain: GRAIN,
    time: { validTime, asOf: at },
    epistemic: 'supported',
    profile,
    measurementModelRef: shape.measurementModelRef ?? null,
    evidenceIds: shape.evidenceIds ?? [STUDY_EVIDENCE],
    derivationRule: 'witness-obligation.test.v1',
    derivationVersion: 1,
    assumptions: [],
    uncertainty: { kind: 'qualitative', description: 'test fixture' },
    causalStatus: causality,
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

function step(input: Claim, output: Claim, proofs: readonly Witness[]): Derivation {
  return derivation({
    id: `derivation:${input.id}->${output.id}`,
    inputClaimIds: [input.id],
    inputEvidenceIds: [STUDY_EVIDENCE],
    transformation: 'witness-obligation.test.step.v1',
    outputClaimId: output.id,
    outputProposition: output.proposition,
    coordinateChange: { from: COORDINATE, to: COORDINATE },
    witnesses: proofs.map((proof) => ({
      id: proof.id,
      kind: proof.kind,
      evidenceIds: proof.evidenceIds,
      detail: proof.detail,
    })),
    assumptions: [],
    uncertaintyTransformation: 'none',
    version: 1,
    reproducibilityHash: `hash:${input.id}->${output.id}`,
  });
}

/** Append the whole chain in one transaction, as every product issuance does. */
function append(
  input: Claim,
  output: Claim,
  proofs: readonly Witness[],
  extraEvidence: readonly Evidence[] = [],
): void {
  const ledger = new EpistemicLedger(new DatabaseSync(':memory:'));
  ledger.runInTransaction(() => {
    ledger.appendEvidenceWithinTransaction(record(STUDY_EVIDENCE, THIS_MODEL));
    for (const item of extraEvidence) ledger.appendEvidenceWithinTransaction(item);
    ledger.appendClaimWithinTransaction(input);
    ledger.appendClaimWithinTransaction(output);
    for (const proof of proofs) ledger.appendWitnessWithinTransaction(proof);
    ledger.appendDerivationWithinTransaction(step(input, output, proofs));
  });
}

function identification(id: string, evidenceIds: readonly string[]): Witness {
  return witness({
    id,
    kind: 'causal_identification',
    evidenceIds,
    detail: 'assignment was randomized under the recorded protocol',
    issuedAt: at,
    epistemic: 'supported',
    schemaVersion: 1,
  });
}

test('a causal_identification witness grounded in another study cannot lift this one', () => {
  // The whole point of grounding a witness in evidence: the identification has
  // to be an identification OF something. Sharing no cited record with the
  // claim it licenses means it is about a different study, and the kernel
  // accepted it because `hasWitness` compares the kind and stops.
  assert.throws(
    () => append(
      mk('claim:observational'),
      mk('claim:randomized', { causality: 'randomized' }),
      [identification('witness:identification:elsewhere', [OTHER_EVIDENCE])],
      [record(OTHER_EVIDENCE, null)],
    ),
    /witness:identification:elsewhere/,
    'the refusal must name the witness whose content does not bear on the step',
  );
});

test('the identification the causal issuance path actually mints still discharges', () => {
  // The guard. `buildCausalStudyKernelIssuance` grounds its witness in the
  // assignment Evidence, and the effect claim cites that same record — so the
  // obligation must be satisfied by the one production path that mints this
  // kind, or the rule is wrong rather than the path.
  append(
    mk('claim:observational'),
    mk('claim:randomized', { causality: 'randomized' }),
    [identification('witness:identification:this', [STUDY_EVIDENCE])],
  );
});

test('a measurement_validation witness for a different model cannot license this rung', () => {
  // The claim asserts a rung FOR A NAMED MODEL. A validation grounded in a
  // record collected under some other model says nothing about it, and saying
  // it does is the measurement half of the same laundering D-168 closed at the
  // claim layer.
  const validated = witness({
    id: 'witness:measurement:other-model',
    kind: 'measurement_validation',
    evidenceIds: [OTHER_EVIDENCE],
    detail: 'surrogate bridge validated against held-out human ratings',
    issuedAt: at,
    epistemic: 'supported',
    schemaVersion: 1,
  });
  assert.throws(
    () => append(
      mk('claim:unvalidated'),
      mk('claim:validated', { measurement: 'proxy_validated', measurementModelRef: THIS_MODEL }),
      [validated],
      [record(OTHER_EVIDENCE, OTHER_MODEL)],
    ),
    /witness:measurement:other-model/,
  );
});

test('a measurement_validation witness grounded in the record made under that model discharges', () => {
  const validated = witness({
    id: 'witness:measurement:this-model',
    kind: 'measurement_validation',
    evidenceIds: [STUDY_EVIDENCE],
    detail: 'surrogate bridge validated against held-out human ratings',
    issuedAt: at,
    epistemic: 'supported',
    schemaVersion: 1,
  });
  append(
    mk('claim:unvalidated'),
    mk('claim:validated', { measurement: 'proxy_validated', measurementModelRef: THIS_MODEL }),
    [validated],
  );
});

test('a monetary_rebasing witness must name the basis it moves from and to', () => {
  // `detail` is prose. A re-basing witness that names neither side licenses
  // every re-basing equally, which is the same as licensing none of them
  // deliberately.
  assert.throws(
    () => witness({
      id: 'witness:rebasing:unnamed',
      kind: 'monetary_rebasing',
      evidenceIds: [STUDY_EVIDENCE],
      detail: 'allocation from the declared rate-card estimate under the recorded allocation rule',
      issuedAt: at,
      epistemic: 'supported',
      schemaVersion: 1,
    }),
    /basisChange/,
  );
});

test('no other witness kind may declare a basis change', () => {
  // The same shape the coordinate kinds already have: a witness that is not
  // about the money axis cannot smuggle a movement along it.
  assert.throws(
    () => witness({
      id: 'witness:identification:with-basis',
      kind: 'causal_identification',
      evidenceIds: [STUDY_EVIDENCE],
      detail: 'assignment was randomized under the recorded protocol',
      basisChange: { from: 'estimated', to: 'billed' },
      issuedAt: at,
      epistemic: 'supported',
      schemaVersion: 1,
    }),
    /basisChange/,
  );
});

test('a monetary_rebasing witness naming a different pair cannot license this step', () => {
  // Naming a re-basing is not enough; it has to be THIS re-basing. A witness
  // for `list -> allocated` standing in for `estimated -> billed` is the exact
  // collapse the first line of the contract forbids.
  const rebasing = witness({
    id: 'witness:rebasing:elsewhere',
    kind: 'monetary_rebasing',
    evidenceIds: [STUDY_EVIDENCE],
    detail: 'allocation from the published list price under the recorded allocation rule',
    basisChange: { from: 'list', to: 'allocated' },
    issuedAt: at,
    epistemic: 'supported',
    schemaVersion: 1,
  });
  assert.throws(
    () => append(
      mk('claim:estimated', { monetaryBasis: 'estimated' }),
      mk('claim:billed', { monetaryBasis: 'billed' }),
      [rebasing],
    ),
    /witness:rebasing:elsewhere/,
  );
});

test('a monetary_rebasing witness naming this step licenses it', () => {
  const rebasing = witness({
    id: 'witness:rebasing:this',
    kind: 'monetary_rebasing',
    evidenceIds: [STUDY_EVIDENCE],
    detail: 'provider invoice line reconciled against the declared rate-card estimate',
    basisChange: { from: 'estimated', to: 'billed' },
    issuedAt: at,
    epistemic: 'supported',
    schemaVersion: 1,
  });
  append(
    mk('claim:estimated', { monetaryBasis: 'estimated' }),
    mk('claim:billed', { monetaryBasis: 'billed' }),
    [rebasing],
  );
});
