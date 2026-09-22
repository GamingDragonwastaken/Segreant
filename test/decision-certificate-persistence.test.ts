import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { certifyDecision } from '../src/decision/engine.ts';
import {
  buildDecisionKernelIssuance,
  issueDecisionToKernel,
  readDecisionCertificateBundle,
  type DecisionKernelIssuanceInput,
} from '../src/decision/epistemic.ts';
import { EpistemicLedger } from '../src/epistemic/ledger.ts';
import type { Evidence } from '../src/epistemic/evidence.ts';
import { grain } from '../src/epistemic/grain.ts';
import { scope } from '../src/epistemic/scope.ts';

const issuedAt = '2026-09-03T12:00:00.000Z';
const sourceId = 'evidence:decision:persistence-source';
const decisionId = 'decision:persistence-1';
const intervals = [
  { action: 'keep', low: 12, high: 18 },
  { action: 'route', low: 2, high: 10 },
] as const;

function sourceEvidence(): Evidence {
  const validTime = { from: '2026-09-01T00:00:00.000Z', to: '2026-09-03T00:00:00.000Z' };
  return {
    id: sourceId,
    evidenceType: 'decision.utility.input',
    sourceIdentity: 'test:decision-persistence',
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
    revocation: null,
    schemaVersion: 1,
    sensitivity: 'internal',
    redaction: 'none',
  };
}

function input(overrides: Partial<DecisionKernelIssuanceInput> = {}): DecisionKernelIssuanceInput {
  return {
    decisionId,
    decisionProblem: { id: 'problem:budget-control', version: 3 },
    certificate: certifyDecision(intervals),
    intervals,
    evidence: [{ id: sourceId, record: sourceEvidence() }],
    issuedAt,
    validity: {
      expiresAt: '2026-09-10T00:00:00.000Z',
      revalidateAfter: '2026-09-08T00:00:00.000Z',
      conditions: ['Required evidence remains available and unrevoked.'],
    },
    ...overrides,
  };
}

function openLedger(): EpistemicLedger {
  return new EpistemicLedger(new DatabaseSync(':memory:'));
}

test('decision preview is side-effect free and commit persists one explicit certificate bundle', () => {
  const ledger = openLedger();
  const preview = buildDecisionKernelIssuance(input());
  assert.equal(ledger.readEvidence(preview.certificateBundle.id), null);

  const committed = issueDecisionToKernel(ledger, input());
  const read = readDecisionCertificateBundle(ledger, committed.certificateBundle.id, issuedAt);
  assert.ok(read);
  assert.deepEqual(read.bundle.decisionProblem, { id: 'problem:budget-control', version: 3 });
  assert.deepEqual(read.bundle.actionSet, intervals);
  assert.deepEqual(read.bundle.dominance, certifyDecision(intervals));
  assert.ok(read.bundle.dependencies.evidenceIds.includes(sourceId));
  assert.ok(read.bundle.dependencies.claimIds.includes(committed.observation.id));
  assert.equal(read.bundle.validity.issuedAt, issuedAt);
  assert.equal(read.bundle.validity.expiresAt, '2026-09-10T00:00:00.000Z');
  assert.equal(read.bundle.validity.revalidateAfter, '2026-09-08T00:00:00.000Z');
  assert.equal(read.bundle.actionSemantics.mode, 'no_action');
  assert.equal(read.bundle.actionSemantics.permitted, false);
  assert.equal(read.canAutoAct, false);
  assert.equal(read.status, 'valid');
});

test('revoking required evidence invalidates the certificate on read without deleting it', () => {
  const ledger = openLedger();
  const committed = issueDecisionToKernel(ledger, input());
  ledger.appendRevocation({
    eventId: 'revoke:decision:persistence-source',
    targetId: sourceId,
    recordedAt: '2026-09-04T00:00:00.000Z',
    reason: 'source withdrawn',
  });

  const read = readDecisionCertificateBundle(ledger, committed.certificateBundle.id, '2026-09-05T00:00:00.000Z');
  assert.ok(read);
  assert.equal(read.status, 'invalidated');
  assert.ok(read.invalidatedBy.includes(sourceId));
  assert.equal(ledger.readEvidence(committed.certificateBundle.id)?.id, committed.certificateBundle.id);
  assert.equal(read.canAutoAct, false);
});

test('undetermined dominance remains a persisted no-action certificate', () => {
  const ledger = openLedger();
  const undeterminedIntervals = [
    { action: 'keep', low: 1, high: 9 },
    { action: 'route', low: 4, high: 10 },
  ] as const;
  const committed = issueDecisionToKernel(ledger, input({
    certificate: certifyDecision(undeterminedIntervals),
    intervals: undeterminedIntervals,
  }));

  const read = readDecisionCertificateBundle(ledger, committed.certificateBundle.id, issuedAt);
  assert.ok(read);
  assert.equal(read.bundle.dominance.status, 'undetermined');
  assert.equal(read.bundle.dominance.action, null);
  assert.equal(read.bundle.actionSemantics.mode, 'no_action');
  assert.equal(ledger.readClaim(`claim:decision:fitness:${decisionId}`), null);
  assert.equal(read.canAutoAct, false);
});

test('certificate reads distinguish expiry and revalidation from evidence revocation', () => {
  const ledger = openLedger();
  const committed = issueDecisionToKernel(ledger, input());

  const revalidate = readDecisionCertificateBundle(ledger, committed.certificateBundle.id, '2026-09-08T00:00:00.000Z');
  assert.ok(revalidate);
  assert.equal(revalidate.status, 'revalidation_required');
  assert.deepEqual(revalidate.invalidatedBy, []);

  const expired = readDecisionCertificateBundle(ledger, committed.certificateBundle.id, '2026-09-10T00:00:00.000Z');
  assert.ok(expired);
  assert.equal(expired.status, 'expired');
  assert.equal(expired.canAutoAct, false);
});
