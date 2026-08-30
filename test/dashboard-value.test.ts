/**
 * GET /api/value — the payload carries `reclaimed` (Time Reclaimed) alongside
 * the existing roi/frontier/budget keys, present even with no git repo
 * attached (null, never omitted — the UI needs to tell "not computed" apart
 * from "computed as zero").
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import type http from 'node:http';
import { Store } from '../src/store/db.ts';
import { DEFAULT_CONFIG } from '../src/config.ts';
import { createDashboardServer } from '../src/dashboard/server.ts';
import { seedDemo } from '../src/demo/seed.ts';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

function boot(store: Store): Promise<{ base: string; close: () => Promise<void> }> {
  const server: http.Server = createDashboardServer({ store, config: structuredClone(DEFAULT_CONFIG), version: 'test' });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as AddressInfo).port;
      resolve({ base: `http://127.0.0.1:${port}`, close: () => new Promise((r) => server.close(() => r())) });
    });
  });
}

test('GET /api/value: payload always carries a reclaimed key (null when no git repo is attached)', async () => {
  const store = new Store(':memory:');
  const srv = await boot(store);
  try {
    const res = await fetch(`${srv.base}/api/value`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as Record<string, unknown>;
    assert.ok('reclaimed' in body, 'reclaimed key is always present, even when null');
    const budget = body['budget'] as Record<string, unknown>;
    assert.equal(budget['spendBasis'], 'live_proxy', 'advisor basis matches the default cap enforcement basis');
    assert.equal(budget['minActiveDays'], 7, 'thin history is visible to dashboard users');
    assert.ok('frontier' in body, 'dashboard API always carries the frontier slot, even when no Git repository is attached');
  } finally {
    await srv.close();
    store.close();
  }
});

test('GET /api/value: a synthetic demo labels itself and exposes only a review-only cheaper-model trial', async () => {
  const previousDemo = process.env.FISCUS_DEMO;
  process.env.FISCUS_DEMO = '1';
  const store = new Store(':memory:');
  const now = new Date();
  now.setHours(12, 0, 0, 0);
  seedDemo(store, { now: now.getTime() });
  const srv = await boot(store);
  try {
    const res = await fetch(`${srv.base}/api/value`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      demo: boolean;
      valueSource: string | null;
      frontier: { modelSwitches: Array<{ confidence: string; candidateModel: string; incumbentModel: string }> } | null;
    };
    assert.equal(body.demo, true);
    assert.equal(body.valueSource, 'store');
    assert.ok(body.frontier && body.frontier.modelSwitches.length > 0);
    assert.ok(body.frontier!.modelSwitches.every((item) => item.confidence === 'trial'));
    assert.ok(body.frontier!.modelSwitches.some((item) => item.candidateModel === 'claude-haiku-4-5' && item.incumbentModel === 'claude-opus-4-8'));
  } finally {
    await srv.close();
    store.close();
    if (previousDemo === undefined) delete process.env.FISCUS_DEMO;
    else process.env.FISCUS_DEMO = previousDemo;
  }
});

test('value dashboard reveals the observed mature-unit and realization evidence behind model trials', () => {
  const html = readFileSync(join(import.meta.dirname, '..', 'src', 'dashboard', 'web', 'classic.html'), 'utf8');
  assert.match(html, /mature units/);
  assert.match(html, /observed realization/);
  assert.match(html, /intervals overlap — keep this as a measured trial/);
  assert.match(html, /Fiscus does <b>not<\/b> change routing/);
});

test('modern Value view discloses exact economic coverage instead of leaving the numeric cost basis implicit', () => {
  const source = readFileSync(join(import.meta.dirname, '..', 'src', 'dashboard', 'web', 'app', 'views', 'value.ts'), 'utf8');
  assert.match(source, /Exact economic coverage/);
  assert.match(source, /legacy_unknown/);
  assert.match(source, /unresolvedRequests/);
});

test('classic Value view discloses exact economic coverage for every value-bearing section', () => {
  const source = readFileSync(join(import.meta.dirname, '..', 'src', 'dashboard', 'web', 'classic.html'), 'utf8');
  assert.match(source, /function economicCoverageHtml/);
  assert.match(source, /d\.realization\?\.matured\?\.economic/);
  assert.match(source, /d\.usage\?\.economic/);
  assert.match(source, /d\.budget\?\.economic/);
  assert.match(source, /p\.economic/);
  assert.match(source, /team\?\.distribution\?\.economic/);
  assert.match(source, /Exact economic coverage/);
  assert.match(source, /unresolved legacy request/);
  assert.match(source, /exact coverage was not reported/);
});

test('browser Value contract includes project exact economic coverage', () => {
  const source = readFileSync(join(import.meta.dirname, '..', 'src', 'dashboard', 'web', 'app', 'core', 'api.ts'), 'utf8');
  assert.match(source, /export interface ValueProjectPayload/);
  assert.match(source, /projects\?: ValueProjectPayload\[\]/);
  assert.match(source, /economic\?: RealizationEconomicRollupPayload/);
});
