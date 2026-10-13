// Real Chromium, real dashboard server. Once figures are on screen and the server
// stops, the page must say the figures are not current, with their age and a retry,
// without the operator having to click anything. Run with: npm run test:browser
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
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

// SEGREANT_CHROME may point at an installed Chrome or Edge when Playwright's own
// browser is not downloaded; unset, Playwright uses its bundled Chromium.
test('dashboard outage: figures on screen are labelled not current, with age and retry', async () => {
  const store = new Store(':memory:');
  const server = createDashboardServer({ store, config: structuredClone(DEFAULT_CONFIG), version: 'outage-stale-test' });
  const base = await listen(server);
  let browser;
  try {
    browser = await chromium.launch({ headless: true, executablePath: process.env.SEGREANT_CHROME || undefined });
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    await context.addInitScript(() => { try { localStorage.setItem('segreant.register', 'plain'); } catch {} });
    const page = await context.newPage();
    await page.goto(`${base}/#/spend`);
    await page.waitForSelector('.spine', { timeout: 60000 });

    // Simulate a dead process: stop listening and drop every open keep-alive socket.
    server.close();
    server.closeAllConnections();

    // The shell re-checks the server on a timer while figures are shown, so this needs no click.
    const banner = page.locator('.banner-stale');
    await banner.waitFor({ state: 'visible', timeout: 40000 });
    const text = await banner.innerText();
    assert.match(text, /stopped responding/i, 'says the server stopped responding');
    assert.match(text, /not current/i, 'says the figures are not current');
    assert.match(text, /read .*ago|less than a minute ago|read at/i, 'states when the figures were read, and how old they are');
    await page.getByRole('button', { name: 'Retry', exact: true }).waitFor({ state: 'visible', timeout: 5000 });
  } finally {
    await browser?.close();
    server.closeAllConnections();
    if (server.listening) server.close();
    store.close();
  }
});
