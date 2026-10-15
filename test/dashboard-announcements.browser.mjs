/**
 * What a screen reader is told, found by running NVDA 2026.2 over the G2 script
 * (2026-10-15). Three defects, each pinned here before it was fixed:
 *
 * 1. After the first-run choice, focus fell to <body>: the dialog restored focus
 *    to whatever had it when it opened, which on a fresh page is nothing. NVDA
 *    started reading from the top of the document.
 * 2. Each job's status line (`.page-notice`, role=status) was `hidden` until it
 *    had text. A live region that enters the accessibility tree already holding
 *    its message is usually not announced, so "saved" and the Close check result
 *    were shown but never spoken.
 * 3. While a month loaded, its live label read the raw key ("2026-09") and then
 *    the name ("September 2026"): two announcements, the first meaningless.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { chromium } from 'playwright';
import { Store } from '../dist/store/db.js';
import { DEFAULT_CONFIG } from '../dist/config.js';
import { createDashboardServer } from '../dist/dashboard/server.js';

test('screen readers are told where they are and what happened', async () => {
  const store = new Store(':memory:');
  const server = createDashboardServer({ store, config: structuredClone(DEFAULT_CONFIG), version: 'announcements-test' });
  let browser;
  try {
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const base = `http://127.0.0.1:${server.address().port}`;
    browser = await chromium.launch({ headless: true, executablePath: process.env.SEGREANT_CHROME || undefined });
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    await page.goto(base, { waitUntil: 'domcontentloaded' });

    // 1. The keyboard path through the first run lands on the page heading.
    const choice = page.getByRole('dialog', { name: 'What brings you to Segreant?' }).getByRole('button', { name: /look after the money/ });
    await choice.focus();
    await page.keyboard.press('Enter');
    const main = page.getByRole('main');
    await main.getByRole('heading', { name: 'Statement', exact: true, level: 1 }).waitFor();
    await page.waitForFunction(() => document.activeElement !== document.body, null, { timeout: 5000 }).catch(() => {});
    const landed = await page.evaluate(() => {
      const el = document.activeElement;
      return el ? `${el.tagName.toLowerCase()}:${(el.textContent || '').trim().slice(0, 40)}` : 'none';
    });
    assert.equal(landed, 'h1:Statement', 'after the first-run choice, focus lands on the page heading, not <body>');

    // 3. Every text the month label ever holds is a month name, never the raw key.
    const seen = await page.evaluate(() => {
      const label = document.querySelector('.month-label');
      const texts = [label?.textContent ?? ''];
      if (label) new MutationObserver(() => texts.push(label.textContent ?? '')).observe(label, { childList: true, characterData: true, subtree: true });
      (window).__monthTexts = texts;
      return texts.length;
    });
    assert.ok(seen >= 1);
    await main.getByRole('button', { name: 'Previous month', exact: true }).click();
    await page.waitForTimeout(800);
    const texts = await page.evaluate(() => (window).__monthTexts);
    for (const t of texts) assert.doesNotMatch(t, /^\d{4}-\d{2}$/, `the live month label must never read a raw key, saw "${t}" in ${JSON.stringify(texts)}`);

    // 2. Each job's status line is in the accessibility tree before it speaks.
    const jobs = page.getByRole('navigation', { name: 'Jobs' });
    await jobs.getByRole('button', { name: 'Allocate', exact: true }).click();
    await main.getByRole('heading', { name: 'Allocate', exact: true }).waitFor();
    const before = await page.evaluate(() => {
      const n = document.querySelector('main .page-notice');
      return n ? { hidden: n.hidden, display: getComputedStyle(n).display, role: n.getAttribute('role') } : null;
    });
    assert.ok(before, 'Allocate has a status line');
    assert.equal(before.role, 'status');
    assert.equal(before.hidden, false, 'an empty status line stays in the accessibility tree');
    assert.notEqual(before.display, 'none', 'an empty status line is not display:none');
    await main.getByRole('textbox', { name: 'Name', exact: true }).fill('Engineering');
    await main.getByRole('button', { name: 'Add cost centre', exact: true }).click();
    await main.getByRole('button', { name: 'Archive Engineering', exact: true }).waitFor();
    const said = await page.evaluate(() => document.querySelector('main .page-notice')?.textContent ?? '');
    assert.match(said, /\S/, 'the status line carries the confirmation');
  } finally {
    await browser?.close();
    server.close();
    store.close?.();
  }
});
