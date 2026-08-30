/**
 * The GUI/server payload contract.
 *
 * The browser app declares its own view of every payload in
 * `src/dashboard/web/app/core/api.ts`. Nothing checks those declarations against
 * what the server actually sends: the browser tsconfig cannot see the node
 * source, so the two sides are structurally unrelated to the typechecker, and a
 * field name invented in the GUI is not a compile error.
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
import { DASHBOARD_API_CONTRACTS, DASHBOARD_PAYLOAD_CONTRACTS, type DashboardPayloadContract } from '../src/dashboard/contracts.ts';
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

/**
 * Check every required field of `typeName` against `value`, recursing into other
 * declared interfaces. Absent optional fields are fine; absent REQUIRED ones are
 * the defect this file exists to catch.
 */
function checkValueType(
  type: string,
  value: unknown,
  where: string,
  interfaces: Map<string, Field[]>,
  problems: string[],
  seen: Set<string>,
): void {
  const normalized = type.replace(/\s+/g, ' ').trim();
  const alternatives = normalized.split('|').map((part) => part.trim());
  if (alternatives.length > 1) {
    if (value === null && alternatives.includes('null')) return;
    if (value === undefined && alternatives.includes('undefined')) return;
    if (alternatives.some((alternative) => alternative !== 'null' && alternative !== 'undefined'
      && valueMatchesType(alternative, value, where, interfaces, problems, seen))) return;
    problems.push(where + ' — expected ' + type + ', got ' + (value === null ? 'null' : typeof value));
    return;
  }
  if (value === undefined) return;
  if (!valueMatchesType(normalized, value, where, interfaces, problems, seen)) {
    problems.push(where + ' — expected ' + type + ', got ' + (value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value));
  }
}

function valueMatchesType(
  type: string,
  value: unknown,
  where: string,
  interfaces: Map<string, Field[]>,
  problems: string[],
  seen: Set<string>,
): boolean {
  if (type === 'unknown' || type === 'any') return true;
  if (type === 'string') return typeof value === 'string';
  if (type === 'number') return typeof value === 'number' && Number.isFinite(value);
  if (type === 'boolean') return typeof value === 'boolean';
  if (type === 'null') return value === null;
  if (type.endsWith('[]')) {
    if (!Array.isArray(value)) return false;
    const elementType = type.slice(0, -2).trim();
    for (const [index, element] of value.entries()) {
      checkValueType(elementType, element, where + '[' + index + ']', interfaces, problems, seen);
    }
    return true;
  }
  if (type.startsWith('Record<')) return value !== null && typeof value === 'object' && !Array.isArray(value);
  if (type.startsWith('{') || type.startsWith('(') || type.includes('=>')) return true;
  const literal = /^['"](.+)['"]$/.exec(type);
  if (literal) return typeof value === 'string' && value === literal[1];
  const named = /^([A-Z]\w*)$/.exec(type);
  if (named && interfaces.has(named[1]!)) {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
    checkShape(named[1]!, value, interfaces, where, problems, seen);
    return true;
  }
  return true;
}

function checkShape(
  typeName: string,
  value: unknown,
  interfaces: Map<string, Field[]>,
  where: string,
  problems: string[],
  seen: Set<string>,
): void {
  const fields = interfaces.get(typeName);
  if (!fields || seen.has(typeName)) return;
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return;

  const obj = value as Record<string, unknown>;
  for (const field of fields) {
    const present = field.name in obj;
    if (!present) {
      if (!field.optional) {
        problems.push(`${where}.${field.name} — declared as required, absent from the payload`);
      }
      continue;
    }
    const next = new Set(seen);
    next.add(typeName);
    checkValueType(field.type, obj[field.name], where + '.' + field.name, interfaces, problems, next);
  }
}

test('dashboard contract checker rejects a runtime primitive type mismatch', () => {
  const source = readFileSync(API_SRC, 'utf8');
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
  const source = readFileSync(API_SRC, 'utf8');
  assert.equal(
    DASHBOARD_INTERFACE_CONTRACT_SOURCE_SHA256,
    createHash('sha256').update(source, 'utf8').digest('hex'),
    'generated nested interface metadata is stale; run the dashboard contract generator',
  );
  const interfaces = generatedInterfaces();
  const endpoints = parseEndpoints(source);

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
