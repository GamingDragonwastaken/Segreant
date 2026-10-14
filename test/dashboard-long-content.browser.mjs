// Long content must not break the page: a 120-character project name with no
// spaces, a long model name, a long cost-centre name, 200 projects, and an
// eight-figure amount with micro-dollar precision. At phone width no route may
// scroll sideways, and a name in a table must not push the amount beside it
// out of view: passing the first check alone hid the money column on Statement.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { Store } from '../dist/store/db.js';
import { DEFAULT_CONFIG } from '../dist/config.js';
import { createDashboardServer } from '../dist/dashboard/server.js';

const ROUTES = ['statement', 'spend', 'control', 'evidence', 'allocation', 'value', 'data', 'system'];
const LONG_PROJECT = 'monorepo-' + 'x'.repeat(111);
const LONG_MODEL = 'vendor-experimental-reasoning-model-with-an-unusually-long-identifier-2026-10-14-preview';
const LONG_CENTRE = 'Platform-Infrastructure-and-Developer-Productivity-Shared-Services-EMEA-cost-centre';

function row(id, tsEpochMs, costUsd, project, model = 'gpt-5') {
  return {
    requestId: id, sessionId: null, tsEpochMs, provider: 'openai', model, project, taskWeight: 1,
    inputTokens: 10, outputTokens: 10, cacheWriteTokens: 0, cacheReadTokens: 0, reasoningTokens: 0, costUsd,
    estimated: false, streamed: false, statusCode: 200, durationMs: 1,
  };
}

// For every body row of every table under `scope`, the first figure column
// must end inside the visible part of its scrolling wrapper.
async function hiddenFigures(page, scope) {
  return page.evaluate((sel) => {
    const out = [];
    for (const table of document.querySelectorAll(`${sel} table`)) {
      const wrap = table.closest('.table-wrap') ?? table.parentElement;
      const edge = wrap.getBoundingClientRect().right;
      for (const tr of table.querySelectorAll('tbody tr')) {
        const num = tr.querySelector('td.num');
        if (num && num.getBoundingClientRect().right > edge + 1) {
          out.push(`${table.getAttribute('aria-label') ?? table.querySelector('caption')?.textContent ?? 'table'}: "${tr.cells[0]?.textContent?.slice(0, 30)}" amount ends at ${Math.round(num.getBoundingClientRect().right)}px, view ends at ${Math.round(edge)}px`);
          break;
        }
      }
    }
    return out;
  }, scope);
}

test('long names, many rows and an eight-figure amount never make a page scroll sideways or hide an amount at 375 px', async () => {
  const home = mkdtempSync(join(tmpdir(), 'segreant-long-content-'));
  const saved = Object.fromEntries(['SEGREANT_HOME', 'SEGREANT_DB', 'SEGREANT_DEMO'].map((k) => [k, process.env[k]]));
  process.env.SEGREANT_HOME = home; delete process.env.SEGREANT_DB; delete process.env.SEGREANT_DEMO;
  const store = new Store(':memory:');
  const now = Date.now();
  store.insertRequest(row('huge', now - 60_000, 12_345_678.901234, LONG_PROJECT, LONG_MODEL));
  for (let i = 0; i < 200; i++) store.insertRequest(row(`p-${i}`, now - 120_000 - i, 0.01 + i / 1000, `project number ${i} with a long human name for the team that owns it`));
  const server = createDashboardServer({ store, config: structuredClone(DEFAULT_CONFIG), version: 'long-content' });
  let browser;
  try {
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    const base = `http://127.0.0.1:${server.address().port}`;
    const post = async (body) => {
      const res = await fetch(`${base}/api/allocation/write`, { method: 'POST', headers: { 'x-segreant-local': '1', 'content-type': 'application/json' }, body: JSON.stringify(body) });
      const payload = await res.json(); assert.equal(res.status, 200, JSON.stringify(payload)); return payload;
    };
    // Only the long project is routed, so the other 200 land in an
    // "unallocated, mostly …" row that lists long project names too.
    await post({ op: 'centre', id: 'platform', name: LONG_CENTRE });
    await post({ op: 'rule', id: 'long', method: 'direct', targets: [{ costCentreId: 'platform', ratio: 1 }], match: { project: LONG_PROJECT } });

    browser = await chromium.launch({ headless: true, executablePath: process.env.SEGREANT_CHROME || undefined });
    const context = await browser.newContext({ viewport: { width: 375, height: 812 } });
    await context.addInitScript(() => { try { localStorage.setItem('segreant.register', 'plain'); } catch {} });
    const page = await context.newPage();
    const artifacts = process.env.SEGREANT_BROWSER_ARTIFACTS;
    if (artifacts) mkdirSync(artifacts, { recursive: true });
    const overflow = [];
    for (const route of ROUTES) {
      await page.goto(`${base}/#/${route}`, { waitUntil: 'networkidle' });
      await page.getByRole('heading', { level: 1 }).first().waitFor();
      await page.waitForFunction(() => !document.querySelector('[aria-busy="true"]'));
      const widths = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, client: document.documentElement.clientWidth }));
      if (widths.scroll > widths.client + 1) overflow.push(`${route}: page is ${widths.scroll}px wide in a ${widths.client}px viewport`);
      // Stacked cards need space between them; borders that touch read as one box.
      overflow.push(...(await page.evaluate(() => {
        const cards = [...document.querySelectorAll('main .card')].filter((c) => c.offsetParent !== null);
        const out = [];
        for (const a of cards) for (const b of cards) {
          if (a === b || a.contains(b) || b.contains(a)) continue;
          const ra = a.getBoundingClientRect(); const rb = b.getBoundingClientRect();
          const sideBySide = ra.right <= rb.left || rb.right <= ra.left;
          const gap = rb.top - ra.bottom;
          if (!sideBySide && gap >= 0 && gap < 4) out.push(`cards touch: "${a.textContent.trim().slice(0, 30)}" / "${b.textContent.trim().slice(0, 30)}"`);
        }
        return out;
      })).map((m) => `${route}: ${m}`));
      if (route === 'statement') {
        overflow.push(...(await hiddenFigures(page, 'main')).map((m) => `statement: ${m}`));
        const shares = await page.locator('main table td.num:nth-child(3)').allInnerTexts();
        assert.ok(shares.includes('>99%') && shares.includes('<1%'), `Statement shares: ${shares.slice(0, 3).join(', ')}`);
        assert.ok(!shares.includes('0%') && !shares.includes('100%'), 'no partial share reads as 0% or 100%');
      }
      if (artifacts) await page.screenshot({ path: join(artifacts, `long-${route}-375.png`), fullPage: true });
    }

    const main = page.getByRole('main');
    await page.goto(`${base}/#/allocation`, { waitUntil: 'networkidle' });
    await main.getByLabel('Period').selectOption({ index: 1 });
    await main.getByRole('button', { name: 'Preview split', exact: true }).click();
    await main.locator('.run-result table').waitFor();
    const previewText = await main.locator('.run-result').innerText();
    assert.match(previewText, /Platform-Infrastructure/, 'the long cost-centre name is shown');
    assert.match(previewText, /12,345,678/, 'its eight-figure amount is shown');
    // $21.90 of $12.3M is unallocated: neither side may round to the whole or to nothing.
    assert.doesNotMatch(previewText, /(?<![<>\d.])(?:0\.0|100\.0)%/, 'a partial share never reads as 0.0% or 100.0%');
    assert.match(previewText, />99\.9%/);
    assert.match(previewText, /<0\.1%/);
    overflow.push(...(await hiddenFigures(page, '.run-result')).map((m) => `allocation preview: ${m}`));
    const widths = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, client: document.documentElement.clientWidth }));
    if (widths.scroll > widths.client + 1) overflow.push(`allocation preview: page is ${widths.scroll}px wide`);
    if (artifacts) await main.locator('.run-result').screenshot({ path: join(artifacts, 'long-allocation-preview-375.png') });

    assert.deepEqual(overflow, []);
    await page.goto(`${base}/#/spend`, { waitUntil: 'networkidle' });
    assert.match(await main.innerText(), /12,345,678/, 'the eight-figure amount is shown, grouped');
  } finally {
    await browser?.close();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    store.close();
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    rmSync(home, { recursive: true, force: true });
  }
});
