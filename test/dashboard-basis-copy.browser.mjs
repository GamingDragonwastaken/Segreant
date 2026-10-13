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

const START = Date.UTC(2026, 6, 1);
const DAY = 86400000;
const iso = (offset) => new Date(START + offset * DAY).toISOString();

async function fixture(run) {
  const home = mkdtempSync(join(tmpdir(), 'segreant-basis-copy-'));
  const saved = Object.fromEntries(['SEGREANT_HOME', 'SEGREANT_DB', 'SEGREANT_DEMO'].map((key) => [key, process.env[key]]));
  process.env.SEGREANT_HOME = home; delete process.env.SEGREANT_DB; delete process.env.SEGREANT_DEMO;
  const store = new Store(':memory:');
  const server = createDashboardServer({ store, config: structuredClone(DEFAULT_CONFIG), version: 'basis-copy-fixture' });
  let browser;
  try {
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    const base = `http://127.0.0.1:${server.address().port}`;
    const post = async (route, body) => {
      const res = await fetch(`${base}/api/${route}/write`, { method: 'POST', headers: { 'x-segreant-local': '1', 'content-type': 'application/json' }, body: JSON.stringify(body) });
      const payload = await res.json(); assert.equal(res.status, 200, JSON.stringify(payload)); return payload;
    };
    const scope = await post('billing', { op: 'scope', accountRef: 'org_basis_fixture', projectRef: 'proj_basis_fixture', apply: true });
    const doc = { schemaVersion: 1, source: { system: 'operator-export', provider: 'openai', exportId: 'basis-fixture', billingAccountRef: 'acct_basis_fixture', exportedAt: iso(5), periodStart: iso(0), periodEnd: iso(2), coverage: 'complete' }, records: [0, 1].map((i) => ({ sourceRecordId: `line-${i}`, chargePeriodStart: iso(i), chargePeriodEnd: iso(i + 1), observedAt: iso(i + 1), providerProjectRef: 'proj_basis_fixture', chargeType: 'usage', currency: 'USD', amount: '2.000000', sku: 'model-usage', service: 'api', model: 'gpt-5', region: null, usageUnit: 'tokens', usageQuantity: '1000' })) };
    const imported = await post('billing', { op: 'import', fileName: 'basis-costs.json', contentBase64: Buffer.from(JSON.stringify(doc)).toString('base64'), apply: true });
    await post('billing', { op: 'adopt', importId: imported.run.importId, apply: true });
    for (const i of [0, 1]) store.insertRequest({ requestId: `basis-${i}`, sessionId: null, tsEpochMs: START + i * DAY + DAY / 2, provider: 'openai', model: 'gpt-5', project: 'basis-fixture', taskWeight: 1, inputTokens: 1, outputTokens: 1, cacheWriteTokens: 0, cacheReadTokens: 0, reasoningTokens: 0, costUsd: 1.75, estimated: false, streamed: false, statusCode: 200, durationMs: 1, scopeCaptureStatus: 'declared_unverified', providerScopeDeclarationId: scope.declaration.declarationId });
    // This other provider/day is part of allocation's ledger input but has no
    // provider-side comparison. One two-day OpenAI check cannot verify it.
    store.insertRequest({ requestId: 'outside-compared-scope', sessionId: null, tsEpochMs: START + 10 * DAY, provider: 'anthropic', model: 'fixture-model', project: 'other-fixture', taskWeight: 1, inputTokens: 1, outputTokens: 1, cacheWriteTokens: 0, cacheReadTokens: 0, reasoningTokens: 0, costUsd: 6, estimated: true, streamed: false, statusCode: 200, durationMs: 1 });
    await post('billing', { op: 'reconcile', apply: true });
    await post('allocation', { op: 'centre', id: 'engineering', name: 'Engineering' });
    browser = await chromium.launch({ headless: true, executablePath: process.env.SEGREANT_CHROME || undefined });
    await run({ browser, base, store, post });
  } finally {
    await browser?.close(); server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); store.close();
    for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    rmSync(home, { recursive: true, force: true });
  }
}

async function open(browser, base, route, timezoneId = 'Africa/Cairo') {
  const context = await browser.newContext({ locale: 'en-GB', timezoneId, viewport: { width: 1440, height: 900 } });
  const page = await context.newPage(); await page.clock.setFixedTime(new Date('2026-07-15T12:00:00Z'));
  await page.goto(base); await page.getByRole('button', { name: /look after the money/ }).click();
  await page.goto(`${base}/#/${route}`);
  return { context, page, main: page.getByRole('main') };
}

test('a recorded provider comparison never verifies the whole allocation input', async () => {
  await fixture(async ({ browser, base }) => {
    const { context, main } = await open(browser, base, 'allocation');
    try {
      await main.getByRole('button', { name: 'Add cost centre', exact: true }).waitFor();
      const text = await main.innerText();
      assert.match(text, /provider comparison is on record/i);
      assert.match(text, /covers its own project and dates/i);
      assert.match(text, /does not verify (?:this split|the inputs to this allocation)/i);
      assert.doesNotMatch(text, /ledger checked against a bill/i);
    } finally { await context.close(); }
  });
});

test('provider day labels retain UTC dates in both positive and negative time zones', async () => {
  await fixture(async ({ browser, base }) => {
    for (const zone of ['Africa/Cairo', 'America/New_York']) {
      const { context, page, main } = await open(browser, base, 'statement', zone);
      try {
        await main.getByRole('link', { name: 'Open Close', exact: true }).waitFor();
        assert.match(await main.innerText(), /1 Jul 2026 – 2 Jul 2026 UTC/);
        await page.getByRole('button', { name: 'Close', exact: true }).click();
        await main.getByRole('button', { name: 'Preview the comparison', exact: true }).waitFor();
        assert.match(await main.innerText(), /1 Jul 2026 – 2 Jul 2026 UTC/);
      } finally { await context.close(); }
    }
  });
});

test('plain save confirmations explain rules and declarations without status tokens', async () => {
  await fixture(async ({ browser, base }) => {
    const { context, page, main } = await open(browser, base, 'allocation');
    try {
      await main.getByRole('button', { name: 'Save rule', exact: true }).click();
      await page.waitForFunction(() => Array.from(document.querySelectorAll('[role="status"]')).some((node) => node.textContent?.startsWith('Rule saved.')));
      assert.doesNotMatch((await main.getByRole('status').allTextContents()).join(' '), /fixed_split|proportional_to_direct|v\d+ \(/);
      await page.getByRole('button', { name: 'Close', exact: true }).click();
      await main.getByRole('textbox', { name: 'Organisation id', exact: true }).fill('org_next_fixture');
      await main.getByRole('textbox', { name: 'Project id', exact: true }).fill('proj_next_fixture');
      await main.getByRole('button', { name: 'Check', exact: true }).click();
      await main.getByRole('button', { name: 'Declare this project', exact: true }).click();
      await page.waitForFunction(() => Array.from(document.querySelectorAll('[role="status"]')).some((node) => node.textContent?.startsWith('Project declared for future')));
      const text = (await main.getByRole('status').allTextContents()).join(' ');
      assert.match(text, /provider has not verified/i);
      assert.doesNotMatch(text, /declared_unverified|not_reconciled/);
    } finally { await context.close(); }
  });
});

test('rule supersession distinguishes immutable saved results from a new historical preview', async () => {
  await fixture(async ({ store, post }) => {
    await post('allocation', { op: 'centre', id: 'operations', name: 'Operations' });
    const rule = { op: 'rule', id: 'historical', method: 'direct', targets: [{ costCentreId: 'engineering', ratio: 1 }], match: {} };
    await post('allocation', rule);
    const saved = await post('allocation', { op: 'run', from: iso(0), to: iso(2), apply: true });
    const revised = await post('allocation', { ...rule, targets: [{ costCentreId: 'operations', ratio: 1 }] });
    const next = await post('allocation', { op: 'run', from: iso(0), to: iso(2) });
    assert.equal(store.allocationRuns()[0].result.byCostCentre[0].costCentreId, 'engineering');
    assert.equal(saved.result.totalMicros, 3500000);
    assert.equal(next.result.byCostCentre[0].costCentreId, 'operations');
    assert.match(revised.message, /recorded runs (?:keep their results|are unchanged)/i);
    assert.match(revised.message, /(?:new )?previews use (?:the )?effective dates/i);
    assert.doesNotMatch(revised.message, /past periods still re-run under it/i);
  });
});
