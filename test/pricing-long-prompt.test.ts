/**
 * A provider may charge a whole request more once its prompt passes a length.
 * Pricing such a request at the short-prompt rate understates it several times
 * over, and a cap counts what the price says.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.SEGREANT_HOME = mkdtempSync(join(tmpdir(), 'segreant-home-'));
import { applyPricingManifest, computeCost, loadPricing, transformLiteLLMManifest } from '../src/cost/pricing.ts';
import { formatMoneyAmount } from '../src/economics/money.ts';

const usage = (inputTokens: number, cacheReadTokens: number, outputTokens: number, cacheWriteTokens = 0) => ({ inputTokens, outputTokens, cacheWriteTokens, cacheReadTokens });

test('the prompt that decides the rate is input, cache reads and cache writes together', () => {
  // claude-haiku-5-5: $0.10/$0.50, cache read $0.01; past 100,000 prompt tokens $0.50/$2.50 and $0.05.
  const at = computeCost('anthropic', 'claude-haiku-5-5', usage(10_000, 90_000, 1000));
  assert.ok(Math.abs(at.costUsd - (0.001 + 0.0009 + 0.0005)) < 1e-12, 'exactly 100,000 is still a short prompt');
  const over = computeCost('anthropic', 'claude-haiku-5-5', usage(10_000, 80_000, 1000, 10_001));
  assert.ok(Math.abs(over.costUsd - (0.005 + 0.004 + 0.0025 + 10_001 * 0.625 / 1e6)) < 1e-12);
  assert.equal(over.estimated, false);
});

test('the exact amount follows the same rate as the number', () => {
  const c = computeCost('openai', 'gpt-6.1-sol', usage(300_000, 0, 1000));
  assert.ok(Math.abs(c.costUsd - (300_000 * 4 + 1000 * 15) / 1e6) < 1e-9);
  assert.equal(Number(formatMoneyAmount(c.exact!.total)), 1.215);
});

test('a model with one price for every length is unaffected', () => {
  const short = computeCost('anthropic', 'claude-opus-5-5', usage(1000, 0, 0));
  const long = computeCost('anthropic', 'claude-opus-5-5', usage(500_000, 0, 0));
  assert.ok(Math.abs(long.costUsd - short.costUsd * 500) < 1e-9);
});

test('a row too long to be one prompt is several requests, at the standard rate', () => {
  const lump = computeCost('openai', 'gpt-6.1-sol', usage(5_000_000, 100_000_000, 0));
  assert.ok(Math.abs(lump.costUsd - (5 * 2 + 100 * 0.1)) < 1e-9);
});

test('the public list\'s long-prompt prices are read, and a cache price it leaves out rises with input', () => {
  const filler = Object.fromEntries(Array.from({ length: 10 }, (_, i) => [`m${i}`, { litellm_provider: 'openai', mode: 'chat', input_cost_per_token: 1e-6, output_cost_per_token: 2e-6 }]));
  const r = transformLiteLLMManifest(JSON.stringify({
    ...filler,
    'gemini/long': {
      litellm_provider: 'gemini', mode: 'chat', input_cost_per_token: 1e-6, output_cost_per_token: 4e-6, cache_read_input_token_cost: 1e-7,
      input_cost_per_token_above_200k_tokens: 2e-6, output_cost_per_token_above_200k_tokens: 6e-6,
      input_cost_per_token_above_200k_tokens_batches: 9e-6, cache_creation_input_token_cost_above_1hr: 8e-6,
    },
  }));
  const rate = r.file!.providers['google']!.models['long']!;
  assert.equal(rate.cache_write_1h, 8);
  assert.deepEqual(rate.above, [{ prompt_tokens: 200_000, input: 2, output: 6, cache_write_1h: 16, cache_read: 0.2, exact: { input: '2', output: '6', cache_write_1h: '16', cache_read: '0.2' } }]);
});

test('a card with unordered or non-positive long-prompt rates is refused', () => {
  const card = structuredClone(loadPricing());
  const model = card.providers['anthropic']!.models['claude-haiku-5-5']!;
  const refused = (above: unknown): string => {
    (model as { above?: unknown }).above = above;
    const r = applyPricingManifest(JSON.stringify(card));
    assert.equal(r.ok, false);
    return r.error ?? '';
  };
  assert.match(refused([{ prompt_tokens: 200, input: 1, output: 1 }, { prompt_tokens: 100, input: 1, output: 1 }]), /increasing/);
  assert.match(refused([{ prompt_tokens: 100, input: 0, output: 1 }]), /positive/);
  assert.match(refused({}), /not a list/);
});
