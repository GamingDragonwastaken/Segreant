import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applyPricingManifest, loadPricing, MAX_PRICING_MANIFEST_BYTES, pricingStatus, rateFor, refreshPricing, transformLiteLLMManifest } from '../src/cost/pricing.ts';

// These exercise the refresh/override path against an isolated AEGIS_HOME so the
// real ~/.aegisflow is never touched. node's test runner isolates each FILE in
// its own process, so the module-level pricing memo here can't leak elsewhere.
const origHome = process.env.AEGIS_HOME;

function freshHome(): string {
  const dir = mkdtempSync(join(tmpdir(), 'aegis-pricing-'));
  process.env.AEGIS_HOME = dir;
  return dir;
}

function manifest(opusInput: number, updated = '2020-01-01'): string {
  return JSON.stringify({
    schema_version: 1,
    updated,
    currency: 'USD',
    unit: 'per_million_tokens',
    providers: {
      anthropic: { verified: true, models: { 'claude-opus-4-8': { input: opusInput, output: 25 } } },
    },
    fallbacks: { unknown: { input: 3, output: 15 } },
  });
}

test('a valid manifest is cached and then OVERRIDES the bundled table', () => {
  freshHome();
  const res = applyPricingManifest(manifest(999));
  assert.equal(res.ok, true);
  assert.equal(res.modelCount, 1);
  // The cache must now win: opus reads the cache's sentinel 999, not bundled $5.
  const { rate, estimated } = rateFor('anthropic', 'claude-opus-4-8');
  assert.equal(rate.input, 999);
  assert.equal(estimated, false);
  assert.equal(pricingStatus().source, 'cache');
});

test('a bad refresh never downgrades a good cache', () => {
  freshHome();
  assert.equal(applyPricingManifest(manifest(111)).ok, true);
  // Garbage JSON and valid-but-wrong-shape are both rejected...
  assert.equal(applyPricingManifest('{not json').ok, false);
  assert.equal(applyPricingManifest(JSON.stringify({ schema_version: 1, foo: 'bar' })).ok, false);
  // ...and the previously-good cache is still intact.
  assert.equal(rateFor('anthropic', 'claude-opus-4-8').rate.input, 111);
});

test('with no cache, loadPricing falls back to the bundled table', () => {
  freshHome(); // empty temp home → no cache file present
  loadPricing(true);
  assert.equal(pricingStatus().source, 'bundled');
  assert.equal(rateFor('anthropic', 'claude-opus-4-8').rate.input, 5); // the real bundled rate
});

test('pricingStatus distinguishes local accepted-cache freshness from a source-declared date', () => {
  freshHome();
  applyPricingManifest(manifest(5, '2000-01-01'));
  const st = pricingStatus(30);
  assert.equal(st.stale, false, 'a card accepted moments ago is locally fresh even when the native source declared an old date');
  assert.equal(st.freshnessBasis, 'local_fetch');
  assert.equal(st.upstreamDeclaredUpdated, '2000-01-01');
  assert.equal(st.cacheIntegrity, 'verified');
  assert.match(st.cardSha256, /^[a-f0-9]{64}$/);
  assert.ok(st.fetchedAt);
});

// ---- LiteLLM feed transformation (the autonomous-pricing path) ----

/** A LiteLLM-shaped price file: per-TOKEN costs, provider routing keys, mixed modes. */
function litellmFeed(extra: Record<string, unknown> = {}): string {
  const models: Record<string, unknown> = {
    sample_spec: { input_cost_per_token: 1, output_cost_per_token: 1, litellm_provider: 'anthropic' }, // must be skipped
    'claude-opus-4-8': {
      litellm_provider: 'anthropic', mode: 'chat',
      input_cost_per_token: 5e-6, output_cost_per_token: 25e-6,
      cache_creation_input_token_cost: 6.25e-6, cache_read_input_token_cost: 0.5e-6,
    },
    'gpt-4o': { litellm_provider: 'openai', mode: 'chat', input_cost_per_token: 2.5e-6, output_cost_per_token: 10e-6 },
    'gemini/gemini-2.5-pro': { litellm_provider: 'gemini', mode: 'chat', input_cost_per_token: 1.25e-6, output_cost_per_token: 10e-6 },
    'text-embedding-3-small': { litellm_provider: 'openai', mode: 'embedding', input_cost_per_token: 0.02e-6, output_cost_per_token: 0.02e-6 },
    'some-other-provider/model': { litellm_provider: 'bedrock', mode: 'chat', input_cost_per_token: 1e-6, output_cost_per_token: 2e-6 },
    ...extra,
  };
  // Pad with enough plausible chat models to clear the shape-sanity threshold.
  for (let i = 0; i < 8; i++) {
    models[`gpt-pad-${i}`] = { litellm_provider: 'openai', mode: 'chat', input_cost_per_token: 1e-6, output_cost_per_token: 2e-6 };
  }
  return JSON.stringify(models);
}

test('litellm: per-token costs transform to exact per-1M rates, provider-mapped and prefix-stripped', () => {
  freshHome();
  const t = transformLiteLLMManifest(litellmFeed());
  assert.equal(t.ok, true);
  const f = t.file!;
  // Per-token → per-1M is exact, not float-noisy.
  assert.deepEqual(f.providers['anthropic']!.models['claude-opus-4-8'], {
    input: 5, output: 25, cache_write_5m: 6.25, cache_read: 0.5,
  });
  assert.equal(f.providers['openai']!.models['gpt-4o']!.input, 2.5);
  // gemini routes map to our 'google' provider, with the route prefix stripped.
  assert.equal(f.providers['google']!.models['gemini-2.5-pro']!.input, 1.25);
  // Non-chat modes, unknown providers, and sample_spec are all excluded.
  assert.equal(f.providers['openai']!.models['text-embedding-3-small'], undefined);
  assert.equal(f.providers['bedrock' as 'openai'], undefined);
  // Community rates are honestly marked unverified; fallback carried from the current table.
  assert.equal(f.providers['anthropic']!.verified, false);
  assert.ok(f.fallbacks.unknown.input > 0);
});

test('litellm: applyPricingManifest auto-detects the feed and the cache then prices requests', () => {
  freshHome();
  const res = applyPricingManifest(litellmFeed());
  assert.equal(res.ok, true);
  assert.ok((res.modelCount ?? 0) >= 10);
  assert.equal(rateFor('anthropic', 'claude-opus-4-8').rate.input, 5);
  assert.equal(pricingStatus().source, 'cache');
});

test('litellm: a shape-shifted feed is refused and never touches the table', () => {
  freshHome();
  assert.equal(applyPricingManifest(manifest(222)).ok, true); // good native cache first
  // Valid JSON, but too few recognizable models → the transform refuses.
  const tiny = JSON.stringify({ 'gpt-4o': { litellm_provider: 'openai', mode: 'chat', input_cost_per_token: 1e-6, output_cost_per_token: 2e-6 } });
  const res = applyPricingManifest(tiny);
  assert.equal(res.ok, false);
  assert.match(res.error ?? '', /not recognized/);
  assert.equal(rateFor('anthropic', 'claude-opus-4-8').rate.input, 222, 'previous cache intact');
});

test('pricing manifest validation refuses impossible native rates and future dates without replacing the active card', () => {
  freshHome();
  assert.equal(applyPricingManifest(manifest(77)).ok, true);
  assert.equal(applyPricingManifest(manifest(88, '2099-01-01')).ok, false, 'a future declared card date is not credible freshness evidence');
  const zeroRate = JSON.parse(manifest(88)) as { providers: { anthropic: { models: { 'claude-opus-4-8': { input: number } } } } };
  zeroRate.providers.anthropic.models['claude-opus-4-8'].input = 0;
  const result = applyPricingManifest(JSON.stringify(zeroRate));
  assert.equal(result.ok, false);
  assert.match(result.error ?? '', /finite positive/i);
  assert.equal(rateFor('anthropic', 'claude-opus-4-8').rate.input, 77, 'the last verified card remains active');
});

test('accepted cards retain a hash-addressed local archive and verified provenance', () => {
  const home = freshHome();
  const result = applyPricingManifest(manifest(66));
  assert.equal(result.ok, true);
  assert.match(result.cardSha256 ?? '', /^[a-f0-9]{64}$/);
  assert.equal(existsSync(join(home, 'pricing', 'models.json')), true);
  assert.equal(existsSync(join(home, 'pricing', 'provenance.json')), true);
  assert.equal(existsSync(join(home, 'pricing', 'cards', `${result.cardSha256}.json`)), true);
  const status = pricingStatus();
  assert.equal(status.cacheIntegrity, 'verified');
  assert.equal(status.cardSha256, result.cardSha256);
});

test('a mismatched active cache recovers only the provenance-named archived card', () => {
  const home = freshHome();
  const original = applyPricingManifest(manifest(55));
  assert.equal(original.ok, true);
  // Model an interrupted/external replacement: active card changed, state and
  // immutable archive still name the last verified card.
  writeFileSync(join(home, 'pricing', 'models.json'), manifest(999), 'utf8');
  assert.equal(loadPricing(true).providers.anthropic!.models['claude-opus-4-8']!.input, 55);
  assert.equal(pricingStatus().cacheIntegrity, 'archive_recovered');
});

test('remote refresh is HTTPS-only, records a redacted source identity, and revalidates unchanged cards with ETag', async () => {
  freshHome();
  const originalFetch = globalThis.fetch;
  let conditionalEtag: string | null = null;
  let redirectMode: string | undefined;
  try {
    globalThis.fetch = (async (_input, init) => {
      redirectMode = init?.redirect;
      return new Response(litellmFeed(), {
      status: 200,
      headers: { etag: '"price-v1"', 'last-modified': 'Wed, 12 Aug 2026 00:00:00 GMT' },
      });
    }) as typeof fetch;
    const first = await refreshPricing('https://pricing.example.test/models.json?private=never-display');
    assert.equal(first.ok, true);
    assert.equal(first.sourceKind, 'litellm_transformed');
    assert.equal(first.sourceUrl, 'https://pricing.example.test/models.json');
    assert.equal(redirectMode, 'error', 'a pricing refresh cannot silently follow to another URL');
    const before = pricingStatus();
    assert.equal(before.sourceKind, 'litellm_transformed');
    assert.equal(before.sourceUrl, 'https://pricing.example.test/models.json');
    assert.equal(before.freshnessBasis, 'local_fetch');

    globalThis.fetch = (async (_input, init) => {
      conditionalEtag = new Headers(init?.headers).get('if-none-match');
      return new Response(null, { status: 304 });
    }) as typeof fetch;
    const second = await refreshPricing('https://pricing.example.test/models.json?private=never-display');
    assert.equal(second.ok, true);
    assert.equal(second.unchanged, true);
    assert.equal(second.cardSha256, first.cardSha256, '304 never rewrites the active rate card');
    assert.equal(conditionalEtag, '"price-v1"');

    let calls = 0;
    globalThis.fetch = (async () => { calls += 1; return new Response('{}'); }) as typeof fetch;
    const insecure = await refreshPricing('http://pricing.example.test/models.json');
    assert.equal(insecure.ok, false);
    assert.match(insecure.error ?? '', /https/i);
    assert.equal(calls, 0, 'insecure URL is rejected before an outbound request');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('an oversized remote manifest is refused before it can replace a verified card', async () => {
  freshHome();
  assert.equal(applyPricingManifest(manifest(73)).ok, true);
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = (async () => new Response('{}', {
      status: 200,
      headers: { 'content-length': String(MAX_PRICING_MANIFEST_BYTES + 1) },
    })) as typeof fetch;
    const result = await refreshPricing('https://pricing.example.test/too-large.json');
    assert.equal(result.ok, false);
    assert.match(result.error ?? '', /byte limit/i);
    assert.equal(rateFor('anthropic', 'claude-opus-4-8').rate.input, 73);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test.after(() => {
  if (origHome === undefined) delete process.env.AEGIS_HOME;
  else process.env.AEGIS_HOME = origHome;
});
