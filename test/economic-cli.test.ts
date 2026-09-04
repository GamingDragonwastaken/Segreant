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
import { exactRate } from '../src/economics/rate.ts';
import { interval } from '../src/epistemic/time.ts';

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

test('economic report keeps source and translated coverage on one historical as-of boundary', () => {
  const store = new Store(':memory:');
  try {
    const startMs = Date.parse('2026-08-01T00:00:00.000Z');
    const endMs = Date.parse('2026-08-02T00:00:00.000Z');
    const asOf = '2026-12-31T00:00:00.000Z';
    store.economic().appendHistoricalRateObservation({
      id: 'fx-rate:economic-cli:original',
      rate: exactRate({
        numerator: 9n,
        denominator: 10n,
        sourceUnit: 'USD',
        targetUnit: 'EUR',
        validTime: interval('2026-01-01T00:00:00.000Z', '2027-01-01T00:00:00.000Z'),
      }),
      rateSource: 'fixture:economic-cli:historical',
      recordedAt: '2026-01-02T00:00:00.000Z',
      supersedes: null,
    });
    store.insertRequest(request());

    const report = buildEconomicReport(store, {
      startMs,
      endMs,
      demo: false,
      targetUnit: 'EUR',
      asOf,
    });

    assert.equal(report.window.requestCoverage.currency, 'USD');
    assert.equal(report.window.requestCoverage.amount, '1.25');
    assert.ok(report.translation);
    assert.equal(report.translation.currency, 'EUR');
    assert.equal(report.translation.amount, '1.125');
    assert.equal(report.translation.complete, true);
    assert.equal(report.translation.asOf, asOf);
    assert.deepEqual(report.translation.rateSources, ['fixture:economic-cli:historical']);
    assert.equal(report.projection.asOf, asOf);
    assert.equal(report.periodClose.asOf, asOf);
    assert.doesNotThrow(() => JSON.stringify(report));
  } finally {
    store.close();
  }
});

test('economic CLI emits historical translation coverage and provenance', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'fiscus-economic-report-cli-'));
  const db = join(dir, 'fiscus.db');
  const asOf = '2026-12-31T00:00:00.000Z';
  try {
    const seed = new Store(db);
    seed.economic().appendHistoricalRateObservation({
      id: 'fx-rate:economic-cli:command',
      rate: exactRate({
        numerator: 9n,
        denominator: 10n,
        sourceUnit: 'USD',
        targetUnit: 'EUR',
        validTime: interval('2026-01-01T00:00:00.000Z', '2027-01-01T00:00:00.000Z'),
      }),
      rateSource: 'fixture:economic-cli:command',
      recordedAt: '2026-01-02T00:00:00.000Z',
      supersedes: null,
    });
    seed.insertRequest(request());
    seed.close();

    const result = await runCli(['economic', '--all', '--target-currency', 'EUR', '--as-of', asOf, '--json'], db);
    assert.equal(result.code, 0, result.stderr);
    const payload = JSON.parse(result.stdout) as {
      window: { requestCoverage: { amount: string; currency: string } };
      translation: { amount: string; currency: string; asOf: string | null; rateSources: string[]; complete: boolean } | null;
    };
    assert.equal(payload.window.requestCoverage.amount, '1.25');
    assert.equal(payload.window.requestCoverage.currency, 'USD');
    assert.equal(payload.translation?.amount, '1.125');
    assert.equal(payload.translation?.currency, 'EUR');
    assert.equal(payload.translation?.asOf, asOf);
    assert.deepEqual(payload.translation?.rateSources, ['fixture:economic-cli:command']);
    assert.equal(payload.translation?.complete, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('economic CLI export preserves effective-at context and requires a target for translation', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'fiscus-economic-export-cli-'));
  const db = join(dir, 'fiscus.db');
  const asOf = '2026-12-31T00:00:00.000Z';
  try {
    const seed = new Store(db);
    seed.economic().appendHistoricalRateObservation({
      id: 'fx-rate:economic-export:command',
      rate: exactRate({
        numerator: 4n,
        denominator: 5n,
        sourceUnit: 'USD',
        targetUnit: 'EUR',
        validTime: interval('2026-01-01T00:00:00.000Z', '2027-01-01T00:00:00.000Z'),
      }),
      rateSource: 'fixture:economic-export:command',
      recordedAt: '2026-01-02T00:00:00.000Z',
      supersedes: null,
    });
    seed.insertRequest(request());
    seed.close();

    const exported = await runCli([
      'export', '--economic', '--all', '--target-currency', 'EUR', '--as-of', asOf,
      '--effective-at', '2026-08-01T00:00:00.000Z', '--json',
    ], db);
    assert.equal(exported.code, 0, exported.stderr);
    const rows = JSON.parse(exported.stdout) as Array<{ translatedAmount: string | null; translatedCurrency: string | null; fxRateSource: string | null; fxEffectiveAt: string | null; fxRateAsOf: string | null }>;
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.translatedAmount, '1');
    assert.equal(rows[0]?.translatedCurrency, 'EUR');
    assert.equal(rows[0]?.fxRateSource, 'fixture:economic-export:command');
    assert.equal(rows[0]?.fxEffectiveAt, '2026-08-01T00:00:00.000Z');
    assert.equal(rows[0]?.fxRateAsOf, asOf);

    const missingTarget = await runCli(['export', '--economic', '--all', '--effective-at', '2026-08-01T00:00:00.000Z', '--json'], db);
    assert.equal(missingTarget.code, 1);
    assert.match(missingTarget.stderr, /--effective-at requires --target-currency/i);
  } finally {
    rmSync(dir, { recursive: true, force: true });
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
