/**
 * POST /api/allocation/write: the GUI's route to `segreant alloc`.
 *
 * These pin the properties the endpoint exists to keep: the local-only gate
 * refuses a cross-site write, a preview never records a run, apply records
 * exactly one, malformed requests are refused before any write, and demo mode
 * refuses every change while still answering a preview.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Store, type RequestRow } from '../src/store/db.ts';
import { DEFAULT_CONFIG } from '../src/config.ts';
import { createDashboardServer } from '../src/dashboard/server.ts';

const DAY = 24 * 60 * 60 * 1000;
const T0 = Date.UTC(2026, 6, 1);
const T1 = T0 + 5 * DAY;
const ISO_FROM = new Date(T0).toISOString();
const ISO_TO = new Date(T1).toISOString();

let seq = 0;
function request(costUsd: number, over: Partial<RequestRow> = {}): RequestRow {
  return {
    requestId: `alloc-write-${seq++}`, sessionId: null, tsEpochMs: T0 + DAY, provider: 'openai', model: 'gpt-4o',
    project: 'backend-api', taskWeight: 1, inputTokens: 10, outputTokens: 10, cacheWriteTokens: 0, cacheReadTokens: 0,
    reasoningTokens: 0, costUsd, estimated: false, streamed: false, statusCode: 200, durationMs: 1,
    ...over,
  };
}

async function listen(server: http.Server): Promise<string> {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

function close(server: http.Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

/**
 * Runs `body` against a dashboard over `store`, with SEGREANT_HOME pointed at a
 * fresh temp directory and SEGREANT_DEMO set to `demo`, restoring both after.
 */
async function withDashboard(store: Store, demo: boolean, body: (base: string) => Promise<void>): Promise<void> {
  const saved = { home: process.env.SEGREANT_HOME, demo: process.env.SEGREANT_DEMO };
  const home = mkdtempSync(join(tmpdir(), 'segreant-alloc-write-'));
  process.env.SEGREANT_HOME = home;
  if (demo) process.env.SEGREANT_DEMO = '1';
  else delete process.env.SEGREANT_DEMO;
  const server = createDashboardServer({ store, config: structuredClone(DEFAULT_CONFIG), version: 'test' });
  try {
    const base = await listen(server);
    await body(base);
  } finally {
    await close(server);
    if (saved.home === undefined) delete process.env.SEGREANT_HOME;
    else process.env.SEGREANT_HOME = saved.home;
    if (saved.demo === undefined) delete process.env.SEGREANT_DEMO;
    else process.env.SEGREANT_DEMO = saved.demo;
    rmSync(home, { recursive: true, force: true });
  }
}

function post(base: string, payload: unknown, headers: Record<string, string> = { 'x-segreant-local': '1' }): Promise<Response> {
  return fetch(`${base}/api/allocation/write`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(payload),
  });
}

interface AllocationRuns { costCentres: unknown[]; rules: unknown[]; runs: unknown[] }

async function readAllocation(base: string): Promise<AllocationRuns> {
  const res = await fetch(`${base}/api/allocation`);
  assert.equal(res.status, 200);
  return (await res.json()) as AllocationRuns;
}

test('POST /api/allocation/write without x-segreant-local is refused and writes nothing', async () => {
  const store = new Store(':memory:');
  await withDashboard(store, false, async (base) => {
    const res = await post(base, { op: 'centre', id: 'eng', name: 'Engineering' }, {});
    assert.equal(res.status, 403);
    assert.equal(store.costCentres().length, 0);
  });
  store.close();
});

test('allocation write: centre, rule, preview leaves no run, apply records one', async () => {
  const store = new Store(':memory:');
  store.insertRequest(request(4, { tsEpochMs: T0 + DAY }));
  store.insertRequest(request(1, { project: 'default', tsEpochMs: T0 + 2 * DAY }));
  await withDashboard(store, false, async (base) => {
    const centre = await post(base, { op: 'centre', id: 'eng', name: 'Engineering', owner: 'cto' });
    assert.equal(centre.status, 200);
    const centreBody = await centre.json() as { ok: boolean; op: string; applied: boolean; message: string; costCentre: { costCentreId: string } };
    assert.equal(centreBody.ok, true);
    assert.equal(centreBody.op, 'centre');
    assert.equal(centreBody.applied, true);
    assert.equal(centreBody.message, 'Cost centre "eng" saved.');
    assert.equal(centreBody.costCentre.costCentreId, 'eng');

    const rule = await post(base, {
      op: 'rule', id: 'backend', method: 'direct', targets: [{ costCentreId: 'eng', ratio: 1 }],
      match: { project: 'backend-api' }, priority: 10,
    });
    assert.equal(rule.status, 200);
    const ruleBody = await rule.json() as { applied: boolean; rule: { ruleId: string; version: number; priority: number } };
    assert.equal(ruleBody.applied, true);
    assert.equal(ruleBody.rule.ruleId, 'backend');
    assert.equal(ruleBody.rule.version, 1);
    assert.equal(ruleBody.rule.priority, 10);

    const preview = await post(base, { op: 'run', from: ISO_FROM, to: ISO_TO });
    assert.equal(preview.status, 200);
    const previewBody = await preview.json() as { applied: boolean; allocationRunId: string | null; message: string; result: { allocatedMicros: number; conserves: boolean } };
    assert.equal(previewBody.applied, false);
    assert.equal(previewBody.allocationRunId, null);
    assert.equal(previewBody.message, 'Not recorded. Apply to record this run.');
    assert.equal(previewBody.result.conserves, true);
    assert.ok(previewBody.result.allocatedMicros > 0);
    assert.equal((await readAllocation(base)).runs.length, 0, 'a preview must not record a run');

    const applied = await post(base, { op: 'run', apply: true, from: ISO_FROM, to: ISO_TO });
    assert.equal(applied.status, 200);
    const appliedBody = await applied.json() as { applied: boolean; allocationRunId: string | null };
    assert.equal(appliedBody.applied, true);
    assert.equal(typeof appliedBody.allocationRunId, 'string');
    assert.equal((await readAllocation(base)).runs.length, 1);
  });
  store.close();
});

test('allocation write: malformed requests are refused with 400 before any write', async () => {
  const store = new Store(':memory:');
  await withDashboard(store, false, async (base) => {
    const unknownField = await post(base, { op: 'centre', id: 'eng', name: 'Engineering', colour: 'red' });
    assert.equal(unknownField.status, 400);

    const badMethod = await post(base, {
      op: 'rule', id: 'r', method: 'magic', targets: [{ costCentreId: 'eng', ratio: 1 }],
    });
    assert.equal(badMethod.status, 400);

    const reversed = await post(base, { op: 'run', from: ISO_TO, to: ISO_FROM });
    assert.equal(reversed.status, 400);
    assert.match(((await reversed.json()) as { error: string }).error, /after from/);

    const badMatch = await post(base, {
      op: 'rule', id: 'r', method: 'direct', targets: [{ costCentreId: 'eng', ratio: 1 }], match: { colour: 'red' },
    });
    assert.equal(badMatch.status, 400);

    assert.equal(store.costCentres().length, 0);
    assert.equal(store.allocationRules().length, 0);
  });
  store.close();
});

test('allocation write: archiving or revoking a missing id is a 404', async () => {
  const store = new Store(':memory:');
  await withDashboard(store, false, async (base) => {
    const archive = await post(base, { op: 'archive', id: 'ghost' });
    assert.equal(archive.status, 404);
    assert.equal(((await archive.json()) as { error: string }).error, 'No open cost centre "ghost".');

    const revoke = await post(base, { op: 'revoke', id: 'ghost' });
    assert.equal(revoke.status, 404);
    assert.equal(((await revoke.json()) as { error: string }).error, 'No open rule "ghost".');
  });
  store.close();
});

test('demo mode: a centre write is refused with 409, a preview is allowed, and an applied run is refused', async () => {
  const store = new Store(':memory:');
  store.upsertCostCentre({ costCentreId: 'eng', name: 'Engineering', createdAtMs: T0 });
  await withDashboard(store, true, async (base) => {
    const centre = await post(base, { op: 'centre', id: 'platform', name: 'Platform' });
    assert.equal(centre.status, 409);
    assert.match(((await centre.json()) as { error: string }).error, /Demo mode holds sample data only/);
    assert.equal(store.costCentres().length, 1, 'a refused write must not reach the store');

    const preview = await post(base, { op: 'run', from: ISO_FROM, to: ISO_TO });
    assert.equal(preview.status, 200);
    assert.equal(((await preview.json()) as { applied: boolean }).applied, false);

    const applied = await post(base, { op: 'run', apply: true, from: ISO_FROM, to: ISO_TO });
    assert.equal(applied.status, 409);
    assert.equal((await readAllocation(base)).runs.length, 0);
  });
  store.close();
});
