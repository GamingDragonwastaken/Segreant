import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { claim, type Claim } from '../src/epistemic/claim.ts';
import { evidence } from '../src/epistemic/evidence.ts';
import { EpistemicLedger } from '../src/epistemic/ledger.ts';
import { claimProfile } from '../src/epistemic/profile.ts';
import { grain } from '../src/epistemic/grain.ts';
import { scope } from '../src/epistemic/scope.ts';

const VALID_FROM = '2026-08-01T00:00:00.000Z';
const VALID_TO = '2026-08-02T00:00:00.000Z';
const ORIGINAL_ISSUED = '2026-08-02T00:00:01.000Z';
const REVISED_ISSUED = '2026-08-03T00:00:01.000Z';

function ledger(): { db: DatabaseSync; value: EpistemicLedger } {
  const db = new DatabaseSync(':memory:');
  return { db, value: new EpistemicLedger(db) };
}

function sourceEvidence() {
  return evidence({
    id: 'evidence:invoice',
    evidenceType: 'provider.invoice',
    sourceIdentity: 'provider:openai:account-1',
    sourceClass: 'provider_statement',
    payload: { amount: '12.34', currency: 'USD' },
    scope: scope({ account: 'acct-1' }),
    grain: grain(['day', 'project']),
    occurredAt: VALID_FROM,
    observedAt: '2026-08-02T00:00:00.000Z',
    integrity: 'verified',
    authenticity: 'provider_authenticated',
    completeness: { status: 'complete', method: 'provider_export' },
    monetaryBasis: 'billed',
    schemaVersion: 1,
    sensitivity: 'confidential',
    redaction: 'none',
  });
}

function claimVersion(
  id: string,
  amount: string,
  issuedAt: string,
  supersedes: readonly string[] = [],
  subject = 'project:api',
): Claim {
  return claim({
    id,
    proposition: { predicate: 'cost.reconciled', value: { amount } },
    subject,
    scope: scope({ account: 'acct-1' }),
    grain: grain(['day', 'project']),
    time: { validTime: { from: VALID_FROM, to: VALID_TO }, asOf: issuedAt },
    epistemic: 'supported',
    profile: claimProfile({
      epistemic: 'supported', integrity: 'verified', authenticity: 'provider_authenticated',
      scope: 'established', coverage: 'complete', measurement: 'proxy_unvalidated',
      causality: 'none', monetaryBasis: 'billed', finality: 'provisional', decisionFitness: 'not_assessed',
    }),
    measurementModelRef: null,
    evidenceIds: ['evidence:invoice'],
    derivationRule: 'billing.reconcile.v1',
    derivationVersion: 1,
    causalStatus: 'none',
    issuedAt,
    supersedes,
    schemaVersion: 1,
  });
}

function appendOriginal(value: EpistemicLedger): Claim {
  const e = sourceEvidence();
  assert.equal(value.appendEvidence(e), 'inserted');
  const original = claimVersion('claim:original', '12.34', ORIGINAL_ISSUED);
  assert.equal(value.appendClaim(original), 'inserted');
  return original;
}

test('claim revisions are explicit, linear, persisted, and latest selection is hindsight-safe', () => {
  const { db, value } = ledger();
  const original = appendOriginal(value);
  const revised = claimVersion('claim:revised', '13.01', REVISED_ISSUED, [original.id]);

  assert.equal(value.appendClaim(revised), 'inserted');
  assert.equal(value.appendClaim(revised), 'duplicate');
  assert.deepEqual(value.graph().edges.filter((edge) => edge.relation === 'supersedes'), [
    { from: revised.id, to: original.id, relation: 'supersedes' },
  ]);
  assert.deepEqual(value.latestClaims().map((item) => item.id), [revised.id]);
  assert.deepEqual(value.latestClaims(ORIGINAL_ISSUED).map((item) => item.id), [original.id]);
  assert.deepEqual(value.latestClaims('2026-08-03T00:00:01.000Z').map((item) => item.id), [revised.id]);
  db.close();
});

test('claim supersession refuses missing or non-claim targets, coordinate changes, early revisions, and branches', () => {
  const { db, value } = ledger();
  const original = appendOriginal(value);

  const missing = claimVersion('claim:missing-target', '13.01', REVISED_ISSUED, ['claim:missing']);
  assert.throws(() => value.appendClaim(missing), /unknown superseded|supersession target/i);
  assert.equal(value.readClaim(missing.id), null);

  const nonClaim = claimVersion('claim:evidence-target', '13.01', REVISED_ISSUED, ['evidence:invoice']);
  assert.throws(() => value.appendClaim(nonClaim), /claim.*target|supersession.*claim/i);

  const changedCoordinate = claimVersion('claim:changed-coordinate', '13.01', REVISED_ISSUED, [original.id], 'project:other');
  assert.throws(() => value.appendClaim(changedCoordinate), /coordinate|same.*claim|supersession/i);

  const early = claimVersion('claim:early', '13.01', ORIGINAL_ISSUED, [original.id]);
  assert.throws(() => value.appendClaim(early), /later|issued|supersession/i);

  const successor = claimVersion('claim:successor', '13.01', REVISED_ISSUED, [original.id]);
  assert.equal(value.appendClaim(successor), 'inserted');
  const branch = claimVersion('claim:branch', '13.02', '2026-08-04T00:00:01.000Z', [original.id]);
  assert.throws(() => value.appendClaim(branch), /already.*superseded|successor|branch/i);
  assert.deepEqual(value.latestClaims().map((item) => item.id), [successor.id]);
  db.close();
});
