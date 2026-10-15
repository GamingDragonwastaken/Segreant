/**
 * GET /api/statement: one calendar month, with the four claims side by side.
 *
 * The product's core rule is that metered usage, provider-billed cost,
 * allocated cost and realized value are different claims with different
 * evidence. These tests pin that the statement keeps them apart: each figure
 * counts only the rows and runs that belong to the month, a partial run is
 * reported as itself and never prorated, realized value is not computed, and a
 * figure the month does not establish says so.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type http from 'node:http';
import type { AddressInfo } from 'node:net';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Store, type RequestRow } from '../src/store/db.ts';
import { DEFAULT_CONFIG } from '../src/config.ts';
import { createDashboardServer } from '../src/dashboard/server.ts';
import { checkInterfaceShape } from '../src/dashboard/contracts.ts';
import { DASHBOARD_INTERFACE_CONTRACTS } from '../src/dashboard/web/app/core/generated-payload-contract.ts';

const DAY = 24 * 60 * 60 * 1000;
// The statement's month is local time, so the fixture months are built in local time too.
const JULY_START = new Date(2026, 6, 1).getTime();
const JULY_END = new Date(2026, 7, 1).getTime();
const D0 = Date.UTC(2026, 6, 1);
const PROJECT = 'proj_statement_fixture';
const day = (i: number): string => new Date(D0 + i * DAY).toISOString();

interface StatementBody {
  demo: boolean;
  month: string;
  period: { startMs: number; endMs: number; label: string; complete: boolean };
  metered: { costUsd: number; requests: number; byProject: unknown[]; byModel: unknown[]; claimSupport: unknown; basis: { totalUsd: number; headline: string }; retention: { truncated: boolean } };
  billed: { monthCoverage: string; overlappingRuns: number; scanComplete: boolean; runs: Array<{ reconciliationRunId: string; periodStartMs: number; periodEndMs: number; providerReportedMicros: number; coversWholeMonth: boolean }> };
  allocated: { monthCoverage: string; overlappingRuns: number; runs: Array<{ allocationRunId: string; coversWholeMonth: boolean; byCostCentre: Array<{ costCentreId: string; allocatedMicros: number }> }>; costCentres: Array<{ costCentreId: string; name: string }> };
  realized: { standing: string; reason: string; measuredAt: string | null; kept: { units: number; costUsd: number } };
  close: { status: string; activeFinalizationId: string | null; eventCount: number | null };
}

function row(id: string, tsEpochMs: number, costUsd: number, over: Partial<RequestRow> = {}): RequestRow {
  return {
    requestId: id, sessionId: null, tsEpochMs, provider: 'openai', model: 'gpt-4o', project: 'backend-api', taskWeight: 1,
    inputTokens: 10, outputTokens: 10, cacheWriteTokens: 0, cacheReadTokens: 0, reasoningTokens: 0, costUsd,
    estimated: false, streamed: false, statusCode: 200, durationMs: 1, ...over,
  };
}

function proxyRow(id: string, scopeId: string, tsEpochMs: number, costUsd: number): RequestRow {
  return {
    ...row(id, tsEpochMs, costUsd, { provider: 'openai', model: 'gpt-5', project: 'p' }),
    scopeCaptureStatus: 'declared_unverified', providerScopeDeclarationId: scopeId,
  };
}

/** An operator export for two UTC provider days, with a BOM. */
function exportBytes(): Buffer {
  const doc = {
    schemaVersion: 1,
    source: {
      system: 'operator-export', provider: 'openai', exportId: 'export-statement-1', billingAccountRef: 'acct-statement',
      exportedAt: day(10), periodStart: day(0), periodEnd: day(2), coverage: 'complete',
    },
    records: [0, 1].map((i) => ({
      sourceRecordId: `line-${i}`, chargePeriodStart: day(i), chargePeriodEnd: day(i + 1), observedAt: day(i + 1),
      providerProjectRef: PROJECT, chargeType: 'usage', currency: 'USD', amount: '2.000000', sku: 'model-usage',
      service: 'api', model: 'gpt-5', region: null, usageUnit: 'tokens', usageQuantity: '1000',
    })),
  };
  return Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(JSON.stringify(doc), 'utf8')]);
}

/**
 * Runs `body` against a dashboard over `store`, with SEGREANT_HOME in a fresh
 * temp directory (the billing write route reads the config from it).
 */
async function withServer(store: Store, body: (base: string) => Promise<void>): Promise<void> {
  const saved = { home: process.env.SEGREANT_HOME, demo: process.env.SEGREANT_DEMO };
  const home = mkdtempSync(join(tmpdir(), 'segreant-statement-'));
  process.env.SEGREANT_HOME = home;
  delete process.env.SEGREANT_DEMO;
  const server: http.Server = createDashboardServer({ store, config: structuredClone(DEFAULT_CONFIG), version: 'test' });
  try {
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    await body(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    if (saved.home === undefined) delete process.env.SEGREANT_HOME; else process.env.SEGREANT_HOME = saved.home;
    if (saved.demo !== undefined) process.env.SEGREANT_DEMO = saved.demo;
    rmSync(home, { recursive: true, force: true });
  }
}

async function statement(base: string, month?: string): Promise<{ status: number; json: StatementBody }> {
  const res = await fetch(`${base}/api/statement${month === undefined ? '' : `?month=${month}`}`);
  return { status: res.status, json: await res.json() as StatementBody };
}

/**
 * Declares a scope, imports and adopts a two-day export, records proxy traffic
 * on the declared route, and records a reconciliation through the billing write
 * route. The run covers two UTC days, so it overlaps July without covering it.
 */
async function recordPartialReconciliation(base: string, store: Store): Promise<void> {
  const post = async (payload: Record<string, unknown>): Promise<{ status: number; json: Record<string, unknown> }> => {
    const res = await fetch(`${base}/api/billing/write`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-segreant-local': '1' }, body: JSON.stringify(payload),
    });
    return { status: res.status, json: await res.json() as Record<string, unknown> };
  };
  const scope = await post({ op: 'scope', accountRef: 'org_statement', projectRef: PROJECT, apply: true });
  assert.equal(scope.status, 200, JSON.stringify(scope.json));
  const scopeId = (scope.json.declaration as { declarationId: string }).declarationId;
  const bytes = exportBytes();
  const imported = await post({ op: 'import', fileName: 'costs.json', contentBase64: bytes.toString('base64'), apply: true });
  assert.equal(imported.status, 200, JSON.stringify(imported.json));
  const importId = (imported.json.run as { importId: string }).importId;
  const adopted = await post({ op: 'adopt', importId, apply: true });
  assert.equal(adopted.status, 200, JSON.stringify(adopted.json));
  store.insertRequest(proxyRow('stmt-a', scopeId, D0 + DAY / 2, 1.5));
  store.insertRequest(proxyRow('stmt-b', scopeId, D0 + DAY + DAY / 2, 1.75));
  const recorded = await post({ op: 'reconcile', apply: true });
  assert.equal(recorded.status, 200, JSON.stringify(recorded.json));
}

test('(a) an empty store gives zeros and "not established" everywhere, and 200', async () => {
  const store = new Store(':memory:');
  await withServer(store, async (base) => {
    const res = await statement(base, '2026-07');
    assert.equal(res.status, 200);
    const b = res.json;
    assert.equal(b.month, '2026-07');
    assert.equal(b.period.startMs, JULY_START);
    assert.equal(b.period.endMs, JULY_END);
    assert.equal(b.period.complete, true);
    assert.equal(b.metered.costUsd, 0);
    assert.equal(b.metered.requests, 0);
    assert.deepEqual(b.metered.byProject, []);
    assert.deepEqual(b.metered.byModel, []);
    assert.equal(b.billed.monthCoverage, 'not_established');
    assert.equal(b.billed.runs.length, 0);
    assert.equal(b.allocated.monthCoverage, 'not_established');
    assert.equal(b.allocated.runs.length, 0);
    assert.equal(b.realized.standing, 'none_judged', 'an empty ledger has nothing judged in the month');
    assert.equal(b.realized.measuredAt, null);
    assert.equal(b.realized.kept.units, 0);
    assert.match(b.realized.reason, /Value page/);
    assert.equal(b.close.activeFinalizationId, null);

    // With no month, the statement is the current local month, which is never complete on the day it is read.
    const current = await statement(base);
    assert.equal(current.status, 200);
    assert.equal(current.json.period.complete, false);
  });
  store.close();
});

test('(b) only requests inside the month count, and both boundaries are exact', async () => {
  const store = new Store(':memory:');
  store.insertRequest(row('before-start', JULY_START - 1, 100));
  store.insertRequest(row('at-start', JULY_START, 1));
  store.insertRequest(row('just-inside', JULY_END - 1, 2));
  store.insertRequest(row('at-end', JULY_END, 100));
  store.insertRequest(row('after-end', JULY_END + DAY, 100));
  await withServer(store, async (base) => {
    const res = await statement(base, '2026-07');
    assert.equal(res.status, 200);
    assert.equal(res.json.metered.requests, 2, 'the start is inclusive and the end is exclusive');
    assert.equal(res.json.metered.costUsd, 3);
    assert.equal(res.json.metered.byProject.length, 1);
    assert.equal(res.json.metered.retention.truncated, false);
  });
  store.close();
});

test('(c) a reconciliation covering part of the month is reported with its own figures and coversWholeMonth false', async () => {
  const store = new Store(':memory:');
  await withServer(store, async (base) => {
    await recordPartialReconciliation(base, store);
    const res = await statement(base, '2026-07');
    assert.equal(res.status, 200);
    assert.equal(res.json.billed.monthCoverage, 'partial');
    assert.equal(res.json.billed.overlappingRuns, 1);
    assert.equal(res.json.billed.runs.length, 1);
    const run = res.json.billed.runs[0]!;
    assert.equal(run.coversWholeMonth, false);
    assert.equal(run.periodStartMs, D0, 'the run keeps its own period');
    assert.equal(run.providerReportedMicros, 4_000_000, 'the run keeps its own figure, not a prorated one');
    assert.equal(res.json.allocated.monthCoverage, 'not_established', 'a billed run is not an allocation');
  });
  store.close();
});

test('(d) an allocation run for the month appears with byCostCentre and the centre names', async () => {
  const store = new Store(':memory:');
  store.upsertCostCentre({ costCentreId: 'eng', name: 'Engineering', createdAtMs: JULY_START });
  store.saveAllocationRule({
    ruleId: 'backend', method: 'direct', match: { project: 'backend-api' }, targets: [{ costCentreId: 'eng', ratio: 1 }],
    priority: 10, effectiveFromMs: 0, effectiveToMs: null, revokedAtMs: null, owner: null, note: null,
  });
  store.insertRequest(row('alloc-in', JULY_START + DAY, 4));
  store.saveAllocationRun(store.allocatePeriod(JULY_START, JULY_END));
  await withServer(store, async (base) => {
    const res = await statement(base, '2026-07');
    assert.equal(res.status, 200);
    assert.equal(res.json.allocated.monthCoverage, 'whole');
    assert.equal(res.json.allocated.runs.length, 1);
    const run = res.json.allocated.runs[0]!;
    assert.equal(run.coversWholeMonth, true);
    assert.equal(run.byCostCentre.length, 1);
    assert.equal(run.byCostCentre[0]!.costCentreId, 'eng');
    assert.equal(run.byCostCentre[0]!.allocatedMicros, 4_000_000);
    assert.deepEqual(res.json.allocated.costCentres, [{ costCentreId: 'eng', name: 'Engineering' }]);
  });
  store.close();
});

test('(e) a malformed month, a month that does not exist, and a future month are refused with 400', async () => {
  const store = new Store(':memory:');
  await withServer(store, async (base) => {
    for (const month of ['2026-13', '2026-00', 'garbage', '26-07', '2026-7']) {
      const res = await fetch(`${base}/api/statement?month=${month}`);
      assert.equal(res.status, 400, `month=${month}`);
      assert.match(((await res.json()) as { error: string }).error, /month must be/);
    }
    const future = new Date().getFullYear() + 1;
    const res = await fetch(`${base}/api/statement?month=${future}-01`);
    assert.equal(res.status, 400);
    assert.match(((await res.json()) as { error: string }).error, /entirely in the future/);
  });
  store.close();
});

test('(f) a populated statement passes the deep check the browser runs on it', async () => {
  const store = new Store(':memory:');
  store.upsertCostCentre({ costCentreId: 'eng', name: 'Engineering', createdAtMs: JULY_START });
  store.saveAllocationRule({
    ruleId: 'backend', method: 'direct', match: { project: 'backend-api' }, targets: [{ costCentreId: 'eng', ratio: 1 }],
    priority: 10, effectiveFromMs: 0, effectiveToMs: null, revokedAtMs: null, owner: null, note: null,
  });
  store.insertRequest(row('deep-1', JULY_START + DAY, 4));
  store.insertRequest(row('deep-2', JULY_START + 2 * DAY, 1, { project: 'research', model: 'gpt-4o-mini' }));
  store.saveAllocationRun(store.allocatePeriod(JULY_START, JULY_END));
  await withServer(store, async (base) => {
    await recordPartialReconciliation(base, store);
    const res = await statement(base, '2026-07');
    assert.equal(res.status, 200);
    // The check is only meaningful over populated arrays.
    assert.ok(res.json.metered.byProject.length > 0);
    assert.ok(res.json.metered.byModel.length > 0);
    assert.equal(res.json.billed.runs.length, 1);
    assert.equal(res.json.allocated.runs.length, 1);
    assert.equal(res.json.allocated.costCentres.length, 1);
    const problems = checkInterfaceShape('StatementPayload', res.json, DASHBOARD_INTERFACE_CONTRACTS, 'StatementPayload');
    assert.deepEqual(problems, []);

    // The check must reach the nested run and centre shapes, not stop at the top level.
    const broken = structuredClone(res.json);
    (broken.billed.runs[0] as unknown as { providerReportedMicros: string }).providerReportedMicros = 'four million';
    (broken.allocated.runs[0]!.byCostCentre[0] as unknown as { allocatedMicros: string }).allocatedMicros = 'x';
    assert.ok(checkInterfaceShape('StatementPayload', broken, DASHBOARD_INTERFACE_CONTRACTS, 'StatementPayload').length >= 2);
  });
  store.close();
});
