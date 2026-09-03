/**
 * A revocation the ledger stores and never projects (WP-R07).
 *
 * THE DEFECT. `Evidence` and `Claim` both carry an optional `revocation`
 * envelope — `{ eventId, effectiveAt, reason }` — validated by their canonical
 * constructors and stored verbatim in the payload. Nothing reads it.
 * `EpistemicLedger.revocationEvents()` selects from `epistemic_revocations`
 * only, the table `appendRevocation` writes, so a provider statement that says
 * on its face "this was withdrawn, event revocation:provider:1, effective
 * 2026-08-05, because the provider withdrew it" is appended, persisted, read
 * back with the envelope intact, and reported by `revocationProjection()` as
 * live. Every claim derived from it reads as supported.
 *
 * Probed before it was diagnosed: append returned `inserted`,
 * `readEvidence().revocation` returned the envelope in full, and
 * `revocationProjection().revokedIds` returned `[]`.
 *
 * THE SAME SHAPE, THIRD TIME. `assessDerivationLegality` was correct, tested,
 * and had no caller in `src/` at all until the ledger consulted it — the
 * comment recording that is still in `appendDerivationWithinTransaction`. D-094
 * was the read boundary serving a claim the projection already knew was
 * revoked. This one is the projection itself ignoring a revocation the ledger
 * already stores. In all three the kernel held the information and a layer
 * above it did not ask.
 *
 * WHERE THE REPAIR GOES, and the two places it could have gone instead.
 * Refusing the envelope at append would delete a legitimate capability: a
 * withdrawn provider statement is a fact worth recording. Requiring the
 * envelope to reference an existing revocation event deadlocks —
 * `appendRevocation` refuses an unknown target, so the event cannot precede its
 * node and the envelope cannot follow it. So the projection is what changes: it
 * now reflects everything the ledger knows about revocation, from both the
 * event table and the stored envelopes.
 *
 * WHAT THE ENVELOPE'S `effectiveAt` IS NOT USED FOR. `RevocationProjection` is
 * a set of revoked ids with no effective-time dimension, and `replayAsOf`
 * filters events by the time they were RECORDED. An envelope carries no
 * recorded time, but it needs none: it is part of its node's immutable payload,
 * so the ledger learns it exactly when the node becomes available, and that is
 * the knowledge time used here. `effectiveAt` is preserved in the payload and
 * deliberately not consulted — treating an effective time as a knowledge time
 * is the collapse this codebase exists to refuse. The consequence is stated
 * rather than hidden: a node carrying a future-dated revocation reads as revoked
 * from the moment it exists, which errs toward withholding. Recorded at D-099.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { EpistemicLedger } from '../src/epistemic/ledger.ts';
import { evidence, type EvidenceInput } from '../src/epistemic/evidence.ts';
import { claim, type ClaimInput } from '../src/epistemic/claim.ts';
import { claimProfile } from '../src/epistemic/profile.ts';
import { grain } from '../src/epistemic/grain.ts';
import { interval } from '../src/epistemic/time.ts';
import { scope } from '../src/epistemic/scope.ts';

type Envelope = { eventId: string; effectiveAt: string; reason: string } | null;

const WITHDRAWN: Envelope = {
  eventId: 'revocation:provider:1',
  effectiveAt: '2026-08-05T00:00:00.000Z',
  reason: 'the provider withdrew this statement',
};

function evidenceInput(id: string, revocation: Envelope): EvidenceInput {
  return {
    id,
    evidenceType: 'provider.invoice',
    sourceIdentity: 'provider:openai:account-1',
    sourceClass: 'provider_statement',
    payload: { amount: '12.34', currency: 'USD' },
    scope: scope({ account: 'acct-1', provider: 'openai' }),
    grain: grain(['day']),
    occurredAt: '2026-08-01T00:00:00.000Z',
    validTime: interval('2026-08-01T00:00:00.000Z', '2026-08-02T00:00:00.000Z'),
    observedAt: '2026-08-02T03:00:00.000Z',
    recordedAt: '2026-08-02T03:00:01.000Z',
    integrity: 'verified',
    authenticity: 'provider_authenticated',
    completeness: { status: 'complete', method: 'provider_export' },
    measurementModelRef: 'measurement:provider-cost:v1',
    monetaryBasis: 'billed',
    assumptions: [],
    supersedes: [],
    supersededBy: null,
    revocation,
    schemaVersion: 1,
    sensitivity: 'confidential',
    redaction: 'none',
  };
}

function claimInput(id: string, evidenceIds: readonly string[], revocation: Envelope): ClaimInput {
  return {
    id,
    proposition: { predicate: 'cost.reconciled', value: { amount: '12.34', currency: 'USD' } },
    subject: 'project:api',
    scope: scope({ account: 'acct-1', provider: 'openai' }),
    grain: grain(['day']),
    time: {
      validTime: interval('2026-08-01T00:00:00.000Z', '2026-08-02T00:00:00.000Z'),
      asOf: '2026-08-02T03:00:02.000Z',
    },
    epistemic: 'supported',
    profile: claimProfile({
      epistemic: 'supported',
      integrity: 'verified',
      authenticity: 'provider_authenticated',
      scope: 'established',
      coverage: 'complete',
      measurement: 'validated',
      causality: 'observational',
      monetaryBasis: 'billed',
      finality: 'provisional',
      decisionFitness: 'sufficient',
    }),
    measurementModelRef: 'measurement:provider-cost:v1',
    evidenceIds: [...evidenceIds],
    derivationRule: 'billing.reconcile.v1',
    derivationVersion: 1,
    assumptions: [],
    uncertainty: { kind: 'interval', lower: 12.34, upper: 12.34 },
    causalStatus: 'observational',
    issuedAt: '2026-08-02T03:00:02.000Z',
    supersedes: [],
    supersededBy: null,
    revocation,
    decisionCertificateIds: [],
    schemaVersion: 1,
  };
}

function ledger(): EpistemicLedger {
  return new EpistemicLedger(new DatabaseSync(':memory:'));
}

test('evidence whose own envelope says it was withdrawn is projected as revoked', () => {
  const kernel = ledger();
  assert.equal(kernel.appendEvidence(evidence(evidenceInput('evidence:withdrawn:1', WITHDRAWN))), 'inserted');

  // The premise: the envelope really is stored, so the ledger is not missing the
  // information — it was declining to use it.
  assert.deepEqual(kernel.readEvidence('evidence:withdrawn:1')?.revocation, WITHDRAWN);

  assert.deepEqual(kernel.revocationProjection().revokedIds, ['evidence:withdrawn:1']);
});

test('a claim whose own envelope says it was withdrawn is projected as revoked', () => {
  // The structural twin. `Claim` carries the identical field, and a repair that
  // read only the evidence table would leave half the defect standing — the
  // missing-sibling shape this round has now produced five times.
  const kernel = ledger();
  kernel.appendEvidence(evidence(evidenceInput('evidence:invoice:1', null)));
  assert.equal(
    kernel.appendClaim(claim(claimInput('claim:withdrawn:1', ['evidence:invoice:1'], WITHDRAWN))),
    'inserted',
  );

  assert.deepEqual(kernel.revocationProjection().revokedIds, ['claim:withdrawn:1']);
});

test('the closure carries an envelope revocation downstream, exactly as it carries an event', () => {
  // An envelope revocation is not a cosmetic flag on one row. Whatever depends
  // on withdrawn evidence is withdrawn too, which is the whole purpose of the
  // closure and the reason projecting the envelope matters more than reporting
  // it.
  const kernel = ledger();
  kernel.appendEvidence(evidence(evidenceInput('evidence:withdrawn:1', WITHDRAWN)));
  kernel.appendClaim(claim(claimInput('claim:downstream:1', ['evidence:withdrawn:1'], null)));

  const projection = kernel.revocationProjection();
  assert.deepEqual(projection.revokedIds, ['claim:downstream:1', 'evidence:withdrawn:1']);
  assert.deepEqual(
    projection.trace.find((entry) => entry.nodeId === 'claim:downstream:1')?.path,
    ['evidence:withdrawn:1', 'claim:downstream:1'],
  );
});

test('an envelope-revoked node and an event-revoked node are the same kind of revoked', () => {
  // Two routes to one state. The event table is unchanged and still authoritative
  // for revocations recorded after the fact; the envelope is the same fact
  // arriving with the record instead of after it.
  const kernel = ledger();
  kernel.appendEvidence(evidence(evidenceInput('evidence:withdrawn:1', WITHDRAWN)));
  kernel.appendEvidence(evidence(evidenceInput('evidence:invoice:2', null)));
  kernel.appendRevocation({
    eventId: 'revocation:operator:1',
    targetId: 'evidence:invoice:2',
    recordedAt: '2026-08-06T00:00:00.000Z',
    reason: 'the operator withdrew this row after review',
  });

  assert.deepEqual(kernel.revocationProjection().revokedIds, ['evidence:invoice:2', 'evidence:withdrawn:1']);
});

test('a record carrying no envelope is not revoked, and the projection stays empty', () => {
  // THE GUARD-RAIL. A repair that read the field's PRESENCE rather than its
  // content would revoke every record in the ledger, since both constructors
  // normalise a missing envelope to an explicit `null`.
  const kernel = ledger();
  kernel.appendEvidence(evidence(evidenceInput('evidence:invoice:1', null)));
  kernel.appendClaim(claim(claimInput('claim:billed:1', ['evidence:invoice:1'], null)));

  assert.deepEqual(kernel.revocationProjection().revokedIds, []);
});

test('an as-of replay before the withdrawn record existed does not know it was withdrawn', () => {
  // The envelope's knowledge time is its node's availability, so the boundary
  // behaves the way an event's `recordedAt` does: before the record exists
  // there is nothing to know, and afterwards the revocation is known at once.
  // `effectiveAt` — 2026-08-05 — is deliberately not the boundary, and the
  // second assertion is where that shows: the node is revoked at 2026-08-03.
  const kernel = ledger();
  kernel.appendEvidence(evidence(evidenceInput('evidence:withdrawn:1', WITHDRAWN)));

  assert.deepEqual(kernel.revocationProjectionAsOf('2026-08-01T00:00:00.000Z').revokedIds, []);
  assert.deepEqual(kernel.revocationProjectionAsOf('2026-08-03T00:00:00.000Z').revokedIds, ['evidence:withdrawn:1']);
});
