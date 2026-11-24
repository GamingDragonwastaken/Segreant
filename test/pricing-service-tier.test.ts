/**
 * A provider charges more for a request served at priority or fast service and
 * less for flex or batch. At the standard rate a priority request reads at half
 * its price, and so does the cap that counts it.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.SEGREANT_HOME = mkdtempSync(join(tmpdir(), 'segreant-home-'));
import { computeCost, serviceTierNamed, transformLiteLLMManifest, type ServiceTier } from '../src/cost/pricing.ts';
import { formatMoneyAmount } from '../src/economics/money.ts';
import { normalizeAnthropicUsage, normalizeOpenAIUsage, StreamUsageAccumulator } from '../src/proxy/usage.ts';
import { parseTranscriptLine } from '../src/connect/claudeCode.ts';
import { importCodex } from '../src/connect/codex.ts';
import { previewReprice } from '../src/cost/reprice.ts';
import { Store } from '../src/store/db.ts';

const usage = (inputTokens: number, outputTokens: number, serviceTier?: ServiceTier) => ({ inputTokens, outputTokens, cacheWriteTokens: 0, cacheReadTokens: 0, ...(serviceTier === undefined ? {} : { serviceTier }) });
const near = (actual: number, expected: number): void => assert.ok(Math.abs(actual - expected) < 1e-9, `${actual} is not ${expected}`);

test('each service level takes its own rate, as a number and exactly', () => {
  // gpt-6-sol: $2/$10 standard, $4/$20 priority, $1/$5 flex.
  near(computeCost('openai', 'gpt-6-sol', usage(100_000, 1000)).costUsd, 0.21);
  near(computeCost('openai', 'gpt-6-sol', usage(100_000, 1000, 'standard')).costUsd, 0.21);
  near(computeCost('openai', 'gpt-6-sol', usage(100_000, 1000, 'flex')).costUsd, 0.105);
  const priority = computeCost('openai', 'gpt-6-sol', usage(100_000, 1000, 'priority'));
  near(priority.costUsd, 0.42);
  assert.equal(Number(formatMoneyAmount(priority.exact!.total)), 0.42);
  assert.equal(priority.estimated, false);
  // claude-opus-5-5: $4/$20, twice that in fast mode, half of it in a batch.
  near(computeCost('anthropic', 'claude-opus-5-5', usage(100_000, 1000, 'fast')).costUsd, 0.84);
  near(computeCost('anthropic', 'claude-opus-5-5', usage(100_000, 1000, 'batch')).costUsd, 0.21);
});

test('a long prompt takes the long-prompt rate of its own service level', () => {
  near(computeCost('openai', 'gpt-6-sol', usage(300_000, 1000, 'priority')).costUsd, (300_000 * 8 + 1000 * 30) / 1e6);
});

test('a service level with no known price is an estimate at the standard rate', () => {
  for (const tier of ['other', 'batch'] as const) {
    const c = computeCost('openai', 'gpt-6-sol', usage(100_000, 1000, tier));
    near(c.costUsd, 0.21);
    assert.deepEqual([c.estimated, c.pricing.rateMatchKind], [true, 'standard_rate_assumed'], tier);
  }
});

test('names for a service level', () => {
  assert.deepEqual(['default', 'standard', 'priority', 'FLEX', 'batch', 'scale', 'auto', '', null, 3].map(serviceTierNamed),
    ['standard', 'standard', 'priority', 'flex', 'batch', 'other', undefined, undefined, undefined, undefined]);
});

test('the price list gives every level a response can name, cache prices moving with input', () => {
  const entry = (litellm_provider: string, extra: object) => ({ litellm_provider, mode: 'chat', input_cost_per_token: 2e-6, output_cost_per_token: 1e-5, cache_read_input_token_cost: 2e-7, ...extra });
  const feed: Record<string, unknown> = {};
  for (let i = 0; i < 80; i++) feed[`gpt-filler-${i}`] = entry('openai', {});
  feed['gpt-t'] = entry('openai', {
    input_cost_per_token_priority: 4e-6, output_cost_per_token_priority: 2e-5,
    input_cost_per_token_above_272k_tokens: 4e-6, output_cost_per_token_above_272k_tokens: 1.5e-5,
    input_cost_per_token_above_272k_tokens_priority: 8e-6, output_cost_per_token_above_272k_tokens_priority: 3e-5,
    input_cost_per_token_batches: 1e-6, output_cost_per_token_batches: 5e-6,
  });
  feed['claude-t'] = entry('anthropic', { provider_specific_entry: { fast: 6, us: 1.1 }, input_cost_per_token_batches: 1e-6, output_cost_per_token_batches: 5e-6 });
  const out = transformLiteLLMManifest(JSON.stringify(feed));
  const gpt = out.file!.providers.openai!.models['gpt-t']!;
  assert.deepEqual(Object.keys(gpt.service_tiers!), ['priority'], 'an OpenAI answer never names a batch');
  const p = gpt.service_tiers!.priority!;
  assert.deepEqual([p.input, p.output, p.cache_read, p.exact!.cache_read], [4, 20, 0.4, '0.4']);
  assert.deepEqual(p.above!.map((t) => [t.prompt_tokens, t.input, t.output, t.cache_read]), [[272_000, 8, 30, 0.8]]);
  assert.deepEqual(gpt.above!.map((t) => [t.prompt_tokens, t.input, t.output]), [[272_000, 4, 15]], 'the standard long-prompt rate is untouched');
  const claude = out.file!.providers.anthropic!.models['claude-t']!.service_tiers!;
  assert.deepEqual([claude.fast!.input, claude.fast!.output, claude.fast!.cache_read, claude.batch!.input], [12, 60, 1.2, 1]);
});

test('the proxy reads the level from each provider, whole and streamed', () => {
  assert.equal(normalizeOpenAIUsage({ prompt_tokens: 1, completion_tokens: 1 }, 'priority').serviceTier, 'priority');
  assert.equal(normalizeOpenAIUsage({ input_tokens: 1, output_tokens: 1 }, 'fast').serviceTier, 'priority');
  assert.equal('serviceTier' in normalizeOpenAIUsage({ input_tokens: 1, output_tokens: 1 }), false);
  assert.equal(normalizeAnthropicUsage({ input_tokens: 1, service_tier: 'standard', speed: 'fast' }).serviceTier, 'fast');
  assert.equal(normalizeAnthropicUsage({ input_tokens: 1, service_tier: 'batch' }).serviceTier, 'batch');

  const streamed = (provider: 'openai' | 'anthropic', ...events: object[]) => {
    const acc = new StreamUsageAccumulator(provider);
    for (const e of events) acc.push(`data: ${JSON.stringify(e)}\n\n`);
    acc.end();
    return acc.usage;
  };
  // Chat Completions names it in every chunk; the usage chunk is the last.
  assert.equal(streamed('openai', { service_tier: 'priority', choices: [] }, { choices: [], usage: { prompt_tokens: 5, completion_tokens: 2 } }).serviceTier, 'priority');
  // Responses: what was asked for first, what was served at the end.
  assert.equal(streamed('openai', { response: { service_tier: 'priority' } }, { response: { service_tier: 'default', usage: { input_tokens: 5, output_tokens: 2 } } }).serviceTier, 'standard');
  assert.equal(streamed('anthropic', { type: 'message_start', message: { usage: { input_tokens: 5, service_tier: 'standard', speed: 'fast' } } }, { type: 'message_delta', usage: { output_tokens: 2 } }).serviceTier, 'fast');
});

test('a Claude Code line names its level', () => {
  const line = (u: object) => parseTranscriptLine(JSON.stringify({ type: 'assistant', requestId: 'r', timestamp: '2026-11-20T10:00:00Z', message: { model: 'claude-opus-5-5', usage: { input_tokens: 1, output_tokens: 1, ...u } } }))!;
  assert.equal(line({ service_tier: 'standard', speed: 'standard' }).serviceTier, 'standard');
  assert.equal(line({ service_tier: 'standard', speed: 'fast' }).serviceTier, 'fast');
  assert.equal(line({}).serviceTier, undefined);
});

const THREAD = '01a09c97-1058-7451-8461-e7e0d16685b2';

function codexRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'codex-tier-'));
  const day = join(root, 'sessions', '2026', '09', '22');
  mkdirSync(day, { recursive: true });
  const settings = (tier: string | null) => ({ type: 'event_msg', payload: { type: 'thread_settings_applied', thread_settings: { service_tier: tier } } });
  const count = (input: number) => ({ type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { input_tokens: input, cached_input_tokens: 0, output_tokens: 0 } } } });
  const lines = [
    { type: 'session_meta', payload: { id: THREAD, cwd: '/work/app', model_provider: 'openai', model: 'gpt-6-sol' } },
    count(100_000), settings('priority'), count(200_000), settings('default'), count(300_000), settings(null), count(400_000),
  ].map((l, i) => JSON.stringify({ timestamp: `2026-09-22T10:0${i}:00.000Z`, ...l }));
  writeFileSync(join(day, `rollout-2026-09-22T10-00-00-${THREAD}.jsonl`), lines.join('\n') + '\n');
  return root;
}

test('a Codex request is priced at the level its session was set to when it ran', async () => {
  const store = new Store(':memory:');
  await importCodex(store, { root: codexRoot() });
  const rows = store.requestsInRange(0, Date.now()).sort((a, b) => a.tsEpochMs - b.tsEpochMs);
  assert.deepEqual(rows.map((r) => [r.serviceTier, Number(r.costUsd.toFixed(6))]), [[undefined, 0.2], ['priority', 0.4], ['standard', 0.2], [undefined, 0.2]]);
  store.close();
});

test('a request recorded before the level was read is corrected from its own log, once', async () => {
  const root = codexRoot();
  const store = new Store(':memory:');
  await importCodex(store, { root });
  const total = (): number => store.summary(0, Date.now()).costUsd;
  const right = total();
  // What an earlier version left: the standard price and no level.
  store.raw().prepare("UPDATE requests SET service_tier = 'legacy_unknown', cost_usd = 0.2").run();
  near(total(), 0.8);
  assert.equal((await importCodex(store, { root, rescan: true })).completedObservations, 1, 'only the one whose price differs');
  near(total(), right);
  assert.equal((await importCodex(store, { root, rescan: true })).completedObservations ?? 0, 0);
  store.close();
});

test('a level with no price stays an estimate when repriced, and a stray stored one is refused', () => {
  const store = new Store(':memory:');
  const c = computeCost('openai', 'gpt-6-sol', usage(100_000, 1000, 'other'));
  store.insertRequest({
    requestId: 'r1', sessionId: null, tsEpochMs: 1000, provider: 'openai', model: 'gpt-6-sol', project: 'p', taskWeight: 1,
    inputTokens: 100_000, outputTokens: 1000, cacheWriteTokens: 0, cacheReadTokens: 0, reasoningTokens: 0, serviceTier: 'other',
    costUsd: c.costUsd, economicAmount: c.exact!.total, estimated: c.estimated, pricing: c.pricing, streamed: false, statusCode: 200, durationMs: null,
  });
  const plan = previewReprice(store);
  assert.deepEqual([plan.estimatedRows, plan.stillEstimated], [1, 1]);
  store.raw().prepare("UPDATE requests SET service_tier = 'bogus'").run();
  assert.throws(() => store.requestsInRange(0, Date.now()), /serviceTier/);
  store.close();
});
