import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { Store } from '../src/store/db.ts';
import { DEFAULT_CONFIG } from '../src/config.ts';
import { createDashboardServer } from '../src/dashboard/server.ts';

async function boot() {
  const store = new Store(':memory:');
  const server = createDashboardServer({ store, config: structuredClone(DEFAULT_CONFIG), version: 'security-test' });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    port,
    base: `http://127.0.0.1:${port}`,
    close: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      store.close();
    },
  };
}

function raw(port: number, path: string, opts: { method?: string; headers?: Record<string, string>; body?: string } = {}) {
  return new Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }>((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path, method: opts.method ?? 'GET', headers: opts.headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.setTimeout(2000, () => req.destroy(new Error('request timeout')));
    req.on('error', reject);
    if (opts.body) req.write(opts.body);
    req.end();
  });
}

test('dashboard security matrix: Host, methods, CSRF, CORS, traversal, malformed paths, and response headers fail closed', async () => {
  const srv = await boot();
  try {
    const rebound = await raw(srv.port, '/api/health', { headers: { Host: 'attacker.example' } });
    assert.equal(rebound.status, 403, 'DNS-rebinding Host must never read local data');

    const wrongMethod = await raw(srv.port, '/api/import');
    assert.equal(wrongMethod.status, 405);
    assert.equal(wrongMethod.headers.allow, 'POST');

    const csrf = await raw(srv.port, '/api/settings/update', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    assert.equal(csrf.status, 403, 'mutation without same-origin custom header must fail');

    const preflight = await raw(srv.port, '/api/settings/update', {
      method: 'OPTIONS',
      headers: { Origin: 'https://attacker.example', 'Access-Control-Request-Method': 'POST' },
    });
    assert.equal(preflight.status, 405);
    assert.equal(preflight.headers['access-control-allow-origin'], undefined, 'server must not opt a hostile origin into CORS');

    const traversal = await raw(srv.port, '/app/%2e%2e%2f%2e%2e%2fpackage.json.js');
    assert.equal(traversal.status, 404, 'encoded traversal must not escape WEB_ROOT');

    const malformed = await raw(srv.port, '/%E0%A4%A.js');
    assert.equal(malformed.status, 404, 'malformed percent-encoding is an invalid asset, not an exception');

    const page = await raw(srv.port, '/');
    assert.equal(page.status, 200);
    const csp = String(page.headers['content-security-policy'] ?? '');
    assert.match(csp, /connect-src 'self'/);
    assert.match(csp, /frame-ancestors 'none'/);
    assert.equal(page.headers['x-content-type-options'], 'nosniff');

    const healthAfter = await raw(srv.port, '/api/health');
    assert.equal(healthAfter.status, 200, 'adversarial requests must not destabilize the local server');
  } finally {
    await srv.close();
  }
});
