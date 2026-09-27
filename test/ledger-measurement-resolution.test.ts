/**
 * A direct claim's measurement model reference was checked for PRESENCE, never
 * for RESOLUTION.
 *
 * THE HOLE, IN THREE LAYERS THAT EACH STOPPED ONE SHORT. `claim()` refuses a
 * null `measurementModelRef` above `proxy_unvalidated` — a reference was
 * WRITTEN. `assertClaimWithinItsEvidence` (D-168) refuses a reference no
 * cited evidence declares — a reference was CARRIED. `directClaimObligation`
 * (D-192) restated the same floor. None asked whether the reference named a
 * model at all, so a direct claim asserting `proxy_validated` behind
 * `model:no-such` — written on the claim and on its evidence — persisted with
 * the rung intact, and so did one behind a real model validated for a
 * different construct, and one behind a real model whose own author declared
 * it `proxy_unvalidated`. `src/measurement/registry.ts` existed to answer
 * exactly this question and had one caller, inside the causal adapter,
 * resolving its own reference against a registry it built for itself.
 *
 * THE SEAM. The ledger, not `claim()`: the pure constructor has no registry
 * and must not acquire a database (D-168). `EpistemicLedger` now takes an
 * optional `measurementModels` registry and the direct floor consults it. The
 * default is the EMPTY registry, not "no check": a ledger that holds no models
 * can resolve nothing, so a direct claim above the bottom rung is refused
 * there exactly as it is refused for a dangling reference. Fail closed. The
 * derivation path with a `measurement_validation` witness (D-201) is untouched
 * and still legalizes what the direct floor refuses.
 *
 * WHAT A CLAIM'S CONSTRUCT IS. The envelope carries no construct field. The
 * proposition predicate is what the claim asserts a measurement OF, so the
 * floor requires the resolved model's `targetConstruct` to be the claim's
 * predicate. A model whose author wrote a different construct on it is not a
 * model of this claim, however strong its validation.
 *
 * LEGACY ROWS. A claim persisted before this check reads back exactly as
 * stored — rung, reference and all. It is neither refused, upgraded, nor
 * backfilled on read, and re-offering the identical payload returns
 * `duplicate` without re-raising the obligation. The row says what its issuer
 * said; whether that reference would resolve today is not a fact the read
 * path invents.
 *
 * Recorded at D-224.
 *
 * THE WINDOW (D-227). `MeasurementModel.validTime` was declared, carried, and
 * read by the surrogate-bridge path only; the direct floor resolved a model
 * and never asked WHEN. A model whose author bounded its calibration to July
 * backed an August claim, and a claim that named no instant at all was backed
 * by a model that could only answer for an instant. The floor now passes the
 * claim's own `time.asOf` as the instant the citation is made about: a model
 * with a window that does not contain it is refused, and a model with a
 * window asked by a claim with no `asOf` is refused because the question was
 * not asked — absence of an instant is not "now". A model that declares no
 * window is unbounded by declaration and unaffected.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { claim, type Claim } from '../src/epistemic/claim.ts';
import { evidence, type Evidence } from '../src/epistemic/evidence.ts';
import { derivation } from '../src/epistemic/derivation.ts';
import { witness } from '../src/epistemic/witness.ts';
import { EpistemicLedger } from '../src/epistemic/ledger.ts';
import { claimProfile, type ClaimProfileInput } from '../src/epistemic/profile.ts';
import { grain } from '../src/epistemic/grain.ts';
import { scope } from '../src/epistemic/scope.ts';
import { measurementModel, type MeasurementModel, type MeasurementValidation } from '../src/measurement/model.ts';
import { measurementRegistry } from '../src/measurement/registry.ts';

const VALID_FROM = '2026-08-01T00:00:00.000Z';
const VALID_TO = '2026-08-02T00:00:00.000Z';
const ISSUED = '2026-08-02T00:00:01.000Z';

const STUDY_SCOPE = scope({ account: 'acct-1' });
const STUDY_GRAIN = grain(['day', 'project']);

const PREDICATE = 'ops.incident_count';
const MODEL_REF = 'model:ops-incidents-v1';

function model(overrides: Partial<{ id: string; targetConstruct: string; validation: MeasurementValidation; validTime: { from: string; to: string } }> = {}): MeasurementModel {
  return measurementModel({
    ...(overrides.validTime ? { validTime: overrides.validTime } : {}),
    id: overrides.id ?? MODEL_REF,
    targetConstruct: overrides.targetConstruct ?? PREDICATE,
    measurand: 'incidents opened per day',
    observable: 'rows in the incident feed',
    procedure: 'count rows per day',
    scope: STUDY_SCOPE,
    population: 'all incidents',
    validation: overrides.validation ?? 'validated',
    calibration: null,
    uncertainty: { kind: 'none', description: 'exact count' },
  });
}

function ledgerWith(models: readonly MeasurementModel[]): EpistemicLedger {
  return new EpistemicLedger(new DatabaseSync(':memory:'), { measurementModels: measurementRegistry(models) });
}

function record(id: string, measurementModelRef: string | null): Evidence {
  return evidence({
    id,
    evidenceType: 'ops.incident_feed',
    sourceIdentity: 'segreant:local',
    sourceClass: 'segreant_local_records',
    payload: { value: '1' },
    scope: STUDY_SCOPE,
    grain: STUDY_GRAIN,
    occurredAt: VALID_FROM,
    observedAt: VALID_FROM,
    finalizedAt: null,
    integrity: 'verified',
    authenticity: 'pinned',
    completeness: { status: 'complete', method: 'local_scan' },
    measurementModelRef,
    monetaryBasis: null,
    schemaVersion: 1,
    sensitivity: 'internal',
    redaction: 'none',
  });
}

const BASE_PROFILE: ClaimProfileInput = {
  epistemic: 'supported',
  integrity: 'verified',
  authenticity: 'pinned',
  scope: 'conditional',
  coverage: 'complete',
  measurement: 'proxy_unvalidated',
  causality: 'none',
  monetaryBasis: 'none',
  finality: 'provisional',
  decisionFitness: 'not_assessed',
};

function measuringClaim(
  id: string,
  measurement: MeasurementValidation,
  measurementModelRef: string | null,
  predicate = PREDICATE,
  asOf: string | null = ISSUED,
): Claim {
  const profile = { ...BASE_PROFILE, measurement };
  return claim({
    id,
    proposition: { predicate, value: { count: 3 } },
    subject: 'project:api',
    scope: STUDY_SCOPE,
    grain: STUDY_GRAIN,
    time: { validTime: { from: VALID_FROM, to: VALID_TO }, asOf },
    epistemic: 'supported',
    profile: claimProfile(profile),
    measurementModelRef,
    evidenceIds: ['evidence:feed'],
    derivationRule: 'ops.count.v1',
    derivationVersion: 1,
    causalStatus: 'none',
    issuedAt: ISSUED,
    schemaVersion: 1,
  });
}

test('COUNTEREXAMPLE: a direct proxy_validated claim behind a reference that resolves to nothing is refused', () => {
  // The reference is written on the claim AND declared by the evidence, so
  // every check that existed before this one is satisfied. No model with this
  // id is registered anywhere.
  const value = ledgerWith([model()]);
  assert.equal(value.appendEvidence(record('evidence:feed', 'model:no-such')), 'inserted');

  assert.throws(
    () => value.appendClaim(measuringClaim('claim:dangling', 'proxy_validated', 'model:no-such')),
    /model:no-such.*resolves to no registered measurement model/,
  );
  assert.equal(value.readClaim('claim:dangling'), null, 'the refusal must roll back, not persist the rung');
});

test('COUNTEREXAMPLE: a reference to a real model validated for a DIFFERENT construct is refused', () => {
  // The most valuable reference to forge is a true one. `model:tickets` is
  // registered, `validated`, and measures something else entirely.
  const other = model({ id: 'model:tickets', targetConstruct: 'ops.ticket_count' });
  const value = ledgerWith([other]);
  assert.equal(value.appendEvidence(record('evidence:feed', 'model:tickets')), 'inserted');

  assert.throws(
    () => value.appendClaim(measuringClaim('claim:laundered', 'validated', 'model:tickets')),
    /construct mismatch: model targets ops\.ticket_count, claim requires ops\.incident_count/,
  );
  assert.equal(value.readClaim('claim:laundered'), null);
});

test('COUNTEREXAMPLE: a reference to a real model its own author declared proxy_unvalidated cannot back proxy_validated', () => {
  const weak = model({ validation: 'proxy_unvalidated' });
  const value = ledgerWith([weak]);
  assert.equal(value.appendEvidence(record('evidence:feed', MODEL_REF)), 'inserted');

  assert.throws(
    () => value.appendClaim(measuringClaim('claim:escalated', 'proxy_validated', MODEL_REF)),
    /unvalidated proxy cannot establish the target construct/,
  );
  assert.equal(value.readClaim('claim:escalated'), null);
});

test('COUNTEREXAMPLE: a ledger built with no registry holds no models and resolves nothing', () => {
  // The default is the empty registry, not the absence of a check. This is the
  // ledger `Store` constructs today.
  const value = new EpistemicLedger(new DatabaseSync(':memory:'));
  assert.equal(value.appendEvidence(record('evidence:feed', MODEL_REF)), 'inserted');

  assert.throws(
    () => value.appendClaim(measuringClaim('claim:unresolvable', 'validated', MODEL_REF)),
    /resolves to no registered measurement model/,
  );
  assert.equal(value.readClaim('claim:unresolvable'), null);
});

test('COUNTEREXAMPLE (D-227): a model whose validity window closed before the claim\'s asOf cannot back it', () => {
  const ledger = ledgerWith([model({ validTime: { from: '2026-07-01T00:00:00.000Z', to: '2026-07-15T00:00:00.000Z' } })]);
  ledger.appendEvidence(record('evidence:feed', MODEL_REF));
  assert.throws(
    () => ledger.appendClaim(measuringClaim('claim:expired-window', 'proxy_validated', MODEL_REF)),
    (error: Error) => /valid from 2026-07-01T00:00:00.000Z to 2026-07-15T00:00:00.000Z and does not cover 2026-08-02T00:00:01.000Z/.test(error.message),
  );
  assert.equal(ledger.readClaim('claim:expired-window'), null);
});

test('COUNTEREXAMPLE (D-227): a windowed model asked by a claim that names no asOf is refused, not read as current', () => {
  const ledger = ledgerWith([model({ validTime: { from: VALID_FROM, to: '2026-09-01T00:00:00.000Z' } })]);
  ledger.appendEvidence(record('evidence:feed', MODEL_REF));
  assert.throws(
    () => ledger.appendClaim(measuringClaim('claim:no-instant', 'proxy_validated', MODEL_REF, PREDICATE, null)),
    (error: Error) => /names no instant to check it against/.test(error.message),
  );
  assert.equal(ledger.readClaim('claim:no-instant'), null);
});

test('GUARD (D-227): a windowed model whose window contains the claim\'s asOf is accepted', () => {
  const ledger = ledgerWith([model({ validTime: { from: VALID_FROM, to: '2026-09-01T00:00:00.000Z' } })]);
  ledger.appendEvidence(record('evidence:feed', MODEL_REF));
  assert.equal(ledger.appendClaim(measuringClaim('claim:in-window', 'proxy_validated', MODEL_REF)), 'inserted');
});

test('GUARD: a registered, construct-matching model strong enough for the rung is accepted', () => {
  const value = ledgerWith([model()]);
  assert.equal(value.appendEvidence(record('evidence:feed', MODEL_REF)), 'inserted');
  assert.equal(value.appendClaim(measuringClaim('claim:backed', 'validated', MODEL_REF)), 'inserted');
  assert.equal(value.readClaim('claim:backed')?.profile.measurement, 'validated');

  // `proxy_validated` asserted behind a `validated` model is a claim asserting
  // LESS than its model earns, which the ladder permits.
  assert.equal(value.appendClaim(measuringClaim('claim:under', 'proxy_validated', MODEL_REF)), 'inserted');
});

test('GUARD: a proxy_unvalidated claim carrying an unresolvable reference is still accepted', () => {
  // The floor is ABOVE the bottom rung. Segreant\'s own causal claims sit at
  // `proxy_unvalidated` with a reference synthesized from a stored protocol
  // that no static registry can hold (D-168); they assert nothing on the axis
  // and must keep working in a ledger that knows no models.
  const value = new EpistemicLedger(new DatabaseSync(':memory:'));
  assert.equal(value.appendEvidence(record('evidence:feed', 'causal:quality-metric:m@hash')), 'inserted');
  assert.equal(
    value.appendClaim(measuringClaim('claim:weak', 'proxy_unvalidated', 'causal:quality-metric:m@hash')),
    'inserted',
  );
});

test('GUARD: a derivation carrying a measurement_validation witness still legalizes what the direct floor refuses', () => {
  // The registry bounds the DIRECT path. A rung earned through a derivation
  // is licensed by its witness (D-201), and that route is unchanged.
  const value = new EpistemicLedger(new DatabaseSync(':memory:'));
  value.runInTransaction(() => {
    value.appendEvidenceWithinTransaction(record('evidence:feed', MODEL_REF));
    value.appendClaimWithinTransaction(measuringClaim('claim:weak', 'proxy_unvalidated', MODEL_REF));
    value.appendWitnessWithinTransaction(witness({
      id: 'witness:validation',
      kind: 'measurement_validation',
      evidenceIds: ['evidence:feed'],
      detail: 'Counts reconciled against the incident system of record.',
      issuedAt: ISSUED,
      epistemic: 'supported',
      schemaVersion: 1,
    }));
    value.appendClaimWithinTransaction(measuringClaim('claim:strong', 'proxy_validated', MODEL_REF, 'ops.incident_count.validated'));
    value.appendDerivationWithinTransaction(derivation({
      id: 'derivation:validation',
      inputEvidenceIds: ['evidence:feed'],
      inputClaimIds: ['claim:weak'],
      transformation: 'ops.validate_count.v1',
      outputClaimId: 'claim:strong',
      outputProposition: { predicate: 'ops.incident_count.validated', value: { count: 3 } },
      coordinateChange: {
        from: { grain: STUDY_GRAIN, scope: STUDY_SCOPE },
        to: { grain: STUDY_GRAIN, scope: STUDY_SCOPE },
      },
      witnesses: [{
        id: 'witness:validation',
        kind: 'measurement_validation',
        evidenceIds: ['evidence:feed'],
        detail: 'Counts reconciled against the incident system of record.',
      }],
      uncertaintyTransformation: 'Exact count carried through.',
      version: 1,
      reproducibilityHash: 'hash:validation',
    }));
  });
  assert.equal(value.readClaim('claim:strong')?.profile.measurement, 'proxy_validated');
});

test('LEGACY ROW: a claim persisted before the check reads back as stored and is not re-judged', () => {
  // Same database handle, two ledgers: the first resolves the model, the
  // second knows no models — which is what every row written before this
  // check looks like to the ledger reading it now.
  const db = new DatabaseSync(':memory:');
  const before = new EpistemicLedger(db, { measurementModels: measurementRegistry([model()]) });
  assert.equal(before.appendEvidence(record('evidence:feed', MODEL_REF)), 'inserted');
  const persisted = measuringClaim('claim:legacy', 'validated', MODEL_REF);
  assert.equal(before.appendClaim(persisted), 'inserted');

  const now = new EpistemicLedger(db);
  const read = now.readClaim('claim:legacy');
  assert.equal(read?.profile.measurement, 'validated', 'the rung is neither refused nor lowered on read');
  assert.equal(read?.measurementModelRef, MODEL_REF, 'the reference is neither dropped nor rewritten');
  assert.equal(now.appendClaim(persisted), 'duplicate', 'idempotent replay does not re-raise the obligation');
});
