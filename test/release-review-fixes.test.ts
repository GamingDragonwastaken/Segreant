// Findings from the two independent reviews of the 0.2.0 candidate
// (2026-10-18), each pinned by the behaviour a user would meet.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';

const home = mkdtempSync(join(tmpdir(), 'segreant-rc-review-'));
process.env.SEGREANT_HOME = home;
const { Store } = await import('../src/store/db.ts');
const { computeCost, legacyPricingEvidence, unpricedPricingEvidence, cacheWriteDuration } = await import('../src/cost/pricing.ts');
const { previewReprice, applyReprice } = await import('../src/cost/reprice.ts');
const { normalizeAnthropicUsage } = await import('../src/proxy/usage.ts');
const { DEFAULT_CONFIG, mutateConfig, configPath } = await import('../src/config.ts');
const { providerEgressRefusalBody } = await import('../src/proxy/server.ts');
const { EgressError } = await import('../src/egress/transport.ts');
const { suggestOption } = await import('../src/cli/flags.ts');
const { upstreamAdvice } = await import('../src/cli/connectCmd.ts');
const { createDashboardServer } = await import('../src/dashboard/server.ts');

const usage = { inputTokens: 1_000_000, outputTokens: 0, cacheWriteTokens: 0, cacheReadTokens: 0, reasoningTokens: 0 };
const base = { sessionId: null, tsEpochMs: 1_000, project: 'p', taskWeight: 1, streamed: false, statusCode: 200, durationMs: 1 } as const;

test('a reprice event keeps the provenance it replaced', () => {
  const store = new Store(join(home, 'audit.db'));
  try {
    const before = { ...legacyPricingEvidence(), costBasis: 'fallback_estimate' as const, rateMatchKind: 'fallback' as const, rateCardSourceKind: 'bundled' as const, rateCardSha256: 'a'.repeat(64) };
    store.insertRequest({ ...base, requestId: 'audit', provider: 'anthropic', model: 'claude-opus-4-8', ...usage, costUsd: 18, estimated: true, pricing: before });
    applyReprice(store);
    const event = store.requestPriceEvents('audit')[0]!;
    assert.equal(event.previousPricing.costBasis, 'fallback_estimate', 'not legacy_unknown');
    assert.equal(event.previousPricing.rateMatchKind, 'fallback');
    assert.equal(event.previousPricing.rateCardSha256, 'a'.repeat(64));
  } finally { store.close(); }
});

test('a reprice never turns a request whose usage was not captured into a confirmed $0', () => {
  const store = new Store(join(home, 'unpriced.db'));
  try {
    const zero = { inputTokens: 0, outputTokens: 0, cacheWriteTokens: 0, cacheReadTokens: 0, reasoningTokens: 0 };
    store.insertRequest({ ...base, requestId: 'cut-off', provider: 'anthropic', model: 'claude-sonnet-4-6', ...zero, costUsd: 0, estimated: true, pricing: unpricedPricingEvidence() });
    const plan = previewReprice(store);
    assert.equal(plan.repriceable, 0);
    applyReprice(store);
    assert.equal(store.requestPriceEvents('cut-off').length, 0, 'the unknown cost stays unknown');
  } finally { store.close(); }
});

test('the cache-write duration is recorded only when it was observed', () => {
  assert.deepEqual(cacheWriteDuration(0, 0), { observed: false });
  assert.deepEqual(cacheWriteDuration(0, 10), { ttl: '1h', observed: true });
  assert.deepEqual(cacheWriteDuration(10, 0), { ttl: '5m', observed: true });
  assert.deepEqual(cacheWriteDuration(3, 10), { ttl: '1h', observed: false });
  const bare = normalizeAnthropicUsage({ input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 1_000_000 });
  assert.equal(bare.cacheWriteTtl, undefined, 'no breakdown: priced at the standard 5-minute rate');
  const priced = computeCost('anthropic', 'claude-sonnet-4-6', bare);
  assert.equal(priced.costUsd, computeCost('anthropic', 'claude-sonnet-4-6', { ...bare, cacheWriteTtl: '5m' }).costUsd);
  const store = new Store(join(home, 'ttl.db'));
  try {
    store.insertRequest({ ...base, requestId: 'bare', provider: 'anthropic', model: 'claude-sonnet-4-6', ...usage, cacheWriteTokens: 1_000_000, costUsd: priced.costUsd, estimated: false, pricing: priced.pricing });
    assert.equal(store.requestsInRange(0, 10_000)[0]!.cacheWriteTtl, undefined, 'stored as not recorded, not as a guess');
  } finally { store.close(); }
});

test('a config write that does not touch egress keeps a malformed egress section as it is', () => {
  const rule = { id: 'gw', enabled: true, purpose: 'provider_inference', dataClass: 'provider_request', method: 'POST', origin: 'https://gateway.example.com', pathPrefix: '/', extra: 1 };
  writeFileSync(configPath(), JSON.stringify({ egress: { mode: 'controlled_cloud', rules: [rule] } }));
  mutateConfig((c) => { c.budget.dailyUsd = 5; });
  const written = JSON.parse(readFileSync(configPath(), 'utf8'));
  assert.equal(written.budget.dailyUsd, 5);
  assert.deepEqual(written.egress, { mode: 'controlled_cloud', rules: [rule] }, 'the user\'s rule survives to be repaired');
  rmSync(configPath());
});

test('an invalid egress section refuses with the real repair, not a rule for a built-in API', () => {
  const refusal = new EgressError('policy_denied', 'the egress configuration is invalid');
  const body = providerEgressRefusalBody('openai', refusal, 'https://api.openai.com/v1/chat/completions', 'POST', 'invalid');
  assert.match(body, /egress section of config\.json is malformed/);
  assert.match(body, /--mode local_locked/);
  assert.doesNotMatch(body, /not one of the built-in provider APIs/);
});

test('connect explains each kind of upstream truthfully', () => {
  assert.equal(upstreamAdvice('https://api.openai.com/v1').ok, true);
  assert.match(upstreamAdvice('http://localhost:11434/v1').text, /this machine/);
  assert.match(upstreamAdvice('https://openrouter.ai/api/v1').text, /egress apply/);
  const lan = upstreamAdvice('http://192.168.1.50:8000/v1');
  assert.equal(lan.ok, false);
  assert.match(lan.text, /cannot be allowed as it is/);
  assert.doesNotMatch(lan.text, /official provider API/);
});

test('a mistyped --cache-write-1h is corrected to it, not to --cache-write', () => {
  assert.equal(suggestOption('cache-write-1'), 'cache-write-1h');
});

test('the sample data can show a reprice preview; only applying is refused', async () => {
  process.env.SEGREANT_DEMO = '1';
  const store = new Store(':memory:');
  const server = createDashboardServer({ store, config: structuredClone(DEFAULT_CONFIG), version: 'test' });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/reprice`;
  const post = (apply: boolean) => fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', 'x-segreant-local': '1' }, body: JSON.stringify({ apply }) });
  try {
    const preview = await post(false);
    assert.equal(preview.status, 200);
    assert.equal(((await preview.json()) as { demo: boolean }).demo, true);
    assert.equal((await post(true)).status, 409);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    store.close();
    process.env.SEGREANT_DEMO = '';
  }
});

test('storing a rate without cache prices says how its cache is priced', async () => {
  const { spawnSync } = await import('node:child_process');
  const scratch = mkdtempSync(join(home, 'declare-'));
  const run = (...args: string[]) => spawnSync(process.execPath, ['--experimental-strip-types', '--no-warnings', 'src/cli.ts', 'pricing', 'set', ...args], { encoding: 'utf8', env: { ...process.env, SEGREANT_HOME: scratch } });
  const bare = run('acme-cache-note', '--input', '1', '--output', '2');
  assert.equal(bare.status, 0, bare.stderr);
  assert.match(bare.stdout, /5-minute cache writes at 1\.25×, 1-hour cache writes at 2×, cache reads at 0\.1×/);
  const full = run('acme-cache-full', '--input', '1', '--output', '2', '--cache-write', '1.5', '--cache-write-1h', '2.5', '--cache-read', '0.2');
  assert.equal(full.status, 0, full.stderr);
  assert.doesNotMatch(full.stdout, /usual multiple/, 'nothing derived, nothing said');
});
