import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store, type RequestRow } from '../src/store/db.ts';
import { buildEconomicReport } from '../src/cli/economicCmd.ts';
import { economicEvent } from '../src/economics/events.ts';
import { money } from '../src/economics/money.ts';

const CLI = join(import.meta.dirname, '..', 'src', 'cli.ts');

function runCli(args: string[], dbPath: string): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [CLI, ...args],
      { env: { ...process.env, FISCUS_DB: dbPath, NODE_OPTIONS: '' } },
      (err, stdout, stderr) => {
        const code = err && typeof (err as NodeJS.ErrnoException & { code?: unknown }).code === 'number'
          ? ((err as unknown as { code: number }).code)
          : err ? 1 : 0;
        resolve({ code, stdout: String(stdout), stderr: String(stderr) });
      },
    );
  });
}

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

test('economic report carries period-close state without collapsing the exact balances', () => {
  const store = new Store(':memory:');
  try {
    const startMs = Date.parse('2026-08-01T00:00:00.000Z');
    const endMs = Date.parse('2026-08-02T00:00:00.000Z');
    store.insertRequest(request());
    const closed = store.finalizeEconomicPeriod({
      periodStartMs: startMs,
      periodEndMs: endMs,
      recordedAt: '2026-08-03T00:00:00.000Z',
    });
    const report = buildEconomicReport(store, { startMs, endMs, demo: false });
    assert.equal(report.periodClose.status, 'finalized');
    assert.equal(report.periodClose.activeFinalizationId, closed.eventId);
    assert.equal(report.periodClose.projectionDigest, closed.projectionDigest);
    assert.equal(report.window.requestCoverage.amount, '1.25');
    assert.doesNotThrow(() => JSON.stringify(report));
  } finally {
    store.close();
  }
});

test('economic CLI exposes explicit period-close finalize, status, and reopen operations', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'fiscus-economic-close-cli-'));
  const db = join(dir, 'fiscus.db');
  const from = '2026-08-01T00:00:00.000Z';
  const to = '2026-08-02T00:00:00.000Z';
  try {
    const seed = new Store(db);
    seed.economic().append(economicEvent({
      id: 'economic:cli-close:charge',
      kind: 'charge_estimated',
      subject: 'request:economic-cli-close',
      occurredAt: '2026-08-01T01:00:00.000Z',
      recordedAt: '2026-08-02T01:00:00.000Z',
      amount: money('1.25', 'USD', 'list'),
      sourceEventIds: [],
      reversalOf: null,
      metadata: null,
      schemaVersion: 1,
    }));
    seed.close();

    const before = await runCli(['economic', '--close-status', '--from', from, '--to', to, '--json'], db);
    assert.equal(before.code, 0, before.stderr);
    const beforePayload = JSON.parse(before.stdout) as { kind: string; operation: string; result: { status: string; activeFinalizationId: string | null } };
    assert.equal(beforePayload.kind, 'period_close');
    assert.equal(beforePayload.operation, 'status');
    assert.equal(beforePayload.result.status, 'open');
    assert.equal(beforePayload.result.activeFinalizationId, null);

    const finalized = await runCli([
      'economic', '--finalize', '--from', from, '--to', to,
      '--recorded-at', '2026-08-03T00:00:00.000Z', '--json',
    ], db);
    assert.equal(finalized.code, 0, finalized.stderr);
    const finalizedPayload = JSON.parse(finalized.stdout) as {
      kind: string;
      operation: string;
      result: { status: string; eventId: string; projectionDigest: string; balances: Array<{ amount: { coefficient: string; scale: number; currency: string; basis: string } }> };
      kernel: { evidenceId: string; claimId: string; evidence: { result: string }; claim: { result: string } };
    };
    assert.equal(finalizedPayload.kind, 'period_close');
    assert.equal(finalizedPayload.operation, 'finalize');
    assert.equal(finalizedPayload.result.status, 'finalized');
    assert.match(finalizedPayload.result.eventId, /^economic:close:/);
    assert.match(finalizedPayload.result.projectionDigest, /^[a-f0-9]{64}$/);
    assert.equal(finalizedPayload.result.balances[0]?.amount.currency, 'USD');
    assert.equal(typeof finalizedPayload.result.balances[0]?.amount.coefficient, 'string');
    assert.match(finalizedPayload.kernel.evidenceId, /^evidence:economic:period-close:/);
    assert.match(finalizedPayload.kernel.claimId, /^claim:economic:period-close:/);
    assert.equal(finalizedPayload.kernel.evidence.result, 'inserted');
    assert.equal(finalizedPayload.kernel.claim.result, 'inserted');

    const reopened = await runCli([
      'economic', '--reopen', '--from', from, '--to', to,
      '--recorded-at', '2026-08-04T00:00:00.000Z', '--reason', 'late provider correction', '--json',
    ], db);
    assert.equal(reopened.code, 0, reopened.stderr);
    const reopenedPayload = JSON.parse(reopened.stdout) as { kind: string; operation: string; result: { status: string; reason: string; reopenedFinalizationId: string } };
    assert.equal(reopenedPayload.kind, 'period_close');
    assert.equal(reopenedPayload.operation, 'reopen');
    assert.equal(reopenedPayload.result.status, 'reopened');
    assert.equal(reopenedPayload.result.reason, 'late provider correction');
    assert.match(reopenedPayload.result.reopenedFinalizationId, /^economic:close:/);

    const after = await runCli(['economic', '--close-status', '--from', from, '--to', to, '--json'], db);
    assert.equal(after.code, 0, after.stderr);
    const afterPayload = JSON.parse(after.stdout) as { result: { status: string; activeFinalizationId: string | null; latestReopenId: string | null } };
    assert.equal(afterPayload.result.status, 'reopened');
    assert.equal(afterPayload.result.activeFinalizationId, null);
    assert.match(afterPayload.result.latestReopenId ?? '', /^economic:reopen:/);

    const missingReason = await runCli(['economic', '--reopen', '--from', from, '--to', to, '--json'], db);
    assert.equal(missingReason.code, 1);
    assert.match(missingReason.stderr, /--reason is required/i);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
