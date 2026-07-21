/**
 * GET /api/value — the payload carries `reclaimed` (Time Reclaimed) alongside
 * the existing roi/frontier/budget keys, present even with no git repo
 * attached (null, never omitted — the UI needs to tell "not computed" apart
 * from "computed as zero").
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import type http from 'node:http';
import { Store } from '../src/store/db.ts';
import { DEFAULT_CONFIG } from '../src/config.ts';
import { createDashboardServer } from '../src/dashboard/server.ts';

function boot(store: Store): Promise<{ base: string; close: () => Promise<void> }> {
  const server: http.Server = createDashboardServer({ store, config: structuredClone(DEFAULT_CONFIG), version: 'test' });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as AddressInfo).port;
      resolve({ base: `http://127.0.0.1:${port}`, close: () => new Promise((r) => server.close(() => r())) });
    });
  });
}

test('GET /api/value: payload always carries a reclaimed key (null when no git repo is attached)', async () => {
  const store = new Store(':memory:');
  const srv = await boot(store);
  try {
    const res = await fetch(`${srv.base}/api/value`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as Record<string, unknown>;
    assert.ok('reclaimed' in body, 'reclaimed key is always present, even when null');
  } finally {
    await srv.close();
    store.close();
  }
});
