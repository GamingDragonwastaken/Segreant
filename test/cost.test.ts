import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeCost, rateFor } from '../src/cost/pricing.ts';
import { normalizeAnthropicUsage, normalizeOpenAIUsage } from '../src/proxy/usage.ts';

test('Anthropic rate is exact for a known model', () => {
  const { rate, estimated } = rateFor('anthropic', 'claude-opus-4-8');
  assert.equal(estimated, false);
  assert.equal(rate.input, 5);
  assert.equal(rate.output, 25);
});

test('unknown model falls back and is flagged estimated', () => {
  const { estimated } = rateFor('anthropic', 'totally-made-up-model');
  assert.equal(estimated, true);
});

test('heuristic match resolves a versioned id by family substring', () => {
  // An unknown dated suffix should still match the family by substring.
  const { rate, estimated } = rateFor('anthropic', 'claude-sonnet-4-6-20990101');
  assert.equal(rate.input, 3);
  assert.equal(estimated, true);
});

test('computeCost: Anthropic input+output+cacheWrite', () => {
  const usage = {
    inputTokens: 2000,
    outputTokens: 100,
    cacheWriteTokens: 500,
    cacheReadTokens: 0,
    cacheWriteTtl: '5m' as const,
  };
  const { costUsd } = computeCost('anthropic', 'claude-opus-4-8', usage);
  // 2000*5 + 100*25 + 500*6.25 = 10000 + 2500 + 3125 (per 1e6) = 0.015625
  assert.ok(Math.abs(costUsd - 0.015625) < 1e-9, `got ${costUsd}`);
});

test('computeCost: OpenAI uncached input excludes cached tokens', () => {
  const raw = {
    prompt_tokens: 1000,
    completion_tokens: 50,
    prompt_tokens_details: { cached_tokens: 200 },
    completion_tokens_details: { reasoning_tokens: 10 },
  };
  const usage = normalizeOpenAIUsage(raw);
  assert.equal(usage.inputTokens, 800);
  assert.equal(usage.cacheReadTokens, 200);
  assert.equal(usage.reasoningTokens, 10);
  const { costUsd } = computeCost('openai', 'gpt-4o', usage);
  // 800*2.5 + 50*10 + 200*1.25 = 2000 + 500 + 250 (per 1e6) = 0.00275
  assert.ok(Math.abs(costUsd - 0.00275) < 1e-9, `got ${costUsd}`);
});

test('Anthropic usage normalization keeps input uncached', () => {
  const usage = normalizeAnthropicUsage({
    input_tokens: 1000,
    output_tokens: 50,
    cache_read_input_tokens: 200,
    cache_creation_input_tokens: 0,
  });
  assert.equal(usage.inputTokens, 1000);
  assert.equal(usage.cacheReadTokens, 200);
  assert.equal(usage.cacheWriteTokens, 0);
});
