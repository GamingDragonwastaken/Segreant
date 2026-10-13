// Both themes are real: every page passes axe in light and dark, the theme
// follows the operating system by default, and an explicit choice wins and
// survives a reload. Synthetic demo rows on an in-memory ledger; no proxy,
// no credential, no personal data.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';
import AxeBuilder from '@axe-core/playwright';
import { Store } from '../dist/store/db.js';
import { DEFAULT_CONFIG } from '../dist/config.js';
import { createDashboardServer } from '../dist/dashboard/server.js';
import { seedDemo } from '../dist/demo/seed.js';

const ROUTES = ['statement', 'spend', 'control', 'evidence', 'allocation', 'value', 'data', 'system'];

async function withDashboard(run) {
  const home = mkdtempSync(join(tmpdir(), 'segreant-theme-'));
  const saved = Object.fromEntries(['SEGREANT_HOME', 'SEGREANT_DB', 'SEGREANT_DEMO'].map((k) => [k, process.env[k]]));
  process.env.SEGREANT_HOME = home; delete process.env.SEGREANT_DB; delete process.env.SEGREANT_DEMO;
  const store = new Store(':memory:');
  seedDemo(store);
  const server = createDashboardServer({ store, config: structuredClone(DEFAULT_CONFIG), version: 'theme-test' });
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

async function open(browser, base, colorScheme, route) {
  const context = await browser.newContext({ colorScheme, viewport: { width: 1280, height: 900 } });
  await context.addInitScript(() => { try { localStorage.setItem('segreant.register', 'plain'); } catch {} });
  const page = await context.newPage();
  await page.goto(`${base}/#/${route}`, { waitUntil: 'networkidle' });
  await page.getByRole('heading', { level: 1 }).first().waitFor();
  return { context, page };
}

for (const scheme of ['light', 'dark']) {
  test(`every page passes axe in the ${scheme} theme`, async () => {
    await withDashboard(async (browser, base) => {
      for (const route of ROUTES) {
        const { context, page } = await open(browser, base, scheme, route);
        try {
          assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), scheme, `${route} follows a ${scheme} system`);
          const result = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze();
          const found = result.violations.map((v) => `${v.id}: ${v.nodes.slice(0, 3).map((n) => n.target.join(' ')).join(' | ')}`);
          assert.deepEqual(found, [], `${route} in ${scheme}`);
        } finally { await context.close(); }
      }
    });
  });
}

test('an explicit appearance choice overrides the system and survives a reload', async () => {
  await withDashboard(async (browser, base) => {
    const { context, page } = await open(browser, base, 'dark', 'system');
    try {
      const group = page.getByRole('group', { name: 'Appearance' });
      await group.getByRole('button', { name: 'Light', exact: true }).click();
      assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), 'light');
      assert.equal(await group.getByRole('button', { name: 'Light', exact: true }).getAttribute('aria-pressed'), 'true');
      await page.reload({ waitUntil: 'networkidle' });
      assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), 'light', 'the choice is kept in this browser');
      await page.getByRole('group', { name: 'Appearance' }).getByRole('button', { name: 'Match this computer', exact: true }).click();
      assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), 'dark', 'back to following the system');
    } finally { await context.close(); }
  });
});
