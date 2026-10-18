// The user's own requests to their provider are built in: a fresh install
// forwards to Anthropic and OpenAI without egress commands, in either mode.
// Everything else that would send data somewhere new stays locked.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { evaluateEgressPolicy, PROVIDER_RULE_ID_PREFIX } from '../src/egress/policy.ts';
import { DEFAULT_CONFIG } from '../src/config.ts';

const provider = { purpose: 'provider_inference', dataClass: 'provider_request', method: 'POST' } as const;
const LOCKED = { mode: 'local_locked' as const, rules: [] };
const CLOUD = { mode: 'controlled_cloud' as const, rules: [] };

test('a fresh install reaches the official provider APIs, in either mode', () => {
  assert.equal(DEFAULT_CONFIG.egress.mode, 'local_locked', 'the default stays locked for everything else');
  for (const config of [LOCKED, CLOUD]) {
    for (const [url, id] of [
      ['https://api.anthropic.com/v1/messages?beta=true', 'anthropic'],
      ['https://api.openai.com/v1/chat/completions', 'openai'],
      ['https://api.openai.com/v1/responses', 'openai'],
    ] as const) {
      const d = evaluateEgressPolicy(config, { ...provider, url });
      assert.equal(d.allowed, true, `${config.mode} ${url}`);
      assert.equal(d.ruleId, PROVIDER_RULE_ID_PREFIX + id);
      assert.equal(d.targetClass, 'controlled_cloud', 'the address must still resolve public');
    }
    assert.equal(evaluateEgressPolicy(config, { ...provider, method: 'GET', url: 'https://api.openai.com/v1/models' }).allowed, true);
  }
});

test('the built-in provider routes are exact: nothing else gets through them', () => {
  const denied = [
    { ...provider, url: 'http://api.openai.com/v1/chat/completions' },
    { ...provider, url: 'https://api.openai.com/admin' },
    { ...provider, url: 'https://api.openai.com.attacker.example/v1/chat/completions' },
    { ...provider, url: 'https://gateway.example.com/v1/chat/completions' },
    { ...provider, method: 'DELETE', url: 'https://api.openai.com/v1/files/x' },
    { ...provider, purpose: 'alert_delivery' as const, url: 'https://api.openai.com/v1/chat/completions' },
    { ...provider, dataClass: 'judge_structural_summary' as const, url: 'https://api.anthropic.com/v1/messages' },
  ];
  for (const intent of denied) {
    const d = evaluateEgressPolicy(LOCKED, intent as never);
    assert.equal(d.allowed, false, `${intent.method} ${intent.url} ${intent.purpose}/${intent.dataClass}`);
  }
});

test('a request to a provider that is not built in is refused with the one command that allows it', async () => {
  const home = mkdtempSync(join(tmpdir(), 'segreant-provider-refusal-'));
  const previous = process.env.SEGREANT_HOME;
  process.env.SEGREANT_HOME = home;
  const { createProxyServer } = await import('../src/proxy/server.ts');
  const { Store } = await import('../src/store/db.ts');
  const store = new Store(join(home, 'ledger.db'));
  const config = structuredClone(DEFAULT_CONFIG);
  config.upstreams.openai = 'https://gateway.example.com';
  const proxy = createProxyServer({ store, config });
  proxy.listen(0, '127.0.0.1');
  await once(proxy, 'listening');
  try {
    const response = await fetch(`http://127.0.0.1:${(proxy.address() as AddressInfo).port}/v1/chat/completions`, {
      method: 'POST',
      headers: { authorization: 'Bearer test', 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'gpt-4o', messages: [{ role: 'user', content: 'hi' }] }),
    });
    assert.equal(response.status, 403);
    const body = await response.json() as { error: { message: string; subcode: string } };
    assert.equal(body.error.subcode, 'policy_denied');
    assert.match(body.error.message, /https:\/\/gateway\.example\.com is not one of the built-in provider APIs/);
    assert.match(body.error.message, /segreant egress apply --apply --mode controlled_cloud --id gateway\.example\.com --purpose provider_inference --data-class provider_request --method POST --origin https:\/\/gateway\.example\.com --path-prefix \//);
  } finally {
    await new Promise<void>((resolve) => proxy.close(() => resolve()));
    store.close();
    if (previous === undefined) delete process.env.SEGREANT_HOME; else process.env.SEGREANT_HOME = previous;
    rmSync(home, { recursive: true, force: true });
  }
});

