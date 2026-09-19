/**
 * The GUI/server payload contract.
 *
 * The canonical payload declarations live in `src/dashboard/shared-types.ts`;
 * the browser consumes a hash-bound generated copy. The endpoint client remains
 * in `src/dashboard/web/app/core/api.ts`, where route bindings are checked below.
 *
 * It is not a runtime error either, which is what makes this class of defect
 * expensive. Reading a field the payload does not have yields `undefined`, and
 * `undefined` renders as whatever the screen shows for "absent" — which is
 * usually a legitimate, honest-looking state:
 *
 *   GroupRow.label      written as something else, so every breakdown row
 *                       rendered an em-dash while the numbers beside it were
 *                       correct. Shipped. Found only by taking a screenshot.
 *   BudgetConfig.dailyUsd  written as `dailyCapUsd`, so Control announced
 *                       "no cap set" on a machine with a $30 cap enforcing, and
 *                       the cap-setting action POSTed a key
 *                       `applySettingsPatch` discards — 200, healthy response,
 *                       nothing changed.
 *
 * Two instances of one mistake, each caught by chance rather than by a check.
 * So this stops testing instances and tests the contract: every endpoint the GUI
 * declares is fetched for real, and every REQUIRED field the GUI says it will
 * find must actually be there.
 *
 * The pairings are derived from the source rather than listed here, so a new
 * endpoint is covered the moment it is added to the `api` object — a hand-kept
 * list would drift in exactly the way this test exists to prevent.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type http from 'node:http';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Store } from '../src/store/db.ts';
import { DEFAULT_CONFIG } from '../src/config.ts';
import { createDashboardServer } from '../src/dashboard/server.ts';
import { DASHBOARD_API_CONTRACTS, DASHBOARD_PAYLOAD_CONTRACTS, checkInterfaceShape, type DashboardPayloadContract } from '../src/dashboard/contracts.ts';
import { DASHBOARD_INTERFACE_CONTRACTS, DASHBOARD_INTERFACE_CONTRACT_SOURCE_SHA256 } from '../src/dashboard/web/app/core/generated-payload-contract.ts';
import { seedDemo } from '../src/demo/seed.ts';

const API_SRC = join(
  import.meta.dirname,
  '..',
  'src',
  'dashboard',
  'web',
  'app',
  'core',
  'api.ts',
);
const SHARED_TYPES_SRC = join(import.meta.dirname, '..', 'src', 'dashboard', 'shared-types.ts');

interface Field {
  name: string;
  optional: boolean;
  /** The declared type, trimmed — used to recurse into other declared interfaces. */
  type: string;
}

/** Parse `export interface X { ... }` blocks into their field lists. */
function parseInterfaces(source: string): Map<string, Field[]> {
  const out = new Map<string, Field[]>();
  const re = /export interface (\w+)\s*\{/g;
  let match: RegExpExecArray | null;

  while ((match = re.exec(source)) !== null) {
    const name = match[1];
    if (!name) continue;

    // Walk braces from the opening one so nested object literals in field types
    // do not end the block early.
    let depth = 0;
    let i = re.lastIndex - 1;
    const start = i;
    for (; i < source.length; i += 1) {
      if (source[i] === '{') depth += 1;
      else if (source[i] === '}') {
        depth -= 1;
        if (depth === 0) break;
      }
    }
    const body = source.slice(start + 1, i);

    // Only fields at the block's own depth. Anything nested inside an inline
    // object type belongs to that type, not to this interface.
    const fields: Field[] = [];
    let d = 0;
    for (const rawLine of body.split(String.fromCharCode(10))) {
      const line = rawLine.trim();
      const fieldMatch = d === 0 ? /^(\w+)(\??):\s*(.+?);?$/.exec(line) : null;
      if (fieldMatch && fieldMatch[1] && !line.startsWith('//') && !line.startsWith('*')) {
        fields.push({
          name: fieldMatch[1],
          optional: fieldMatch[2] === '?',
          type: (fieldMatch[3] ?? '').trim(),
        });
      }
      for (const ch of rawLine) {
        if (ch === '{') d += 1;
        else if (ch === '}') d -= 1;
      }
    }
    out.set(name, fields);
  }
  return out;
}

/**
 * Pair each read endpoint with the interface the GUI claims it returns, straight
 * out of the `api` object literal.
 */
function parseEndpoints(source: string): Array<{ routeId: string; method: string; type: string; path: string }> {
  const out: Array<{ routeId: string; method: string; type: string; path: string }> = [];
  // The endpoint list is canonical now; the source check below proves the
  // browser client actually binds each named payload through routePath(...).
  // Inline response descriptions remain outside this field-level checker until
  // the generated payload-schema tranche gives them a named interface.
  for (const contract of DASHBOARD_API_CONTRACTS) {
    if (!(contract.methods as readonly string[]).includes('GET') || !(contract.browserBinding as readonly string[]).includes('modern-api')) continue;
    const type = contract.responseType;
    if (!/^[A-Z]\w*$/.test(type)) continue;
    if (!source.includes(`request<${type}>`) || !source.includes(`routePath('${contract.id}')`)) continue;
    out.push({ routeId: contract.id, method: 'GET', type, path: contract.path });
  }
  return out;
}

function generatedInterfaces(): Map<string, Field[]> {
  return new Map(Object.entries(DASHBOARD_INTERFACE_CONTRACTS).map(([name, fields]) => [
    name,
    fields.map((field) => ({ name: field.name, optional: field.optional, type: field.type })),
  ]));
}

/**
 * D-243: the deep walk is the SHARED one in `src/dashboard/contracts.ts`, which
 * the browser client runs after the envelope check. This test and the browser
 * therefore validate with one function and cannot disagree by drifting apart.
 */
function checkShape(
  typeName: string,
  value: unknown,
  interfaces: Map<string, Field[]>,
  where: string,
  problems: string[],
  _seen: Set<string>,
): void {
  problems.push(...checkInterfaceShape(typeName, value, Object.fromEntries(interfaces), where));
}

function payloadKind(value: unknown): string {
  if (Array.isArray(value)) return 'array';
  if (value !== null && typeof value === 'object') return 'object';
  return typeof value;
}

function checkPayloadContract(contract: DashboardPayloadContract, payload: unknown, where: string, problems: string[]): void {
  if (contract.contentType === 'text') return;
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
    problems.push(`${where} — expected an object envelope, got ${payloadKind(payload)}`);
    return;
  }
  const object = payload as Record<string, unknown>;
  for (const field of contract.required) {
    if (!(field.name in object)) {
      problems.push(`${where}.${field.name} — required by the shared payload contract, absent from the response`);
      continue;
    }
    const value = object[field.name];
    if (value === null && field.nullable === true) continue;
    if (payloadKind(value) !== field.kind) {
      problems.push(`${where}.${field.name} — expected ${field.kind}${field.nullable ? ' or null' : ''}, got ${payloadKind(value)}`);
    }
  }
}

function boot(store: Store): Promise<{ base: string; close: () => Promise<void> }> {
  const server: http.Server = createDashboardServer({
    store,
    config: structuredClone(DEFAULT_CONFIG),
    version: 'test',
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as AddressInfo).port;
      resolve({
        base: `http://127.0.0.1:${port}`,
        close: () => new Promise<void>((r) => server.close(() => r())),
      });
    });
  });
}

/** Substitute a usable value for any template hole in a declared path. */
function concretePath(path: string): string {
  return path.replace(/\$\{[^}]*\}/g, '30d');
}


test('dashboard contract checker rejects a runtime primitive type mismatch', () => {
  const source = readFileSync(SHARED_TYPES_SRC, 'utf8');
  assert.equal(
    DASHBOARD_INTERFACE_CONTRACT_SOURCE_SHA256,
    createHash('sha256').update(source, 'utf8').digest('hex'),
    'generated nested interface metadata is stale; run the dashboard contract generator',
  );
  const interfaces = generatedInterfaces();
  const problems: string[] = [];
  checkShape('Summary', { requests: 'one', costUsd: 1 }, interfaces, 'Summary', problems, new Set());
  assert.ok(
    problems.some((problem) => problem.includes('Summary.requests') && problem.includes('number')),
    'a string where the browser declares a number must be a contract failure',
  );
});

test('every required field the GUI declares exists in the payload the server sends', async () => {
  const source = readFileSync(SHARED_TYPES_SRC, 'utf8');
  assert.equal(
    DASHBOARD_INTERFACE_CONTRACT_SOURCE_SHA256,
    createHash('sha256').update(source, 'utf8').digest('hex'),
    'generated nested interface metadata is stale; run the dashboard contract generator',
  );
  const interfaces = generatedInterfaces();
  const endpoints = parseEndpoints(readFileSync(API_SRC, 'utf8'));

  assert.ok(interfaces.size >= 8, `expected to parse the GUI interfaces, got ${interfaces.size}`);
  assert.ok(endpoints.length >= 5, `expected to parse the GUI endpoints, got ${endpoints.length}`);

  // A seeded store, so payloads are populated rather than empty: an absent field
  // and a field that is merely unreachable on an empty ledger look alike.
  const store = new Store(':memory:');
  seedDemo(store);
  const srv = await boot(store);
  const problems: string[] = [];
  const checkedPayloads = new Set<string>();

  try {
    for (const endpoint of endpoints) {
      const res = await fetch(`${srv.base}${concretePath(endpoint.path)}`, {
        headers: { 'x-fiscus-local': '1' },
      });
      assert.equal(
        res.status,
        200,
        `${endpoint.method}: GET ${endpoint.path} returned ${res.status} — the GUI issues this exact request`,
      );
      const payload: unknown = await res.json();
      const payloadContract = DASHBOARD_PAYLOAD_CONTRACTS.find((candidate) => candidate.routeId === endpoint.routeId && candidate.method === endpoint.method);
      assert.ok(payloadContract, `${endpoint.routeId} has no shared payload contract`);
      checkPayloadContract(payloadContract!, payload, `${endpoint.type} (${endpoint.path})`, problems);
      checkedPayloads.add(endpoint.routeId + ':' + endpoint.method);
      checkShape(endpoint.type, payload, interfaces, `${endpoint.type} (${endpoint.path})`, problems, new Set());
    }

    // Named browser interfaces cover the modern app's most-used endpoints. Run
    // the remaining JSON envelopes too, including classic/API-only surfaces,
    // so a new route cannot evade the shared schema merely by using an inline
    // response generic.
    for (const contract of DASHBOARD_PAYLOAD_CONTRACTS) {
      if (contract.method !== 'GET' || contract.contentType !== 'json' || checkedPayloads.has(contract.routeId + ':GET')) continue;
      const route = DASHBOARD_API_CONTRACTS.find((candidate) => candidate.id === contract.routeId);
      assert.ok(route, `${contract.routeId} payload contract has no route contract`);
      const res = await fetch(`${srv.base}${route!.path}`);
      assert.equal(res.status, 200, `GET ${route!.path} returned ${res.status}`);
      checkPayloadContract(contract, await res.json(), `${contract.responseType} (${route!.path})`, problems);
    }
    // D-243: the browser's deep check now runs on POST responses too, so the
    // POST envelopes that can be exercised against an in-memory store without
    // touching the machine are walked here with the same function. `discover`,
    // `scan` and `import` read the operator's machine and `settings-update`
    // writes configuration; they stay out of this test by design and are
    // named so their absence is not read as coverage.
    for (const routeId of ['clear-proposals'] as const) {
      const contract = DASHBOARD_PAYLOAD_CONTRACTS.find((candidate) => candidate.routeId === routeId && candidate.method === 'POST');
      const route = DASHBOARD_API_CONTRACTS.find((candidate) => candidate.id === routeId);
      assert.ok(contract && route, `${routeId} needs both contracts`);
      const res = await fetch(`${srv.base}${route!.path}`, { method: 'POST', headers: { 'x-fiscus-local': '1', 'content-type': 'application/json' }, body: '{}' });
      assert.equal(res.status, 200, `POST ${route!.path} returned ${res.status}`);
      const payload: unknown = await res.json();
      checkPayloadContract(contract!, payload, `${contract!.responseType} (POST ${route!.path})`, problems);
      checkShape(contract!.responseType, payload, interfaces, `${contract!.responseType} (POST ${route!.path})`, problems, new Set());
    }
  } finally {
    await srv.close();
    store.close();
  }

  assert.deepEqual(
    problems,
    [],
    `the GUI declares fields the server does not send:${String.fromCharCode(10)}  ${problems.join(String.fromCharCode(10) + '  ')}`,
  );
});

test('the shared deep walker is the one the browser runs, and it refuses a nested declaration the wire does not honour (D-243)', () => {
  // Browser wiring: the client imports the walker from the copied contract and
  // the generated field table, and throws a 502-class ApiError on problems.
  const client = readFileSync(join(import.meta.dirname, '..', 'src', 'dashboard', 'web', 'app', 'core', 'api.ts'), 'utf8');
  assert.match(client, /checkInterfaceShape\(payloadContract\.responseType, payload, DASHBOARD_INTERFACE_CONTRACTS/);
  assert.match(client, /Dashboard interface contract violation/);
  // The copied contract carries the walker byte-for-byte.
  const copied = readFileSync(join(import.meta.dirname, '..', 'src', 'dashboard', 'web', 'app', 'core', 'generated-contract.ts'), 'utf8');
  assert.match(copied, /export function checkInterfaceShape\(/);

  // Able to fail: a nested required field declared as number arrives as a string.
  const table = {
    Outer: [{ name: 'inner', optional: false, type: 'Inner' }, { name: 'items', optional: true, type: 'Inner[]' }],
    Inner: [{ name: 'count', optional: false, type: 'number' }, { name: 'note', optional: true, type: 'string | null' }],
  };
  assert.deepEqual(checkInterfaceShape('Outer', { inner: { count: 3, note: null }, items: [{ count: 1 }] }, table, 'Outer'), []);
  const problems = checkInterfaceShape('Outer', { inner: { count: '3' }, items: [{ note: 'x' }] }, table, 'Outer');
  assert.ok(problems.some((item) => item.startsWith('Outer.inner.count — expected number')), problems.join('; '));
  assert.ok(problems.some((item) => item.startsWith('Outer.items[0].count — declared as required')), problems.join('; '));
  // The defect that motivated the rule: a number declared where the server sends an array.
  assert.ok(checkInterfaceShape('Inner', { count: [] }, table, 'Inner').length === 1);
});
