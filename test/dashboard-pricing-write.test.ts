import { after, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { Store, type RequestRow } from '../src/store/db.ts';
import { DEFAULT_CONFIG } from '../src/config.ts';
import { createDashboardServer } from '../src/dashboard/server.ts';
import { loadPriceOverrides, setPriceOverride } from '../src/cost/overrides.ts';
import { computeCost, legacyPricingEvidence } from '../src/cost/pricing.ts';
import { checkInterfaceShape, dashboardPayloadContract, validateDashboardPayload } from '../src/dashboard/contracts.ts';
import { DASHBOARD_INTERFACE_CONTRACTS } from '../src/dashboard/web/app/core/generated-payload-contract.ts';
import type { UnknownPricingPayload, PricingDeclarePayload, PricingUnsetPayload, RepricePayload } from '../src/dashboard/shared-types.ts';

const home = mkdtempSync(join(tmpdir(), 'segreant-pricing-write-'));
beforeEach(() => {
  process.env.SEGREANT_HOME = mkdtempSync(join(home, 'case-'));
  process.env.SEGREANT_DEMO = '';
});
after(() => rmSync(home, { recursive: true, force: true }));

function row(requestId: string, model: string, costUsd = 7, provider = 'openai'): RequestRow {
  return {
    requestId, model, costUsd, provider, sessionId: null, tsEpochMs: 1000, project: 'test', taskWeight: 1,
    inputTokens: 1_000_000, outputTokens: 0, cacheWriteTokens: 0, cacheReadTokens: 0, reasoningTokens: 0,
    estimated: true, streamed: false, statusCode: 200, durationMs: 1,
    pricing: { ...legacyPricingEvidence(), costBasis: 'fallback_estimate', rateMatchKind: 'fallback' },
  };
}

async function dashboard(body: (base: string, store: Store) => Promise<void>): Promise<void> {
  const store = new Store(':memory:');
  const server = createDashboardServer({ store, config: structuredClone(DEFAULT_CONFIG), version: 'test' });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try { await body(`http://127.0.0.1:${(server.address() as AddressInfo).port}`, store); }
  finally { await new Promise<void>((resolve) => server.close(() => resolve())); store.close(); }
}

function post(base: string, path: string, payload: unknown, local = true): Promise<Response> {
  return fetch(base + path, {
    method: 'POST', headers: { 'content-type': 'application/json', ...(local ? { 'x-segreant-local': '1' } : {}) },
    body: JSON.stringify(payload),
  });
}

function wire(id: Parameters<typeof dashboardPayloadContract>[0], method: 'GET' | 'POST', payload: unknown): void {
  const contract = dashboardPayloadContract(id, method);
  validateDashboardPayload(contract, payload);
  assert.deepEqual(checkInterfaceShape(contract.responseType, payload, DASHBOARD_INTERFACE_CONTRACTS, id), []);
}

async function read<T>(response: Response): Promise<T> { return await response.json() as T; }
const unknown = async (base: string) => read<UnknownPricingPayload>(await fetch(base + '/api/pricing/unknown'));

test('unknown prices: current exact and declared prices disappear; provider/model guesses aggregate without writing', async () => {
  await dashboard(async (base, store) => {
    store.insertRequest(row('a', 'private-model', 3));
    store.insertRequest(row('b', 'private-model', 2));
    store.insertRequest(row('c', 'claude-sonnet-4-6-20990101', 4, 'anthropic'));
    store.insertRequest(row('d', 'claude-opus-4-8'));
    store.insertRequest(row('e', 'declared-model'));
    setPriceOverride('declared-model', { kind: 'free' });
    const res = await fetch(base + '/api/pricing/unknown');
    assert.equal(res.status, 200);
    const body = await read<UnknownPricingPayload>(res);
    wire('pricing-unknown', 'GET', body);
    assert.deepEqual(body.models.map((m) => [m.model, m.requests, m.costUsd, m.rateMatchKind]), [
      ['private-model', 2, 5, 'fallback'], ['claude-sonnet-4-6-20990101', 1, 4, 'family_provider'],
    ]);
    assert.match(body.boundary, /recorded.*estimated/i);
    assert.equal(body.demo, false);
    assert.equal(store.estimatedRequestRows().length, 5);
    assert.deepEqual(store.requestPriceEvents('a'), []);
    process.env.SEGREANT_DEMO = '1';
    assert.equal((await unknown(base)).demo, true);
  });
});

for (const price of [
  { kind: 'rate', input: '0.2', output: '0.8', cacheRead: '0.02', cacheWrite: '0.25' },
  { kind: 'like', like: 'claude-haiku-4-5' },
  { kind: 'free' },
]) test(`declare ${price.kind}, refresh and unset keep historical estimates unchanged`, async () => {
  await dashboard(async (base, store) => {
    store.insertRequest(row('history', 'private-model'));
    const res = await post(base, '/api/pricing/declare', { model: 'private-model', ...price });
    assert.equal(res.status, 200);
    const body = await read<PricingDeclarePayload>(res);
    wire('pricing-declare', 'POST', body);
    assert.equal(body.model, 'private-model');
    assert.equal(body.price.kind, price.kind);
    assert.equal(loadPriceOverrides().models['private-model']?.kind, price.kind);
    assert.deepEqual((await unknown(base)).models, []);
    assert.equal(store.estimatedRequestRows()[0]!.costUsd, 7);
    assert.deepEqual(store.requestPriceEvents('history'), []);
    const unset = await post(base, '/api/pricing/unset', { model: 'private-model' });
    assert.equal(unset.status, 200);
    const removed = await read<PricingUnsetPayload>(unset);
    wire('pricing-unset', 'POST', removed);
    assert.equal(removed.removed, true);
    assert.equal((await read<PricingUnsetPayload>(await post(base, '/api/pricing/unset', { model: 'private-model' }))).removed, false);
    assert.equal((await unknown(base)).models.length, 1);
  });
});

test('declare refuses invalid, mixed, unknown and non-card prices without persistence', async () => {
  await dashboard(async (base) => {
    setPriceOverride('declared-target', { kind: 'free' });
    for (const payload of [null, [], {}, { model: '__proto__', kind: 'free' },
      { model: 'x', kind: 'rate', input: 1, output: '2' }, { model: 'x', kind: 'rate', input: '0', output: '2' },
      { model: 'x', kind: 'free', input: '1' }, { model: 'x', kind: 'free', colour: 'red' },
      { model: 'x', kind: 'like', like: 'missing-model' },
      { model: 'x', kind: 'like', like: 'declared-target' },
      { model: 'x', kind: 'like', like: 'claude-sonnet-4-6-20990101' }]) {
      const res = await post(base, '/api/pricing/declare', payload);
      assert.equal(res.status, 400, JSON.stringify(payload));
    }
    assert.deepEqual(Object.keys(loadPriceOverrides().models), ['declared-target']);
  });
});

test('reprice preview writes nothing; apply reports the written rows, basis and retained audit events', async () => {
  await dashboard(async (base, store) => {
    store.insertRequest(row('exact', 'claude-opus-4-8', 9, 'anthropic'));
    store.insertRequest(row('declared', 'private-model', 7));
    store.insertRequest(row('guess', 'still-unknown', 6));
    store.insertRequest({ ...row('untouched', 'claude-opus-4-8', 11), estimated: false });
    setPriceOverride('private-model', { kind: 'free' });
    const res = await post(base, '/api/reprice', { apply: false });
    assert.equal(res.status, 200);
    const preview = await read<RepricePayload>(res);
    wire('reprice', 'POST', preview);
    assert.equal(preview.applied, false);
    assert.equal(preview.estimatedRows, 3);
    assert.equal(preview.repriceable, 2);
    assert.equal(preview.stillEstimated, 1);
    assert.equal(preview.totalBeforeUsd, 16);
    assert.equal(preview.totalAfterUsd, computeCost('anthropic', 'claude-opus-4-8', {
      inputTokens: 1_000_000, outputTokens: 0, cacheWriteTokens: 0, cacheReadTokens: 0,
    }).costUsd);
    assert.deepEqual(preview.byModel.map((m) => m.afterBasis), ['list price', 'your price']);
    assert.equal(store.estimatedRequestRows().length, 3);
    assert.deepEqual(store.requestPriceEvents('exact'), []);
    const applied = await read<RepricePayload>(await post(base, '/api/reprice', { apply: true }));
    wire('reprice', 'POST', applied);
    assert.equal(applied.applied, true);
    assert.deepEqual(applied.byModel, preview.byModel);
    assert.equal(applied.totalAfterUsd, preview.totalAfterUsd);
    assert.deepEqual(store.estimatedRequestRows().map((r) => r.requestId), ['guess']);
    assert.equal(store.requestPriceEvents('exact')[0]!.previousCostUsd, 9);
    assert.equal(store.requestPriceEvents('declared')[0]!.previousCostUsd, 7);
    assert.deepEqual(store.requestPriceEvents('untouched'), []);
    assert.equal((await read<RepricePayload>(await post(base, '/api/reprice', { apply: true }))).repriceable, 0);
  });
});

for (const path of ['/api/pricing/declare', '/api/pricing/unset', '/api/reprice']) {
  test(`${path}: strict bounded JSON, method and local-only guards, and demo refusal`, async () => {
    await dashboard(async (base, store) => {
      const valid = path.endsWith('declare') ? { model: 'x', kind: 'free' } : path.endsWith('unset') ? { model: 'x' } : { apply: false };
      assert.equal((await post(base, path, valid, false)).status, 403);
      assert.equal((await fetch(base + path)).status, 405);
      for (const payload of [null, [], {}, { ...valid, unknown: true },
        ...(path.endsWith('unset') ? [{ model: 123 }, { model: '../bad' }] : []),
        ...(path === '/api/reprice' ? [{ apply: 'true' }, { apply: 1 }] : [])]) {
        assert.equal((await post(base, path, payload)).status, 400, JSON.stringify(payload));
      }
      assert.equal((await fetch(base + path, { method: 'POST', headers: { 'x-segreant-local': '1' }, body: '{' })).status, 400);
      const malformed = await fetch(base + path, { method: 'POST', headers: { 'x-segreant-local': '1' }, body: 'private-fixture-not-for-response' });
      assert.equal(malformed.status, 400);
      assert.doesNotMatch((await read<{ error: string }>(malformed)).error, /private-|SyntaxError| at /);
      assert.equal((await post(base, path, { ...valid, padding: 'x'.repeat(17_000) })).status, 413);
      setPriceOverride('x', { kind: 'rate', input: '1', output: '2' });
      const pricesBefore = structuredClone(loadPriceOverrides().models);
      store.insertRequest(row('demo-refusal', 'x'));
      process.env.SEGREANT_DEMO = '1';
      // A reprice preview writes nothing, so the sample data may show one; every
      // write is refused (independent review, 2026-10-18).
      assert.equal((await post(base, path, valid)).status, path === '/api/reprice' ? 200 : 409);
      if (path === '/api/reprice') assert.equal((await post(base, path, { apply: true })).status, 409);
      assert.deepEqual({ ...loadPriceOverrides().models }, { ...pricesBefore });
      assert.equal(store.estimatedRequestRows().length, 1);
      assert.deepEqual(store.requestPriceEvents('demo-refusal'), []);
    });
  });
}

test('a forced free price is labelled as forced in the declared prices (PR #153 review)', async () => {
  setPriceOverride('claude-sonnet-4-6', { kind: 'free', force: true });
  setPriceOverride('acme-local-llm', { kind: 'free' });
  await dashboard(async (base) => {
    const payload = await unknown(base);
    wire('pricing-unknown', 'GET', payload);
    const forced = payload.declared.find((p) => p.model === 'claude-sonnet-4-6')!;
    assert.equal(forced.forced, true);
    assert.match(forced.summary, /forced: a cap counts this model as \$0 even though a rate card prices it/);
    const local = payload.declared.find((p) => p.model === 'acme-local-llm')!;
    assert.equal(local.forced, undefined);
    assert.equal(local.summary, 'free (local model)');
    assert.equal(local.supersededByCard, undefined);
  });
});

test('an unforced free price a rate card now prices is shown as not applied (PR #153 review)', async () => {
  const { writeFileSync, mkdirSync } = await import('node:fs');
  const { overridesPath } = await import('../src/cost/overrides.ts');
  mkdirSync(join(overridesPath(), '..'), { recursive: true });
  // The state a refresh leaves: a free price stored before the card priced the model.
  writeFileSync(overridesPath(), JSON.stringify({ version: 1, models: { 'claude-sonnet-4-6': { kind: 'free', declaredAt: new Date().toISOString() } } }));
  await dashboard(async (base) => {
    const payload = await unknown(base);
    wire('pricing-unknown', 'GET', payload);
    const p = payload.declared.find((d) => d.model === 'claude-sonnet-4-6')!;
    assert.equal(p.supersededByCard, true);
    assert.match(p.summary, /not applied: a rate card now prices this model/);
  });
});
