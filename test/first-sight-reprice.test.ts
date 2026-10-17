// The first-sight workflow end to end: a request for a model the card does not
// know is recorded through the proxy at the bundled fallback (an exact amount),
// the public list is learned, and `reprice --apply` must then succeed with an
// exact replacement (PR #146 review: the transform carried no exact companion).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.SEGREANT_HOME = mkdtempSync(join(tmpdir(), 'segreant-first-sight-reprice-'));
delete process.env.SEGREANT_DB;
delete process.env.SEGREANT_DEMO;

const { createProxyServer } = await import('../src/proxy/server.ts');
const { Store } = await import('../src/store/db.ts');
const { DEFAULT_CONFIG } = await import('../src/config.ts');
const { rateFor, refreshPricingFromResponses } = await import('../src/cost/pricing.ts');
const { applyReprice, previewReprice } = await import('../src/cost/reprice.ts');

const MODEL = 'acme-firstsight-9';

function feed(): string {
  const entries: Record<string, unknown> = {
    [MODEL]: { litellm_provider: 'openai', mode: 'chat', input_cost_per_token: 1e-7, output_cost_per_token: 5e-7, cache_read_input_token_cost: 1e-8 },
  };
  // The transform refuses a feed with fewer than ten usable models.
  for (let i = 0; i < 12; i++) entries[`filler-${i}`] = { litellm_provider: 'openai', mode: 'chat', input_cost_per_token: 1e-6, output_cost_per_token: 2e-6 };
  return JSON.stringify(entries);
}

test('a model learned from the public list reprices to an exact amount', async () => {
  const upstream = http.createServer(async (req, res) => {
    req.resume();
    await once(req, 'end');
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ id: 'c', object: 'chat.completion', model: MODEL,
      choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 1000, completion_tokens: 200, total_tokens: 1200 } }));
  });
  upstream.listen(0, '127.0.0.1');
  await once(upstream, 'listening');
  const config = structuredClone(DEFAULT_CONFIG);
  config.upstreams.openai = `http://127.0.0.1:${(upstream.address() as { port: number }).port}`;
  const store = new Store(':memory:');
  const proxy = createProxyServer({ store, config });
  proxy.listen(0, '127.0.0.1');
  await once(proxy, 'listening');
  try {
    const r = await fetch(`http://127.0.0.1:${(proxy.address() as { port: number }).port}/v1/chat/completions`, {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer sk-test' },
      body: JSON.stringify({ model: MODEL, messages: [{ role: 'user', content: 'hi' }] }),
    });
    assert.equal(r.status, 200);
    await r.text();
    await new Promise((done) => setTimeout(done, 100));
    assert.equal(rateFor('openai', MODEL).pricing.rateMatchKind, 'fallback');

    const learned = await refreshPricingFromResponses({ url: 'https://pricing.example.test/litellm.json', responses: [new Response(feed(), { status: 200 })] });
    assert.equal(learned.ok, true, learned.error ?? 'refresh failed');
    const now = rateFor('openai', MODEL);
    assert.equal(now.estimated, false);
    assert.equal(now.rate.exact?.input, '0.1', 'the learned rate carries its decimal companion');

    const preview = previewReprice(store);
    assert.equal(preview.repriceable, 1);
    const applied = applyReprice(store);
    assert.equal(applied.repriceable, 1, 'apply succeeds instead of refusing for want of an exact amount');
    assert.ok(Math.abs(applied.totalAfterUsd - 0.0002) < 1e-12, `1,000 in at $0.10 + 200 out at $0.50 per 1M = $0.0002 (got ${applied.totalAfterUsd})`);
  } finally {
    proxy.closeAllConnections?.();
    await new Promise<void>((done) => proxy.close(() => done()));
    upstream.closeAllConnections?.();
    await new Promise<void>((done) => upstream.close(() => done()));
    store.close();
  }
});
