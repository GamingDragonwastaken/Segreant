/** The actual Value response must reach the browser in both absence and presence. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store/db.ts';
import { DEFAULT_CONFIG } from '../src/config.ts';
import { seedDemo } from '../src/demo/seed.ts';
import { createDashboardServer } from '../src/dashboard/server.ts';
import { dashboardPayloadContract, validateDashboardPayload, checkInterfaceShape } from '../src/dashboard/contracts.ts';
import { DASHBOARD_INTERFACE_CONTRACTS } from '../src/dashboard/web/app/core/generated-payload-contract.ts';

for (const populated of [false, true]) {
  test(`Value ${populated ? 'populated per-project rows' : 'uncomputed per-project value'} passes the browser envelope and deep wire check`, async () => {
    const home = mkdtempSync(join(tmpdir(), 'segreant-value-wire-'));
    const saved = { home: process.env.SEGREANT_HOME, demo: process.env.SEGREANT_DEMO, db: process.env.SEGREANT_DB };
    process.env.SEGREANT_HOME = home;
    delete process.env.SEGREANT_DEMO;
    delete process.env.SEGREANT_DB;
    const store = new Store(':memory:');
    if (populated) seedDemo(store);
    const server = createDashboardServer({ store, config: structuredClone(DEFAULT_CONFIG), version: 'wire-fixture' });
    try {
      server.listen(0, '127.0.0.1');
      await once(server, 'listening');
      const res = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/api/value`);
      assert.equal(res.status, 200);
      const payload = await res.json() as { projects: unknown; valueSource: unknown };
      if (populated) {
        assert.ok(Array.isArray(payload.projects) && payload.projects.length > 0, 'named row shapes must be checked over real populated rows');
      } else {
        assert.equal(payload.projects, null, 'uncomputed is unknown, never an empty measured collection');
        assert.equal(payload.valueSource, null);
      }
      assert.doesNotThrow(() => validateDashboardPayload(dashboardPayloadContract('value', 'GET'), payload));
      assert.deepEqual(checkInterfaceShape('ValuePayload', payload, DASHBOARD_INTERFACE_CONTRACTS, 'ValuePayload'), []);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      store.close();
      for (const [key, value] of [['SEGREANT_HOME', saved.home], ['SEGREANT_DEMO', saved.demo], ['SEGREANT_DB', saved.db]]) {
        if (value === undefined) delete process.env[key!]; else process.env[key!] = value;
      }
      rmSync(home, { recursive: true, force: true });
    }
  });
}
