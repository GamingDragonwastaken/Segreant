import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// These exercise the refresh/override path against an isolated SEGREANT_HOME so the
// real ~/.segreant is never touched. node's test runner isolates each FILE in
// its own process, so the module-level pricing memo here can't leak elsewhere.
const origHome = process.env.SEGREANT_HOME;

function freshHome(): string {
  const dir = mkdtempSync(join(tmpdir(), 'segreant-pricing-'));
  process.env.SEGREANT_HOME = dir;
  return dir;
}

freshHome();
const {
  applyPricingManifest,
  computeCost,
  loadPricing,
  MAX_PRICING_MANIFEST_BYTES,
  pricingStatus,
  pricingCardProvenance,
  rateFor,
  refreshPricing,
  refreshPricingFromResponses,
  transformLiteLLMManifest,
} = await import('../src/cost/pricing.ts');
const { Store } = await import('../src/store/db.ts');

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
  assert.equal(computeCost('anthropic', 'claude-opus-4-8', {
    inputTokens: 1,
    outputTokens: 1,
    cacheWriteTokens: 0,
    cacheReadTokens: 0,
  }).exact, undefined, 'numeric-only refreshed cards must not be promoted into exact accounting');
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

const firstPartyEntries = {
  'deepseek/deepseek-chat': { litellm_provider: 'deepseek', mode: 'chat', input_cost_per_token: 0.28e-6, output_cost_per_token: 0.42e-6 },
  'mistral/mistral-small-latest': { litellm_provider: 'mistral', mode: 'chat', input_cost_per_token: 0.1e-6, output_cost_per_token: 0.3e-6 },
  'xai/grok-4.20-multi-agent-beta-0309': { litellm_provider: 'xai', mode: 'responses', input_cost_per_token: 1.25e-6, output_cost_per_token: 2.5e-6 },
  'dashscope/qwen-plus': { litellm_provider: 'dashscope', mode: 'chat', input_cost_per_token: 0.4e-6, output_cost_per_token: 1.2e-6 },
  'zai/glm-5': { litellm_provider: 'zai', mode: 'chat', input_cost_per_token: 1e-6, output_cost_per_token: 3.2e-6 },
  'perplexity/sonar': { litellm_provider: 'perplexity', mode: 'chat', input_cost_per_token: 1e-6, output_cost_per_token: 1e-6 },
  'command-r-08-2024': { litellm_provider: 'cohere_chat', mode: 'chat', input_cost_per_token: 0.15e-6, output_cost_per_token: 0.6e-6 },
};

test('litellm: per-token costs transform to exact per-1M rates, provider-mapped and prefix-stripped', () => {
  freshHome();
  const t = transformLiteLLMManifest(litellmFeed());
  assert.equal(t.ok, true);
  const f = t.file!;
  // Per-token → per-1M is exact, not float-noisy.
  // ...and every learned rate carries its decimal companion, so a first-sight
  // model reprices to an exact amount (PR #146 review).
  assert.deepEqual(f.providers['anthropic']!.models['claude-opus-4-8'], {
    input: 5, output: 25, cache_write_5m: 6.25, cache_read: 0.5,
    exact: { input: '5', output: '25', cache_write_5m: '6.25', cache_read: '0.5' },
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

test('litellm: first-party makers survive with bare model keys and unverified list prices', () => {
  freshHome();
  const transformed = transformLiteLLMManifest(litellmFeed(firstPartyEntries));
  assert.equal(transformed.ok, true);
  const expected = [
    ['deepseek', 'deepseek-chat', { input: 0.28, output: 0.42, exact: { input: '0.28', output: '0.42' } }],
    ['mistral', 'mistral-small-latest', { input: 0.1, output: 0.3, exact: { input: '0.1', output: '0.3' } }],
    ['xai', 'grok-4.20-multi-agent-beta-0309', { input: 1.25, output: 2.5, exact: { input: '1.25', output: '2.5' } }],
    ['dashscope', 'qwen-plus', { input: 0.4, output: 1.2, exact: { input: '0.4', output: '1.2' } }],
    ['zai', 'glm-5', { input: 1, output: 3.2, exact: { input: '1', output: '3.2' } }],
    ['perplexity', 'sonar', { input: 1, output: 1, exact: { input: '1', output: '1' } }],
    ['cohere', 'command-r-08-2024', { input: 0.15, output: 0.6, exact: { input: '0.15', output: '0.6' } }],
  ] as const;
  for (const [provider, model, rate] of expected) {
    assert.deepEqual(transformed.file!.providers[provider]?.models[model], rate, `${provider}/${model}`);
    assert.equal(transformed.file!.providers[provider]!.verified, false);
  }
  assert.equal(transformed.file!.providers.cohere_chat, undefined);
});

test('litellm: reseller and host prices, including Fireworks routes, are excluded', () => {
  freshHome();
  const hosts = [
    'fireworks_ai', 'together_ai', 'bedrock', 'bedrock_converse', 'azure', 'azure_ai',
    'openrouter', 'deepinfra', 'novita', 'vertex_ai', 'vertex_ai-language-models', 'groq',
  ];
  const entries = Object.fromEntries(hosts.map((host) => [
    `${host}/accounts/host/models/${host}-host-only`,
    { litellm_provider: host, mode: 'chat', input_cost_per_token: 9e-6, output_cost_per_token: 9e-6 },
  ]));
  const transformed = transformLiteLLMManifest(litellmFeed({ ...firstPartyEntries, ...entries }));
  assert.equal(transformed.ok, true);
  for (const host of hosts) {
    assert.equal(transformed.file!.providers[host], undefined);
    assert.equal(Object.values(transformed.file!.providers).some((p) => `${host}-host-only` in p.models), false);
  }
});

test('litellm: provider order and big-three collision priority are independent of feed key order', () => {
  const shadowRate = { litellm_provider: 'deepseek', mode: 'chat', input_cost_per_token: 99e-6, output_cost_per_token: 99e-6 };
  const entries = Object.entries(JSON.parse(litellmFeed({
    ...firstPartyEntries,
    'deepseek/claude-opus-4-8': shadowRate,
    'deepseek/gpt-4o': shadowRate,
    'deepseek/gemini-2.5-pro': shadowRate,
  })) as Record<string, unknown>);
  const expectedOrder = ['anthropic', 'openai', 'google', 'cohere', 'dashscope', 'deepseek', 'mistral', 'perplexity', 'xai', 'zai'];
  for (const ordered of [entries, [...entries].reverse()]) {
    freshHome();
    const raw = JSON.stringify(Object.fromEntries(ordered));
    const transformed = transformLiteLLMManifest(raw);
    assert.equal(transformed.ok, true);
    assert.deepEqual(Object.keys(transformed.file!.providers), expectedOrder);
    assert.equal(applyPricingManifest(raw).ok, true);
    assert.deepEqual(pricingStatus().providers, expectedOrder);
    for (const [route, model, provider, input] of [
      ['openai', 'claude-opus-4-8', 'anthropic', 5],
      ['anthropic', 'gpt-4o', 'openai', 2.5],
      ['openai', 'gemini-2.5-pro', 'google', 1.25],
    ] as const) {
      const resolved = rateFor(route, model);
      assert.equal(resolved.pricing.rateMatchKind, 'exact_cross_provider');
      assert.equal(resolved.pricing.rateMatchProvider, provider);
      assert.equal(resolved.rate.input, input);
    }
  }
});

test('litellm: DeepSeek on the OpenAI route resolves exactly against the transformed card', () => {
  freshHome();
  const applied = applyPricingManifest(litellmFeed(firstPartyEntries));
  assert.equal(applied.ok, true);
  assert.equal(applied.sourceKind, 'litellm_transformed');
  const resolved = rateFor('openai', 'deepseek-chat');
  assert.deepEqual(resolved.rate, { input: 0.28, output: 0.42, exact: { input: '0.28', output: '0.42' } });
  assert.equal(resolved.estimated, false);
  assert.equal(resolved.pricing.costBasis, 'local_list_price');
  assert.equal(resolved.pricing.rateMatchKind, 'exact_cross_provider');
  assert.equal(resolved.pricing.rateMatchProvider, 'deepseek');
  assert.equal(resolved.pricing.rateMatchModel, 'deepseek-chat');
  assert.equal(resolved.pricing.rateCardSourceKind, 'litellm_transformed');
  assert.equal(resolved.pricing.rateCardSha256, applied.cardSha256);
});

test('litellm: unchanged cross-provider family matching prices an R1 distill as DeepSeek R1', () => {
  freshHome();
  const applied = applyPricingManifest(litellmFeed({
    'deepseek/deepseek-r1': { litellm_provider: 'deepseek', mode: 'chat', input_cost_per_token: 0.55e-6, output_cost_per_token: 2.19e-6 },
    'fireworks_ai/accounts/fireworks/models/deepseek-r1-distill-qwen-32b': {
      litellm_provider: 'fireworks_ai', mode: 'chat', input_cost_per_token: 0.9e-6, output_cost_per_token: 0.9e-6,
    },
  }));
  assert.equal(applied.ok, true);
  // A distinct distilled model still contains the maker's short key. This
  // characterizes the existing heuristic; it does not endorse the guessed rate.
  const resolved = rateFor('openai', 'deepseek-ai/DeepSeek-R1-Distill-Qwen-32B');
  assert.deepEqual(resolved.rate, { input: 0.55, output: 2.19, exact: { input: '0.55', output: '2.19' } });
  assert.equal(resolved.estimated, true);
  assert.equal(resolved.pricing.rateMatchKind, 'family_cross_provider');
  assert.equal(resolved.pricing.rateMatchProvider, 'deepseek');
  assert.equal(resolved.pricing.rateMatchModel, 'deepseek-r1');
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

test('each accepted card retains immutable hash-bound provenance and coverage exposes it', () => {
  const home = freshHome();
  const first = applyPricingManifest(manifest(66), {
    sourceUrl: 'https://pricing.example.test/models.json?private=never-display',
    sourceKind: 'native_manifest',
    fetchedAt: '2026-08-29T10:00:00.000Z',
    etag: '"card-v1"',
  });
  assert.equal(first.ok, true);
  const firstSha = first.cardSha256!;
  const firstProvenance = pricingCardProvenance(firstSha);
  assert.ok(firstProvenance);
  assert.equal(firstProvenance!.cardSha256, firstSha);
  assert.equal(firstProvenance!.sourceUrl, 'https://pricing.example.test/models.json');
  assert.equal(firstProvenance!.sourceUrlSha256?.length, 64);
  assert.equal(firstProvenance!.sourceKind, 'native_manifest');
  assert.equal(firstProvenance!.fetchedAt, '2026-08-29T10:00:00.000Z');
  assert.equal(firstProvenance!.etag, '"card-v1"');
  assert.equal(existsSync(join(home, 'pricing', 'cards', firstSha + '.provenance.json')), true);

  const second = applyPricingManifest(manifest(77), {
    sourceUrl: 'https://pricing.example.test/models.json?private=never-display',
    sourceKind: 'native_manifest',
    fetchedAt: '2026-08-29T11:00:00.000Z',
    etag: '"card-v2"',
  });
  assert.equal(second.ok, true);
  assert.deepEqual(pricingCardProvenance(firstSha), firstProvenance, 'a later card must not rewrite an earlier card provenance record');
  assert.equal(pricingCardProvenance(second.cardSha256!)!.etag, '"card-v2"');

  const store = new Store(':memory:');
  const cost = computeCost('anthropic', 'claude-opus-4-8', {
    inputTokens: 1_000,
    outputTokens: 100,
    cacheWriteTokens: 0,
    cacheReadTokens: 0,
  });
  store.insertRequest({
    requestId: 'card-provenance-request',
    sessionId: null,
    tsEpochMs: Date.now(),
    provider: 'anthropic',
    model: 'claude-opus-4-8',
    project: 'provenance',
    taskWeight: 1,
    inputTokens: 1_000,
    outputTokens: 100,
    cacheWriteTokens: 0,
    cacheReadTokens: 0,
    reasoningTokens: 0,
    costUsd: cost.costUsd,
    estimated: cost.estimated,
    streamed: true,
    statusCode: 200,
    durationMs: 1,
    pricing: cost.pricing,
  });
  const bucket = store.pricingEvidenceByModel(0, Date.now() + 1_000)[0]!;
  assert.equal(bucket.rateCardSha256, second.cardSha256);
  assert.equal(bucket.rateCardProvenance?.cardSha256, second.cardSha256);
  assert.equal(bucket.rateCardProvenance?.fetchedAt, '2026-08-29T11:00:00.000Z');
  store.close();
});

test('card provenance is rejected when its archive sidecar no longer matches the card identity', () => {
  const home = freshHome();
  const result = applyPricingManifest(manifest(88), {
    sourceUrl: 'https://pricing.example.test/models.json',
    sourceKind: 'native_manifest',
    fetchedAt: '2026-08-29T12:00:00.000Z',
  });
  assert.equal(result.ok, true);
  const sidecar = join(home, 'pricing', 'cards', result.cardSha256! + '.provenance.json');
  const body = JSON.parse(readFileSync(sidecar, 'utf8')) as Record<string, unknown>;
  body.cardSha256 = '0'.repeat(64);
  writeFileSync(sidecar, JSON.stringify(body), 'utf8');
  assert.equal(pricingCardProvenance(result.cardSha256!), null);
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
  let conditionalEtag: string | null = null;
  const target = 'https://pricing.example.test/models.json?private=never-display';
  const first = await refreshPricingFromResponses({
    url: target,
    responses: [new Response(litellmFeed(), {
      status: 200,
      headers: { etag: '"price-v1"', 'last-modified': 'Wed, 12 Aug 2026 00:00:00 GMT' },
    })],
    onRequest: (_url, init) => {
      assert.equal(init.purpose, 'pricing_refresh');
      assert.equal(init.dataClass, 'pricing_manifest');
      assert.equal(init.method, undefined);
    },
  });
  assert.equal(first.ok, true);
  assert.equal(first.sourceKind, 'litellm_transformed');
  assert.equal(first.sourceUrl, 'https://pricing.example.test/models.json');
  const before = pricingStatus();
  assert.equal(before.sourceKind, 'litellm_transformed');
  assert.equal(before.sourceUrl, 'https://pricing.example.test/models.json');
  assert.equal(before.freshnessBasis, 'local_fetch');

  const second = await refreshPricingFromResponses({
    url: target,
    responses: [new Response(null, { status: 304 })],
    onRequest: (_url, init) => { conditionalEtag = new Headers(init.headers).get('if-none-match'); },
  });
  assert.equal(second.ok, true);
  assert.equal(second.unchanged, true);
  assert.equal(second.cardSha256, first.cardSha256, '304 never rewrites the active rate card');
  assert.equal(conditionalEtag, '"price-v1"');

  const insecure = await refreshPricingFromResponses({
    url: 'http://pricing.example.test/models.json',
    responses: [],
  });
  assert.equal(insecure.ok, false);
  assert.match(insecure.error ?? '', /https/i);
});

test('an oversized remote manifest is refused before it can replace a verified card', async () => {
  freshHome();
  assert.equal(applyPricingManifest(manifest(73)).ok, true);
  const result = await refreshPricingFromResponses({
    url: 'https://pricing.example.test/too-large.json',
    responses: [new Response('{}', {
      status: 200,
      headers: { 'content-length': String(MAX_PRICING_MANIFEST_BYTES + 1) },
    })],
  });
  assert.equal(result.ok, false);
  assert.match(result.error ?? '', /byte limit/i);
  assert.equal(rateFor('anthropic', 'claude-opus-4-8').rate.input, 73);
});

test('default local_locked mode refuses a remote pricing refresh before DNS or dial', async () => {
  freshHome();
  const result = await refreshPricing('https://pricing.example.test/models.json');
  assert.equal(result.ok, false);
  assert.match(result.error ?? '', /local_locked permits only literal loopback/i);
});

test('default pricing transport refuses corrupt receipt history before DNS or socket creation', async () => {
  const home = freshHome();
  writeFileSync(join(home, 'egress-receipts.jsonl'), '{"version":1}\n', 'utf8');
  const result = await refreshPricing('https://pricing.example.test/models.json');
  assert.equal(result.ok, false);
  assert.equal(result.failureCode, 'egress_receipt_integrity_failed');
  assert.match(result.error ?? '', /repair\/restore.*receipt/i);
});

test.after(() => {
  if (origHome === undefined) delete process.env.SEGREANT_HOME;
  else process.env.SEGREANT_HOME = origHome;
});
