import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyExactAllocation, type ExactAllocatableRow } from '../src/alloc/exact.ts';
import { type AllocationRule, type CostCentre } from '../src/alloc/rules.ts';
import { economicEvent } from '../src/economics/events.ts';
import { priceCorrectionEvent } from '../src/economics/corrections.ts';
import { money } from '../src/economics/money.ts';
import { Store } from '../src/store/db.ts';

const CENTRE: CostCentre = { costCentreId: 'eng', name: 'Engineering', owner: null, createdAtMs: 0, archivedAtMs: null };
const RULE: AllocationRule = {
  ruleId: 'api', version: 1, method: 'direct', match: { project: 'api' }, targets: [{ costCentreId: 'eng', ratio: 1 },], priority: 1,
  effectiveFromMs: 0, effectiveToMs: null, revokedAtMs: null, owner: null, note: null, createdAtMs: 0,
};

function closeAllocationPeriod(store: Store): void {
  store.finalizeEconomicPeriod({ periodStartMs: 0, periodEndMs: 100, recordedAt: '1970-01-01T00:00:00.200Z' });
}

test('exact allocation persistence issues an idempotent allocated showback Claim', () => {
  const store = new Store(':memory:');
  try {
    const sourceId = 'economic:allocation-kernel:source';
    store.economic().append(economicEvent({
      id: sourceId,
      kind: 'charge_estimated',
      subject: 'request:allocation-kernel',
      occurredAt: '1970-01-01T00:00:00.010Z',
      recordedAt: '1970-01-01T00:00:00.020Z',
      amount: money('1.25', 'USD', 'list'),
      sourceEventIds: [],
      reversalOf: null,
      metadata: null,
      schemaVersion: 1,
    }));
    const rows: ExactAllocatableRow[] = [{
      sourceEventIds: [sourceId], amount: money('1.25', 'USD', 'list'), project: 'api', provider: 'anthropic', model: 'claude-opus-4-8', source: null, user: null, tsEpochMs: 10,
    }];
    const result = applyExactAllocation({ rows, rules: [RULE], costCentres: [CENTRE], periodStartMs: 0, periodEndMs: 100, runAtMs: 100 });
    closeAllocationPeriod(store);
    const runId = store.saveExactAllocationRun(result, 200);
    const claimId = `claim:economic:allocation:${runId}`;
    const evidenceId = `evidence:economic:allocation:${runId}`;
    const claim = store.epistemic().readClaim(claimId)!;
    const evidence = store.epistemic().readEvidence(evidenceId)!;
    assert.equal(claim.proposition.predicate, 'economic.allocation_recorded');
    assert.equal(claim.profile.monetaryBasis, 'allocated');
    assert.equal(claim.profile.coverage, 'complete');
    assert.equal(evidence.completeness.status, 'complete');
    assert.equal((claim.proposition.value as { allocationRunId: string }).allocationRunId, runId);
    assert.equal((claim.proposition.value as { result: { lines: Array<{ amount: { coefficient: string } }> } }).result.lines[0]!.amount.coefficient, '125');

    const replay = store.issueExactAllocationToKernel(store.exactAllocationRun(runId)!);
    assert.equal(replay.evidence.result, 'duplicate');
    assert.equal(replay.claim.result, 'duplicate');
  } finally {
    store.close();
  }
});

test('incomplete exact allocation remains a partial kernel claim, not an exact complete claim', () => {
  const store = new Store(':memory:');
  try {
    const sourceId = 'economic:allocation-kernel:partial';
    store.economic().append(economicEvent({
      id: sourceId,
      kind: 'charge_estimated',
      subject: 'request:allocation-kernel-partial',
      occurredAt: '1970-01-01T00:00:00.010Z',
      recordedAt: '1970-01-01T00:00:00.020Z',
      amount: money('2', 'USD', 'list'),
      sourceEventIds: [],
      reversalOf: null,
      metadata: null,
      schemaVersion: 1,
    }));
    const result = applyExactAllocation({
      rows: [{ sourceEventIds: [sourceId], amount: money('2', 'USD', 'list'), project: 'other', provider: 'anthropic', model: 'claude-opus-4-8', source: null, user: null, tsEpochMs: 10 }],
      rules: [], costCentres: [], periodStartMs: 0, periodEndMs: 100, runAtMs: 100,
    });
    closeAllocationPeriod(store);
    const runId = store.saveExactAllocationRun({ ...result, complete: false, unresolvedRequestIds: ['legacy-request'] }, 200);
    const claim = store.epistemic().readClaim(`claim:economic:allocation:${runId}`)!;
    assert.equal(claim.profile.coverage, 'partial');
    assert.equal((claim.proposition.value as { result: { unresolvedRequestIds: string[] } }).result.unresolvedRequestIds[0], 'legacy-request');
  } finally {
    store.close();
  }
});

test('exact allocation persistence refuses a result whose source charge total does not match its declared total', () => {
  const store = new Store(':memory:');
  try {
    const sourceId = 'economic:allocation-kernel:mismatch';
    store.economic().append(economicEvent({
      id: sourceId,
      kind: 'charge_estimated',
      subject: 'request:allocation-kernel-mismatch',
      occurredAt: '1970-01-01T00:00:00.010Z',
      recordedAt: '1970-01-01T00:00:00.020Z',
      amount: money('1.25', 'USD', 'list'),
      sourceEventIds: [],
      reversalOf: null,
      metadata: null,
      schemaVersion: 1,
    }));
    const result = applyExactAllocation({
      rows: [{ sourceEventIds: [sourceId], amount: money('1.50', 'USD', 'list'), project: 'api', provider: 'anthropic', model: 'claude-opus-4-8', source: null, user: null, tsEpochMs: 10 }],
      rules: [RULE], costCentres: [CENTRE], periodStartMs: 0, periodEndMs: 100, runAtMs: 100,
    });

    closeAllocationPeriod(store);
    assert.throws(
      () => store.saveExactAllocationRun(result, 200),
      /allocation.*source|source.*allocation|charge.*match|lineage/i,
    );
    assert.equal(store.exactAllocationRuns().length, 0, 'a mismatched allocation must not leave a persisted result');
  } finally {
    store.close();
  }
});

test('exact allocation persistence refuses a non-charge source role', () => {
  const store = new Store(':memory:');
  try {
    const sourceId = 'economic:allocation-kernel:non-charge';
    store.economic().append(economicEvent({
      id: sourceId,
      kind: 'usage_observed',
      subject: 'request:allocation-kernel-non-charge',
      occurredAt: '1970-01-01T00:00:00.010Z',
      recordedAt: '1970-01-01T00:00:00.020Z',
      amount: null,
      sourceEventIds: [],
      reversalOf: null,
      metadata: null,
      schemaVersion: 1,
    }));
    const result = applyExactAllocation({
      rows: [{ sourceEventIds: [sourceId], amount: money('1.25', 'USD', 'list'), project: 'api', provider: 'anthropic', model: 'claude-opus-4-8', source: null, user: null, tsEpochMs: 10 }],
      rules: [RULE], costCentres: [CENTRE], periodStartMs: 0, periodEndMs: 100, runAtMs: 100,
    });

    closeAllocationPeriod(store);
    assert.throws(
      () => store.saveExactAllocationRun(result, 200),
      /charge.*source|source.*charge|role/i,
    );
    assert.equal(store.exactAllocationRuns().length, 0);
  } finally {
    store.close();
  }
});

test('exact allocation accepts a source charge plus its validated local correction as one effective total', () => {
  const store = new Store(':memory:');
  try {
    const source = economicEvent({
      id: 'economic:allocation-kernel:corrected-source',
      kind: 'charge_estimated',
      subject: 'request:allocation-kernel-corrected',
      occurredAt: '1970-01-01T00:00:00.010Z',
      recordedAt: '1970-01-01T00:00:00.020Z',
      amount: money('1.25', 'USD', 'list'),
      sourceEventIds: [],
      reversalOf: null,
      metadata: null,
      schemaVersion: 1,
    });
    store.economic().append(source);
    const correction = priceCorrectionEvent({
      id: 'economic:allocation-kernel:correction',
      source,
      previousAmount: money('1.25', 'USD', 'list'),
      nextAmount: money('1.50', 'USD', 'list'),
      recordedAt: '1970-01-01T00:00:00.030Z',
    });
    store.economic().append(correction);
    const effective = store.economic().effectiveChargeFor(source.id)!;
    const result = applyExactAllocation({
      rows: [{ sourceEventIds: effective.eventIds, amount: effective.amount, project: 'api', provider: 'anthropic', model: 'claude-opus-4-8', source: null, user: null, tsEpochMs: 10 }],
      rules: [RULE], costCentres: [CENTRE], periodStartMs: 0, periodEndMs: 100, runAtMs: 100,
    });

    closeAllocationPeriod(store);
    const runId = store.saveExactAllocationRun(result, 200);
    assert.ok(store.exactAllocationRun(runId));
  } finally {
    store.close();
  }
});
