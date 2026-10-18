// Where a declared price must NOT reach: the provider is never called while the
// declarations file is broken, and the sample data never takes a real declaration.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const home = mkdtempSync(join(tmpdir(), 'segreant-override-boundaries-'));
process.env.SEGREANT_HOME = home;

const { createProxyServer } = await import('../src/proxy/server.ts');
const { DEFAULT_CONFIG } = await import('../src/config.ts');
const { Store } = await import('../src/store/db.ts');
const { setPriceOverride, removePriceOverride, overridesPath } = await import('../src/cost/overrides.ts');
const { seedDemo } = await import('../src/demo/seed.ts');

async function listen(server: http.Server): Promise<string> {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}
const close = (server: http.Server): Promise<void> => new Promise((resolve) => server.close(() => resolve()));

test('a broken declarations file stops forwarding before the provider is called, and repairing it resumes (PR #146 review)', async () => {
  let upstreamRequests = 0;
  const upstream = http.createServer((_req, res) => {
    upstreamRequests += 1;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ model: 'gpt-4o', usage: { prompt_tokens: 1, completion_tokens: 1 } }));
  });
  const upstreamBase = await listen(upstream);
  const config = structuredClone(DEFAULT_CONFIG);
  config.upstreams.openai = upstreamBase;
  const store = new Store(join(home, 'proxy.db'));
  const proxy = createProxyServer({ store, config });
  const proxyBase = await listen(proxy);
  const send = () => fetch(`${proxyBase}/v1/chat/completions`, {
    method: 'POST',
    headers: { authorization: 'Bearer test', 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'gpt-4o', messages: [{ role: 'user', content: 'hello' }] }),
  });
  try {
    mkdirSync(join(home, 'pricing'), { recursive: true });
    writeFileSync(overridesPath(), '{ "version": 1, "models": { "acme": { "kind": "rate" } } }');
    const refused = await send();
    assert.equal(refused.status, 503);
    assert.equal(((await refused.json()) as { error?: { code?: string } }).error?.code, 'budget_enforcement_unavailable');
    assert.equal(upstreamRequests, 0, 'nothing is sent while a declared price cannot be read');

    rmSync(overridesPath());
    const sent = await send();
    assert.equal(sent.status, 200, 'repairing the file resumes forwarding without a restart');
    await sent.text();
    assert.equal(upstreamRequests, 1);
  } finally {
    await close(proxy);
    await close(upstream);
    store.close();
  }
});

test('a request is priced from the declarations it was checked against, even if the file breaks while it is in flight (PR #146 review)', async () => {
  setPriceOverride('acme-inflight', { kind: 'rate', input: '2', output: '8' });
  const upstream = http.createServer((_req, res) => {
    // Someone breaks the file while the provider is answering.
    writeFileSync(overridesPath(), '{ "version": 1, "models": { "x": { "kind": "rate" } } }');
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ model: 'acme-inflight', usage: { prompt_tokens: 1000, completion_tokens: 0 } }));
  });
  const upstreamBase = await listen(upstream);
  const config = structuredClone(DEFAULT_CONFIG);
  config.upstreams.openai = upstreamBase;
  const store = new Store(join(home, 'inflight.db'));
  const proxy = createProxyServer({ store, config });
  const proxyBase = await listen(proxy);
  try {
    const response = await fetch(`${proxyBase}/v1/chat/completions`, {
      method: 'POST',
      headers: { authorization: 'Bearer test', 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'acme-inflight', messages: [{ role: 'user', content: 'hello' }] }),
    });
    assert.equal(response.status, 200, 'the answer the provider charged for reaches the client');
    await response.text();
    await new Promise((resolve) => setTimeout(resolve, 100));
    const recorded = store.pricingEvidenceByModel(0, Date.now() + 60_000);
    assert.equal(recorded.length, 1, 'the charged request is in the ledger');
    assert.equal(recorded[0]!.requests, 1);
    assert.equal(recorded[0]!.costBasis, 'user_declared_price');
    assert.ok(Math.abs(recorded[0]!.costUsd - 0.002) < 1e-9, 'priced at the declaration it was checked against');
  } finally {
    await close(proxy);
    await close(upstream);
    store.close();
    rmSync(overridesPath(), { force: true });
  }
});

test('the sample data is priced from the card, whatever the user declared (PR #146 review)', () => {
  const now = Date.parse('2026-10-15T12:00:00Z');
  const seed = (name: string) => {
    const store = new Store(join(home, name));
    try { return seedDemo(store, { now }); } finally { store.close(); }
  };
  const plain = seed('demo-plain.db');
  setPriceOverride('gpt-4o', { kind: 'free' });
  setPriceOverride('claude-sonnet-4-6', { kind: 'rate', input: '99', output: '99' });
  try {
    const declared = seed('demo-declared.db');
    assert.equal(declared.totalCostUsd, plain.totalCostUsd);
    assert.equal(declared.requests, plain.requests);
  } finally {
    removePriceOverride('gpt-4o');
    removePriceOverride('claude-sonnet-4-6');
  }
});

test.after(() => rmSync(home, { recursive: true, force: true }));

test('a period priced by your own prices is not claimed as complete list-price support (PR #146 review)', async () => {
  const { buildOverview } = await import('../src/dashboard/routes.ts');
  const { computeCost } = await import('../src/cost/pricing.ts');
  setPriceOverride('acme-support-7b', { kind: 'rate', input: '2', output: '8' });
  const store = new Store(join(home, 'support.db'));
  try {
    const usage = { inputTokens: 1_000_000, outputTokens: 0, cacheWriteTokens: 0, cacheReadTokens: 0, reasoningTokens: 0 };
    const c = computeCost('openai', 'acme-support-7b', usage);
    assert.equal(c.estimated, false, 'a declared price is resolved, so a reprice can write it');
    store.insertRequest({
      requestId: 'declared-1', sessionId: null, tsEpochMs: Date.now() - 60_000, provider: 'openai', model: 'acme-support-7b',
      project: 'p', taskWeight: 1, ...usage, costUsd: c.costUsd, estimated: c.estimated, streamed: false, statusCode: 200, durationMs: 1,
      pricing: c.pricing,
    });
    const support = buildOverview(store, structuredClone(DEFAULT_CONFIG), '30d').claimSupport;
    assert.equal(support.profile.monetaryBasis, 'mixed');
    assert.equal(support.profile.coverage, 'partial');
  } finally {
    store.close();
    removePriceOverride('acme-support-7b');
  }
});

test('one reprice plan prices every row from the same declarations, even if the file changes midway (PR #146 review)', async () => {
  const { withPricingSnapshot, computeCost } = await import('../src/cost/pricing.ts');
  const usage = { inputTokens: 1_000_000, outputTokens: 0, cacheWriteTokens: 0, cacheReadTokens: 0 };
  setPriceOverride('acme-snap', { kind: 'rate', input: '2', output: '8' });
  try {
    const [first, second] = withPricingSnapshot(() => {
      const a = computeCost('openai', 'acme-snap', usage).costUsd;
      setPriceOverride('acme-snap', { kind: 'rate', input: '5', output: '8' }); // another process, midway
      return [a, computeCost('openai', 'acme-snap', usage).costUsd];
    });
    assert.equal(first, 2);
    assert.equal(second, 2, 'the plan keeps the declarations it started with');
    assert.equal(computeCost('openai', 'acme-snap', usage).costUsd, 5, 'the next plan reads the new price');
  } finally {
    removePriceOverride('acme-snap');
  }
});

test('sample data never reads, shows or writes your real prices (PR #146 review)', async () => {
  const { computeCost } = await import('../src/cost/pricing.ts');
  const { activePriceOverrides } = await import('../src/cost/overrides.ts');
  const { handlePricingUnknown } = await import('../src/dashboard/routes.ts');
  setPriceOverride('acme-negotiated', { kind: 'rate', input: '0.5', output: '1' });
  const usage = { inputTokens: 1_000_000, outputTokens: 0, cacheWriteTokens: 0, cacheReadTokens: 0 };
  const store = new Store(join(home, 'demo-route.db'));
  process.env.SEGREANT_DEMO = '1';
  try {
    assert.deepEqual(Object.keys(activePriceOverrides()), []);
    assert.notEqual(computeCost('openai', 'acme-negotiated', usage).pricing.rateMatchKind, 'user_declared');
    let body = '';
    const res = { writeHead() { return this; }, setHeader() {}, end(chunk?: string) { body = chunk ?? ''; } };
    handlePricingUnknown({ res, store } as never);
    const payload = JSON.parse(body) as { declared: unknown[]; demo: boolean };
    assert.equal(payload.demo, true);
    assert.deepEqual(payload.declared, [], 'no real model name or rate reaches the sample screen');
    assert.throws(() => setPriceOverride('acme-demo-write', { kind: 'free' }), /Demo mode only shows sample data/);
  } finally {
    delete process.env.SEGREANT_DEMO;
    store.close();
  }
  assert.equal(computeCost('openai', 'acme-negotiated', usage).pricing.rateMatchKind, 'user_declared', 'outside the demo the price applies again');
  removePriceOverride('acme-negotiated');
});

test('value comparisons see each price you set as its own revision (PR #146 review)', async () => {
  const { computeCost } = await import('../src/cost/pricing.ts');
  const store = new Store(join(home, 'revisions.db'));
  const usage = { inputTokens: 1_000_000, outputTokens: 0, cacheWriteTokens: 0, cacheReadTokens: 0, reasoningTokens: 0 };
  const record = (id: string, at: number) => {
    const c = computeCost('openai', 'acme-eras', usage);
    store.insertRequest({ requestId: id, sessionId: null, tsEpochMs: at, provider: 'openai', model: 'acme-eras', project: 'p', taskWeight: 1,
      ...usage, costUsd: c.costUsd, estimated: c.estimated, streamed: false, statusCode: 200, durationMs: 1, pricing: c.pricing });
  };
  try {
    setPriceOverride('acme-eras', { kind: 'rate', input: '1', output: '2' });
    record('era-1', 1_000);
    setPriceOverride('acme-eras', { kind: 'rate', input: '4', output: '2' });
    record('era-2', 2_000);
    setPriceOverride('acme-eras', { kind: 'like', like: 'claude-haiku-4-5' });
    record('era-3', 3_000);
    setPriceOverride('acme-eras', { kind: 'like', like: 'claude-sonnet-4-6' });
    record('era-4', 4_000);
    const basis = store.modelPricingBasis(0, 10_000, 'acme-eras');
    assert.deepEqual(basis.costBases, ['user_declared_price']);
    assert.equal(basis.rateCardShas.length, 4, 'two typed prices and two like targets on one card are four revisions');
  } finally {
    store.close();
    removePriceOverride('acme-eras');
  }
});

test('a reprice prices cache writes at the duration they were recorded with (PR #146 review)', async () => {
  const { computeCost } = await import('../src/cost/pricing.ts');
  const { previewReprice } = await import('../src/cost/reprice.ts');
  const store = new Store(join(home, 'ttl-reprice.db'));
  const writes = { inputTokens: 0, outputTokens: 0, cacheWriteTokens: 1_000_000, cacheReadTokens: 0, reasoningTokens: 0 };
  const record = (id: string, ttl?: '5m' | '1h') => {
    const c = computeCost('openai', 'acme-ttl-reprice', { ...writes, ...(ttl ? { cacheWriteTtl: ttl } : {}) });
    store.insertRequest({ requestId: id, sessionId: null, tsEpochMs: 1_000, provider: 'openai', model: 'acme-ttl-reprice', project: 'p', taskWeight: 1,
      ...writes, ...(ttl ? { cacheWriteTtl: ttl } : {}), costUsd: c.costUsd, estimated: c.estimated, streamed: false, statusCode: 200, durationMs: 1, pricing: c.pricing });
  };
  try {
    record('one-hour', '1h');
    record('five-minute', '5m');
    record('not-recorded');
    setPriceOverride('acme-ttl-reprice', { kind: 'rate', input: '1', output: '2', cacheWrite: '1.25', cacheWrite1h: '2' });
    const plan = previewReprice(store);
    const after = Object.fromEntries(plan.updates.map((u) => [u.requestId, u.costUsd]));
    assert.equal(after['one-hour'], 2, 'a 1-hour write is priced at the 1-hour price');
    assert.equal(after['five-minute'], 1.25);
    assert.equal(after['not-recorded'], 1.25, 'an unrecorded duration is priced as it was first priced, at the 5-minute rate');
    assert.equal(plan.cacheDurationUnknown, 1, 'and the preview says how many rows that was');
  } finally {
    store.close();
    removePriceOverride('acme-ttl-reprice');
  }
});

test('an older ledger gains the cache-write duration column on open, with no guessed values (PR #146 review)', async () => {
  const path = join(home, 'pre-ttl.db');
  const old = new Store(path);
  old.insertRequest({ requestId: 'before-column', sessionId: null, tsEpochMs: 1_000, provider: 'openai', model: 'm', project: 'p', taskWeight: 1,
    inputTokens: 1, outputTokens: 1, cacheWriteTokens: 5, cacheReadTokens: 0, reasoningTokens: 0, costUsd: 0.1, estimated: true, streamed: false, statusCode: 200, durationMs: 1 });
  old.close();
  const { DatabaseSync } = await import('node:sqlite');
  const raw = new DatabaseSync(path);
  raw.exec('ALTER TABLE requests DROP COLUMN cache_write_ttl');
  raw.close();
  const reopened = new Store(path);
  reopened.close();
  const check = new DatabaseSync(path);
  const cols = check.prepare('PRAGMA table_info(requests)').all() as Array<{ name: string; notnull: number; dflt_value: string | null }>;
  const recorded = check.prepare("SELECT cache_write_ttl AS ttl FROM requests WHERE request_id = 'before-column'").get() as { ttl: string };
  check.close();
  const column = cols.find((c) => c.name === 'cache_write_ttl');
  assert.ok(column && column.notnull === 1 && column.dflt_value === "'legacy_unknown'", 'a NOT NULL column with the legacy sentinel, per the store contract');
  assert.equal(recorded.ttl, 'legacy_unknown', 'an older row says it predates the column; nothing is guessed');
});

test('a plan comparison counts list prices, never a price you set (PR #146 review)', async () => {
  const { computeCost } = await import('../src/cost/pricing.ts');
  const { importedListCost } = await import('../src/cli/planCmd.ts');
  const store = new Store(join(home, 'plan-compare.db'));
  const usage = { inputTokens: 1_000_000, outputTokens: 0, cacheWriteTokens: 0, cacheReadTokens: 0, reasoningTokens: 0 };
  try {
    const listed = computeCost('anthropic', 'claude-sonnet-4-6', usage).costUsd;
    setPriceOverride('claude-sonnet-4-6', { kind: 'free' });
    const c = computeCost('anthropic', 'claude-sonnet-4-6', usage);
    assert.equal(c.costUsd, 0);
    store.insertRequestIfNew({ requestId: 'plan-1', sessionId: null, tsEpochMs: 5_000, provider: 'anthropic', model: 'claude-sonnet-4-6', project: 'p', taskWeight: 1,
      ...usage, costUsd: c.costUsd, estimated: c.estimated, streamed: true, statusCode: 200, durationMs: null, pricing: c.pricing, source: 'claude-code', via: 'import' });
    assert.equal(importedListCost(store, 'claude-code', 0, 10_000), listed, 'the plan line still shows the list-price work done');
  } finally {
    store.close();
    removePriceOverride('claude-sonnet-4-6');
  }
});

test('a plan comparison leaves out a declared model the card has no exact price for (PR #146 review)', async () => {
  const { computeCost } = await import('../src/cost/pricing.ts');
  const { importedListWork } = await import('../src/cli/planCmd.ts');
  const store = new Store(join(home, 'plan-withhold.db'));
  const usage = { inputTokens: 1_000_000, outputTokens: 0, cacheWriteTokens: 0, cacheReadTokens: 0, reasoningTokens: 0 };
  try {
    const listed = computeCost('anthropic', 'claude-sonnet-4-6', usage);
    store.insertRequestIfNew({ requestId: 'plan-listed', sessionId: null, tsEpochMs: 5_000, provider: 'anthropic', model: 'claude-sonnet-4-6', project: 'p', taskWeight: 1,
      ...usage, costUsd: listed.costUsd, estimated: listed.estimated, streamed: true, statusCode: 200, durationMs: null, pricing: listed.pricing, source: 'claude-code', via: 'import' });
    setPriceOverride('acme-private-plan', { kind: 'rate', input: '2', output: '8' });
    const mine = computeCost('anthropic', 'acme-private-plan', usage);
    assert.equal(mine.pricing.costBasis, 'user_declared_price');
    store.insertRequestIfNew({ requestId: 'plan-private', sessionId: null, tsEpochMs: 5_000, provider: 'anthropic', model: 'acme-private-plan', project: 'p', taskWeight: 1,
      ...usage, costUsd: mine.costUsd, estimated: mine.estimated, streamed: true, statusCode: 200, durationMs: null, pricing: mine.pricing, source: 'claude-code', via: 'import' });
    const work = importedListWork(store, 'claude-code', 0, 10_000);
    assert.equal(work.listCostUsd, listed.costUsd, 'only the request with a published price counts as list-price work');
    assert.equal(work.withheldRequests, 1, 'and the one left out is counted, not priced at a guess');
  } finally {
    store.close();
    removePriceOverride('acme-private-plan');
  }
});

test('a reprice reports only the rows it wrote when another reprice wrote some first (PR #146 review)', async () => {
  const { computeCost } = await import('../src/cost/pricing.ts');
  const { applyReprice } = await import('../src/cost/reprice.ts');
  const path = join(home, 'reprice-race.db');
  const store = new Store(path);
  const usage = { inputTokens: 1_000_000, outputTokens: 0, cacheWriteTokens: 0, cacheReadTokens: 0, reasoningTokens: 0 };
  try {
    for (const id of ['race-1', 'race-2']) {
      const guess = computeCost('openai', 'acme-race', usage);
      store.insertRequest({ requestId: id, sessionId: null, tsEpochMs: 1_000, provider: 'openai', model: 'acme-race', project: 'p', taskWeight: 1,
        ...usage, costUsd: guess.costUsd, estimated: true, streamed: false, statusCode: 200, durationMs: 1, pricing: guess.pricing });
    }
    setPriceOverride('acme-race', { kind: 'rate', input: '2', output: '8' });
    // The other process commits between this one's plan and its write.
    const write = store.applyRepricedCosts.bind(store);
    store.applyRepricedCosts = (updates, at) => {
      const other = new Store(path);
      try { other.applyRepricedCosts(updates.filter((u) => u.requestId === 'race-1'), at); } finally { other.close(); }
      return write(updates, at);
    };
    const result = applyReprice(store);
    assert.equal(result.applied, true);
    assert.equal(result.repriceable, 1, 'only the row this reprice wrote');
    assert.equal(result.alreadyRepriced, 1, 'the other is named as already re-priced');
    assert.equal(result.totalAfterUsd, 2);
    assert.deepEqual(result.byModel.map((m) => m.rows), [1]);
  } finally {
    store.close();
    removePriceOverride('acme-race');
  }
});

// Last: it replaces the active card for this process.
test('a reprice plan never promises a row it cannot write exactly (PR #146 review)', async () => {
  const { computeCost, applyPricingManifest } = await import('../src/cost/pricing.ts');
  const { previewReprice, applyReprice } = await import('../src/cost/reprice.ts');
  const store = new Store(join(home, 'reprice-exact.db'));
  try {
    const usage = { inputTokens: 1_000_000, outputTokens: 0, cacheWriteTokens: 1_000, cacheReadTokens: 0, reasoningTokens: 0 };
    const guess = computeCost('openai', 'acme-custom-1', usage);
    assert.equal(guess.pricing.rateMatchKind, 'fallback');
    assert.ok(guess.exact, 'a proxied guess carries an exact economic amount');
    store.insertRequest({
      requestId: 'exact-guess', sessionId: null, tsEpochMs: Date.now() - 60_000, provider: 'openai', model: 'acme-custom-1',
      project: 'p', taskWeight: 1, ...usage, costUsd: guess.costUsd, estimated: true, streamed: false, statusCode: 200, durationMs: 1,
      pricing: guess.pricing, economicAmount: guess.exact!.total,
    });
    // A custom card that knows the model but states no decimal companions.
    const applied = applyPricingManifest(JSON.stringify({
      schema_version: 1, updated: '2026-10-01', currency: 'USD', unit: 'per_million_tokens',
      providers: { openai: { verified: false, models: { 'acme-custom-1': { input: 0.3, output: 1.2 } } } },
      fallbacks: { unknown: { input: 3, output: 15 } },
    }));
    assert.equal(applied.ok, true, applied.error ?? 'manifest refused');
    assert.equal(computeCost('openai', 'acme-custom-1', usage).exact, undefined);
    const plan = previewReprice(store);
    assert.equal(plan.repriceable, 0);
    assert.equal(plan.stillEstimated, 1);
    assert.equal(plan.cacheDurationUnknown, 0, 'a row the plan leaves untouched is not said to be priced at the 5-minute rate');
    assert.doesNotThrow(() => applyReprice(store), 'apply writes exactly what the preview promised');
  } finally {
    store.close();
  }
});

test('the prices file is private to its owner, on every write (PR #146 review)', { skip: process.platform === 'win32' ? 'POSIX modes only' : false }, () => {
  const old = process.umask(0o022);
  try {
    setPriceOverride('acme-private-a', { kind: 'free' });
    assert.equal(statSync(overridesPath()).mode & 0o777, 0o600, 'first write');
    setPriceOverride('acme-private-b', { kind: 'rate', input: '1', output: '2' });
    assert.equal(statSync(overridesPath()).mode & 0o777, 0o600, 'replacement');
  } finally {
    process.umask(old);
    removePriceOverride('acme-private-a');
    removePriceOverride('acme-private-b');
  }
});

test('an edit that keeps the file size and timestamp is still read (PR #146 review)', async () => {
  const { loadPriceOverrides } = await import('../src/cost/overrides.ts');
  const { readFileSync, utimesSync } = await import('node:fs');
  try {
    setPriceOverride('acme-same-size', { kind: 'rate', input: '1', output: '2' });
    const path = overridesPath();
    const fixed = new Date('2026-01-01T00:00:00Z'); // whole seconds survive every filesystem's precision
    utimesSync(path, fixed, fixed);
    assert.equal((loadPriceOverrides().models['acme-same-size'] as { input: string }).input, '1');
    const mtimeMs = statSync(path).mtimeMs;
    const before = readFileSync(path, 'utf8');
    const after = before.replace('"input": "1"', '"input": "9"');
    assert.equal(after.length, before.length, 'same size');
    writeFileSync(path, after);
    utimesSync(path, fixed, fixed);
    assert.equal(statSync(path).mtimeMs, mtimeMs, 'same timestamp');
    assert.equal((loadPriceOverrides().models['acme-same-size'] as { input: string }).input, '9', 'the new price, not the cached one');
  } finally {
    removePriceOverride('acme-same-size');
  }
});

test('a prices file the process cannot reach refuses rather than reading as empty (PR #146 review)', {
  skip: process.platform === 'win32' ? 'POSIX permissions only' : process.getuid?.() === 0 ? 'root reads through permissions' : false,
}, async () => {
  const { loadPriceOverrides, PriceOverridesError } = await import('../src/cost/overrides.ts');
  const { chmodSync } = await import('node:fs');
  const { dirname } = await import('node:path');
  setPriceOverride('acme-unreachable', { kind: 'rate', input: '1', output: '2' });
  const dir = dirname(overridesPath());
  chmodSync(dir, 0o000);
  try {
    assert.throws(() => loadPriceOverrides(), (e: unknown) => e instanceof PriceOverridesError && /could not be read/.test((e as Error).message));
  } finally {
    chmodSync(dir, 0o700);
    removePriceOverride('acme-unreachable');
  }
});
