/**
 * `pendingIds` was computed and read by nobody, so closing one hole opened a
 * quieter one.
 *
 * WHAT CHANGED UPSTREAM. `RevocationProjection` used to have no effective-time
 * dimension: a revocation envelope declaring `effectiveAt: 2026-09-09` made its
 * node read as fully revoked from the instant the node became known. That was
 * wrong, and WP-R07 fixed it by splitting known-but-not-yet-effective nodes into
 * a new `pendingIds` set.
 *
 * WHAT THAT COST, MEASURED. `readDecisionCertificateBundle` is one of only two
 * places in `src/` that consume a revocation projection, and it reads
 * `projection.revokedIds` alone. So the fix moved a decision certificate whose
 * required evidence carries a scheduled withdrawal from
 *
 *   status: 'invalidated', invalidatedBy: ['evidence:...source']
 *
 * to
 *
 *   status: 'valid', invalidatedBy: []
 *
 * — with the scheduled withdrawal appearing in the read NOWHERE. The old
 * reading was wrong about WHEN; the new one is silent about WHETHER, and a
 * reader cannot tell a certificate with no withdrawal on record from one with a
 * withdrawal already booked. That is the absence-of-a-result-reported-as-a-
 * result class this repository has now found nine times, arriving by way of a
 * mechanism built and left unwired.
 *
 * THE REPAIR IS DISCLOSURE, NOT RE-BREAKING. `status` stays `valid`, because at
 * the instant asked it IS valid and pretending otherwise would restore the
 * error just fixed. What is added is `pendingInvalidationBy`, alongside
 * `invalidatedBy` and in the same object, so the limit arrives in the same place
 * as the result rather than in a document nobody reads.
 *
 * WHY THE THREE KERNEL CLAIM READERS ARE NOT TOUCHED. `Store.billingKernelClaims`
 * and its two siblings are the other consumer, and `pendingIds` is unreachable
 * from them: every node they serve is issued by Fiscus's own issuance path,
 * which never attaches a revocation envelope, and an operator revocation goes
 * through `appendRevocation`, which has no `effectiveAt` and is effective when
 * recorded. The last test here pins that, so the omission rests on a measured
 * fact rather than on my say-so. Adding a permanently-empty field there would
 * repeat the unwired-mechanism defect in a new place.
 *
 * Recorded at D-161.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { certifyDecision } from '../src/decision/engine.ts';
import {
  issueDecisionToKernel,
  readDecisionCertificateBundle,
  type DecisionKernelIssuanceInput,
} from '../src/decision/epistemic.ts';
import { EpistemicLedger } from '../src/epistemic/ledger.ts';
import type { Evidence } from '../src/epistemic/evidence.ts';
import { grain } from '../src/epistemic/grain.ts';
import { scope } from '../src/epistemic/scope.ts';

const issuedAt = '2026-09-03T12:00:00.000Z';
const sourceId = 'evidence:decision:pending-source';
const decisionId = 'decision:pending-1';
const intervals = [
  { action: 'keep', low: 12, high: 18 },
  { action: 'route', low: 2, high: 10 },
] as const;

/** Booked for 2026-09-09: after every read below except the last. */
const SCHEDULED_WITHDRAWAL = {
  eventId: 'revoke:decision:pending-source',
  effectiveAt: '2026-09-09T00:00:00.000Z',
  reason: 'the source is withdrawn at the end of the retention window',
};

function sourceEvidence(revocation: Evidence['revocation']): Evidence {
  const validTime = { from: '2026-09-01T00:00:00.000Z', to: '2026-09-03T00:00:00.000Z' };
  return {
    id: sourceId,
    evidenceType: 'decision.utility.input',
    sourceIdentity: 'test:decision-pending',
    sourceClass: 'test',
    payload: { sourceId },
    scope: scope({ ledger: 'test', decision: decisionId }),
    grain: grain(['decision']),
    occurredAt: validTime.from,
    validTime,
    observedAt: issuedAt,
    recordedAt: issuedAt,
    assertedAt: issuedAt,
    finalizedAt: null,
    integrity: 'verified',
    authenticity: 'self_asserted',
    completeness: {
      status: 'complete',
      method: 'test',
      coveredEventTypes: [],
      coveredScope: null,
      coveredTime: null,
    },
    measurementModelRef: null,
    monetaryBasis: null,
    assumptions: [],
    supersedes: [],
    supersededBy: null,
    revocation,
    schemaVersion: 1,
    sensitivity: 'internal',
    redaction: 'none',
  };
}

function input(revocation: Evidence['revocation']): DecisionKernelIssuanceInput {
  return {
    decisionId,
    decisionProblem: { id: 'problem:budget-control', version: 3 },
    certificate: certifyDecision(intervals),
    intervals,
    evidence: [{ id: sourceId, record: sourceEvidence(revocation) }],
    issuedAt,
    validity: {
      expiresAt: '2026-09-10T00:00:00.000Z',
      revalidateAfter: '2026-09-08T00:00:00.000Z',
      conditions: ['Required evidence remains available and unrevoked.'],
    },
  };
}

function openLedger(): EpistemicLedger {
  return new EpistemicLedger(new DatabaseSync(':memory:'));
}

test('a certificate whose evidence has a booked withdrawal says so before it bites', () => {
  // THE COUNTEREXAMPLE. Read on 2026-09-05, four days before the withdrawal
  // takes effect. Before this, the read returned `status: 'valid'`,
  // `invalidatedBy: []` and carried the booked withdrawal nowhere at all.
  const ledger = openLedger();
  const committed = issueDecisionToKernel(ledger, input(SCHEDULED_WITHDRAWAL));

  const read = readDecisionCertificateBundle(ledger, committed.certificateBundle.id, '2026-09-05T00:00:00.000Z');
  assert.ok(read);
  assert.deepEqual(read.invalidatedBy, [], 'nothing is withdrawn yet, and claiming otherwise is the error WP-R07 fixed');
  assert.ok(
    read.pendingInvalidationBy.includes(sourceId),
    `a withdrawal already on record must be visible in the read that depends on it; got ${JSON.stringify([...read.pendingInvalidationBy])}`,
  );
  assert.equal(read.status, 'valid');
  assert.equal(read.canAutoAct, false);
});

test('the kernel knows, which is why the silence was the read boundary and not the projection', () => {
  // The premise, separated from the defect. The projection had the fact the
  // whole time; the certificate read simply did not ask for it.
  const ledger = openLedger();
  issueDecisionToKernel(ledger, input(SCHEDULED_WITHDRAWAL));

  const projection = ledger.revocationProjectionAsOf('2026-09-05T00:00:00.000Z');
  assert.deepEqual(projection.revokedIds, []);
  assert.ok(
    projection.pendingIds.includes(sourceId),
    `the projection should hold ${sourceId} as pending; got ${JSON.stringify([...projection.pendingIds])}`,
  );
});

test('a certificate with nothing booked against it reports an empty pending list', () => {
  // The half that a reader which always reported something pending would break.
  // An empty list here is an established absence, not an unexamined one.
  const ledger = openLedger();
  const committed = issueDecisionToKernel(ledger, input(null));

  const read = readDecisionCertificateBundle(ledger, committed.certificateBundle.id, '2026-09-05T00:00:00.000Z');
  assert.ok(read);
  assert.equal(read.status, 'valid');
  assert.deepEqual(read.invalidatedBy, []);
  assert.deepEqual(read.pendingInvalidationBy, []);
});

test('once the booked instant arrives the certificate is invalidated and nothing stays pending', () => {
  // Pending must be a waiting room, not a parking space. Read on the effective
  // instant itself: the withdrawal moves across, and the disclosure that
  // announced it stops repeating itself.
  const ledger = openLedger();
  const committed = issueDecisionToKernel(ledger, input(SCHEDULED_WITHDRAWAL));

  const read = readDecisionCertificateBundle(ledger, committed.certificateBundle.id, SCHEDULED_WITHDRAWAL.effectiveAt);
  assert.ok(read);
  assert.equal(read.status, 'invalidated');
  assert.ok(read.invalidatedBy.includes(sourceId));
  assert.deepEqual(read.pendingInvalidationBy, []);
});

test('what is pending is exactly what will be withdrawn, no wider and no narrower', () => {
  // CONTAINMENT, and the property that makes the disclosure worth reading. The
  // pending set is a closure over the same dependency edges the revoked set
  // uses, so the derived utility claim, fitness claim and fitness witness all
  // appear alongside the source evidence -- withdrawing the source withdraws
  // what rests on it. A pending list that named more than the withdrawal will
  // actually reach would be an alarm the evidence does not license; one that
  // named less would be the silence this file exists to close. So the two are
  // asserted against each other rather than against a list I typed out.
  const ledger = openLedger();
  const committed = issueDecisionToKernel(ledger, input(SCHEDULED_WITHDRAWAL));

  const before = readDecisionCertificateBundle(ledger, committed.certificateBundle.id, '2026-09-05T00:00:00.000Z');
  const after = readDecisionCertificateBundle(ledger, committed.certificateBundle.id, SCHEDULED_WITHDRAWAL.effectiveAt);
  assert.ok(before);
  assert.ok(after);

  assert.ok(before.pendingInvalidationBy.length > 1, 'the fixture must exercise the closure, not just the revoked node itself');
  assert.deepEqual(
    [...before.pendingInvalidationBy],
    [...after.invalidatedBy],
    'the pending list must predict the withdrawal exactly',
  );
});

test('an operator revocation is never pending, which is why the kernel claim readers are untouched', () => {
  // The measured basis for not adding a `pendingRevocation` field to
  // `KernelClaimView`. `appendRevocation` carries no `effectiveAt` — it is
  // effective when recorded — so nothing reachable from those three readers can
  // ever land in `pendingIds`. A field there would be permanently empty, which
  // is the unwired mechanism this file exists to stop repeating.
  const ledger = openLedger();
  issueDecisionToKernel(ledger, input(null));
  ledger.appendRevocation({
    eventId: 'revoke:operator:pending-source',
    targetId: sourceId,
    recordedAt: '2026-09-04T00:00:00.000Z',
    reason: 'the operator withdrew the source',
  });

  const projection = ledger.revocationProjectionAsOf('2026-09-05T00:00:00.000Z');
  assert.ok(projection.revokedIds.includes(sourceId));
  assert.deepEqual(projection.pendingIds, [], 'a table-recorded revocation is effective when recorded, never pending');
});
