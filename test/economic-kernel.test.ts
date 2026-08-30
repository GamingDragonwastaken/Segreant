import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store/db.ts';
import { economicEvent } from '../src/economics/events.ts';
import { money } from '../src/economics/money.ts';

const START = Date.parse('2026-08-01T00:00:00.000Z');
const END = Date.parse('2026-08-02T00:00:00.000Z');

test('a finalized economic period issues one exact, replayable kernel Evidence/Claim', () => {
  const store = new Store(':memory:');
  try {
    store.economic().append(economicEvent({
      id: 'economic:kernel-close:charge',
      kind: 'charge_estimated',
      subject: 'request:kernel-close',
      occurredAt: '2026-08-01T12:00:00.000Z',
      recordedAt: '2026-08-02T01:00:00.000Z',
      amount: money('1.25', 'USD', 'list'),
      sourceEventIds: [],
      reversalOf: null,
      metadata: null,
      schemaVersion: 1,
    }));
    const finalized = store.finalizeEconomicPeriod({
      periodStartMs: START,
      periodEndMs: END,
      recordedAt: '2026-08-03T00:00:00.000Z',
    });

    const issued = store.issueEconomicPeriodCloseToKernel(finalized);
    assert.equal(issued.evidence.result, 'inserted');
    assert.equal(issued.claim.result, 'inserted');
    assert.match(issued.evidenceId, /^evidence:economic:period-close:/);
    assert.match(issued.claimId, /^claim:economic:period-close:/);

    const evidence = store.epistemic().readEvidence(issued.evidenceId)!;
    const claim = store.epistemic().readClaim(issued.claimId)!;
    assert.equal(evidence.evidenceType, 'economic.period_close');
    assert.equal(evidence.completeness.status, 'complete');
    assert.equal(evidence.monetaryBasis, 'list');
    assert.equal(claim.proposition.predicate, 'economic.period_closed');
    assert.equal(claim.profile.monetaryBasis, 'list');
    assert.equal(claim.profile.finality, 'provisional');
    assert.deepEqual(claim.proposition.value, {
      balances: [{
        amount: { basis: 'list', coefficient: '125', currency: 'USD', scale: 2 },
        basis: 'list',
        currency: 'USD',
        eventIds: ['economic:kernel-close:charge'],
        role: 'charge',
      }],
      eventCount: finalized.eventCount,
      finalizationId: finalized.eventId,
      periodEndMs: END,
      periodStartMs: START,
      projectionDigest: finalized.projectionDigest,
      sourceEventIds: finalized.sourceEventIds,
    });
    assert.doesNotThrow(() => JSON.stringify({ evidence, claim }));

    const replay = store.issueEconomicPeriodCloseToKernel(finalized);
    assert.equal(replay.evidence.result, 'duplicate');
    assert.equal(replay.claim.result, 'duplicate');
  } finally {
    store.close();
  }
});

test('close kernel issuance refuses a forged digest and a reopened finalization', () => {
  const store = new Store(':memory:');
  try {
    const finalized = store.finalizeEconomicPeriod({
      periodStartMs: START,
      periodEndMs: END,
      recordedAt: '2026-08-03T00:00:00.000Z',
    });
    assert.throws(
      () => store.issueEconomicPeriodCloseToKernel({ ...finalized, projectionDigest: '0'.repeat(64) }),
      /digest|snapshot|close/i,
    );
    store.issueEconomicPeriodCloseToKernel(finalized);
    store.reopenEconomicPeriod({
      periodStartMs: START,
      periodEndMs: END,
      recordedAt: '2026-08-04T00:00:00.000Z',
      reason: 'late evidence',
    });
    assert.throws(
      () => store.issueEconomicPeriodCloseToKernel(finalized),
      /active|finalized|reopen/i,
    );
  } finally {
    store.close();
  }
});
