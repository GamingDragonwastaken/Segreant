import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { Store } from '../dist/store/db.js';
import { DEFAULT_CONFIG } from '../dist/config.js';
import { createDashboardServer } from '../dist/dashboard/server.js';

process.env.SEGREANT_HOME = mkdtempSync(join(tmpdir(), 'segreant-browser-sentinels-'));

async function fixture(run, register = 'precise') {
  const store = new Store(':memory:');
  const server = createDashboardServer({ store, config: structuredClone(DEFAULT_CONFIG), version: 'sentinel-fixture' });
  let browser;
  try {
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    const base = `http://127.0.0.1:${server.address().port}`;
    browser = await chromium.launch({ headless: true, executablePath: process.env.SEGREANT_CHROME || undefined });
    for (const [name, width, height] of [['desktop', 1440, 900], ['phone', 375, 812]]) {
      const context = await browser.newContext({ viewport: { width, height } });
      await context.addInitScript((value) => localStorage.setItem('segreant.register', value), register);
      const page = await context.newPage();
      const errors = [];
      page.on('pageerror', (error) => errors.push(String(error)));
      try { await run(page, base, name); assert.deepEqual(errors, []); }
      finally { await context.close(); }
    }
  } finally {
    await browser?.close();
    server.closeAllConnections();
    if (server.listening) await new Promise((resolve) => server.close(resolve));
    store.close();
  }
}

async function capture(page, name) {
  if (!process.env.SEGREANT_CAPTURE_DIR) return;
  mkdirSync(process.env.SEGREANT_CAPTURE_DIR, { recursive: true });
  await page.screenshot({ path: join(process.env.SEGREANT_CAPTURE_DIR, `${name}.png`), fullPage: true });
}

test('Spend renders missing retention dates as unknown at desktop and phone widths', async () => {
  await fixture(async (page, base, viewport) => {
    for (const prunedBeforeMs of [null, 0]) {
      await page.route('**/api/overview?**', async (route) => {
        const response = await route.fetch();
        const payload = await response.json();
        payload.retention = { truncated: true, prunedBeforeMs, rowsRemoved: 2 };
        await route.fulfill({ response, json: payload });
      });
      await page.goto(`${base}/#/spend`, { waitUntil: 'networkidle' });
      const warnings = page.locator('#main').getByRole('status');
      const text = (await warnings.allInnerTexts()).join('\n');
      assert.match(text, /before unknown/);
      assert.doesNotMatch(text, /1970/);
      await capture(page, `spend-${prunedBeforeMs === null ? 'null' : 'zero'}-${viewport}`);
      await page.unroute('**/api/overview?**');
    }
  });
});

test('Data does not call a failed ledger read an empty ledger', async () => {
  await fixture(async (page, base, viewport) => {
    await page.route('**/api/overview?**', (route) => route.fulfill({ status: 503, json: { error: 'fixture ledger unavailable' } }));
    await page.route('**/api/importers', (route) => route.fulfill({ json: { importers: [] } }));
    await page.goto(`${base}/#/data`, { waitUntil: 'networkidle' });
    await page.getByRole('heading', { name: 'Native importers', exact: true }).waitFor();
    assert.doesNotMatch(await page.locator('#main').innerText(), /Nothing imported yet|Every other screen will stay empty/);
    await capture(page, `data-unavailable-${viewport}`);
  });
});

test('Close does not date an unrecorded retention boundary to 1970', async () => {
  await fixture(async (page, base, viewport) => {
    await page.route('**/api/billing**', async (route) => {
      const response = await route.fetch();
      const payload = await response.json();
      payload.readiness = {
        ready: false, missing: [], coverage: null,
        localLedgerRetention: { truncated: true, prunedBeforeMs: 0 },
      };
      await route.fulfill({ response, json: payload });
    });
    await page.goto(`${base}/#/evidence`, { waitUntil: 'networkidle' });
    const warning = page.getByText('This ledger was emptied by retention', { exact: true });
    await warning.waitFor();
    const text = await warning.locator('..').innerText();
    assert.match(text, /unrecorded boundary|unknown/);
    assert.doesNotMatch(text, /1970/);
    await capture(page, `close-retention-zero-${viewport}`);
  });
});

test('Value usage coverage does not date a zero retention boundary to 1970', async () => {
  await fixture(async (page, base, viewport) => {
    await page.route('**/api/value**', async (route) => {
      const response = await route.fetch();
      const payload = await response.json();
      assert.ok(payload.usage?.retention, 'the live usage payload must provide retention evidence');
      payload.usage.retention = { truncated: true, prunedBeforeMs: 0, rowsRemoved: 2 };
      // Remove once the independent A4 Value declaration fix is in this branch.
      payload.projects = [];
      await route.fulfill({ response, json: payload });
    });
    await page.goto(`${base}/#/value`, { waitUntil: 'networkidle' });
    await page.getByRole('main').focus();
    let focused = false;
    for (let tab = 0; tab < 40; tab += 1) {
      await page.keyboard.press('Tab');
      focused = await page.evaluate(() => document.activeElement?.tagName === 'SUMMARY'
        && document.activeElement?.textContent === 'Usage without code signals');
      if (focused) break;
    }
    assert.equal(focused, true, 'usage coverage disclosure must be keyboard reachable');
    await page.keyboard.press('Enter');
    const warning = page.getByRole('status').filter({ hasText: 'This usage window reaches behind retention' });
    const text = await warning.innerText();
    assert.match(text, /unrecorded boundary|unknown/);
    assert.doesNotMatch(text, /1970/);
    await capture(page, `value-retention-zero-${viewport}`);
  });
});

for (const site of ['rating', 'consensus']) test(`public market ${site} prices with absent fields are unknown and explicit zero remains zero`, async () => {
  await fixture(async (page, base, viewport) => {
    // Keep this fixture about market-price rendering. The empty value producer
    // currently sends a projects wrapper where the payload contract expects an
    // array; that separate wire mismatch must not prevent reaching this table.
    await page.route('**/api/value**', async (route) => {
      const response = await route.fetch();
      const payload = await response.json();
      payload.projects = [];
      await route.fulfill({ response, json: payload });
    });
    await page.route('**/api/market**', async (route) => {
      const response = await route.fetch();
      const payload = await response.json();
      const price = { basis: 'public_list_price', source: 'litellm', asOf: '2026-09-01', pricedAs: 'fixture', match: 'exact' };
      const row = { kind: 'rating', model: 'fixture', rating: 1000, ratingLower: 990, ratingUpper: 1010, votes: 1, basis: 'public_preference_rating', perDollar: null, frontier: null, personal: null };
      const category = payload.categories[0];
      const board = category.boards.find((item) => item.sourceId !== 'aider');
      assert.ok(board, 'the fixture must reach the rating table');
      board.status = 'available';
      board.rows = [
        { ...row, model: 'Unknown price fixture', price },
        { ...row, model: 'Free image fixture', price: { ...price, usdPerImage: 0 } },
      ];
      const consensus = category.consensus;
      consensus.status = 'available';
      consensus.rows = [
        { model: 'unknown', label: 'Unknown consensus fixture', score: 50, low: 40, high: 60, benchmarks: [], basis: 'public_benchmark_consensus', price, frontier: null, beatenBy: null, personal: null },
        { model: 'zero', label: 'Free consensus fixture', score: 50, low: 40, high: 60, benchmarks: [], basis: 'public_benchmark_consensus', price: { ...price, blendedUsdPerMillion: 0 }, frontier: null, beatenBy: null, personal: null },
      ];
      await route.fulfill({ response, json: payload });
    });
    await page.goto(`${base}/#/value`, { waitUntil: 'networkidle' });
    assert.equal(await page.locator('#main').getByRole('alert').count(), 0, await page.locator('#main').innerText());
    // Native summary has Chromium's DisclosureTriangle AX role, rather than a
    // Playwright button role. Reach and open it as a keyboard user would.
    await page.getByRole('main').focus();
    let focused = false;
    for (let tab = 0; tab < 40; tab += 1) {
      await page.keyboard.press('Tab');
      focused = await page.evaluate(() => document.activeElement?.tagName === 'SUMMARY'
        && document.activeElement?.textContent === 'Public model market: public evidence, not your results');
      if (focused) break;
    }
    assert.equal(focused, true, 'the market disclosure must be keyboard reachable');
    await page.keyboard.press('Enter');
    for (const label of [site === 'rating' ? 'Unknown price fixture' : 'Unknown consensus fixture']) {
      const row = page.getByRole('row').filter({ has: page.getByRole('cell', { name: label, exact: true }) });
      await row.waitFor();
      assert.match(await row.innerText(), /no public price/);
      assert.doesNotMatch(await row.innerText(), /\$0/);
    }
    for (const label of [site === 'rating' ? 'Free image fixture' : 'Free consensus fixture']) {
      const row = page.getByRole('row').filter({ has: page.getByRole('cell', { name: label, exact: true }) });
      assert.match(await row.innerText(), /\$0\.000000/);
    }
    await capture(page, `market-${site}-unknown-${viewport}`);
  });
});

test('Data describes recorded request cost as a metered estimate in plain register', async () => {
  await fixture(async (page, base, viewport) => {
    await page.route('**/api/overview?**', async (route) => {
      const response = await route.fetch();
      const payload = await response.json();
      payload.summary.requests = 3;
      payload.summary.costUsd = 1.25;
      await route.fulfill({ response, json: payload });
    });
    await page.route('**/api/importers', (route) => route.fulfill({ json: { importers: [] } }));
    await page.goto(`${base}/#/data`, { waitUntil: 'networkidle' });
    await page.getByRole('heading', { name: 'Tools we can read on this machine', exact: true }).waitFor();
    const text = await page.getByRole('main').innerText();
    assert.match(text, /AI calls recorded, with \$1\.25 of metered cost estimates/);
    assert.doesNotMatch(text, /worth \$/);
    await capture(page, `data-metered-cost-${viewport}`);
  }, 'plain');
});
