import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import type http from 'node:http';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store/db.ts';
import { DEFAULT_CONFIG } from '../src/config.ts';
import { createDashboardServer } from '../src/dashboard/server.ts';

function boot(store: Store): Promise<{ base: string; close: () => Promise<void> }> {
  const server: http.Server = createDashboardServer({ store, config: structuredClone(DEFAULT_CONFIG), version: 'test' });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as AddressInfo).port;
      resolve({ base: `http://127.0.0.1:${port}`, close: () => new Promise<void>((r) => server.close(() => r())) });
    });
  });
}

test('GET /api/scan is a pure preview and does not advance the persisted diff baseline', async () => {
  const root = mkdtempSync(join(tmpdir(), 'fiscus-dashboard-scan-'));
  mkdirSync(join(root, 'repo', '.git'), { recursive: true });
  const store = new Store(':memory:');
  const srv = await boot(store);
  try {
    const url = `${srv.base}/api/scan?path=${encodeURIComponent(root)}`;
    const first = await (await fetch(url)).json() as { diff: { comparable: boolean } };
    const second = await (await fetch(url)).json() as { diff: { comparable: boolean } };
    assert.equal(first.diff.comparable, false);
    assert.equal(second.diff.comparable, false, 'a GET must not create the baseline used by the next GET');
  } finally {
    await srv.close();
    store.close();
  }
});
