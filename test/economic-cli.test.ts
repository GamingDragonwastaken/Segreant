import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store, type RequestRow } from '../src/store/db.ts';
import { buildEconomicReport } from '../src/cli/economicCmd.ts';
import { money } from '../src/economics/money.ts';

function request(overrides: Partial<RequestRow> = {}): RequestRow {
  return {
    requestId: 'economic-cli-exact',
    sessionId: null,
    tsEpochMs: Date.parse('2026-08-01T00:00:00.000Z'),
    provider: 'anthropic',
    model: 'claude-opus-4-8',
    project: 'fiscus',
    taskWeight: 1,
    inputTokens: 1,
    outputTokens: 1,
    cacheWriteTokens: 0,
    cacheReadTokens: 0,
    reasoningTokens: 0,
    costUsd: 1.25,
    estimated: false,
    streamed: false,
    statusCode: 200,
    durationMs: 1,
    via: 'proxy',
    economicAmount: money('1.25', 'USD', 'list'),
    ...overrides,
  };
}

test('economic report is JSON-safe, exact, role-aware, and discloses legacy coverage', () => {
  const store = new Store(':memory:');
  try {
    store.insertRequest(request());
    store.insertRequest(request({ requestId: 'economic-cli-legacy', costUsd: 2, economicAmount: undefined }));
    const report = buildEconomicReport(store, {
      startMs: Date.parse('2026-07-31T00:00:00.000Z'),
      endMs: Date.parse('2026-08-02T00:00:00.000Z'),
      demo: false,
    });
    assert.equal(report.window.requestCoverage.requestCount, 2);
    assert.equal(report.window.requestCoverage.unresolvedRequests, 1);
    assert.equal(report.window.requestCoverage.complete, false);
    assert.equal(report.window.requestCoverage.amount, '1.25');
    assert.deepEqual(report.window.requestCoverage.sourceBases, ['list']);
    assert.equal(report.projection.balances[0]!.amount, '1.25');
    assert.equal(report.projection.balances[0]!.role, 'charge');
    assert.doesNotThrow(() => JSON.stringify(report));
  } finally {
    store.close();
  }
});
