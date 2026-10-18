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
    assert.match(body.error.message, /segreant egress apply --apply --mode controlled_cloud --id provider-gateway-example-com-[0-9a-f]{8}-post --purpose provider_inference --data-class provider_request --method POST --origin https:\/\/gateway\.example\.com --path-prefix \//);
  } finally {
    await new Promise<void>((resolve) => proxy.close(() => resolve()));
    store.close();
    if (previous === undefined) delete process.env.SEGREANT_HOME; else process.env.SEGREANT_HOME = previous;
    rmSync(home, { recursive: true, force: true });
  }
});

test('the printed command is one the egress command accepts, and it then allows the provider (PR #148 review)', async () => {
  const { providerRuleCommand, providerRuleId } = await import('../src/egress/policy.ts');
  const { validateEgressRule } = await import('../src/egress/ruleValidation.ts');
  for (const host of ['gateway.example.com', 'openrouter.ai', 'My-Proxy.Internal.Example.ORG', 'a.b', `${'x'.repeat(80)}.example.com`, '1api.example.com']) {
    const id = providerRuleId(host, 'POST');
    const rule = { id, enabled: true, purpose: 'provider_inference', dataClass: 'provider_request', method: 'POST', origin: `https://${host.toLowerCase()}`, pathPrefix: '/' };
    assert.deepEqual(validateEgressRule(rule as never), [], `${host} -> ${id}`);
  }
  // Run the printed command for real, in a scratch home.
  const home = mkdtempSync(join(tmpdir(), 'segreant-provider-rule-'));
  const previous = process.env.SEGREANT_HOME;
  process.env.SEGREANT_HOME = home;
  try {
    const command = providerRuleCommand('https://gateway.example.com/v1/chat/completions')!;
    const argv = command.split(' ').slice(1);
    const { spawnSync } = await import('node:child_process');
    const run = spawnSync(process.execPath, ['--experimental-strip-types', '--no-warnings', 'src/cli.ts', ...argv], { encoding: 'utf8', env: { ...process.env, SEGREANT_HOME: home } });
    assert.equal(run.status, 0, run.stdout + run.stderr);
    const { loadConfig } = await import('../src/config.ts');
    const config = loadConfig();
    const d = evaluateEgressPolicy(config.egress, { ...provider, url: 'https://gateway.example.com/v1/chat/completions' });
    assert.equal(d.allowed, true, 'the provider is allowed once the printed command has run');
    assert.equal(d.ruleId, providerRuleId('gateway.example.com', 'POST'));
    // The GET command adds its own rule and keeps the POST one.
    const get = providerRuleCommand('https://gateway.example.com/v1/models', 'GET')!;
    const second = spawnSync(process.execPath, ['--experimental-strip-types', '--no-warnings', 'src/cli.ts', ...get.split(' ').slice(1)], { encoding: 'utf8', env: { ...process.env, SEGREANT_HOME: home } });
    assert.equal(second.status, 0, second.stdout + second.stderr);
    const both = loadConfig().egress;
    assert.equal(evaluateEgressPolicy(both, { ...provider, url: 'https://gateway.example.com/v1/chat/completions' }).allowed, true, 'POST still allowed');
    assert.equal(evaluateEgressPolicy(both, { ...provider, method: 'GET', url: 'https://gateway.example.com/v1/models' }).allowed, true, 'GET allowed too');
  } finally {
    if (previous === undefined) delete process.env.SEGREANT_HOME; else process.env.SEGREANT_HOME = previous;
    rmSync(home, { recursive: true, force: true });
  }
});

test('a running proxy follows an egress change in config.json on the next request, with no restart (PR #148 review)', async () => {
  const { liveBudget } = await import('../src/proxy/server.ts');
  const dir = mkdtempSync(join(tmpdir(), 'segreant-live-egress-'));
  try {
    const path = join(dir, 'config.json');
    const { writeFileSync } = await import('node:fs');
    writeFileSync(path, '{}');
    const config = structuredClone(DEFAULT_CONFIG);
    const rule = { id: 'provider-gateway-example-com-x1-post', enabled: true, purpose: 'provider_inference', dataClass: 'provider_request', method: 'POST', origin: 'https://gateway.example.com', pathPrefix: '/' };
    const onDisk = { ...structuredClone(DEFAULT_CONFIG), egress: { mode: 'controlled_cloud', rules: [rule] } };
    const read = liveBudget(config, { intervalMs: 0, path: () => path, load: () => onDisk as never });
    read();
    assert.equal(evaluateEgressPolicy(config.egress, { ...provider, url: 'https://gateway.example.com/v1/chat/completions' }).allowed, true,
      'the rule written by another process governs the running proxy');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('generated rule ids never collide across hosts, and stay valid however long the host (PR #148 review)', async () => {
  const { providerRuleId } = await import('../src/egress/policy.ts');
  const { validateEgressRule } = await import('../src/egress/ruleValidation.ts');
  const hosts = ['api.foo-bar.com', 'api.foo.bar.com', `${'x'.repeat(70)}.one.example.com`, `${'x'.repeat(70)}.two.example.com`];
  const ids = hosts.map((h) => providerRuleId(h, 'POST'));
  assert.equal(new Set(ids).size, hosts.length, ids.join(' '));
  for (const [i, id] of ids.entries()) {
    assert.deepEqual(validateEgressRule({ id, enabled: true, purpose: 'provider_inference', dataClass: 'provider_request', method: 'POST', origin: `https://${hosts[i]}`, pathPrefix: '/' } as never), [], id);
  }
});

test('a malformed egress section refuses even the built-in provider routes until it is repaired (PR #148 review)', async () => {
  const home = mkdtempSync(join(tmpdir(), 'segreant-egress-invalid-'));
  const previous = process.env.SEGREANT_HOME;
  process.env.SEGREANT_HOME = home;
  try {
    const { writeFileSync } = await import('node:fs');
    const { loadConfig, configPath } = await import('../src/config.ts');
    const official = { ...provider, url: 'https://api.openai.com/v1/chat/completions' };
    for (const broken of [{ mode: 'controled_cloud', rules: [] }, { mode: 'controlled_cloud', rules: {} }, { mode: 'local_locked', rules: [], extra: 1 }, 'local_locked']) {
      writeFileSync(configPath(), JSON.stringify({ egress: broken }));
      const egress = loadConfig().egress;
      assert.equal(egress.mode, 'invalid', JSON.stringify(broken));
      assert.equal(evaluateEgressPolicy(egress, official).allowed, false, `a typo never lets provider traffic through: ${JSON.stringify(broken)}`);
    }
    writeFileSync(configPath(), JSON.stringify({ port: 8090 }));
    assert.equal(loadConfig().egress.mode, 'local_locked', 'an absent section is the default');
    assert.equal(evaluateEgressPolicy(loadConfig().egress, official).allowed, true);
  } finally {
    if (previous === undefined) delete process.env.SEGREANT_HOME; else process.env.SEGREANT_HOME = previous;
    rmSync(home, { recursive: true, force: true });
  }
});
