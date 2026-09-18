/**
 * The chain abstraction is now a gate on the path that persists.
 *
 * THE COUNTEREXAMPLE, MEASURED. `analyzeDerivationChain` (D-151) bounds what
 * a whole chain licenses, and `appendDerivationWithinTransaction` never called
 * it — it ran `assessDerivationLegality` per step and nothing else. The two
 * rules disagree on the money axis in exactly one direction, and the ledger
 * sided with the looser one:
 *
 *   leaf   monetaryBasis : billed
 *   output monetaryBasis : mixed          (one input, no witness)
 *   per-step             : allowed   -- `mixed` is "a free weakening"
 *   chain                : violation -- the chain licenses {billed, none}
 *   ledger               : stored
 *
 * `mixed` is not a withholding. `claim-uses.ts` admits `mixed` to
 * `request_metered_spend` and `budget_enforcement` because the metered builder
 * writes `mixed` for "some list, some estimated" — so a provider-billed figure
 * re-labelled `mixed` by a one-input derivation walks into the use that exists
 * to hold the metered figure apart from it. `metered usage != provider-billed
 * cost`, collapsed by a label the per-step rule calls harmless.
 *
 * The two-step form is worse and the same shape: `estimated -> mixed` is free,
 * and `mixed -> billed` needs only a witness declaring `mixed -> billed` —
 * which `witness()` accepts, because resolving a mixture is a legitimate act.
 * The estimate reaches `billed` with a witness that never names `estimated`.
 * The per-step rule compares each hop with its neighbour; the chain sees the
 * leaf.
 *
 * Recorded at D-222.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { claim, type Claim } from '../src/epistemic/claim.ts';
import { derivation, type Derivation, type DerivationWitness } from '../src/epistemic/derivation.ts';
import { EpistemicLedger } from '../src/epistemic/ledger.ts';
import { claimProfile, type ClaimProfile, type MonetaryBasisStatus } from '../src/epistemic/profile.ts';
import { scope } from '../src/epistemic/scope.ts';
import { grain } from '../src/epistemic/grain.ts';
import { witness, type Witness } from '../src/epistemic/witness.ts';
import { evidence, type Evidence } from '../src/epistemic/evidence.ts';
import { analyzeDerivationChain } from '../src/epistemic/abstract.ts';
import { admits } from '../src/epistemic/admissibility.ts';
import { USE_REQUIREMENTS } from '../src/epistemic/claim-uses.ts';
import { canonicalJson } from '../src/epistemic/serialization.ts';
import { createHash } from 'node:crypto';

const at = '2026-09-08T00:00:00.000Z';
const validTime = { from: '2026-09-01T00:00:00.000Z', to: '2026-09-07T00:00:00.000Z' };
const SCOPE = scope({ ledger: 'chain-gate-test' });
const GRAIN = grain(['request']);
const COORDINATE = { grain: GRAIN, scope: SCOPE };
const EVIDENCE_ID = 'evidence:chain-gate';

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
    subject: 'chain-gate-test',
    scope: SCOPE,
    grain: GRAIN,
    time: { validTime, asOf: at },
    epistemic: 'supported',
    profile,
    measurementModelRef: null,
    evidenceIds: [EVIDENCE_ID],
    derivationRule: 'chain-gate.test.v1',
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

function step(id: string, inputs: readonly Claim[], output: Claim, witnesses: readonly DerivationWitness[] = []): Derivation {
  return derivation({
    id,
    inputClaimIds: inputs.map((item) => item.id),
    inputEvidenceIds: [EVIDENCE_ID],
    transformation: 'chain-gate.test.step.v1',
    outputClaimId: output.id,
    outputProposition: output.proposition,
    coordinateChange: { from: COORDINATE, to: COORDINATE },
    witnesses,
    assumptions: [],
    uncertaintyTransformation: 'none',
    version: 1,
    reproducibilityHash: `hash:${id}`,
  });
}

function rebasing(id: string, from: MonetaryBasisStatus, to: MonetaryBasisStatus): Witness {
  return witness({
    id,
    kind: 'monetary_rebasing',
    evidenceIds: [EVIDENCE_ID],
    detail: `declared re-basing ${from} -> ${to} for the chain-gate fixture`,
    basisChange: { from, to },
    issuedAt: at,
    epistemic: 'supported',
    schemaVersion: 1,
  });
}

function reference(proof: Witness): DerivationWitness {
  return { id: proof.id, kind: proof.kind, evidenceIds: proof.evidenceIds, detail: proof.detail };
}

const SOURCE: Evidence = evidence({
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

function fresh(): { ledger: EpistemicLedger; db: DatabaseSync } {
  const db = new DatabaseSync(':memory:');
  const ledger = new EpistemicLedger(db);
  ledger.appendEvidence(SOURCE);
  return { ledger, db };
}

// ---------------------------------------------------------------------------
// THE COUNTEREXAMPLE: one input, `billed` -> `mixed`, no witness.
// ---------------------------------------------------------------------------

test('a billed figure re-labelled mixed by a one-input derivation is refused, because the chain licenses no mixture', () => {
  const billed = mk('claim:billed', 'billed');
  const mixed = mk('claim:mixed', 'mixed');
  const relabel = step('derivation:relabel', [billed], mixed);

  // The abstraction flags it: one basis in, so nothing to disagree about.
  const analysis = analyzeDerivationChain({ claims: [billed, mixed], derivations: [relabel] });
  assert.equal(analysis.withinBound, false);
  assert.ok(analysis.violations.some((item) => item.claimId === 'claim:mixed'
    && item.violations.some((axis) => axis.axis === 'monetaryBasis')));

  // And what the label buys: the metered-spend use admits it, so a provider-
  // billed total now clears the bar written to keep it OUT of that figure.
  assert.equal(admits(mixed.profile, USE_REQUIREMENTS.request_metered_spend).admitted, true);
  assert.equal(admits(billed.profile, USE_REQUIREMENTS.request_metered_spend).admitted, false);

  // THE LEDGER. Before D-222 this transaction committed.
  const { ledger } = fresh();
  assert.throws(() => {
    ledger.runInTransaction(() => {
      ledger.appendClaimWithinTransaction(billed);
      ledger.appendClaimWithinTransaction(mixed);
      ledger.appendDerivationWithinTransaction(relabel);
    });
  }, (error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    assert.match(message, /derivation:relabel/);
    assert.match(message, /claim:mixed/);
    assert.match(message, /monetary basis mixed is not supported by its chain/);
    assert.match(message, /which supports none, billed/, 'the refusal says what the chain DOES license');
    return true;
  });
  // Refused means not stored -- no partial ledger.
  assert.equal(ledger.readDerivation('derivation:relabel'), null);
  assert.equal(ledger.readClaim('claim:mixed'), null);
});

test('mixed is admitted exactly where its inputs disagree', () => {
  // The gate refuses the label where nothing was mixed, not the label.
  const list = mk('claim:list', 'list');
  const estimated = mk('claim:estimated', 'estimated');
  const mixed = mk('claim:mixed', 'mixed');
  const { ledger } = fresh();
  ledger.runInTransaction(() => {
    ledger.appendClaimWithinTransaction(list);
    ledger.appendClaimWithinTransaction(estimated);
    ledger.appendClaimWithinTransaction(mixed);
    ledger.appendDerivationWithinTransaction(step('derivation:merge', [list, estimated], mixed));
  });
  assert.ok(ledger.readDerivation('derivation:merge'));
});

// ---------------------------------------------------------------------------
// THE TWO-STEP FORM: the leaf is `estimated`, the conclusion is `billed`, and
// no witness names `estimated`.
// ---------------------------------------------------------------------------

test('an estimate cannot reach billed through a mixed hop with a witness that never names the estimate', () => {
  const estimated = mk('claim:estimated', 'estimated');
  const mixed = mk('claim:mixed', 'mixed');
  const billed = mk('claim:billed', 'billed');
  const settle = rebasing('witness:settle', 'mixed', 'billed');
  const hop = step('derivation:hop', [estimated], mixed);
  const resolve = step('derivation:resolve', [mixed], billed, [reference(settle)]);

  const analysis = analyzeDerivationChain({ claims: [estimated, mixed, billed], derivations: [hop, resolve] });
  assert.equal(analysis.withinBound, false);

  const { ledger } = fresh();
  assert.throws(() => {
    ledger.runInTransaction(() => {
      ledger.appendClaimWithinTransaction(estimated);
      ledger.appendClaimWithinTransaction(mixed);
      ledger.appendClaimWithinTransaction(billed);
      ledger.appendWitnessWithinTransaction(settle);
      ledger.appendDerivationWithinTransaction(hop);
      ledger.appendDerivationWithinTransaction(resolve);
    });
  }, /derivation:hop .*claim:mixed.*monetary basis mixed is not supported by its chain/);
  assert.equal(ledger.readClaim('claim:billed'), null);
});

test('a conclusion is checked against its leaves, not its neighbour: a stored unsound hop taints what rests on it', () => {
  // A ledger written before this gate can hold the `estimated -> mixed` hop.
  // Simulated the only way it can now happen: the row is inserted underneath
  // the ledger. The per-step rule, looking one hop back, sees `mixed -> billed`
  // with a witness declaring exactly that pair and passes. The chain sees the
  // leaf.
  const estimated = mk('claim:estimated', 'estimated');
  const mixed = mk('claim:mixed', 'mixed');
  const billed = mk('claim:billed', 'billed');
  const settle = rebasing('witness:settle', 'mixed', 'billed');
  const hop = step('derivation:hop', [estimated], mixed);
  const { ledger, db } = fresh();
  ledger.runInTransaction(() => {
    ledger.appendClaimWithinTransaction(estimated);
    ledger.appendClaimWithinTransaction(mixed);
  });
  const encoded = canonicalJson(hop);
  db.prepare('INSERT INTO epistemic_derivations (derivation_id, derivation_json, derivation_digest) VALUES (?, ?, ?)')
    .run(hop.id, encoded, createHash('sha256').update(encoded, 'utf8').digest('hex'));
  db.prepare('INSERT INTO epistemic_edges (from_id, to_id, relation) VALUES (?, ?, ?)').run(EVIDENCE_ID, mixed.id, 'depends_on');
  db.prepare('INSERT INTO epistemic_edges (from_id, to_id, relation) VALUES (?, ?, ?)').run(estimated.id, mixed.id, 'derives');
  assert.ok(ledger.readDerivation('derivation:hop'), 'the unsound hop is on record');

  assert.throws(() => {
    ledger.runInTransaction(() => {
      ledger.appendClaimWithinTransaction(billed);
      ledger.appendWitnessWithinTransaction(settle);
      ledger.appendDerivationWithinTransaction(step('derivation:resolve', [mixed], billed, [reference(settle)]));
    });
  }, (error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    assert.match(message, /derivation:resolve/);
    assert.match(message, /derivation:hop/, 'the refusal names the step upstream that does not hold');
    assert.match(message, /claim:mixed/);
    return true;
  });
  assert.equal(ledger.readClaim('claim:billed'), null);
});

// ---------------------------------------------------------------------------
// What stays licensed: a declared re-basing lifts the chain exactly as the
// per-step rule reads it, and no further.
// ---------------------------------------------------------------------------

test('a supported re-basing witness licenses the chain for the pair it declares', () => {
  const estimated = mk('claim:estimated', 'estimated');
  const billed = mk('claim:billed', 'billed');
  const proof = rebasing('witness:rebase', 'estimated', 'billed');
  const { ledger } = fresh();
  ledger.runInTransaction(() => {
    ledger.appendClaimWithinTransaction(estimated);
    ledger.appendClaimWithinTransaction(billed);
    ledger.appendWitnessWithinTransaction(proof);
    ledger.appendDerivationWithinTransaction(step('derivation:rebase', [estimated], billed, [reference(proof)]));
  });
  assert.ok(ledger.readDerivation('derivation:rebase'));
});

test('resolving two disagreeing inputs into one basis needs a witness that names the mixture', () => {
  // Per step, `estimated -> billed` is witnessed and `billed -> billed` is
  // free, so the per-step rule passes. The chain's meet of {estimated, billed}
  // is `mixed`, and a witness declaring `estimated -> billed` says nothing
  // about settling a mixture. One that does is what the chain asks for.
  const estimated = mk('claim:estimated', 'estimated');
  const observed = mk('claim:observed', 'billed');
  const billed = mk('claim:billed', 'billed');
  const partial = rebasing('witness:partial', 'estimated', 'billed');
  const settled = rebasing('witness:settled', 'mixed', 'billed');

  const refused = fresh().ledger;
  assert.throws(() => {
    refused.runInTransaction(() => {
      refused.appendClaimWithinTransaction(estimated);
      refused.appendClaimWithinTransaction(observed);
      refused.appendClaimWithinTransaction(billed);
      refused.appendWitnessWithinTransaction(partial);
      refused.appendDerivationWithinTransaction(step('derivation:merge', [estimated, observed], billed, [reference(partial)]));
    });
  }, /monetary basis billed is not supported by its chain, which supports none, mixed/);

  const { ledger } = fresh();
  ledger.runInTransaction(() => {
    ledger.appendClaimWithinTransaction(estimated);
    ledger.appendClaimWithinTransaction(observed);
    ledger.appendClaimWithinTransaction(billed);
    ledger.appendWitnessWithinTransaction(partial);
    ledger.appendWitnessWithinTransaction(settled);
    ledger.appendDerivationWithinTransaction(
      step('derivation:merge', [estimated, observed], billed, [reference(partial), reference(settled)]),
    );
  });
  assert.ok(ledger.readDerivation('derivation:merge'));
});

test('a refuted re-basing witness lifts nothing at the chain either', () => {
  // D-190 at the per-step rule; the same rule here, so the chain cannot be
  // lifted by a declaration the kernel itself does not support.
  const estimated = mk('claim:estimated', 'estimated');
  const billed = mk('claim:billed', 'billed');
  const proof = witness({
    id: 'witness:refuted',
    kind: 'monetary_rebasing',
    evidenceIds: [EVIDENCE_ID],
    detail: 'a re-basing the kernel has since refuted',
    basisChange: { from: 'estimated', to: 'billed' },
    issuedAt: at,
    epistemic: 'refuted',
    schemaVersion: 1,
  });
  const { ledger } = fresh();
  assert.throws(() => {
    ledger.runInTransaction(() => {
      ledger.appendClaimWithinTransaction(estimated);
      ledger.appendClaimWithinTransaction(billed);
      ledger.appendWitnessWithinTransaction(proof);
      ledger.appendDerivationWithinTransaction(step('derivation:rebase', [estimated], billed, [reference(proof)]));
    });
  }, /witness:refuted is refuted/);
});
