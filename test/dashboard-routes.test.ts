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
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
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
        route.methods.includes(method),
        `${path} guards ${method}, which it does not serve`,
      );
    }
    // Guarding a read is not the mistake this is looking for; leaving a write
    // ungated is. Every method a mutating route serves must be guarded.
    for (const method of route.methods) {
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

/**
 * The read routes that used to answer ANY method, listed separately from the
 * historical map because their `Allow` is new rather than inherited.
 *
 * They carried `methods: null` — faithfully preserved from the pre-refactor
 * if-chain, which never method-checked them — so `DELETE /api/value` returned
 * 200 and the full payload. Every one of these handlers is a read, so nothing
 * was corruptible through them; it is the route table that was lying, by
 * containing rows that meant "unrestricted" while claiming to be the auditable
 * statement of what this server answers.
 *
 * HEAD is included, not dropped: Node suppresses the body itself, so HEAD
 * already worked on every one of these. Restricting them to GET alone would
 * have turned a fall-open into a regression.
 *
 * OPTIONS is deliberately absent, so it 405s. The CSRF gate rests on this
 * server never answering a preflight — a 405 carries no
 * `Access-Control-Allow-Origin`, so no browser reads it as approval to send the
 * real request.
 */
const READ_ONLY_ALLOW: Record<string, string> = {
  '/api/health': 'GET, HEAD',
  '/api/importers': 'GET, HEAD',
  '/api/overview': 'GET, HEAD',
  '/api/export.csv': 'GET, HEAD',
  '/api/realization': 'GET, HEAD',
  '/api/guide': 'GET, HEAD',
  '/api/value': 'GET, HEAD',
  '/': 'GET, HEAD',
  '/index.html': 'GET, HEAD',
  '/classic': 'GET, HEAD',
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
    // Every route method-checks now, so the old inverse ("no 405 outside this
    // list") is retired by design. What replaces it: the two pinned maps must
    // together account for every route, so a new path cannot ship without a
    // deliberate decision about which methods it answers.
    const pinned = [...Object.keys(HISTORICAL_ALLOW), ...Object.keys(READ_ONLY_ALLOW)].sort();
    assert.deepEqual(ROUTES.map((r) => r.path).sort(), pinned);
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
    // Malformed percent-escapes. `decodeURIComponent` THROWS on these rather
    // than returning something odd, so before the guard each one killed the
    // process rather than missing. Asserting `false` here also asserts no
    // throw: an exception fails this test rather than returning a value.
    '/app/%ZZ.js',
    '/app/%.js',
    '/styles/%E0%A4%A.css', // truncated multi-byte sequence
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

/**
 * `GET /api/scan` is the only route on this server that answers a method no
 * `x-aegis-local: 1` gate covers AND reached a store write: it called
 * `saveScan` two lines below a doc comment promising it "imports and mutates
 * nothing", and below `scanWithDiff`'s own contract that the caller persists
 * separately "so a pure preview can stay non-writing".
 *
 * Two harms, not one. Any page the operator visits can issue a plain cross-origin
 * GET — no custom header, so no preflight to refuse — and silently advance the
 * mark. And `diff` answers "what changed since the last scan you committed to",
 * so a preview that moved the mark made the drift it had just reported
 * unobservable to the next reader.
 *
 * `comparable` is false until a baseline exists for these roots. A second
 * identical preview turning comparable IS the leaked write, which is why the
 * assertion is on the second call rather than on a row count.
 */
test('GET /api/scan previews without moving the baseline it diffs against', async () => {
  const store = new Store(':memory:');
  const dir = mkdtempSync(join(tmpdir(), 'fiscus-scan-'));
  const srv = await boot(store);
  const path = `/api/scan?path=${encodeURIComponent(dir)}`;
  try {
    const first = JSON.parse((await rawRequest(srv.base, path, 'GET')).text);
    assert.equal(first.ok, true);
    assert.equal(first.diff.comparable, false, 'nothing persisted yet, so nothing to compare against');

    const second = JSON.parse((await rawRequest(srv.base, path, 'GET')).text);
    assert.equal(second.diff.comparable, false, 'the preview persisted a baseline it should not have');
    assert.equal(second.diff.sinceMs, null, 'a sinceMs means a snapshot was written by a GET');
  } finally {
    await srv.close();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * The routes that used to answer anything now refuse everything they do not
 * serve — and still serve what they did.
 *
 * Both halves matter. A 405 on DELETE proves the fall-open is closed; a 200 on
 * GET and HEAD proves it was closed by declaring the real method list rather
 * than by narrowing the route until something legitimate broke. HEAD in
 * particular worked before this change, so it has to work after it.
 */
test('the formerly unrestricted read routes 405 every method they do not serve', async () => {
  const store = new Store(':memory:');
  const srv = await boot(store);
  try {
    for (const [path, allow] of Object.entries(READ_ONLY_ALLOW)) {
      for (const method of ['DELETE', 'PUT', 'PATCH', 'POST', 'OPTIONS']) {
        const res = await rawRequest(srv.base, path, method);
        assert.equal(res.status, 405, `${method} ${path} must be refused`);
        assert.equal(res.allow, allow, `Allow header for ${method} ${path}`);
        assert.equal(res.text, 'method not allowed');
      }
    }
  } finally {
    await srv.close();
    store.close();
  }
});

test('restricting those routes did not break the methods they legitimately serve', async () => {
  const store = new Store(':memory:');
  const srv = await boot(store);
  // `/api/value` and `/api/realization` correlate against a git repo, and
  // unscoped they walk the checkout this suite runs in — 52s and 57s per
  // request measured, which would cost more than the whole suite. Pointing
  // them at an empty non-repo makes them return the same shape in ~60ms. The
  // subject here is method dispatch, not correlation depth.
  const empty = mkdtempSync(join(tmpdir(), 'fiscus-norepo-'));
  const scoped = (path: string) => `${path}?repo=${encodeURIComponent(empty)}`;
  try {
    for (const path of Object.keys(READ_ONLY_ALLOW)) {
      const get = await rawRequest(srv.base, scoped(path), 'GET');
      assert.equal(get.status, 200, `GET ${path}`);
      assert.ok(get.text.length > 0, `GET ${path} returned an empty body`);

      // Node drops the body for HEAD on its own; the status and headers are
      // what a HEAD is for, and they must still come from the real handler.
      const head = await rawRequest(srv.base, scoped(path), 'HEAD');
      assert.equal(head.status, 200, `HEAD ${path}`);
      assert.equal(head.text, '', `HEAD ${path} must not send a body`);
    }
  } finally {
    await srv.close();
    store.close();
    rmSync(empty, { recursive: true, force: true });
  }
});

/**
 * The unit test above proves `serveStatic` returns false. This proves the
 * SERVER is still alive afterwards, which is the property that actually
 * mattered: `decodeURIComponent` threw a URIError out of the request handler,
 * where nothing caught it, so the dashboard did not answer 500 — the process
 * exited. A page the operator visited could stop their local Fiscus with a
 * single `<img src="http://localhost:8091/app/%ZZ.js">`.
 *
 * The second half of each pair is the real assertion. A 404 that is followed by
 * a dead socket is not a fix.
 */
test('a malformed percent-escape 404s and leaves the server serving', async () => {
  const store = new Store(':memory:');
  const srv = await boot(store);
  try {
    for (const path of ['/app/%ZZ.js', '/app/%.js', '/styles/%E0%A4%A.css']) {
      const bad = await rawRequest(srv.base, path, 'GET');
      assert.equal(bad.status, 404, `GET ${path} should miss, not crash`);

      const alive = await rawRequest(srv.base, '/api/health', 'GET');
      assert.equal(alive.status, 200, `server stopped serving after ${path}`);
    }
  } finally {
    await srv.close();
    store.close();
  }
});
