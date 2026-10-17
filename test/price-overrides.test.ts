// Prices the user declares for models no rate card knows (the pricing ladder's
// first rung): a private model, a local model that costs nothing, or a new model
// the public list has not caught up with.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const home = mkdtempSync(join(tmpdir(), 'segreant-overrides-'));
process.env.SEGREANT_HOME = home;

const { computeCost, rateFor } = await import('../src/cost/pricing.ts');
const { loadPriceOverrides, overridesPath, removePriceOverride, setPriceOverride, PriceOverridesError } = await import('../src/cost/overrides.ts');
const { summarizeBasis } = await import('../src/cost/basis.ts');
const { formatMoneyAmount } = await import('../src/economics/money.ts');

const usage = { inputTokens: 1_000_000, outputTokens: 1_000_000, cacheWriteTokens: 0, cacheReadTokens: 0 };

test('an unknown model falls to the generic rate until a price is declared', () => {
  rmSync(join(home, 'pricing'), { recursive: true, force: true });
  const before = rateFor('openai', 'acme-private-7b');
  assert.equal(before.pricing.rateMatchKind, 'fallback');
  assert.equal(before.estimated, true);
});

test('a declared rate prices the model exactly, under its own basis', () => {
  setPriceOverride('acme-private-7b', { kind: 'rate', input: '0.2', output: '0.8' });
  const c = computeCost('openai', 'acme-private-7b', usage);
  assert.equal(c.estimated, false, 'a declared price is resolved, not a guess');
  assert.equal(c.pricing.costBasis, 'user_declared_price');
  assert.equal(c.pricing.rateMatchKind, 'user_declared');
  assert.equal(c.costUsd, 1.0);
  assert.equal(formatMoneyAmount(c.exact!.total), '1');
  assert.equal(c.exact!.total.basis, 'estimated', 'never recorded as a list price');
});

test('a "like" declaration follows the named model on the card, and only an exact card match', () => {
  setPriceOverride('acme-haiku-proxy', { kind: 'like', like: 'claude-haiku-4-5' });
  const like = rateFor('anthropic', 'acme-haiku-proxy');
  assert.equal(like.pricing.rateMatchKind, 'user_declared');
  assert.equal(like.pricing.rateMatchModel, 'claude-haiku-4-5');
  assert.equal(like.rate.input, rateFor('anthropic', 'claude-haiku-4-5').rate.input);
  setPriceOverride('acme-ghost', { kind: 'like', like: 'no-such-model-anywhere' });
  assert.equal(rateFor('anthropic', 'acme-ghost').pricing.rateMatchKind, 'fallback', 'a like that no longer resolves is not a price');
});

test('a free (local) model costs exactly zero and does not turn a list total into an estimate', () => {
  setPriceOverride('llama3.1:8b', { kind: 'free' });
  const c = computeCost('openai', 'llama3.1:8b', usage);
  assert.equal(c.costUsd, 0);
  assert.equal(formatMoneyAmount(c.exact!.total), '0');
  const listed = computeCost('anthropic', 'claude-haiku-4-5', usage);
  const summary = summarizeBasis([
    { provider: 'anthropic', model: 'claude-haiku-4-5', costBasis: listed.pricing.costBasis, rateMatchKind: listed.pricing.rateMatchKind, costUsd: listed.costUsd, requests: 1 },
    { provider: 'openai', model: 'llama3.1:8b', costBasis: c.pricing.costBasis, rateMatchKind: c.pricing.rateMatchKind, costUsd: 0, requests: 3 },
  ]);
  assert.equal(summary.headline, 'list_cost');
  assert.ok(summary.cohorts.some((x) => x.id === 'user_declared' && x.requests === 3));
});

test('a nonzero declared price makes the headline an estimate, never "list cost"', () => {
  const c = computeCost('openai', 'acme-private-7b', usage);
  const summary = summarizeBasis([{ provider: 'openai', model: 'acme-private-7b', costBasis: c.pricing.costBasis, rateMatchKind: c.pricing.rateMatchKind, costUsd: c.costUsd, requests: 1 }]);
  assert.equal(summary.headline, 'estimated_cost');
});

test('a declared price wins over the card, and removing it restores the card', () => {
  setPriceOverride('claude-haiku-4-5', { kind: 'rate', input: '9', output: '9' });
  assert.equal(rateFor('anthropic', 'claude-haiku-4-5').pricing.rateMatchKind, 'user_declared');
  assert.equal(removePriceOverride('claude-haiku-4-5'), true);
  assert.equal(rateFor('anthropic', 'claude-haiku-4-5').pricing.rateMatchKind, 'exact_provider');
  assert.equal(removePriceOverride('claude-haiku-4-5'), false);
});

test('a paid declaration under half a cent is still not list price (PR #146 review)', () => {
  const listed = computeCost('anthropic', 'claude-haiku-4-5', usage);
  const summary = summarizeBasis([
    { provider: 'anthropic', model: 'claude-haiku-4-5', costBasis: listed.pricing.costBasis, rateMatchKind: listed.pricing.rateMatchKind, costUsd: 1, requests: 1 },
    { provider: 'openai', model: 'acme-private-7b', costBasis: 'user_declared_price', rateMatchKind: 'user_declared', costUsd: 0.001, requests: 1 },
  ]);
  assert.equal(summary.headline, 'estimated_cost');
});

test('invalid declarations are refused with the reason', () => {
  assert.throws(() => setPriceOverride('m', { kind: 'rate', input: '0', output: '1' }), /input must be a positive decimal/);
  assert.throws(() => setPriceOverride('m', { kind: 'rate', input: '-1', output: '1' }), PriceOverridesError);
  assert.throws(() => setPriceOverride('m', { kind: 'rate', input: '1e3', output: '1' }), PriceOverridesError);
  assert.throws(() => setPriceOverride('m', { kind: 'like', like: 'm' }), /cannot be priced like itself/);
  assert.throws(() => setPriceOverride('__proto__', { kind: 'free' }), PriceOverridesError);
  assert.throws(() => setPriceOverride(' spaced', { kind: 'free' }), PriceOverridesError);
});

test('a hand-edited file that is broken is refused, not half-read', () => {
  mkdirSync(join(home, 'pricing'), { recursive: true });
  writeFileSync(overridesPath(), JSON.stringify({ version: 1, models: { x: { kind: 'rate', input: 'cheap', output: '1', declaredAt: '2026-10-17T00:00:00Z' } } }));
  assert.throws(() => loadPriceOverrides(), /x: input must be a positive decimal/);
  assert.throws(() => rateFor('openai', 'x'), PriceOverridesError, 'a cap must not silently lose a declared price');
  writeFileSync(overridesPath(), '﻿' + JSON.stringify({ version: 1, models: {} }));
  assert.deepEqual(Object.keys(loadPriceOverrides().models), [], 'a byte-order mark from Windows PowerShell is fine');
});
