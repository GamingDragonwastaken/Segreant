import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as http from 'node:http';
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { EgressConfig } from '../src/config.ts';
import { evaluateEgressPolicy, validateEgressRule } from '../src/egress/policy.ts';
import { egressReceiptPath, verifyEgressReceipts } from '../src/egress/receipts.ts';
import { EgressError, egressFetchWithConfig } from '../src/egress/transport.ts';

const LOCKED: EgressConfig = { mode: 'local_locked', rules: [] };

function cloudRule(): EgressConfig {
  return {
    mode: 'controlled_cloud',
    rules: [{
      id: 'openai-inference',
      enabled: true,
      purpose: 'provider_inference',
      dataClass: 'provider_request',
      method: 'POST',
      origin: 'https://api.openai.com',
      pathPrefix: '/v1/',
    }],
  };
}

test('local_locked refuses a cloud intent before it can be resolved or dialled', () => {
  const denied = evaluateEgressPolicy(LOCKED, {
    url: 'https://api.openai.com/v1/responses',
    purpose: 'provider_inference',
    dataClass: 'provider_request',
    method: 'POST',
  });
  assert.equal(denied.allowed, false);
  assert.match(denied.reason, /no non-loopback DNS lookup or dial/i);

  const local = evaluateEgressPolicy(LOCKED, {
    url: 'http://127.0.0.1:11434/v1/chat/completions',
    purpose: 'local_judge',
    dataClass: 'judge_structural_summary',
    method: 'POST',
  });
  assert.equal(local.allowed, true);
  assert.equal(local.targetClass, 'loopback');
});

test('controlled-cloud policy needs one exact enabled method/origin/path/data rule', () => {
  const cfg = cloudRule();
  const good = evaluateEgressPolicy(cfg, {
    url: 'https://api.openai.com/v1/responses?stream=true',
    purpose: 'provider_inference',
    dataClass: 'provider_request',
    method: 'POST',
  });
  assert.equal(good.allowed, true);
  assert.equal(good.ruleId, 'openai-inference');

  for (const changed of [
    { method: 'GET' },
    { purpose: 'pricing_refresh' },
    { dataClass: 'pricing_manifest' },
    { url: 'https://api.openai.com/other' },
    { url: 'http://api.openai.com/v1/responses' },
    { url: 'https://attacker.example/v1/responses' },
  ] as const) {
    const result = evaluateEgressPolicy(cfg, {
      url: changed.url ?? 'https://api.openai.com/v1/responses',
      purpose: changed.purpose ?? 'provider_inference',
      dataClass: changed.dataClass ?? 'provider_request',
      method: changed.method ?? 'POST',
    });
    assert.equal(result.allowed, false, JSON.stringify(changed));
  }
});

test('path prefixes authorize whole path segments, with root retaining root semantics', () => {
  const rule = cloudRule().rules[0]!;
  for (const [path, allowed] of [
    ['/v1', true],
    ['/v1/', true],
    ['/v1/responses', true],
    ['/v1/responses/stream', true],
    ['/v10/responses', false],
    ['/v1beta/responses', false],
  ] as const) {
    const result = evaluateEgressPolicy({
      mode: 'controlled_cloud',
      rules: [{ ...rule, pathPrefix: '/v1' }],
    }, {
      url: 'https://api.openai.com' + path,
      purpose: 'provider_inference',
      dataClass: 'provider_request',
      method: 'POST',
    });
    assert.equal(result.allowed, allowed, path);
  }

  for (const path of ['/anything', '/', '/v1beta']) {
    const result = evaluateEgressPolicy({
      mode: 'controlled_cloud',
      rules: [{ ...rule, pathPrefix: '/' }],
    }, {
      url: 'https://api.openai.com' + path,
      purpose: 'provider_inference',
      dataClass: 'provider_request',
      method: 'POST',
    });
    assert.equal(result.allowed, true, path);
  }
  assert.match(validateEgressRule({ ...rule, pathPrefix: '//' })[0]!, /pathPrefix/i);
  assert.match(validateEgressRule({ ...rule, pathPrefix: '/v1//' })[0]!, /pathPrefix/i);
});

test('controlled-cloud path authorization rejects encoded boundary ambiguity after one canonical decode', () => {
  const cfg = cloudRule();
  cfg.rules[0] = { ...cfg.rules[0]!, pathPrefix: '/v1' };
  const deniedPaths = [
    '/v1/%2fadmin',
    '/v1/%2Fadmin',
    '/v1/%5c..%5cadmin',
    '/v1/%5C..%5Cadmin',
    '/v1/%2E%2E%2Fadmin',
    '/v1/%2e%2e%2fadmin',
    '/v1/%2e%2e/admin',
    '/v1/%3fadmin',
    '/v1/%3Fadmin',
    '/v1/%23admin',
    '/v1/%00admin',
    '/v1/%1fadmin',
    '/v1/%7Fadmin',
    '/v1/%',
    '/v1/%2',
    '/v1/%GG',
    '/v1/%252fadmin',
    '/v1/%252Fadmin',
    '/v1/%255c..%255cadmin',
    '/v1/%252e%252e%252fadmin',
    '/v1/%252E%252E%252Fadmin',
    '/v1/%253fadmin',
    '/v1/%2523admin',
    '/v1/%257Euser',
  ] as const;

  for (const path of deniedPaths) {
    const result = evaluateEgressPolicy(cfg, {
      url: 'https://api.openai.com' + path,
      purpose: 'provider_inference',
      dataClass: 'provider_request',
      method: 'POST',
    });
    assert.equal(result.allowed, false, path);
  }

  for (const url of [
    'https://api.openai.com/v1/%7Euser',
    'https://api.openai.com/v1/%7euser/jobs',
    'https://api.openai.com/v1/responses?redirect=%2fadmin#client-fragment',
  ] as const) {
    const result = evaluateEgressPolicy(cfg, {
      url,
      purpose: 'provider_inference',
      dataClass: 'provider_request',
      method: 'POST',
    });
    assert.equal(result.allowed, true, url);
  }
});

test('configured and programmatic rule prefixes use the same canonical authorization path', () => {
  const rule = cloudRule().rules[0]!;
  const canonicalRule = { ...rule, pathPrefix: '/v1/%7Eteam/' };
  assert.deepEqual(validateEgressRule(canonicalRule), []);
  assert.equal(evaluateEgressPolicy({ mode: 'controlled_cloud', rules: [canonicalRule] }, {
    url: 'https://api.openai.com/v1/~team/jobs',
    purpose: 'provider_inference',
    dataClass: 'provider_request',
    method: 'POST',
  }).allowed, true);

  for (const pathPrefix of [
    '/v1/%2fadmin',
    '/v1/%5cadmin',
    '/v1/%2e%2e/admin',
    '/v1/%3fadmin',
    '/v1/%23admin',
    '/v1/%00admin',
    '/v1/%',
    '/v1/%252fadmin',
    '/v1/%252e%252e%252fadmin',
  ] as const) {
    const unsafeRule = { ...rule, pathPrefix };
    assert.match(validateEgressRule(unsafeRule)[0]!, /pathPrefix/i, pathPrefix);
    assert.equal(evaluateEgressPolicy({ mode: 'controlled_cloud', rules: [unsafeRule] }, {
      url: 'https://api.openai.com/v1/admin',
      purpose: 'provider_inference',
      dataClass: 'provider_request',
      method: 'POST',
    }).allowed, false, pathPrefix);
  }
});

test('controlled-cloud target paths allow only slash and unreserved characters after canonical decode', () => {
  const cfg = cloudRule();
  cfg.rules[0] = { ...cfg.rules[0]!, pathPrefix: '/v1' };
  for (const path of [
    '/v1/..;/admin',
    '/v1/%2e%2e;/admin',
    '/v1/%2E%2e;/admin',
  ] as const) {
    assert.equal(evaluateEgressPolicy(cfg, {
      url: 'https://api.openai.com' + path,
      purpose: 'provider_inference',
      dataClass: 'provider_request',
      method: 'POST',
    }).allowed, false, path);
  }

  const nonStructuralReserved = [':', '[', ']', '@', '!', '$', '&', "'", '(', ')', '*', '+', ',', ';', '='] as const;
  for (const character of nonStructuralReserved) {
    const path = '/v1/a' + character + 'b';
    assert.equal(evaluateEgressPolicy(cfg, {
      url: 'https://api.openai.com' + path,
      purpose: 'provider_inference',
      dataClass: 'provider_request',
      method: 'POST',
    }).allowed, false, JSON.stringify(character));
  }

  for (const url of [
    'https://api.openai.com/v1/AZaz09-._~/child',
    'https://api.openai.com/v1/%41%7a%30%2D%2Ename%5F%7E/child',
    'https://api.openai.com/v1/query-safe?raw=:[]@!$&\'()*+,;=/#fragment',
  ] as const) {
    assert.equal(evaluateEgressPolicy(cfg, {
      url,
      purpose: 'provider_inference',
      dataClass: 'provider_request',
      method: 'POST',
    }).allowed, true, url);
  }
});

test('configured rule prefixes reject parameterized traversal and non-structural reserved characters', () => {
  const rule = cloudRule().rules[0]!;
  const unsafePrefixes = [
    '/v1/..;',
    '/v1/%2e%2e;',
    '/v1/%2E%2e;',
    ...([':', '[', ']', '@', '!', '$', '&', "'", '(', ')', '*', '+', ',', ';', '='] as const)
      .map((character) => '/v1/a' + character + 'b'),
  ];
  for (const pathPrefix of unsafePrefixes) {
    const unsafeRule = { ...rule, pathPrefix };
    assert.match(validateEgressRule(unsafeRule)[0]!, /pathPrefix/i, pathPrefix);
    assert.equal(evaluateEgressPolicy({ mode: 'controlled_cloud', rules: [unsafeRule] }, {
      url: 'https://api.openai.com' + pathPrefix + '/admin',
      purpose: 'provider_inference',
      dataClass: 'provider_request',
      method: 'POST',
    }).allowed, false, pathPrefix);
  }
});

test('rules reject wildcard-adjacent and credential-bearing forms', () => {
  const rule = cloudRule().rules[0]!;
  assert.deepEqual(validateEgressRule(rule), []);
  assert.match(validateEgressRule({ ...rule, id: '*' })[0]!, /id/i);
  assert.match(validateEgressRule({ ...rule, origin: 'https://key@example.test/path' })[0]!, /origin/i);
  assert.match(validateEgressRule({ ...rule, origin: 'http://example.test' })[0]!, /origin/i);
  assert.match(validateEgressRule({ ...rule, pathPrefix: '/v1/../anything' })[0]!, /pathPrefix/i);
});

test('a loopback request succeeds through the sole transport and writes redacted hash-chained receipts', async () => {
  const home = mkdtempSync(join(tmpdir(), 'fiscus-egress-'));
  const previous = process.env.FISCUS_HOME;
  process.env.FISCUS_HOME = home;
  let received = '';
  const server = http.createServer((req, res) => {
    req.setEncoding('utf8');
    req.on('data', (chunk: string) => {
      received += chunk;
    });
    req.on('end', () => {
      res.writeHead(201, { 'content-type': 'application/json' });
      res.end('{"ok":true}');
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  try {
    const body = '{"secret":"must-not-appear-in-a-receipt"}';
    const response = await egressFetchWithConfig(LOCKED, 'http://127.0.0.1:' + address.port + '/private/path?token=also-secret', {
      purpose: 'local_healthcheck',
      dataClass: 'healthcheck',
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
    });
    assert.equal(response.status, 201);
    assert.equal(await response.text(), '{"ok":true}');
    assert.equal(received, body);
    assert.deepEqual(verifyEgressReceipts(), {
      ok: true,
      receiptCount: 3,
      validThroughHash: verifyEgressReceipts().validThroughHash,
      errors: [],
    });
    const ledger = readFileSync(egressReceiptPath(), 'utf8');
    assert.doesNotMatch(ledger, /must-not-appear|also-secret|\/private\/path|127\.0\.0\.1/);
    assert.match(ledger, /preflight_allowed/);
    assert.match(ledger, /dial_started/);
    assert.match(ledger, /response_received/);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    if (previous === undefined) delete process.env.FISCUS_HOME;
    else process.env.FISCUS_HOME = previous;
    rmSync(home, { recursive: true, force: true });
  }
});

test('a denied egress is receipted but never reaches a network dial', async () => {
  const home = mkdtempSync(join(tmpdir(), 'fiscus-egress-denied-'));
  const previous = process.env.FISCUS_HOME;
  process.env.FISCUS_HOME = home;
  try {
    await assert.rejects(
      egressFetchWithConfig(LOCKED, 'https://example.com/never-dialled', {
        purpose: 'pricing_refresh',
        dataClass: 'pricing_manifest',
      }),
      (error: unknown) => error instanceof EgressError && error.code === 'policy_denied',
    );
    const ledger = readFileSync(egressReceiptPath(), 'utf8');
    assert.match(ledger, /preflight_denied/);
    assert.doesNotMatch(ledger, /example\.com/);
    assert.equal(verifyEgressReceipts().ok, true);
  } finally {
    if (previous === undefined) delete process.env.FISCUS_HOME;
    else process.env.FISCUS_HOME = previous;
    rmSync(home, { recursive: true, force: true });
  }
});

test('the transport returns a redirect response without following its target', async () => {
  const home = mkdtempSync(join(tmpdir(), 'fiscus-egress-redirect-'));
  const previous = process.env.FISCUS_HOME;
  process.env.FISCUS_HOME = home;
  const requests: string[] = [];
  const server = http.createServer((req, res) => {
    requests.push(req.url ?? '');
    if (req.url === '/start') {
      res.writeHead(302, { location: '/target' });
      res.end();
      return;
    }
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('must-not-be-reached');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  try {
    const response = await egressFetchWithConfig(LOCKED, 'http://127.0.0.1:' + address.port + '/start', {
      purpose: 'local_healthcheck',
      dataClass: 'healthcheck',
    });
    assert.equal(response.status, 302);
    assert.equal(response.headers.get('location'), '/target');
    assert.deepEqual(requests, ['/start']);
    assert.equal(verifyEgressReceipts().ok, true);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    if (previous === undefined) delete process.env.FISCUS_HOME;
    else process.env.FISCUS_HOME = previous;
    rmSync(home, { recursive: true, force: true });
  }
});

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    const stat = statSync(path);
    if (stat.isDirectory()) return path.includes(join('dashboard', 'web')) ? [] : sourceFiles(path);
    return path.endsWith('.ts') ? [path] : [];
  });
}

test('only the egress transport may contain a server-side HTTP dial primitive', () => {
  const source = join(import.meta.dirname, '..', 'src');
  const offenders = sourceFiles(source)
    .filter((path) => !path.endsWith(join('egress', 'transport.ts')))
    .flatMap((path) => {
      const code = readFileSync(path, 'utf8');
      return /\bfetch\s*\(/.test(code) || /\bhttps?\.request\s*\(/.test(code) ? [path] : [];
    });
  assert.deepEqual(offenders, [], 'a server-side outbound path must route through src/egress/transport.ts');
});
