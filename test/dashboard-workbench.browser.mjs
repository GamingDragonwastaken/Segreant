/**
 * The Spend page Workbench in a real browser, on the sample ledger: the
 * figures on screen are the figures on the wire, the chart's scale reaches its
 * tallest bar, pointing at a bar names its split, choosing one opens that
 * stretch's costliest session, and the sessions table fits its card on a
 * desktop window.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { Store } from '../dist/store/db.js';
import { DEFAULT_CONFIG } from '../dist/config.js';
import { seedDemo } from '../dist/demo/seed.js';
import { createDashboardServer } from '../dist/dashboard/server.js';

const money = (v) => `$${v.toFixed(2)}`;

test('the Workbench shows the wire, scales to its data, and opens the session a bar points at', async () => {
  const home = mkdtempSync(join(tmpdir(), 'segreant-workbench-'));
  const keys = ['SEGREANT_HOME', 'SEGREANT_DB', 'SEGREANT_DEMO'];
  const saved = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  process.env.SEGREANT_HOME = home; delete process.env.SEGREANT_DB; delete process.env.SEGREANT_DEMO;
  const store = new Store(join(home, 'segreant.db'));
  seedDemo(store);
  const server = createDashboardServer({ store, config: structuredClone(DEFAULT_CONFIG), version: 'workbench-fixture' });
  let browser;
  const errors = [];
  try {
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    const base = `http://127.0.0.1:${server.address().port}`;
    const wire = await (await fetch(`${base}/api/sessions?range=30d`)).json();
    assert.ok(wire.sessions.length > 0 && wire.buckets.length >= 30);

    browser = await chromium.launch({ headless: true, executablePath: process.env.SEGREANT_CHROME || undefined });
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    await ctx.addInitScript(() => { try { localStorage.setItem('segreant.register', 'plain'); } catch {} });
    const page = await ctx.newPage();
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(`${base}/#/spend`);
    await page.locator('.wb-tiles').waitFor();
    await page.locator('.rangebar .chip', { hasText: '30 days' }).click();
    await page.waitForFunction(() => document.querySelectorAll('.wb-bar').length >= 30);

    // The tiles are the wire's totals.
    const tiles = await page.locator('.wb-tiles').innerText();
    assert.match(tiles, new RegExp(money(wire.totals.costUsd).replace('$', '\\$')));
    assert.match(tiles, new RegExp(`${wire.totals.sessions} sessions`));

    // One bar per bucket; the top gridline reaches the tallest bar.
    assert.equal(await page.locator('.wb-bar').count(), wire.buckets.length);
    const ticks = await page.locator('.wb-ytick').allInnerTexts();
    const top = Number(ticks[ticks.length - 1].replace(/[$,]/g, ''));
    const tallest = Math.max(...wire.buckets.map((b) => b.costUsd));
    assert.ok(top >= tallest, `axis top ${top} reaches the tallest bar ${tallest}`);
    assert.ok(top < tallest * 2, 'and does not waste half the plot');

    // Point at the costliest bucket: the readout names its total.
    const best = wire.buckets.reduce((bi, b, i, all) => (b.costUsd > all[bi].costUsd ? i : bi), 0);
    await page.locator('.wb-bar').nth(best).hover();
    assert.match(await page.locator('.wb-readout').innerText(), new RegExp(money(wire.buckets[best].costUsd).replace('$', '\\$')));

    // Choose it: the costliest session running in that stretch opens.
    const start = wire.buckets[best].startMs;
    const end = wire.buckets[best + 1]?.startMs ?? wire.window.endMs;
    const expected = wire.sessions.filter((s) => s.startMs < end && s.endMs >= start).sort((a, b) => b.costUsd - a.costUsd)[0];
    await page.locator('.wb-bar').nth(best).click();
    const detail = page.locator('.wb-detail');
    assert.equal((await detail.locator('.wb-head-note').innerText()).trim(), money(expected.costUsd));
    assert.equal(await page.locator('.wb-row.is-selected').count(), 1);

    // Another row opens its own session.
    const other = wire.sessions.find((s) => s.sessionId !== expected.sessionId && s.commits.length > 0) ?? wire.sessions[1];
    await page.locator(`#wb-row-${other.sessionId.replace(/[^A-Za-z0-9_-]/g, '_')}`).click();
    assert.equal((await detail.locator('.wb-head-note').innerText()).trim(), money(other.costUsd));
    if (other.commits.length > 0) assert.equal(await detail.locator('.wb-commit').count(), other.commits.length);

    // The whole table fits its card on a desktop window: no column hides behind a scrollbar.
    const fit = await page.locator('.wb-sessions .table-wrap').evaluate((el) => el.scrollWidth - el.clientWidth);
    assert.ok(fit <= 1, `sessions table overflows its card by ${fit}px`);

    // The outcome split accounts for every session dollar on the wire.
    const o = wire.outcomes;
    const sum = o.kept.costUsd + o.notKept.costUsd + o.contested.costUsd + o.unknown.costUsd + o.maturing.costUsd + o.unmeasured.costUsd + o.noCommit.costUsd;
    const sessionsCost = wire.sessions.reduce((s, x) => s + x.costUsd, 0);
    assert.ok(Math.abs(sum - sessionsCost) < 1e-6);
    assert.match(await page.locator('.wb-outcomes').innerText(), /This is cost, not value/);

    assert.deepEqual(errors, []);
  } finally {
    await browser?.close();
    server.close();
    store.close();
    for (const key of keys) { if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key]; }
    rmSync(home, { recursive: true, force: true });
  }
});
