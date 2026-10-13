import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { chromium } from 'playwright';
import { Store } from '../dist/store/db.js';
import { DEFAULT_CONFIG } from '../dist/config.js';
import { createDashboardServer } from '../dist/dashboard/server.js';

async function waitForText(locator, pattern, message) {
  const until = Date.now() + 10_000;
  let text = '';
  do {
    text = await locator.innerText();
    if (pattern.test(text)) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  } while (Date.now() < until);
  assert.match(text, pattern, message);
}

test('job reloads retain a useful focus target without stealing later focus', async () => {
  const store = new Store(':memory:');
  const server = createDashboardServer({ store, config: structuredClone(DEFAULT_CONFIG), version: 'workflow-focus-test' });
  let browser;
  try {
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const base = `http://127.0.0.1:${server.address().port}`;
    browser = await chromium.launch({ headless: true, executablePath: process.env.SEGREANT_CHROME || undefined });
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    await page.goto(base, { waitUntil: 'domcontentloaded' });
    await page.getByRole('dialog', { name: 'What brings you to Segreant?' })
      .getByRole('button', { name: /look after the money/ }).click();

    const main = page.getByRole('main');
    const jobs = page.getByRole('navigation', { name: 'Jobs' });
    await jobs.getByRole('button', { name: 'Allocate', exact: true }).click();
    const name = main.getByRole('textbox', { name: 'Name', exact: true });
    const add = main.getByRole('button', { name: 'Add cost centre', exact: true });
    await name.fill('Engineering');
    await add.focus();
    await page.keyboard.press('Enter');
    await main.getByRole('button', { name: 'Archive Engineering', exact: true }).waitFor();
    assert.equal(await add.evaluate((element) => document.activeElement === element), true,
      'the rebuilt form must retain focus on its equivalent submit control');

    await page.route('**/api/allocation-write', async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 150));
      await route.continue();
    });
    await name.fill('Operations');
    await add.focus();
    await page.keyboard.press('Enter');
    const statementNav = jobs.getByRole('button', { name: 'Statement', exact: true });
    await statementNav.focus();
    await main.getByRole('button', { name: 'Archive Operations', exact: true }).waitFor();
    assert.equal(await statementNav.evaluate((element) => document.activeElement === element), true,
      'a completed request must not steal focus after the operator moved outside the rebuilt region');

    await jobs.getByRole('button', { name: 'Close', exact: true }).click();
    await main.getByRole('textbox', { name: 'Organisation id', exact: true }).fill('org_focus_test');
    await main.getByRole('textbox', { name: 'Project id', exact: true }).fill('proj_focus_test');
    const check = main.getByRole('button', { name: 'Check', exact: true });
    await check.focus();
    await page.keyboard.press('Enter');
    const declare = main.getByRole('button', { name: 'Declare this project', exact: true });
    await declare.waitFor();
    await declare.focus();
    await page.keyboard.press('Enter');
    await waitForText(main, /A project is declared\./, 'scope save must reload the Close job');
    const file = main.getByLabel('Cost export (.json)', { exact: true });
    assert.equal(await file.evaluate((element) => document.activeElement === element), true,
      'when the initiating control disappears, focus must move to the next useful job control');
  } finally {
    await browser?.close();
    server.closeAllConnections();
    if (server.listening) await new Promise((resolve) => server.close(resolve));
    store.close();
  }
});
