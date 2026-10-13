// The classic dashboard must say what the server refused, in words. The
// settings and judge routes answer `{ error: { code, message } }`; classic
// used to wrap that object in an Error and show "[object Object]".
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

test('classic settings shows the server\'s refusal message, not [object Object]', async () => {
  const home = mkdtempSync(join(tmpdir(), 'segreant-classic-errors-'));
  const saved = Object.fromEntries(['SEGREANT_HOME', 'SEGREANT_DB', 'SEGREANT_DEMO'].map((k) => [k, process.env[k]]));
  process.env.SEGREANT_HOME = home; delete process.env.SEGREANT_DB; delete process.env.SEGREANT_DEMO;
  const store = new Store(':memory:');
  const server = createDashboardServer({ store, config: structuredClone(DEFAULT_CONFIG), version: 'classic-errors' });
  let browser;
  try {
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    const base = `http://127.0.0.1:${server.address().port}`;
    browser = await chromium.launch({ headless: true, executablePath: process.env.SEGREANT_CHROME || undefined });
    const page = await browser.newPage();
    // The real refusal shape this route sends, without depending on which
    // value the validator happens to reject today.
    await page.route('**/api/settings/update', (route) => route.fulfill({
      status: 400, contentType: 'application/json',
      body: JSON.stringify({ error: { code: 'CONFIG_INVALID', message: 'CONFIG_INVALID: budget.dailyUsd must be a finite dollar amount' } }),
    }));
    await page.goto(`${base}/classic`, { waitUntil: 'networkidle' });
    await page.locator('button[data-view="settings"]').click();
    await page.locator('#budget-form').waitFor();
    await page.evaluate(() => document.querySelector('#budget-form').requestSubmit());
    await page.waitForFunction(() => (document.querySelector('#settings-error')?.textContent ?? '').trim().length > 0, null, { timeout: 10_000 });
    const text = await page.evaluate(() => document.querySelector('#settings-error').textContent);
    if (process.env.SEGREANT_BROWSER_ARTIFACTS) await page.screenshot({ path: join(process.env.SEGREANT_BROWSER_ARTIFACTS, 'classic-settings-error.png') });
    assert.doesNotMatch(text, /\[object Object\]/);
    assert.match(text, /budget\.dailyUsd must be a finite dollar amount/);
  } finally {
    await browser?.close();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    store.close();
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    rmSync(home, { recursive: true, force: true });
  }
});
