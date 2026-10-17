// The first-sight lookup: a model priced by a guess triggers one check of the
// public price list, outside the request's path, at most once an hour.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.SEGREANT_HOME = mkdtempSync(join(tmpdir(), 'segreant-first-sight-'));

const { createFirstSightWatcher, FIRST_SIGHT_MIN_INTERVAL_MS } = await import('../src/cost/firstSight.ts');
const { setPriceOverride, removePriceOverride } = await import('../src/cost/overrides.ts');
const { loadConfig, DEFAULT_CONFIG } = await import('../src/config.ts');
const { applyPricingManifest } = await import('../src/cost/pricing.ts');

/** Stand-in for a refreshed card: the public list now prices these models exactly. */
function cardKnows(...models: string[]): void {
  const applied = applyPricingManifest(JSON.stringify({
    schema_version: 1, updated: '2026-10-01', currency: 'USD', unit: 'per_million_tokens',
    providers: { openai: { verified: false, models: Object.fromEntries(models.map((m) => [m, { input: 0.1, output: 0.5 }])) } },
    fallbacks: { unknown: { input: 3, output: 15 } },
  }));
  assert.equal(applied.ok, true, applied.error ?? 'manifest refused');
}

function harness(opts: { enabled?: boolean; lastChecked?: number | null; ok?: boolean; learn?: string } = {}) {
  let clock = 1_000_000_000_000;
  const calls: number[] = [];
  const learned: string[][] = [];
  const failed: string[] = [];
  const watcher = createFirstSightWatcher({
    enabled: () => opts.enabled ?? true,
    now: () => clock,
    lastCheckedMs: () => opts.lastChecked ?? null,
    refresh: async () => {
      calls.push(clock);
      if (opts.learn) cardKnows(opts.learn);
      return opts.ok === false ? { ok: false, error: 'network unreachable' } : { ok: true };
    },
    onLearned: (models) => learned.push(models.map((m) => m.model)),
    onFailed: (e) => failed.push(e),
  });
  return { watcher, calls, learned, failed, advance: (ms: number) => { clock += ms; } };
}

test('an exactly priced request triggers nothing', async () => {
  const h = harness();
  h.watcher.note('anthropic', 'claude-haiku-4-5', 'exact_provider');
  h.watcher.note('anthropic', 'x', 'user_declared');
  await h.watcher.idle();
  assert.equal(h.calls.length, 0);
});

test('a guessed price triggers one lookup, and the learned model is reported', async () => {
  const h = harness({ learn: 'acme-new-1' });
  h.watcher.note('openai', 'acme-new-1', 'fallback');
  h.watcher.note('openai', 'acme-new-1', 'fallback');
  h.watcher.note('openai', 'acme-other', 'family_cross_provider');
  await h.watcher.idle();
  assert.equal(h.calls.length, 1, 'one lookup for a burst of sightings');
  assert.deepEqual(h.learned, [['acme-new-1']], 'only the model the list now knows is reported');
});

test('at most one lookup an hour, and none right after a recent card check', async () => {
  const h = harness();
  h.watcher.note('openai', 'acme-a', 'fallback');
  await h.watcher.idle();
  h.watcher.note('openai', 'acme-b', 'fallback');
  await h.watcher.idle();
  assert.equal(h.calls.length, 1);
  h.advance(FIRST_SIGHT_MIN_INTERVAL_MS);
  h.watcher.note('openai', 'acme-b', 'fallback');
  await h.watcher.idle();
  assert.equal(h.calls.length, 2, 'the next interval looks again');

  const recent = harness({ lastChecked: 1_000_000_000_000 - 60_000 });
  recent.watcher.note('openai', 'acme-c', 'fallback');
  await recent.watcher.idle();
  assert.equal(recent.calls.length, 0, 'the card was checked a minute ago');
});

test('turned off, it never looks anything up', async () => {
  const h = harness({ enabled: false });
  h.watcher.note('openai', 'acme-d', 'fallback');
  await h.watcher.idle();
  assert.equal(h.calls.length, 0);
});

test('a model first seen while a lookup runs is answered by that lookup (PR #146 review)', async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const learned: string[][] = [];
  let calls = 0;
  const watcher = createFirstSightWatcher({
    enabled: () => true,
    lastCheckedMs: () => null,
    refresh: async () => {
      calls += 1;
      await gate;
      cardKnows('acme-during');
      return { ok: true };
    },
    onLearned: (models) => learned.push(models.map((m) => m.model)),
  });
  watcher.note('openai', 'acme-before', 'fallback');
  watcher.note('openai', 'acme-during', 'fallback');
  release();
  await watcher.idle();
  assert.equal(calls, 1);
  assert.deepEqual(learned, [['acme-during']], 'the model sighted mid-lookup is reported once the card prices it');
});

test('a price declared while a lookup runs is not announced as the public list knowing it (PR #146 review)', async () => {
  const learned: string[][] = [];
  const watcher = createFirstSightWatcher({
    enabled: () => true,
    lastCheckedMs: () => null,
    refresh: async () => {
      // The user declares a price meanwhile; the refreshed card still lacks the model.
      setPriceOverride('acme-mine', { kind: 'rate', input: '1', output: '2' });
      cardKnows('acme-listed');
      return { ok: true };
    },
    onLearned: (models) => learned.push(models.map((m) => m.model)),
  });
  watcher.note('openai', 'acme-mine', 'fallback');
  watcher.note('openai', 'acme-listed', 'fallback');
  await watcher.idle();
  assert.deepEqual(learned, [['acme-listed']], 'only a card match is the list\'s answer');
  removePriceOverride('acme-mine');
});

test('a failed lookup is reported and leaves the estimate standing', async () => {
  const h = harness({ ok: false });
  h.watcher.note('openai', 'acme-e', 'fallback');
  await h.watcher.idle();
  assert.deepEqual(h.failed, ['network unreachable']);
  assert.equal(h.learned.length, 0);
});

test('the lookup is on by default, and a config without the key gets the default', () => {
  assert.equal(DEFAULT_CONFIG.pricing.lookupUnknownModels, true);
  assert.equal(loadConfig().pricing.lookupUnknownModels, true);
});
