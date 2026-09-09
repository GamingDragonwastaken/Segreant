/**
 * A direct claim could assert what only a Derivation is allowed to conclude.
 *
 * THE ASYMMETRY. `appendDerivationWithinTransaction` consults
 * `assessDerivationLegality`, which refuses to move a claim up any ordered
 * profile axis without the matching witness — that is how a `randomized`
 * causal reading comes to require a `causal_identification` witness.
 * `appendClaimWithinTransaction` consults `assertClaimWithinItsEvidence`,
 * which bounds integrity, authenticity, coverage, grain, scope and the
 * measurement-model reference against the cited evidence. Between the two
 * lists sit `causality`, `decisionFitness` and `finality`: nobody bounded
 * them on the direct path, and Evidence carries no field any of them could
 * have been bounded against. So the derivation registry could be bypassed by
 * simply not using it — one `integrity: 'unknown'` evidence, one claim
 * declaring `causality: 'randomized'`, and the kernel stored a randomized
 * causal claim with no identification of any kind behind it.
 *
 * WHY EVIDENCE CANNOT SUPPLY A CEILING HERE. `Evidence` has `integrity`,
 * `authenticity` and `completeness`, which is why those three have ceilings.
 * It has no causality field, no decision-fitness field, and no measurement
 * rung. An observation is not randomized and cannot be; randomization is a
 * property of the ASSIGNMENT PROCEDURE, which is exactly what a
 * `causal_identification` witness records. The floor is therefore not a
 * comparison against evidence but a statement of what a claim may conclude
 * with no derivation at all.
 *
 * WHERE THE REFUSAL LIVES. At COMMIT, not at the append. A derivation reads
 * its output claim back out of the ledger, so the claim it legalizes is
 * necessarily persisted first; refusing at append time would refuse the only
 * ordering the kernel permits, and `issueCausalStudyToKernel` writes exactly
 * that ordering.
 *
 * WHAT THIS DOES NOT ESTABLISH. That the derivation's witness is TRUE — D-190
 * settled that a witness discharges only while its own record reads
 * `supported`, and nothing here revisits it. Nor does it bound
 * `monetaryBasis`, which is not a ladder and has no "above" to refuse on this
 * path, nor the measurement RUNG against any measure of validation:
 * `Evidence` records which model a record was collected under and never how
 * well validated that model is.
 *
 * Recorded at D-192.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { claim, type Claim } from '../src/epistemic/claim.ts';
import { evidence, type Evidence } from '../src/epistemic/evidence.ts';
import { derivation, type Derivation } from '../src/epistemic/derivation.ts';
import { witness, type Witness } from '../src/epistemic/witness.ts';
import { EpistemicLedger } from '../src/epistemic/ledger.ts';
import { claimProfile, type ClaimProfileInput } from '../src/epistemic/profile.ts';
import { grain } from '../src/epistemic/grain.ts';
import { scope } from '../src/epistemic/scope.ts';

const VALID_FROM = '2026-08-01T00:00:00.000Z';
const VALID_TO = '2026-08-02T00:00:00.000Z';
const ISSUED = '2026-08-02T00:00:01.000Z';

const STUDY_SCOPE = scope({ account: 'acct-1' });
const STUDY_GRAIN = grain(['day', 'project']);

function ledger(): EpistemicLedger {
  return new EpistemicLedger(new DatabaseSync(':memory:'));
}

/** Deliberately weak: unknown integrity, self-asserted, partial coverage. */
function weakEvidence(id: string, finalizedAt: string | null = null): Evidence {
  return evidence({
    id,
    evidenceType: 'usage.observation',
    sourceIdentity: 'fiscus:local',
    sourceClass: 'fiscus_local_records',
    payload: { value: '1' },
    scope: STUDY_SCOPE,
    grain: STUDY_GRAIN,
    occurredAt: VALID_FROM,
    observedAt: VALID_FROM,
    finalizedAt,
    integrity: 'unknown',
    authenticity: 'self_asserted',
    completeness: { status: 'partial', method: 'local_scan' },
    measurementModelRef: null,
    monetaryBasis: null,
    schemaVersion: 1,
    sensitivity: 'internal',
    redaction: 'none',
  });
}

const BASE_PROFILE: ClaimProfileInput = {
  epistemic: 'supported',
  integrity: 'unknown',
  authenticity: 'self_asserted',
  scope: 'conditional',
  coverage: 'partial',
  measurement: 'proxy_unvalidated',
  causality: 'none',
  monetaryBasis: 'none',
  finality: 'provisional',
  decisionFitness: 'not_assessed',
};

function citingClaim(
  id: string,
  evidenceIds: readonly string[],
  overrides: Partial<ClaimProfileInput> = {},
  predicate = 'usage.observed',
): Claim {
  const profile = { ...BASE_PROFILE, ...overrides };
  return claim({
    id,
    proposition: { predicate, value: { value: '1' } },
    subject: 'project:api',
    scope: STUDY_SCOPE,
    grain: STUDY_GRAIN,
    time: { validTime: { from: VALID_FROM, to: VALID_TO }, asOf: ISSUED },
    epistemic: 'supported',
    profile: claimProfile(profile),
    evidenceIds,
    derivationRule: 'usage.observe.v1',
    derivationVersion: 1,
    causalStatus: profile.causality,
    finality: profile.finality,
    issuedAt: ISSUED,
    schemaVersion: 1,
  });
}

function identificationWitness(evidenceIds: readonly string[]): Witness {
  return witness({
    id: 'witness:identification',
    kind: 'causal_identification',
    evidenceIds,
    detail: 'Randomized assignment recorded before the first exposure.',
    issuedAt: ISSUED,
    epistemic: 'supported',
    schemaVersion: 1,
  });
}

function randomizingDerivation(sourceId: string, outputId: string, evidenceIds: readonly string[]): Derivation {
  return derivation({
    id: 'derivation:randomization',
    inputEvidenceIds: [...evidenceIds],
    inputClaimIds: [sourceId],
    transformation: 'causal.randomization_identifies_arm_difference.v1',
    outputClaimId: outputId,
    outputProposition: { predicate: 'causal.effect_supported', value: { value: '1' } },
    coordinateChange: {
      from: { grain: STUDY_GRAIN, scope: STUDY_SCOPE },
      to: { grain: STUDY_GRAIN, scope: STUDY_SCOPE },
    },
    witnesses: [{
      id: 'witness:identification',
      kind: 'causal_identification',
      evidenceIds: [...evidenceIds],
      detail: 'Randomized assignment recorded before the first exposure.',
    }],
    uncertaintyTransformation: 'Bounds are carried through unchanged.',
    version: 1,
    reproducibilityHash: 'hash:randomization',
  });
}

test('a direct claim cannot assert a causal reading no derivation identified', () => {
  // THE COUNTEREXAMPLE. One unverified local observation, and a stored claim
  // reading `randomized`. No assignment procedure exists anywhere in this
  // ledger; the claim simply declared the conclusion the witness exists to
  // license.
  const value = ledger();
  assert.equal(value.appendEvidence(weakEvidence('evidence:a')), 'inserted');

  assert.throws(
    () => value.appendClaim(citingClaim('claim:effect', ['evidence:a'], { causality: 'randomized' })),
    /causality/i,
    'a causal reading above observational must be refused on the direct path',
  );
  assert.equal(
    value.readClaim('claim:effect'),
    null,
    'the refusal must roll the transaction back, not leave the claim persisted',
  );
});

test('a direct claim cannot assert decision fitness no derivation established', () => {
  const value = ledger();
  assert.equal(value.appendEvidence(weakEvidence('evidence:a')), 'inserted');

  assert.throws(
    () => value.appendClaim(citingClaim('claim:fit', ['evidence:a'], { decisionFitness: 'sufficient' })),
    /decision fitness/i,
    'declaring a decision fit to act on requires a decision_fitness witness on a derivation',
  );
  assert.equal(value.readClaim('claim:fit'), null, 'nothing may persist after the refusal');
});

test('a direct claim may still declare a decision UNFIT to act on', () => {
  // `DECISION_FITNESS` ranks `insufficient` above `not_assessed`, but that
  // ladder orders INFORMATION, not permission: `sufficient` is the only rung
  // that licenses acting. Refusing `insufficient` here would make withholding
  // the expensive path — a boundary would have to mint a derivation to say
  // "do not act on this" — and `buildDecisionKernelIssuance` issues exactly
  // that claim directly, beside the `sufficient` one its derivation produces.
  const value = ledger();
  assert.equal(value.appendEvidence(weakEvidence('evidence:a')), 'inserted');
  assert.equal(
    value.appendClaim(citingClaim('claim:unfit', ['evidence:a'], { decisionFitness: 'insufficient' })),
    'inserted',
  );
});

test('a direct claim cannot declare final while cited evidence is not finalized', () => {
  // `finality` is the one floor of the three that CAN be read off the evidence:
  // `Evidence.finalizedAt` says whether the source considers the record closed.
  const value = ledger();
  assert.equal(value.appendEvidence(weakEvidence('evidence:a')), 'inserted');

  assert.throws(
    () => value.appendClaim(citingClaim('claim:final', ['evidence:a'], { finality: 'final' })),
    /final/i,
    'final may not be declared over evidence that carries no finalizedAt',
  );
  assert.equal(value.readClaim('claim:final'), null, 'nothing may persist after the refusal');
});

test('every cited evidence must be finalized, not merely one of them', () => {
  const value = ledger();
  assert.equal(value.appendEvidence(weakEvidence('evidence:closed', VALID_TO)), 'inserted');
  assert.equal(value.appendEvidence(weakEvidence('evidence:open')), 'inserted');

  assert.throws(
    () => value.appendClaim(citingClaim('claim:final', ['evidence:closed', 'evidence:open'], { finality: 'final' })),
    /final/i,
    'a claim is only as final as the least final record it rests on',
  );

  assert.equal(
    value.appendClaim(citingClaim('claim:final-ok', ['evidence:closed'], { finality: 'final' })),
    'inserted',
    'a claim over wholly finalized evidence may declare final',
  );
});

test('GUARD: the same strengthened claim is accepted when a legal derivation legalizes it in the transaction', () => {
  // This is the shape `issueCausalStudyToKernel` writes: evidence, an
  // observational claim, a causal_identification witness, the randomized
  // claim, and the derivation binding them — all inside ONE transaction. The
  // effect claim exceeds the direct floor and is legal because the derivation
  // that produces it is on record before the commit.
  const value = ledger();
  value.runInTransaction(() => {
    value.appendEvidenceWithinTransaction(weakEvidence('evidence:a'));
    value.appendClaimWithinTransaction(citingClaim('claim:arm', ['evidence:a'], { causality: 'observational' }));
    value.appendWitnessWithinTransaction(identificationWitness(['evidence:a']));
    value.appendClaimWithinTransaction(
      citingClaim('claim:effect', ['evidence:a'], { causality: 'randomized' }, 'causal.effect_supported'),
    );
    value.appendDerivationWithinTransaction(randomizingDerivation('claim:arm', 'claim:effect', ['evidence:a']));
  });

  const stored = value.readClaim('claim:effect');
  assert.notEqual(stored, null, 'the derivation-backed randomized claim must persist');
  assert.equal(stored?.profile.causality, 'randomized');
  assert.notEqual(value.readDerivation('derivation:randomization'), null, 'the derivation must persist with it');
});

test('a derivation over evidence alone legalizes nothing', () => {
  // `assessDerivationLegality` runs once per INPUT CLAIM. A derivation naming
  // only evidence runs it zero times, so accepting its output as legalized
  // would hand back the bypass by another door: declare the strengthened
  // claim, then declare a derivation that checks nothing.
  const value = ledger();
  assert.throws(
    () => value.runInTransaction(() => {
      value.appendEvidenceWithinTransaction(weakEvidence('evidence:a'));
      value.appendClaimWithinTransaction(
        citingClaim('claim:effect', ['evidence:a'], { causality: 'randomized' }, 'causal.effect_supported'),
      );
      value.appendWitnessWithinTransaction(identificationWitness(['evidence:a']));
      value.appendDerivationWithinTransaction(derivation({
        id: 'derivation:evidence-only',
        inputEvidenceIds: ['evidence:a'],
        transformation: 'causal.assert.v1',
        outputClaimId: 'claim:effect',
        outputProposition: { predicate: 'causal.effect_supported', value: { value: '1' } },
        coordinateChange: {
          from: { grain: STUDY_GRAIN, scope: STUDY_SCOPE },
          to: { grain: STUDY_GRAIN, scope: STUDY_SCOPE },
        },
        witnesses: [{
          id: 'witness:identification',
          kind: 'causal_identification',
          evidenceIds: ['evidence:a'],
          detail: 'Randomized assignment recorded before the first exposure.',
        }],
        version: 1,
        reproducibilityHash: 'hash:evidence-only',
      }));
    }),
    /causality/i,
  );
  assert.equal(value.readClaim('claim:effect'), null, 'nothing may persist after the refusal');
});

test('GUARD: an ordinary claim within its evidence still needs no derivation at all', () => {
  // The floor must not turn every honest weak claim into a derivation
  // ceremony. Nothing here exceeds it, so nothing here changes.
  const value = ledger();
  assert.equal(value.appendEvidence(weakEvidence('evidence:a')), 'inserted');
  assert.equal(value.appendClaim(citingClaim('claim:plain', ['evidence:a'])), 'inserted');
  assert.equal(
    value.appendClaim(citingClaim('claim:observational', ['evidence:a'], { causality: 'observational' }, 'usage.observed.b')),
    'inserted',
    'observational is the top of the direct causal floor, not above it',
  );
  assert.notEqual(value.readClaim('claim:plain'), null);
});
