// The first-run choice focuses the chosen page's heading once it renders. On a
// slow machine the heading can arrive after the user has already moved focus
// (CI on PR #146: the skip link put focus on main, then the late heading focus
// took it back). The user's move must win.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { Store } from '../dist/store/db.js';
import { DEFAULT_CONFIG } from '../dist/config.js';
import { createDashboardServer } from '../dist/dashboard/server.js';

test('a late page heading never takes focus back from where the user moved it', async () => {
  const store = new Store(':memory:');
  const server = createDashboardServer({ store, config: structuredClone(DEFAULT_CONFIG), version: 'focus-race-test' });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch({ headless: true, executablePath: process.env.SEGREANT_CHROME || undefined });
  try {
    const page = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
    await page.goto(base + '/', { waitUntil: 'networkidle' });
    // Hold the chosen page's heading back, as a slow machine does.
    await page.evaluate(() => {
      let held = false;
      new MutationObserver((_records, observer) => {
        const heading = document.querySelector('main h1');
        if (held || !heading) return;
        held = true;
        observer.disconnect();
        const parent = heading.parentNode;
        const next = heading.nextSibling;
        heading.remove();
        setTimeout(() => parent.insertBefore(heading, next), 400);
      }).observe(document.body, { childList: true, subtree: true });
    });
    await page.getByRole('button', { name: /build with AI tools/ }).click();
    await page.getByRole('link', { name: 'Skip to content' }).focus();
    await page.keyboard.press('Enter');
    await page.waitForTimeout(1200);
    const active = await page.evaluate(() => {
      const a = document.activeElement;
      return a ? `${a.tagName.toLowerCase()}#${a.id}` : 'none';
    });
    assert.equal(active, 'main#main', 'focus stays where the skip link put it');
  } finally {
    await browser.close();
    await new Promise((resolve) => server.close(resolve));
    store.close();
  }
});
