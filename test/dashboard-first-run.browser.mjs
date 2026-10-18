// Real Chromium, real dashboard server. On a fresh install with nothing
// recorded, Statement and Spend say so and point to where usage comes in; once
// anything is recorded, or on sample data, they do not.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { Store } from '../dist/store/db.js';
import { DEFAULT_CONFIG } from '../dist/config.js';
import { createDashboardServer } from '../dist/dashboard/server.js';
import { seedDemo } from '../dist/demo/seed.js';
import { legacyPricingEvidence } from '../dist/cost/pricing.js';

async function withDashboard(prepare, run) {
  const home = mkdtempSync(join(tmpdir(), 'segreant-first-run-'));
  const saved = Object.fromEntries(['SEGREANT_HOME', 'SEGREANT_DB', 'SEGREANT_DEMO'].map((k) => [k, process.env[k]]));
  process.env.SEGREANT_HOME = home; delete process.env.SEGREANT_DB; delete process.env.SEGREANT_DEMO;
  const store = new Store(':memory:');
  prepare(store);
  const server = createDashboardServer({ store, config: structuredClone(DEFAULT_CONFIG), version: 'first-run-test' });
  let browser;
  try {
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    browser = await chromium.launch({ headless: true, executablePath: process.env.SEGREANT_CHROME || undefined });
    await run(browser, `http://127.0.0.1:${server.address().port}`);
  } finally {
    await browser?.close();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    store.close();
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    rmSync(home, { recursive: true, force: true });
  }
}

// The note decides from the all-time overview; waiting on that response, not on
// network idle, keeps the test exact and unaffected by other suites' load.
async function open(browser, base, route) {
  const page = await browser.newPage({ viewport: { width: 1366, height: 900 } });
  page.setDefaultTimeout(30000);
  await page.addInitScript(() => localStorage.setItem('segreant.register', 'plain'));
  const decided = page.waitForResponse((r) => r.url().includes('overview?range=all'));
  await page.goto(`${base}/#/${route}`);
  await page.getByRole('heading', { level: 1 }).first().waitFor();
  await (await decided).finished();
  // One frame for the response to reach the page and its render to land.
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
  return page;
}

test('an empty install points Statement and Spend to where usage comes in', async () => {
  await withDashboard(() => {}, async (browser, base) => {
    for (const route of ['statement', 'spend']) {
      const page = await open(browser, base, route);
      const note = page.getByRole('note').filter({ hasText: 'Nothing recorded yet.' });
      await note.waitFor();
      const link = note.getByRole('link', { name: 'Bring in your usage' });
      assert.equal(await link.getAttribute('href'), '#/data', `${route} links to Data`);
      await link.click();
      await page.getByRole('heading', { level: 1, name: 'Data' }).waitFor();
      await page.close();
    }
  });
});

test('the pointer is absent once anything is recorded, and on sample data', async () => {
  const one = (store) => store.insertRequest({
    requestId: 'r1', sessionId: null, tsEpochMs: Date.now() - 86_400_000, provider: 'openai', model: 'gpt-4o', project: 'p', taskWeight: 1,
    inputTokens: 10, outputTokens: 10, cacheWriteTokens: 0, cacheReadTokens: 0, reasoningTokens: 0,
    costUsd: 0.01, estimated: true, streamed: false, statusCode: 200, durationMs: 1, pricing: legacyPricingEvidence(),
  });
  for (const [label, prepare] of [['recorded', one], ['sample data', (store) => seedDemo(store)]]) {
    await withDashboard(prepare, async (browser, base) => {
      for (const route of ['statement', 'spend']) {
        const page = await open(browser, base, route);
        assert.equal(await page.getByText('Nothing recorded yet.').count(), 0, `${route} with ${label}`);
        await page.close();
      }
    });
  }
});
