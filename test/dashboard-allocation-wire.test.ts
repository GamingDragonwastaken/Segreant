/**
 * The Allocate screen's declarations must describe what /api/allocation sends
 * once allocation actually exists.
 *
 * `CostCentre` was declared `{ id, label?, name? }` and `AllocationRule` with an
 * `id`, while the store sends `costCentreId` and `ruleId`. The browser runs this
 * same deep check on every payload, so the whole Allocate page failed with a
 * contract violation as soon as one real cost centre existed. Every earlier test
 * read an empty ledger, where an empty array satisfies any element type, so
 * nothing caught it. This test populates centres, a rule and a recorded run.
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
const T0 = Date.UTC(2026, 6, 1);

function row(id: string, project: string, costUsd: number): RequestRow {
  return {
    requestId: id, sessionId: null, tsEpochMs: T0 + DAY, provider: 'openai', model: 'gpt-4o',
    project, taskWeight: 1, inputTokens: 10, outputTokens: 10, cacheWriteTokens: 0, cacheReadTokens: 0,
    reasoningTokens: 0, costUsd, estimated: false, streamed: false, statusCode: 200, durationMs: 1,
  };
}

test('a populated /api/allocation passes the deep check the browser runs on it', async () => {
  const saved = { home: process.env.SEGREANT_HOME, demo: process.env.SEGREANT_DEMO };
  const home = mkdtempSync(join(tmpdir(), 'segreant-alloc-wire-'));
  process.env.SEGREANT_HOME = home;
  delete process.env.SEGREANT_DEMO;
  const store = new Store(':memory:');
  store.insertRequest(row('w-1', 'backend-api', 4));
  store.insertRequest(row('w-2', 'research', 1));
  store.upsertCostCentre({ costCentreId: 'eng', name: 'Engineering', owner: 'cto' });
  store.upsertCostCentre({ costCentreId: 'lab', name: 'Research', owner: null });
  store.archiveCostCentre('lab');
  store.saveAllocationRule({
    ruleId: 'backend', method: 'direct', match: { project: 'backend-api' }, targets: [{ costCentreId: 'eng', ratio: 1 }],
    priority: 10, effectiveFromMs: 0, effectiveToMs: null, revokedAtMs: null, owner: null, note: null,
  });
  store.saveAllocationRun(store.allocatePeriod(T0, T0 + 5 * DAY));

  const server: http.Server = createDashboardServer({ store, config: structuredClone(DEFAULT_CONFIG), version: 'test' });
  try {
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const res = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/api/allocation`);
    assert.equal(res.status, 200);
    const payload = await res.json() as { costCentres: unknown[]; rules: unknown[]; runs: unknown[] };
    assert.equal(payload.costCentres.length, 2, 'the check is only meaningful over populated arrays');
    assert.equal(payload.rules.length, 1);
    assert.equal(payload.runs.length, 1);
    const problems = checkInterfaceShape('AllocationPayload', payload, DASHBOARD_INTERFACE_CONTRACTS, 'AllocationPayload');
    assert.deepEqual(problems, []);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    store.close();
    if (saved.home === undefined) delete process.env.SEGREANT_HOME; else process.env.SEGREANT_HOME = saved.home;
    if (saved.demo !== undefined) process.env.SEGREANT_DEMO = saved.demo;
    rmSync(home, { recursive: true, force: true });
  }
});
