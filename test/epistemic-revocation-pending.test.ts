/**
 * `RevocationProjection` has no effective-time dimension, so a future-dated
 * revocation cannot be represented as pending and is treated as current
 * (WP-R07).
 *
 * THE DEFECT. `Evidence` and `Claim` each carry an optional `revocation`
 * envelope — `{ eventId, effectiveAt, reason }`. `effectiveAt` is preserved in
 * the stored payload, but `EpistemicLedger`'s own D-099 comment says it
 * plainly: "`RevocationProjection` has no effective-time dimension at all;
 * using [the recorded/knowledge time] as [the effective time] would be
 * precisely the collapse this codebase refuses. The consequence is declared
 * rather than hidden: a node carrying a future-dated revocation reads as
 * revoked from the moment it exists."
 *
 * Measured directly: a node whose envelope says "effective 2026-08-05" is
 * already returned in `revocationProjectionAsOf('2026-08-03T...').revokedIds`
 * — two days BEFORE its own declared effective date — and
 * `test/epistemic-revocation-envelope.test.ts`'s
 * "an as-of replay before the withdrawn record existed does not know it was
 * withdrawn" test pins exactly this reading in its own comment: "the node is
 * revoked at 2026-08-03," despite `effectiveAt` being 2026-08-05.
 *
 * THE FIX DOES NOT CHANGE TABLE-RECORDED EVENTS. `appendRevocation` has no
 * `effectiveAt` field — an operator-recorded revocation is effective the
 * instant it is recorded, which is unchanged here. Only envelope-declared
 * revocations, which already carry an independent `effectiveAt`, gain a
 * pending/current split.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { EpistemicLedger } from '../src/epistemic/ledger.ts';
import { evidence, type EvidenceInput } from '../src/epistemic/evidence.ts';
import { claim, type ClaimInput } from '../src/epistemic/claim.ts';
import { claimProfile } from '../src/epistemic/profile.ts';

type Envelope = { eventId: string; effectiveAt: string; reason: string } | null;

const FUTURE_DATED: Envelope = {
  eventId: 'revocation:provider:future:1',
  effectiveAt: '2026-08-05T00:00:00.000Z',
  reason: 'the provider withdrew this statement, effective in five days',
};

function evidenceInput(id: string, revocation: Envelope): EvidenceInput {
  return {
    id,
    evidenceType: 'provider.invoice',
    sourceIdentity: 'provider:openai:account-1',
    sourceClass: 'provider_statement',
    payload: { amount: '12.34', currency: 'USD' },
    scope: { constraints: [{ key: 'account', value: 'acct-1' }] },
    grain: { dimensions: ['day'] },
    occurredAt: '2026-08-01T00:00:00.000Z',
    validTime: { from: '2026-08-01T00:00:00.000Z', to: '2026-08-02T00:00:00.000Z' },
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
    scope: { constraints: [{ key: 'account', value: 'acct-1' }] },
    grain: { dimensions: ['day'] },
    time: {
      validTime: { from: '2026-08-01T00:00:00.000Z', to: '2026-08-02T00:00:00.000Z' },
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
      decisionFitness: 'not_assessed',
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

test('a future-dated envelope revocation is pending, not revoked, before its own effectiveAt', () => {
  const kernel = ledger();
  kernel.appendEvidence(evidence(evidenceInput('evidence:future:1', FUTURE_DATED)));

  // Known (the node is available: recordedAt 2026-08-02) but not yet
  // effective (effectiveAt 2026-08-05): must NOT read as currently revoked.
  const before = kernel.revocationProjectionAsOf('2026-08-03T00:00:00.000Z');
  assert.deepEqual(before.revokedIds, []);
  assert.deepEqual(before.pendingIds, ['evidence:future:1']);
});

test('the same envelope reads as revoked once its own effectiveAt has passed', () => {
  const kernel = ledger();
  kernel.appendEvidence(evidence(evidenceInput('evidence:future:1', FUTURE_DATED)));

  const after = kernel.revocationProjectionAsOf('2026-08-06T00:00:00.000Z');
  assert.deepEqual(after.revokedIds, ['evidence:future:1']);
  assert.deepEqual(after.pendingIds, []);
});

test('a claim resting on pending-only evidence is not yet revoked, but is pending too', () => {
  const kernel = ledger();
  kernel.appendEvidence(evidence(evidenceInput('evidence:future:1', FUTURE_DATED)));
  kernel.appendClaim(claim(claimInput('claim:downstream:1', ['evidence:future:1'], null)));

  const before = kernel.revocationProjectionAsOf('2026-08-03T00:00:00.000Z');
  assert.deepEqual(before.revokedIds, []);
  assert.deepEqual(before.pendingIds, ['claim:downstream:1', 'evidence:future:1']);
});

test('a node already revoked NOW is never demoted to pending by an unrelated future revocation', () => {
  // GUARD-RAIL. A node revoked by an already-effective event stays in
  // revokedIds even while a separate future-dated revocation elsewhere is
  // merely pending.
  const kernel = ledger();
  kernel.appendEvidence(evidence(evidenceInput('evidence:now:1', {
    eventId: 'revocation:provider:now:1',
    effectiveAt: '2026-08-02T12:00:00.000Z',
    reason: 'the provider withdrew this statement immediately',
  })));
  kernel.appendEvidence(evidence(evidenceInput('evidence:future:1', FUTURE_DATED)));

  const projection = kernel.revocationProjectionAsOf('2026-08-03T00:00:00.000Z');
  assert.deepEqual(projection.revokedIds, ['evidence:now:1']);
  assert.deepEqual(projection.pendingIds, ['evidence:future:1']);
});

test('appendRevocation-recorded events have no effective-time gap: recorded means effective', () => {
  // GUARD-RAIL. `appendRevocation` carries no `effectiveAt` field, so this
  // fix must not invent a pending state for operator-recorded events.
  const kernel = ledger();
  kernel.appendEvidence(evidence(evidenceInput('evidence:table:1', null)));
  kernel.appendRevocation({
    eventId: 'revocation:operator:1',
    targetId: 'evidence:table:1',
    recordedAt: '2026-08-06T00:00:00.000Z',
    reason: 'the operator withdrew this row after review',
  });

  const projection = kernel.revocationProjectionAsOf('2026-08-06T00:00:00.000Z');
  assert.deepEqual(projection.revokedIds, ['evidence:table:1']);
  assert.deepEqual(projection.pendingIds, []);
});

test('revocationProjection() (no asOf) treats effectiveAt against the current live boundary the same way', () => {
  // A live (non-as-of) read must use the same effective-time discipline as a
  // historical one; the envelope's own effectiveAt (2026-08-05) is already
  // long past relative to the environment's current date, so it reads as
  // revoked live.
  const kernel = ledger();
  kernel.appendEvidence(evidence(evidenceInput('evidence:future:1', FUTURE_DATED)));
  const projection = kernel.revocationProjection();
  assert.deepEqual(projection.revokedIds, ['evidence:future:1']);
  assert.deepEqual(projection.pendingIds, []);
});
