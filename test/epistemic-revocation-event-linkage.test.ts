/**
 * A revocation envelope's `eventId` is not checked against the event table in
 * either direction (WP-R07).
 *
 * THE DEFECT. `Evidence` and `Claim` each carry an optional `revocation`
 * envelope — `{ eventId, effectiveAt, reason }` — and `appendRevocation` writes
 * rows to a separate `epistemic_revocations` table keyed by `event_id`
 * (`PRIMARY KEY` in `src/store/schema.ts`). Nothing connects the two `eventId`
 * namespaces:
 *
 *   - `appendEvidenceWithinTransaction`/`appendClaimWithinTransaction` accept
 *     any `revocation.eventId` string without checking whether that id is
 *     already recorded in `epistemic_revocations` against a DIFFERENT target.
 *   - `appendRevocation` checks that its `targetId` names a real node
 *     (`this.node(targetId) === null` throws), but never checks whether its
 *     `eventId` is already claimed by some OTHER node's own envelope.
 *
 * So the same `eventId` string can mean two contradictory things at once: one
 * node's envelope says "I was revoked by event E", and the ledger's own event
 * table separately and validly records that event E revoked a different node
 * entirely. Nothing catches the collision in either direction, even though
 * `event_id` is the ledger's own primary key for "one event."
 *
 * WHY THIS IS NOT THE DEADLOCK `envelopeRevocations()` ALREADY REFUSES TO FIX.
 * That comment (D-099, still in `ledger.ts`) rejects REQUIRING an envelope's
 * event to already exist, because `appendRevocation` refuses an unknown
 * target and an envelope can be present from a node's very first append. This
 * fix does not require existence: an envelope naming an eventId nobody has
 * recorded yet is still accepted, exactly as before. It only refuses the
 * narrower case where the SAME eventId is already on record — via the table
 * or via another node's envelope — naming a DIFFERENT target. That is a
 * consistency check on an id the ledger already treats as unique, not a new
 * ordering requirement.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { EpistemicLedger } from '../src/epistemic/ledger.ts';
import { evidence, type EvidenceInput } from '../src/epistemic/evidence.ts';

type Envelope = { eventId: string; effectiveAt: string; reason: string } | null;

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

function ledger(): EpistemicLedger {
  return new EpistemicLedger(new DatabaseSync(':memory:'));
}

test('an evidence envelope cannot claim an eventId the event table already assigns to a different node', () => {
  // Forward measurement of the counterexample: record a real event against A,
  // then append B whose OWN envelope claims the identical eventId. Before the
  // fix this silently succeeds, which is the concrete hole this closes.
  const kernel = ledger();
  kernel.appendEvidence(evidence(evidenceInput('evidence:a', null)));
  kernel.appendRevocation({
    eventId: 'evt-shared-1',
    targetId: 'evidence:a',
    recordedAt: '2026-08-06T00:00:00.000Z',
    reason: 'operator revoked A after review',
  });

  assert.throws(
    () => kernel.appendEvidence(evidence(evidenceInput('evidence:b', {
      eventId: 'evt-shared-1',
      effectiveAt: '2026-08-05T00:00:00.000Z',
      reason: 'the provider withdrew this statement',
    }))),
    /evt-shared-1/,
  );
});

test('appendRevocation cannot reuse an eventId a different node already claims via its own envelope', () => {
  // The reverse direction: the envelope is recorded first (from the node's own
  // creation), and a later, independent appendRevocation call tries to reuse
  // the same eventId against an unrelated node. Before the fix this silently
  // succeeds too.
  const kernel = ledger();
  kernel.appendEvidence(evidence(evidenceInput('evidence:a', {
    eventId: 'evt-shared-2',
    effectiveAt: '2026-08-05T00:00:00.000Z',
    reason: 'the provider withdrew this statement',
  })));
  kernel.appendEvidence(evidence(evidenceInput('evidence:b', null)));

  assert.throws(
    () => kernel.appendRevocation({
      eventId: 'evt-shared-2',
      targetId: 'evidence:b',
      recordedAt: '2026-08-06T00:00:00.000Z',
      reason: 'operator revoked B after review',
    }),
    /evt-shared-2/,
  );
});

test('the SAME eventId on the SAME node, via both the table and its own envelope, is consistent and admissible', () => {
  // THE GUARD-RAIL. A rule that refused every shared eventId, rather than only
  // a mismatched target, would refuse the ordinary case of an operator
  // recording the same fact a self-reporting envelope already declared.
  const kernel = ledger();
  kernel.appendEvidence(evidence(evidenceInput('evidence:a', {
    eventId: 'evt-consistent-1',
    effectiveAt: '2026-08-05T00:00:00.000Z',
    reason: 'the provider withdrew this statement',
  })));

  assert.equal(
    kernel.appendRevocation({
      eventId: 'evt-consistent-1',
      targetId: 'evidence:a',
      recordedAt: '2026-08-06T00:00:00.000Z',
      reason: 'operator confirmed the withdrawal',
    }),
    'inserted',
  );
  assert.deepEqual(kernel.revocationProjection().revokedIds, ['evidence:a']);
});

test('an envelope naming an eventId nobody has recorded yet is still accepted, unchanged', () => {
  // Preserves the D-099 capability this fix must not delete: an envelope does
  // not need a matching appendRevocation row to be honoured.
  const kernel = ledger();
  assert.equal(
    kernel.appendEvidence(evidence(evidenceInput('evidence:orphan', {
      eventId: 'evt-nobody-recorded',
      effectiveAt: '2026-08-05T00:00:00.000Z',
      reason: 'the provider withdrew this statement',
    }))),
    'inserted',
  );
  assert.deepEqual(kernel.revocationProjection().revokedIds, ['evidence:orphan']);
});
