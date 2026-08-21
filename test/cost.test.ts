import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Isolate from any user-level rate-card override (~/.aegisflow/pricing/models.json):
// these tests assert bundled-table pricing, and a developer's own `pricing --refresh`
// must not change what they see. Each test file runs in its own process, so this is airtight.
process.env.FISCUS_HOME = mkdtempSync(join(tmpdir(), 'aegis-home-'));

import { computeCost, rateFor } from '../src/cost/pricing.ts';
import { normalizeAnthropicUsage, normalizeOpenAIUsage } from '../src/proxy/usage.ts';

test('Anthropic rate is exact for a known model', () => {
  const { rate, estimated, pricing } = rateFor('anthropic', 'claude-opus-4-8');
  assert.equal(estimated, false);
  assert.equal(rate.input, 5);
  assert.equal(rate.output, 25);
  assert.equal(pricing.costBasis, 'local_list_price');
  assert.equal(pricing.rateCardSourceKind, 'bundled');
  assert.equal(pricing.rateMatchKind, 'exact_provider');
  assert.equal(pricing.rateMatchProvider, 'anthropic');
  assert.equal(pricing.rateMatchModel, 'claude-opus-4-8');
  assert.match(pricing.rateCardSha256!, /^[a-f0-9]{64}$/);
});

test('unknown model falls back with explicit local-card evidence', () => {
  const { estimated, pricing } = rateFor('anthropic', 'totally-made-up-model');
  assert.equal(estimated, true);
  assert.equal(pricing.costBasis, 'fallback_estimate');
  assert.equal(pricing.rateMatchKind, 'fallback');
  assert.equal(pricing.rateMatchProvider, null);
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

test('computeCost: OpenAI Responses API shape (input_tokens) normalizes identically to Chat Completions', () => {
  // Same figures as the prompt_tokens-shape test above, in the Responses API's
  // field names — proves input_tokens is read as inclusive-of-cache too, and
  // that reasoning_tokens is picked up from output_tokens_details.
  const raw = {
    input_tokens: 1000,
    output_tokens: 50,
    input_tokens_details: { cached_tokens: 200 },
    output_tokens_details: { reasoning_tokens: 10 },
  };
  const usage = normalizeOpenAIUsage(raw);
  assert.equal(usage.inputTokens, 800);
  assert.equal(usage.cacheReadTokens, 200);
  assert.equal(usage.reasoningTokens, 10);
  const { costUsd } = computeCost('openai', 'gpt-4o', usage);
  assert.ok(Math.abs(costUsd - 0.00275) < 1e-9, `got ${costUsd}`);
});

test('normalizeOpenAIUsage: an empty Responses-shape usage object never crosses into the Chat Completions branch', () => {
  // output_tokens: 0 is falsy but must still select the Responses shape via
  // `!== undefined` — a `if (u.output_tokens)` truthiness check would wrongly
  // fall through to reading (undefined) prompt_tokens instead.
  const usage = normalizeOpenAIUsage({ input_tokens: 500, output_tokens: 0 });
  assert.equal(usage.inputTokens, 500);
  assert.equal(usage.outputTokens, 0);
});

test('Gemini on the OpenAI-compatible path: exact rate by model, not estimated', () => {
  // A request to Google's .../v1beta/openai/ base arrives on the OpenAI path,
  // but the model id is a Gemini one. The price must follow the MODEL: an exact
  // cross-provider id match is an exact price, so estimated stays false.
  const { rate, estimated, pricing } = rateFor('openai', 'gemini-2.5-flash');
  assert.equal(estimated, false);
  assert.equal(rate.input, 0.3);
  assert.equal(rate.output, 2.5);
  assert.equal(pricing.rateMatchKind, 'exact_cross_provider');
  assert.equal(pricing.rateMatchProvider, 'google');
});

test('Flash-Lite resolves to its own rate, not Flash (longest key wins)', () => {
  const { rate } = rateFor('openai', 'gemini-2.5-flash-lite');
  assert.equal(rate.input, 0.1); // not 0.3 — must not collapse into "...flash"
  assert.equal(rate.output, 0.4);
});

test('A dated Gemini id matches its family across providers, flagged estimated', () => {
  const { rate, estimated, pricing } = rateFor('openai', 'gemini-2.5-flash-preview-09-2026');
  assert.equal(rate.input, 0.3);
  assert.equal(estimated, true); // family (substring) match, not an exact id
  assert.equal(pricing.rateMatchKind, 'family_cross_provider');
  assert.equal(pricing.rateMatchProvider, 'google');
});

test('Native OpenAI model still resolves in its own provider (no cross-provider drift)', () => {
  const { rate, estimated } = rateFor('openai', 'gpt-4o');
  assert.equal(estimated, false);
  assert.equal(rate.input, 2.5);
});

test('computeCost prices a Gemini request carried on the OpenAI path', () => {
  const usage = {
    inputTokens: 10_000,
    outputTokens: 2_000,
    cacheWriteTokens: 0,
    cacheReadTokens: 0,
  };
  const { costUsd, estimated } = computeCost('openai', 'gemini-2.5-flash', usage);
  // 10000*0.30 + 2000*2.50 = 3000 + 5000 (per 1e6) = 0.008
  assert.ok(Math.abs(costUsd - 0.008) < 1e-9, `got ${costUsd}`);
  assert.equal(estimated, false);
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
