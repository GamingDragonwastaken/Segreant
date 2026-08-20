/**
 * The dashboard's ROUTE TABLE, tested as a table.
 *
 * Route matching and route handling used to be one 560-line if-chain inside
 * `createDashboardServer`. Two properties that matter got harder to see the
 * longer it grew:
 *
 *   - which methods each path answers, and with which `Allow` header, and
 *   - which paths are gated behind `x-aegis-local: 1` — the CSRF guard that is
 *     the only thing stopping a page you visit from driving your local Fiscus.
 *
 * Both were spelled out per-branch, so "is every mutating route guarded?" could
 * only be answered by reading all of them and trusting that you had not missed
 * one. They are declarations now (`src/dashboard/routes.ts`), which means they
 * can be asserted directly rather than probed endpoint by endpoint.
 *
 * This file checks the declarations against the wire in both directions: the
 * table says what the server does, and the server does what the table says.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import http from 'node:http';
import { join } from 'node:path';
import { Store } from '../src/store/db.ts';
import { DEFAULT_CONFIG } from '../src/config.ts';
import { createDashboardServer } from '../src/dashboard/server.ts';
import { ROUTES, handleHealth, type RouteContext } from '../src/dashboard/routes.ts';
import { serveStatic, STATIC_TYPES, WEB_ROOT } from '../src/dashboard/static.ts';

/**
 * Every route that writes to the store or reaches the network. Hard-coded on
 * purpose: deriving it from the table would make the table agree with itself.
 * A new mutating route must be added here, which is the point — the failure
 * mode being guarded against is a route that ships without its CSRF gate.
 */
const MUTATING = [
  '/api/import',
  '/api/discover',
  '/api/scan',
  '/api/judge',
  '/api/settings/update',
  '/api/settings/clear-proposals',
];

function boot(store: Store): Promise<{ base: string; close: () => Promise<void> }> {
  const server = createDashboardServer({ store, config: structuredClone(DEFAULT_CONFIG), version: 'test' });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as AddressInfo).port;
      resolve({ base: `http://127.0.0.1:${port}`, close: () => new Promise((r) => server.close(() => r())) });
    });
  });
}

function rawRequest(
  base: string,
  path: string,
  method: string,
  headers: Record<string, string> = {},
): Promise<{ status: number; allow: string | undefined; text: string }> {
  const url = new URL(path, base);
  return new Promise((resolve, reject) => {
    const req = http.request(url, { method, headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => resolve({
        status: res.statusCode ?? 0,
        allow: typeof res.headers.allow === 'string' ? res.headers.allow : undefined,
        text: Buffer.concat(chunks).toString('utf8'),
      }));
    });
    req.on('error', reject);
    req.end();
  });
}

// --- the table's own invariants ---------------------------------------

test('route table: every mutating route is gated by the x-aegis-local header', () => {
  for (const path of MUTATING) {
    const route = ROUTES.find((r) => r.path === path);
    assert.ok(route, `${path} is missing from the route table`);
    assert.ok(route.localOnly?.length, `${path} mutates but declares no localOnly methods`);
    // A gate that does not cover a method the route actually serves is not a gate.
    for (const method of route.localOnly!) {
      assert.ok(
        route.methods === null || route.methods.includes(method),
        `${path} guards ${method}, which it does not serve`,
      );
    }
    // Guarding a read is not the mistake this is looking for; leaving a write
    // ungated is. Every method a mutating route serves must be guarded.
    for (const method of route.methods ?? []) {
      if (method === 'GET') continue; // GET /api/scan is a read-only preview
      assert.ok(route.localOnly!.includes(method), `${path} serves ${method} unguarded`);
    }
  }
});

test('route table: paths are unique, so matching order can never matter', () => {
  const seen = new Set<string>();
  for (const route of ROUTES) {
    assert.ok(!seen.has(route.path), `duplicate route path: ${route.path}`);
    seen.add(route.path);
    assert.ok(route.path.startsWith('/'), `${route.path} is not an absolute path`);
  }
});

// --- the table, on the wire -------------------------------------------

test('route table: declared methods are the methods the server answers', async () => {
  const store = new Store(':memory:');
  const srv = await boot(store);
  try {
    for (const route of ROUTES) {
      if (route.methods === null) continue; // answers anything, by long-standing design
      const expectedAllow = route.allow ?? route.methods.join(', ');
      // DELETE is served by nothing, so it exercises the 405 on every route.
      const res = await rawRequest(srv.base, route.path, 'DELETE');
      assert.equal(res.status, 405, `DELETE ${route.path}`);
      assert.equal(res.allow, expectedAllow, `Allow header for ${route.path}`);
      assert.equal(res.text, 'method not allowed');
    }
  } finally {
    await srv.close();
    store.close();
  }
});

/**
 * The exact `Allow` header each route has always sent, written out rather than
 * derived from the table. The test above proves the server agrees with the
 * table; this one proves the table still says what the pre-refactor if-chain
 * said. Deriving both from the same source would let a value change silently:
 * '/api/settings' in particular advertises 'GET, POST' while serving only GET
 * (the POST goes to '/api/settings/update'), and nothing else pins that.
 */
const HISTORICAL_ALLOW: Record<string, string> = {
  '/api/import': 'POST',
  '/api/discover': 'POST',
  '/api/scan': 'GET, POST',
  '/api/billing': 'GET',
  '/api/allocation': 'GET',
  '/api/judge': 'POST',
  '/api/settings': 'GET, POST',
  '/api/settings/update': 'POST',
  '/api/settings/clear-proposals': 'POST',
};

test('405 responses send the same Allow header they always have', async () => {
  const store = new Store(':memory:');
  const srv = await boot(store);
  try {
    for (const [path, allow] of Object.entries(HISTORICAL_ALLOW)) {
      const res = await rawRequest(srv.base, path, 'DELETE');
      assert.equal(res.status, 405, `DELETE ${path}`);
      assert.equal(res.allow, allow, `Allow header for ${path}`);
    }
    // And the inverse: no route outside that list method-checks at all, so a
    // new 405 cannot appear on a path that used to answer anything.
    const methodChecked = ROUTES.filter((r) => r.methods !== null).map((r) => r.path).sort();
    assert.deepEqual(methodChecked, Object.keys(HISTORICAL_ALLOW).sort());
  } finally {
    await srv.close();
    store.close();
  }
});

test('route table: a guarded method without the local header is refused before it runs', async () => {
  const store = new Store(':memory:');
  const srv = await boot(store);
  try {
    for (const route of ROUTES) {
      for (const method of route.localOnly ?? []) {
        const bare = await rawRequest(srv.base, route.path, method);
        assert.equal(bare.status, 403, `${method} ${route.path} without the header`);
        assert.equal(bare.text, 'forbidden');

        // A wrong value is not a present value.
        const wrong = await rawRequest(srv.base, route.path, method, { 'x-aegis-local': '0' });
        assert.equal(wrong.status, 403, `${method} ${route.path} with a wrong header value`);
      }
    }
  } finally {
    await srv.close();
    store.close();
  }
});

test('the loopback Host guard rejects a rebound hostname on every route', async () => {
  const store = new Store(':memory:');
  const srv = await boot(store);
  try {
    for (const path of ['/', '/api/health', '/api/settings', '/api/import']) {
      const res = await rawRequest(srv.base, path, 'GET', { host: 'evil.example.com' });
      assert.equal(res.status, 403, `rebound Host on ${path}`);
      assert.equal(res.text, 'forbidden');
    }
    // The guard runs before routing, so an unknown path is refused too.
    const unknown = await rawRequest(srv.base, '/nope', 'GET', { host: 'evil.example.com' });
    assert.equal(unknown.status, 403);
  } finally {
    await srv.close();
    store.close();
  }
});

test('both entry points serve HTML with the shell CSP; an unmatched path 404s', async () => {
  const store = new Store(':memory:');
  const srv = await boot(store);
  try {
    for (const path of ['/', '/index.html', '/classic']) {
      const res = await fetch(`${srv.base}${path}`);
      assert.equal(res.status, 200, path);
      assert.match(res.headers.get('content-type') ?? '', /text\/html/);
      const csp = res.headers.get('content-security-policy') ?? '';
      assert.match(csp, /default-src 'self'/, `${path} must carry the local-first CSP`);
      assert.match(csp, /frame-ancestors 'none'/, path);
      assert.equal(res.headers.get('x-content-type-options'), 'nosniff', path);
    }
    const missing = await rawRequest(srv.base, '/not-a-route', 'GET');
    assert.equal(missing.status, 404);
    assert.equal(missing.text, 'not found');
  } finally {
    await srv.close();
    store.close();
  }
});

// --- handlers are directly callable -----------------------------------

/** A response double: enough of ServerResponse for a handler that only writes. */
interface FakeRes {
  status: number;
  headers: Record<string, string>;
  body: string;
  res: http.ServerResponse;
}

function fakeRes(): FakeRes {
  const captured: FakeRes = {
    status: 0,
    headers: {},
    body: '',
    res: null as unknown as http.ServerResponse,
  };
  captured.res = {
    writeHead(status: number, headers?: Record<string, string>) {
      captured.status = status;
      captured.headers = headers ?? {};
      return this;
    },
    end(chunk?: string | Buffer) {
      if (chunk) captured.body = chunk.toString();
    },
  } as unknown as http.ServerResponse;
  return captured;
}

test('a handler can be called directly, with no socket and no server', () => {
  const out = fakeRes();
  handleHealth({ res: out.res } as unknown as RouteContext);
  assert.equal(out.status, 200);
  assert.equal(out.headers['content-type'], 'application/json; charset=utf-8');
  assert.deepEqual(JSON.parse(out.body), { ok: true, service: 'fiscus-dashboard' });
});

// --- static serving, as its own concern -------------------------------

test('serveStatic refuses traversal, NUL, and unlisted extensions without touching disk', () => {
  // Each of these must be refused, and refusal is `false` — the caller 404s.
  const refused = [
    '/../../../etc/passwd',
    '/app/../../secrets.js',
    '/%2e%2e/%2e%2e/etc/passwd.js', // decoded before the '..' check, so still caught
    // A NUL truncates the path in some syscalls, so it is rejected outright.
    // Built from a char code rather than written literally: a raw NUL in a
    // source file is invisible in review, which is how it would get deleted.
    `/app/main.js${String.fromCharCode(0)}.png`,
    '/index.html', // not in STATIC_TYPES: the shells are served by their own route
    '/app/main.txt',
    '/package.json',
  ];
  for (const path of refused) {
    const out = fakeRes();
    assert.equal(serveStatic(out.res, path), false, `${JSON.stringify(path)} must be refused`);
    assert.equal(out.status, 0, `${JSON.stringify(path)} must not have written a response`);
  }
});

test('serveStatic serves a real asset from inside WEB_ROOT with the asset CSP', () => {
  // Proven to exist rather than assumed: the app's stylesheet ships in the repo.
  const out = fakeRes();
  const served = serveStatic(out.res, '/styles/app.css');
  assert.ok(served, `expected an asset under ${join(WEB_ROOT, 'styles')}`);
  assert.equal(out.status, 200);
  assert.equal(out.headers['content-type'], STATIC_TYPES['.css']);
  assert.equal(out.headers['cache-control'], 'no-cache');
  assert.equal(out.headers['x-content-type-options'], 'nosniff');
  // Assets get the tighter script-src: no inline script, unlike the HTML shells.
  assert.match(out.headers['content-security-policy'] ?? '', /script-src 'self';/);
  assert.doesNotMatch(out.headers['content-security-policy'] ?? '', /script-src 'self' 'unsafe-inline'/);
});
