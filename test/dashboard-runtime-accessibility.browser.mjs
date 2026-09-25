import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import AxeBuilder from '@axe-core/playwright';
import { Store } from '../dist/store/db.js';
import { DEFAULT_CONFIG } from '../dist/config.js';
import { createDashboardServer } from '../dist/dashboard/server.js';

function listen(server) {
  return new Promise((resolve, reject) => {
    const onError = (error) => { server.off('listening', onListening); reject(error); };
    const onListening = () => {
      server.off('error', onError);
      const address = server.address();
      if (!address || typeof address === 'string') return reject(new Error('dashboard did not expose a TCP port'));
      resolve(`http://127.0.0.1:${address.port}`);
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(0, '127.0.0.1');
  });
}

test('runtime dashboard accessibility: real Chromium DOM, keyboard focus, network boundary and axe contract', async () => {
  const store = new Store(':memory:');
  const server = createDashboardServer({ store, config: structuredClone(DEFAULT_CONFIG), version: 'browser-a11y-test' });
  const base = await listen(server);
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();
  const consoleErrors = [];
  const pageErrors = [];
  const unexpectedRequests = [];
  page.on('console', (message) => { if (message.type() === 'error' || message.type() === 'warning') consoleErrors.push(message.text()); });
  page.on('pageerror', (error) => pageErrors.push(String(error)));
  page.on('request', (request) => {
    const url = new URL(request.url());
    if (url.origin !== base) unexpectedRequests.push(request.url());
  });
  try {
    await page.goto(base + '/', { waitUntil: 'networkidle' });

    const firstRun = page.getByRole('dialog', { name: 'How should Segreant talk to you?' });
    await firstRun.waitFor({ state: 'visible' });
    const plain = firstRun.getByRole('button', { name: /Plain language/ });
    const precise = firstRun.getByRole('button', { name: /Precise/ });
    await plain.focus();
    assert.equal(await page.evaluate(() => document.activeElement?.textContent?.includes('Plain language')), true, 'first-run focus must land on the first choice');
    await page.keyboard.press('Escape');
    assert.equal(await firstRun.isVisible(), true, 'Escape must not dismiss the required first-run choice');
    assert.equal(await page.evaluate(() => document.activeElement?.textContent?.includes('Plain language')), true, 'Escape must return focus to the first choice');
    await precise.click();
    await page.locator('#main').waitFor({ state: 'visible' });

    const skip = page.getByRole('link', { name: 'Skip to content' });
    await skip.focus();
    await page.keyboard.press('Enter');
    assert.equal(await page.evaluate(() => document.activeElement?.id), 'main', 'skip link must move focus to main without routing');

    const dialogCountBefore = await page.getByRole('dialog').count();
    assert.equal(dialogCountBefore, 0, 'first-run dialog must be removed after registration');
    const axe = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze();
    assert.deepEqual(axe.violations, [], JSON.stringify(axe.violations, null, 2));
    const unnamedControls = await page.locator('button, input, select, textarea').evaluateAll((nodes) => nodes
      .filter((node) => {
        const label = node.getAttribute('aria-label');
        const labelledBy = node.getAttribute('aria-labelledby');
        const id = node.getAttribute('id');
        const associated = id ? document.querySelector(`label[for="${CSS.escape(id)}"]`) : null;
        return !label && !labelledBy && !associated && !node.textContent?.trim();
      })
      .map((node) => `${node.tagName}.${node.className}`));
    assert.deepEqual(unnamedControls, [], `interactive controls without an accessible name: ${unnamedControls.join('; ')}`);
    await page.setViewportSize({ width: 360, height: 800 });
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
    assert.equal(overflow, false, 'narrow dashboard viewport must not introduce horizontal overflow');
    const narrowAxe = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze();
    assert.deepEqual(narrowAxe.violations, [], JSON.stringify(narrowAxe.violations, null, 2));
    assert.deepEqual(consoleErrors, [], `browser console errors/warnings: ${consoleErrors.join('; ')}`);
    assert.deepEqual(pageErrors, [], `browser page errors: ${pageErrors.join('; ')}`);
    assert.deepEqual(unexpectedRequests, [], `dashboard attempted non-loopback requests: ${unexpectedRequests.join('; ')}`);
  } finally {
    await context.close();
    await browser.close();
    await new Promise((resolve) => server.close(() => resolve()));
    store.close();
  }
});
