import { test } from 'node:test';
import assert from 'node:assert/strict';
import { economicAttributionView } from '../src/economics/attribution.ts';
import { money } from '../src/economics/money.ts';
import { evidence } from '../src/epistemic/evidence.ts';
import { GATE_LADDER, scoreFunnel, type Gate, type GateResult } from '../src/value/gates.ts';
import {
  buildCodingRealizationKernelIssuance,
  type CodingRealizationKernelInput,
} from '../src/value/epistemic.ts';
import { Store } from '../src/store/db.ts';

const ALL_PASS = Object.fromEntries(
  GATE_LADDER.map((gate) => [gate, { gate, verdict: 'pass', detail: 'fixture evidence' }]),
) as Record<Gate, GateResult>;

const ECONOMIC = economicAttributionView({
  amount: money('1.25', 'USD', 'effective'),
  eventIds: ['economic:request:value-kernel:charge'],
  sourceBases: ['list'],
  requestCount: 1,
  unresolvedRequests: 0,
});

const CLEAN_COMPLETENESS = {
  qualified: true,
  requiredEventTypes: ['commit_reverted', 'linked_incident'],
  qualifyingWitnessIds: ['complete-incident-source', 'complete-revert-scan'],
  witnesses: [
    {
      id: 'complete-incident-source',
      sourceId: 'incident-feed',
      state: 'supported',
      eventTypes: ['linked_incident'],
      scope: { project: 'fiscus' },
      period: { from: '1970-01-01T00:00:00.000Z', to: '1970-01-02T00:00:00.000Z' },
    },
    {
      id: 'complete-revert-scan',
      sourceId: 'git-history',
      state: 'supported',
      eventTypes: ['commit_reverted'],
      scope: { project: 'fiscus' },
      period: { from: '1970-01-01T00:00:00.000Z', to: '1970-01-02T00:00:00.000Z' },
    },
  ],
} as const;

function input(overrides: Partial<CodingRealizationKernelInput> = {}): CodingRealizationKernelInput {
  const unit = {
    hash: 'a'.repeat(40),
    subject: 'feat: value kernel',
    tsEpochMs: 2_000,
    linesAdded: 12,
    linesDeleted: 2,
    filesChanged: 1,
    windowStartMs: 500,
    windowEndMs: 2_000,
    taskType: 'feature',
    acceptance: 0.9,
    maturing: false,
    costStale: false,
    reverted: false,
    survivalRatio: 1,
    funnel: scoreFunnel(ALL_PASS),
    cleanCompleteness: CLEAN_COMPLETENESS,
    economic: ECONOMIC,
  };
  return {
    commitHash: unit.hash,
    project: 'fiscus',
    tsEpochMs: unit.tsEpochMs,
    computedAtMs: 3_000,
    attributedCostUsd: 1.25,
    maturing: false,
    realized: true,
    unitJson: JSON.stringify(unit),
    costScope: 'project',
    ...overrides,
  };
}

test('coding realization kernel issuance emits a narrow exact lifecycle Claim', () => {
  const issuance = buildCodingRealizationKernelIssuance(input());
  assert.match(issuance.evidence.id, /^evidence:value:realization:sha256:[0-9a-f]{64}$/);
  assert.match(issuance.claim.id, /^claim:value:realization:sha256:[0-9a-f]{64}$/);
  assert.equal(issuance.evidence.evidenceType, 'value.realization');
  assert.equal(issuance.evidence.completeness.status, 'complete');
  assert.equal(issuance.evidence.monetaryBasis, 'effective');
  assert.equal(issuance.claim.proposition.predicate, 'value.realization_recorded');
  assert.equal(issuance.claim.profile.coverage, 'complete');
  assert.equal(issuance.claim.profile.monetaryBasis, 'effective');
  assert.equal(issuance.claim.profile.causality, 'none');
  assert.equal(issuance.claim.profile.finality, 'provisional');
  const value = issuance.claim.proposition.value as {
    realized: boolean;
    economic: { amountText: string; complete: boolean };
    gates: Array<{ gate: Gate; verdict: string }>;
  };
  assert.equal(value.realized, true);
  assert.equal(value.economic.amountText, '1.25');
  assert.equal(value.economic.complete, true);
  assert.equal((issuance.evidence.completeness.coveredEventTypes as string[]).includes('proposal_capture'), true);
  assert.equal((value as { spendAttributionScope?: string }).spendAttributionScope, 'project');
  assert.equal(value.gates.length, GATE_LADDER.length);
  assert.ok(value.gates.every((gate) => gate.verdict === 'pass'));
  assert.match(issuance.claim.assumptions.join(' '), /not a causal|business-value/i);
});

test('coding realization kernel refuses unresolved or contradictory lifecycle inputs', () => {
  const base = JSON.parse(input().unitJson) as Record<string, unknown>;
  const partialEconomic = economicAttributionView({
    amount: money('1.25', 'USD', 'effective'),
    eventIds: ['economic:request:value-kernel:charge'],
    sourceBases: ['list'],
    requestCount: 2,
    unresolvedRequests: 1,
  });
  assert.throws(
    () => buildCodingRealizationKernelIssuance(input({ unitJson: JSON.stringify({ ...base, economic: partialEconomic }) })),
    /complete exact economic coverage/,
  );
  const unknown = { ...ALL_PASS, shipped: { gate: 'shipped' as const, verdict: 'unknown' as const, detail: 'not observed' } };
  assert.throws(
    () => buildCodingRealizationKernelIssuance(input({ unitJson: JSON.stringify({ ...base, funnel: scoreFunnel(unknown) }) })),
    /every legacy realization gate must be pass/,
  );
  assert.throws(() => buildCodingRealizationKernelIssuance(input({ maturing: true })), /mature/);
  assert.throws(() => buildCodingRealizationKernelIssuance(input({ commitHash: 'b'.repeat(40) })), /hash does not match/);
  const stale = { ...base, costStale: true };
  assert.throws(() => buildCodingRealizationKernelIssuance(input({ unitJson: JSON.stringify(stale) })), /current mature/);
  const withoutCompleteness = { ...base };
  delete withoutCompleteness.cleanCompleteness;
  assert.throws(
    () => buildCodingRealizationKernelIssuance(input({ unitJson: JSON.stringify(withoutCompleteness) })),
    /qualifying completeness witnesses/,
  );
  const forgedCompleteness = {
    ...base,
    cleanCompleteness: { ...CLEAN_COMPLETENESS, qualifyingWitnessIds: [] },
  };
  assert.throws(
    () => buildCodingRealizationKernelIssuance(input({ unitJson: JSON.stringify(forgedCompleteness) })),
    /witness identity is inconsistent/,
  );
});

test('Store canonical realization persistence issues the value Claim once and replays idempotently', () => {
  const store = new Store(':memory:');
  try {
    const record = input();
    store.insertRequest({
      requestId: 'value-kernel', sessionId: null, tsEpochMs: 1_000, provider: 'anthropic', model: 'claude-opus-4-8',
      project: 'fiscus', taskWeight: 1, inputTokens: 10, outputTokens: 10, cacheWriteTokens: 0, cacheReadTokens: 0,
      reasoningTokens: 0, costUsd: 1.25, economicAmount: money('1.25', 'USD', 'list'), estimated: false, streamed: false,
      statusCode: 200, durationMs: 1, via: 'import',
    });
    store.saveRealizationUnits([record]);
    const issuance = buildCodingRealizationKernelIssuance(record);
    assert.ok(store.epistemic().readEvidence(issuance.evidence.id));
    assert.ok(store.epistemic().readClaim(issuance.claim.id));
    const replay = store.issueRealizationUnitToKernel(record);
    assert.equal(replay.evidence.result, 'duplicate');
    assert.equal(replay.claim.result, 'duplicate');
  } finally {
    store.close();
  }
});

test('Store re-derives exact attribution from its ledger and refuses fabricated lineage', () => {
  const store = new Store(':memory:');
  try {
    const record = input();
    store.insertRequest({
      requestId: 'value-kernel-real', sessionId: null, tsEpochMs: 1_000, provider: 'anthropic', model: 'claude-opus-4-8',
      project: 'fiscus', taskWeight: 1, inputTokens: 10, outputTokens: 10, cacheWriteTokens: 0, cacheReadTokens: 0,
      reasoningTokens: 0, costUsd: 1.25, economicAmount: money('1.25', 'USD', 'list'), estimated: false, streamed: false,
      statusCode: 200, durationMs: 1, via: 'import',
    });
    const unit = JSON.parse(record.unitJson) as Record<string, unknown>;
    const forgedEconomic = economicAttributionView({
      amount: money('1.25', 'USD', 'effective'), eventIds: ['economic:unrelated'], sourceBases: ['list'], requestCount: 1, unresolvedRequests: 0,
    });
    const forged = { ...record, unitJson: JSON.stringify({ ...unit, economic: forgedEconomic }) };
    assert.throws(() => store.saveRealizationUnits([forged]), /does not match the current effective ledger/);
    assert.equal((store.raw().prepare('SELECT COUNT(*) AS count FROM realization_units').get() as { count: number }).count, 0);
    assert.equal((store.raw().prepare('SELECT COUNT(*) AS count FROM epistemic_claims').get() as { count: number }).count, 0);
  } finally {
    store.close();
  }
});

test('realization snapshot and kernel pair roll back together on an append conflict', () => {
  const store = new Store(':memory:');
  try {
    const record = input();
    store.insertRequest({
      requestId: 'value-kernel', sessionId: null, tsEpochMs: 1_000, provider: 'anthropic', model: 'claude-opus-4-8',
      project: 'fiscus', taskWeight: 1, inputTokens: 10, outputTokens: 10, cacheWriteTokens: 0, cacheReadTokens: 0,
      reasoningTokens: 0, costUsd: 1.25, economicAmount: money('1.25', 'USD', 'list'), estimated: false, streamed: false,
      statusCode: 200, durationMs: 1, via: 'import',
    });
    const issuance = buildCodingRealizationKernelIssuance(record);
    const divergentEvidence = evidence({
      ...issuance.evidence,
      payload: { ...(issuance.evidence.payload as Record<string, unknown>), subject: 'tampered-before-save' },
    } as never);
    store.epistemic().appendEvidence(divergentEvidence);
    assert.throws(() => store.saveRealizationUnits([record]), /different evidence already exists/);
    assert.equal((store.raw().prepare('SELECT COUNT(*) AS count FROM realization_units').get() as { count: number }).count, 0);
    assert.equal(store.epistemic().readClaim(issuance.claim.id), null);
    assert.equal(store.epistemic().readEvidence(issuance.evidence.id)!.payload && (store.epistemic().readEvidence(issuance.evidence.id)!.payload as Record<string, unknown>).subject, 'tampered-before-save');
  } finally {
    store.close();
  }
});

test('direct value-kernel issuance requires an already persisted, non-stale snapshot', () => {
  const store = new Store(':memory:');
  try {
    const record = input();
    store.insertRequest({
      requestId: 'value-kernel', sessionId: null, tsEpochMs: 1_000, provider: 'anthropic', model: 'claude-opus-4-8',
      project: 'fiscus', taskWeight: 1, inputTokens: 10, outputTokens: 10, cacheWriteTokens: 0, cacheReadTokens: 0,
      reasoningTokens: 0, costUsd: 1.25, economicAmount: money('1.25', 'USD', 'list'), estimated: false, streamed: false,
      statusCode: 200, durationMs: 1, via: 'import',
    });
    assert.throws(() => store.issueRealizationUnitToKernel(record), /not persisted/);
  } finally {
    store.close();
  }
});

test('Store leaves partial and legacy realization snapshots outside the value kernel', () => {
  const store = new Store(':memory:');
  try {
    const partial = economicAttributionView({
      amount: money('1', 'USD', 'effective'), eventIds: ['economic:value:partial'], sourceBases: ['list'], requestCount: 2, unresolvedRequests: 1,
    });
    const base = JSON.parse(input().unitJson) as Record<string, unknown>;
    store.saveRealizationUnits([
      { ...input(), commitHash: 'b'.repeat(40), unitJson: JSON.stringify({ ...base, hash: 'b'.repeat(40), economic: partial }) },
      { ...input(), commitHash: 'c'.repeat(40), unitJson: '{}', realized: true },
    ]);
    assert.equal(store.epistemic().readClaim('claim:value:realization:sha256:' + '0'.repeat(64)), null);
    const count = (store.raw().prepare(
      `SELECT COUNT(*) AS count FROM epistemic_claims WHERE claim_json LIKE '%value.realization_recorded%'`,
    ).get() as { count: number }).count;
    assert.equal(count, 0);
  } finally {
    store.close();
  }
});
