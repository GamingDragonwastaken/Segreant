import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../src/store/db.ts';
import { DEFAULT_CONFIG } from '../src/config.ts';
import { createDashboardServer } from '../src/dashboard/server.ts';

const DEMO_MESSAGE = "This dashboard is showing sample data, so settings can't be changed here. Start Segreant without --demo to change your own settings.";

async function listen(server: http.Server): Promise<string> {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

function close(server: http.Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

/**
 * Runs `body` with SEGREANT_HOME pointed at a fresh temp directory and SEGREANT_DEMO
 * set to `demo`, restoring both afterwards. The dashboard is built WITHOUT a
 * configPersistence override, so writes go through the real mutateConfig and
 * exercise the real DemoReadOnlyError path.
 */
async function withDashboard(demo: boolean, body: (base: string) => Promise<void>): Promise<void> {
  const saved = { home: process.env.SEGREANT_HOME, demo: process.env.SEGREANT_DEMO };
  const home = mkdtempSync(join(tmpdir(), 'segreant-settings-demo-'));
  process.env.SEGREANT_HOME = home;
  if (demo) process.env.SEGREANT_DEMO = '1';
  else delete process.env.SEGREANT_DEMO;
  const store = new Store(':memory:');
  const server = createDashboardServer({ store, config: structuredClone(DEFAULT_CONFIG), version: 'test' });
  try {
    const base = await listen(server);
    await body(base);
  } finally {
    await close(server);
    store.close();
    if (saved.home === undefined) delete process.env.SEGREANT_HOME;
    else process.env.SEGREANT_HOME = saved.home;
    if (saved.demo === undefined) delete process.env.SEGREANT_DEMO;
    else process.env.SEGREANT_DEMO = saved.demo;
    rmSync(home, { recursive: true, force: true });
  }
}

test('demo mode: a settings write is refused with 409 SETTINGS_DEMO_READ_ONLY and a human message', async () => {
  await withDashboard(true, async (base) => {
    const res = await fetch(`${base}/api/settings/update`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-segreant-local': '1' },
      body: JSON.stringify({ budget: { dailyUsd: 5 } }),
    });
    assert.equal(res.status, 409);
    const body = (await res.json()) as { error: { code: string; message: string } };
    assert.equal(body.error.code, 'SETTINGS_DEMO_READ_ONLY');
    assert.equal(body.error.message, DEMO_MESSAGE);
  });
});

test('demo mode: the settings snapshot reports demo: true', async () => {
  await withDashboard(true, async (base) => {
    const res = await fetch(`${base}/api/settings`);
    assert.equal(res.status, 200);
    const snap = (await res.json()) as { demo: unknown };
    assert.equal(snap.demo, true);
  });
});

test('outside demo mode: the settings snapshot reports demo: false', async () => {
  await withDashboard(false, async (base) => {
    const res = await fetch(`${base}/api/settings`);
    assert.equal(res.status, 200);
    const snap = (await res.json()) as { demo: unknown };
    assert.equal(snap.demo, false);
  });
});
