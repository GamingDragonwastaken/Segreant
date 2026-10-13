/** Adversarial HTTP boundaries for the local financial write routes. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store/db.ts';
import { DEFAULT_CONFIG } from '../src/config.ts';
import { createDashboardServer } from '../src/dashboard/server.ts';

async function dashboard(body: (base: string, store: Store) => Promise<void>): Promise<void> {
  const saved = { home: process.env.SEGREANT_HOME, demo: process.env.SEGREANT_DEMO, db: process.env.SEGREANT_DB };
  const home = mkdtempSync(join(tmpdir(), 'segreant-write-boundary-'));
  process.env.SEGREANT_HOME = home;
  delete process.env.SEGREANT_DEMO;
  delete process.env.SEGREANT_DB;
  const store = new Store(':memory:');
  const server = createDashboardServer({ store, config: structuredClone(DEFAULT_CONFIG), version: 'test' });
  try {
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    await body(`http://127.0.0.1:${(server.address() as AddressInfo).port}`, store);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    store.close();
    for (const [key, value] of [['SEGREANT_HOME', saved.home], ['SEGREANT_DEMO', saved.demo], ['SEGREANT_DB', saved.db]]) {
      if (value === undefined) delete process.env[key!]; else process.env[key!] = value;
    }
    rmSync(home, { recursive: true, force: true });
  }
}

function post(base: string, route: string, raw: string): Promise<Response> {
  return fetch(`${base}/api/${route}/write`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-segreant-local': '1' }, body: raw,
  });
}

test('billing refuses materiality that cannot fit safe integer microdollars before checking readiness', async () => {
  await dashboard(async (base, store) => {
    for (const value of [1e308, Number.MAX_SAFE_INTEGER, -1]) {
      const res = await post(base, 'billing', JSON.stringify({ op: 'reconcile', materialityUsd: value, apply: true }));
      assert.equal(res.status, 400, `unsafe materiality ${value} must be rejected`);
      assert.match((await res.json() as { error: string }).error, /materiality/i);
      assert.equal(store.reconciliationRuns().length, 0);
    }
    const boundary = await post(base, 'billing', JSON.stringify({ op: 'reconcile', materialityUsd: 9007199254.74099 }));
    assert.equal(boundary.status, 409, 'a safe large threshold reaches readiness rather than failing validation');
  });
});

for (const route of ['allocation', 'billing']) {
  test(`${route} malformed JSON refuses without echoing submitted contents`, async () => {
    await dashboard(async (base) => {
      const res = await post(base, route, 'private-fixture-not-for-response');
      assert.equal(res.status, 400);
      const error = (await res.json() as { error: string }).error;
      assert.match(error, /valid JSON/i);
      assert.doesNotMatch(error, /private-|SyntaxError| at /);
    });
  });
}

test('malformed billing export refuses without echoing file contents', async () => {
  await dashboard(async (base, store) => {
    const res = await post(base, 'billing', JSON.stringify({
      op: 'import', fileName: 'costs.json', contentBase64: Buffer.from('private-export-fixture').toString('base64'), apply: true,
    }));
    assert.equal(res.status, 400);
    assert.doesNotMatch((await res.json() as { error: string }).error, /private-|SyntaxError| at /);
    assert.equal(store.billingImportRuns().length, 0);
  });
});

test('billing fileName is a portable ordinary basename, never a path or special directory', async () => {
  const bytes = readFileSync(join(import.meta.dirname, 'fixtures', 'billing', 'openai-operator-export.v1.json'));
  await dashboard(async (base, store) => {
    for (const fileName of ['.', '..', '../costs.json', '..\\costs.json', '/costs.json', 'X:\\costs.json']) {
      const res = await post(base, 'billing', JSON.stringify({ op: 'import', fileName, contentBase64: bytes.toString('base64'), apply: true }));
      assert.equal(res.status, 400, `must refuse filename ${fileName}`);
      assert.match((await res.json() as { error: string }).error, /fileName.*basename/i);
      assert.equal(store.billingImportRuns().length, 0);
    }
    const valid = await post(base, 'billing', JSON.stringify({ op: 'import', fileName: 'costs.json', contentBase64: bytes.toString('base64') }));
    assert.equal(valid.status, 200);
    assert.equal(store.billingImportRuns().length, 0, 'valid preview still writes nothing');
  });
});
