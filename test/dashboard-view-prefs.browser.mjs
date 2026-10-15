/**
 * "What you see" in Settings: density, the four-figure strip, the explanations
 * under titles, and which jobs the top bar shows. Display only, kept in this
 * browser, and nothing hidden becomes unreachable.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { chromium } from 'playwright';
import { Store } from '../dist/store/db.js';
import { DEFAULT_CONFIG } from '../dist/config.js';
import { createDashboardServer } from '../dist/dashboard/server.js';

test('readers choose what they see, and nothing hidden becomes unreachable', async () => {
  const store = new Store(':memory:');
  const server = createDashboardServer({ store, config: structuredClone(DEFAULT_CONFIG), version: 'view-prefs-test' });
  let browser;
  try {
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const base = `http://127.0.0.1:${server.address().port}`;
    browser = await chromium.launch({ headless: true, executablePath: process.env.SEGREANT_CHROME || undefined });
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    await page.addInitScript(() => { try { localStorage.setItem('segreant.register', 'plain'); } catch {} });
    await page.goto(`${base}/#/system`, { waitUntil: 'domcontentloaded' });
    const main = page.getByRole('main');
    const jobs = page.getByRole('navigation', { name: 'Jobs' });
    await main.getByRole('heading', { name: 'Settings', exact: true }).waitFor();

    const spacing = () => page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--s4').trim());
    assert.equal(await spacing(), '16px');
    await main.getByRole('group', { name: 'Density' }).getByRole('button', { name: 'Compact' }).click();
    assert.equal(await spacing(), '12px', 'compact tightens the spacing scale');

    await main.getByRole('checkbox', { name: 'Allocate' }).uncheck();
    assert.equal(await jobs.getByRole('button', { name: 'Allocate', exact: true }).isHidden(), true, 'a hidden job leaves the top bar');
    await main.getByRole('link', { name: 'Open Allocate' }).click();
    await main.getByRole('heading', { name: 'Allocate', exact: true }).waitFor();
    assert.equal(await jobs.getByRole('button', { name: 'Allocate', exact: true }).isVisible(), true, 'the job you are in always shows');

    await page.goto(`${base}/#/system`);
    await main.getByRole('checkbox', { name: 'The four figures above the money pages' }).uncheck();
    await main.getByRole('checkbox', { name: 'A short explanation under each page title' }).uncheck();
    await page.goto(`${base}/#/spend`);
    await page.reload();
    await main.getByRole('heading', { level: 1 }).first().waitFor();
    assert.equal(await page.getByRole('region', { name: 'The four figures' }).count(), 0, 'the strip stays folded after a reload');
    assert.equal(await page.locator('main .view-head .view-plain').first().isHidden(), true, 'the explanation stays hidden after a reload');
    assert.equal(await spacing(), '12px', 'density survives a reload');
    assert.equal(await jobs.getByRole('button', { name: 'Allocate', exact: true }).isHidden(), true);
  } finally {
    await browser?.close();
    server.close();
    store.close?.();
  }
});
