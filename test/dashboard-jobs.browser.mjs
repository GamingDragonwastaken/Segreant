// Real job controls, real wire payloads, and an ordinary scratch ledger.
// No proxy process or provider credential is needed for these synthetic rows.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { chromium } from 'playwright';

const DAY = 86_400_000;
const PROJECT = 'proj_browser_jobs';
const ROUTES = [
  ['Statement', 'Statement'], ['Spend', 'Spend'], ['Protect', /Protect|Control/],
  ['Close', 'Close'], ['Allocate', 'Allocate'], ['Value', /Value/],
  ['Data', 'Data'], ['Settings', /Settings|System/],
];

function row(id, tsEpochMs, costUsd, scopeId = null) {
  return {
    requestId: id, sessionId: null, tsEpochMs, provider: 'openai', model: 'gpt-5',
    project: 'browser-fixture', taskWeight: 1, inputTokens: 1, outputTokens: 1,
    cacheWriteTokens: 0, cacheReadTokens: 0, reasoningTokens: 0, costUsd,
    estimated: false, streamed: false, statusCode: 200, durationMs: 1,
    scopeCaptureStatus: scopeId ? 'declared_unverified' : 'unscoped',
    providerScopeDeclarationId: scopeId,
  };
}

async function reads(locator, pattern, message) {
  const until = Date.now() + 15_000;
  let text = '';
  do {
    text = await locator.innerText();
    if (pattern.test(text)) return text;
    await new Promise((resolve) => setTimeout(resolve, 50));
  } while (Date.now() < until);
  assert.match(text, pattern, message);
}

async function capture(page, name) {
  if (!process.env.SEGREANT_BROWSER_ARTIFACTS) return;
  await mkdir(process.env.SEGREANT_BROWSER_ARTIFACTS, { recursive: true });
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: join(process.env.SEGREANT_BROWSER_ARTIFACTS, `${name}.png`), fullPage: true });
}

async function ready(main, label) {
  const until = Date.now() + 60_000;
  do {
    const pending = await main.getByRole('status').evaluateAll((nodes) => nodes.some((node) => node.getAttribute('aria-busy') === 'true'));
    if (!pending) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  } while (Date.now() < until);
  assert.fail(`${label}: page payload did not finish loading`);
}

async function phoneLayout(page, label) {
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true,
    `${label}: no horizontal overflow at 375px`);
  const small = await page.getByRole('button').evaluateAll((buttons) => buttons
    .filter((button) => button.matches('.btn-commit, .btn-ghost') && button.getBoundingClientRect().width > 0)
    .map((button) => ({ name: button.getAttribute('aria-label') || button.textContent.trim(), height: button.getBoundingClientRect().height }))
    .filter(({ height }) => height < 44));
  assert.deepEqual(small, [], `${label}: primary buttons must be at least 44px tall: ${JSON.stringify(small)}`);
}

test('finance jobs: allocate, close with a BOM export, and read each run on Statement', { timeout: 180_000 }, async () => {
  const home = await mkdtemp(join(tmpdir(), 'segreant-browser-jobs-'));
  const saved = Object.fromEntries(['SEGREANT_HOME', 'SEGREANT_DB', 'SEGREANT_DEMO'].map((key) => [key, process.env[key]]));
  process.env.SEGREANT_HOME = home;
  delete process.env.SEGREANT_DB;
  delete process.env.SEGREANT_DEMO;
  let store, server, browser;
  try {
    const [{ Store }, { DEFAULT_CONFIG }, { createDashboardServer }] = await Promise.all([
      import('../dist/store/db.js'), import('../dist/config.js'), import('../dist/dashboard/server.js'),
    ]);
    store = new Store(join(home, 'segreant.db'));
    // Use the preceding month as the browser's current month. Its first two UTC
    // days are always closed >48h ago on the server, including runs on the 1st.
    const now = new Date();
    const start = Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1);
    const browserNow = new Date(start + 14 * DAY + DAY / 2);
    const iso = (offset) => new Date(start + offset * DAY).toISOString();
    const date = (ms) => new Date(ms).toLocaleDateString('en-US', { timeZone: 'UTC', year: 'numeric', month: 'short', day: 'numeric' });
    store.insertRequest(row('allocation-seed', start + 10 * DAY, 10));
    server = createDashboardServer({ store, config: structuredClone(DEFAULT_CONFIG), version: 'browser-jobs-test' });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const base = `http://127.0.0.1:${server.address().port}`;
    browser = await chromium.launch({ headless: true, executablePath: process.env.SEGREANT_CHROME || undefined });
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'en-US', timezoneId: 'UTC' });
    const page = await context.newPage();
    await page.clock.setFixedTime(browserNow);
    const errors = [], external = [];
    page.on('pageerror', (error) => errors.push(String(error)));
    page.on('request', (request) => { if (new URL(request.url()).origin !== base) external.push(request.url()); });
    await page.goto(base, { waitUntil: 'domcontentloaded' });
    await page.getByRole('dialog', { name: 'What brings you to Segreant?' }).getByRole('button', { name: /I look after the money/ }).click();
    const main = page.getByRole('main');
    const jobs = page.getByRole('navigation', { name: 'Jobs' });
    const claims = page.getByRole('region', { name: 'The four claims' });
    const button = (name) => main.getByRole('button', { name, exact: true });
    await main.getByRole('heading', { name: 'Statement', exact: true }).waitFor();
    assert.equal(new URL(page.url()).hash, '#/statement', 'finance first run lands on Statement');
    assert.equal(await button('Next month').isDisabled(), true, 'next is disabled on the browser current month');

    await jobs.getByRole('button', { name: 'Allocate', exact: true }).click();
    for (const name of ['Engineering', 'Operations']) {
      await main.getByRole('textbox', { name: 'Name', exact: true }).fill(name);
      await button('Add cost centre').click();
      await reads(main, new RegExp(`Archive|${name}`), 'centre saved');
      await main.getByRole('button', { name: `Archive ${name}`, exact: true }).waitFor();
    }
    await main.getByRole('combobox', { name: 'How', exact: true }).selectOption('fixed_split');
    await main.getByRole('spinbutton', { name: 'Share for Engineering, percent', exact: true }).fill('70');
    await main.getByRole('spinbutton', { name: 'Share for Operations, percent', exact: true }).fill('30');
    await button('Save rule').click();
    await reads(main, /70% to Engineering, 30% to Operations/, 'saved rule describes the exact split');
    await main.getByRole('combobox', { name: 'Period', exact: true }).selectOption('1');
    await button('Preview split').click();
    await main.getByRole('table', { name: 'Allocation preview by cost centre' }).waitFor();
    const allocationPreview = await main.getByRole('table', { name: 'Allocation preview by cost centre' }).innerText();
    assert.match(allocationPreview, /Engineering\s+\$7\.00\s+70\.0%/);
    assert.match(allocationPreview, /Operations\s+\$3\.00\s+30\.0%/);
    assert.equal(store.allocationRuns().length, 0, 'allocation preview records nothing');
    await capture(page, 'allocate-preview-desktop');
    await page.setViewportSize({ width: 375, height: 812 });
    await phoneLayout(page, 'Allocate preview');
    await capture(page, 'allocate-preview-phone');
    await button('Record this run').click();
    await reads(claims.getByRole('button', { name: /^Allocated ·/ }), /apportioned by recorded rules — showback only/, 'Allocated band refreshes without a page reload');
    assert.equal(store.allocationRuns().length, 1);

    await page.setViewportSize({ width: 1440, height: 900 });
    await jobs.getByRole('button', { name: 'Close', exact: true }).click();
    await main.getByRole('textbox', { name: 'Organisation id', exact: true }).fill(['sk', 'fixture-refused'].join('-'));
    await main.getByRole('textbox', { name: 'Project id', exact: true }).fill(PROJECT);
    await button('Check').click();
    await reads(main, /looks like an API key\. Use the organisation id/, 'a key-shaped reference is refused with a readable sentence');
    assert.equal(store.activeOpenAiScope(), null, 'refused reference never becomes a declaration');
    await main.getByRole('textbox', { name: 'Organisation id', exact: true }).fill('org_browser_jobs');
    await button('Check').click();
    await button('Declare this project').waitFor();
    assert.equal(store.activeOpenAiScope(), null, 'scope preview does not declare');
    await button('Declare this project').click();
    await reads(main, /A project is declared\./, 'scope recorded');
    const document = {
      schemaVersion: 1,
      source: { system: 'operator-export', provider: 'openai', exportId: 'browser-jobs-export', billingAccountRef: 'acct_browser_jobs', exportedAt: iso(10), periodStart: iso(0), periodEnd: iso(2), coverage: 'complete' },
      records: [0, 1].map((i) => ({ sourceRecordId: `line-${i}`, chargePeriodStart: iso(i), chargePeriodEnd: iso(i + 1), observedAt: iso(i + 1), providerProjectRef: PROJECT, chargeType: 'usage', currency: 'USD', amount: '2.000000', sku: 'model-usage', service: 'api', model: 'gpt-5', region: null, usageUnit: 'tokens', usageQuantity: '1000' })),
    };
    const bytes = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(JSON.stringify(document))]);
    // File inputs have no implicit ARIA role; use their associated accessible label.
    await main.getByLabel('Cost export (.json)', { exact: true }).setInputFiles({ name: 'costs.json', mimeType: 'application/json', buffer: bytes });
    await button('Import 2 lines').waitFor();
    assert.equal(store.billingImportRuns().length, 0, 'file preview does not import');
    await button('Import 2 lines').click();
    await button('Use costs.json for the comparison').waitFor();
    assert.equal(store.billingImportRuns().length, 1, 'BOM-prefixed file imported through setInputFiles');
    await button('Use costs.json for the comparison').click();
    await button('Use this export').waitFor();
    await reads(main, /supplied by you, not read from the provider/, 'adoption names its evidence class');
    await button('Use this export').click();
    await reads(main, /Recorded as the provider side for these days\./, 'adoption recorded');
    await reads(main, /in use · adopted/, 'the adopted export says it is in use');
    assert.equal(await button('Use costs.json for the comparison').count(), 0, 'an export in use is not offered again');
    await reads(main, new RegExp(`org_browser_jobs · ${PROJECT}`), 'the declaration is named on the page');
    const scopeId = store.activeOpenAiScope().declarationId;
    store.insertRequest(row('close-a', start + DAY / 2, 1.5, scopeId));
    store.insertRequest(row('close-b', start + DAY + DAY / 2, 1.75, scopeId));
    // Re-open the job to read the injected synthetic proxy rows; no shell reload.
    await jobs.getByRole('button', { name: 'Statement', exact: true }).click();
    await jobs.getByRole('button', { name: 'Close', exact: true }).click();
    // $2.00 against $1.50 and $1.75: the days differ by $0.50 and $0.25, so a
    // $0.30 threshold makes exactly one of them material.
    await main.getByRole('spinbutton', { name: 'Ignore daily differences up to ($)', exact: true }).fill('0.3');
    await button('Preview the comparison').click();
    await button('Record this comparison').waitFor();
    await reads(main, /Days that differ\s+1 by more than \$0\.30/, 'the threshold decides which days count as different');
    await reads(main, /Billed by the provider\s+\$4\.00/, 'provider amount displayed');
    await reads(main, /Measured by Segreant\s+\$3\.25/, 'local amount displayed separately');
    await reads(main, /Not explained\s+\$0\.75/, 'residual displayed separately');
    assert.equal(store.reconciliationRuns().length, 0, 'reconciliation preview records nothing');
    await capture(page, 'close-preview-desktop');
    await page.setViewportSize({ width: 375, height: 812 });
    await phoneLayout(page, 'Close preview');
    await capture(page, 'close-preview-phone');
    await button('Record this comparison').click();
    await reads(main, /Where this stands\s+supported/i, 'status pill reads supported');
    await reads(claims.getByRole('button', { name: /^Billed ·/ }), /reconciled against a provider report, with a residual/, 'Billed band refreshes without a page reload');
    assert.equal(store.reconciliationRuns().length, 1);
    assert.equal(store.reconciliationRuns()[0].result.materialityUsd, 0.3, 'the run is recorded under the threshold that was previewed');
    // Every recorded comparison is listed with its own days and opens to what was recorded.
    const recorded = main.locator('details.recorded-run');
    await recorded.first().waitFor();
    assert.equal(await recorded.count(), 1);
    await recorded.first().locator('summary').click();
    await reads(recorded.first(), /Not explained\s+\$0\.75/, 'a recorded comparison re-opens to its own figures');
    await reads(recorded.first(), /Days that differ\s+1 by more than \$0\.30/, 'with the threshold it was recorded under');
    await capture(page, 'close-recorded-phone');
    // Clearing the declaration previews first and leaves the recorded comparison alone.
    await button(`Stop matching requests to ${PROJECT}`).click();
    await reads(main, /Requests already recorded and recorded comparisons are unchanged/, 'clearing says what it leaves alone');
    assert.notEqual(store.activeOpenAiScope(), null, 'the preview clears nothing');
    await button('Clear the declaration').click();
    await reads(main, /Future OpenAI requests through Segreant are no longer matched to a project/, 'clearing is confirmed');
    assert.equal(store.activeOpenAiScope(), null);
    assert.equal(store.reconciliationRuns().length, 1, 'the recorded comparison survives clearing');
    await reads(main, /Organisation id/, 'step 1 offers a new declaration');
    await capture(page, 'close-cleared-phone');

    await jobs.getByRole('button', { name: 'Statement', exact: true }).click();
    const allocated = store.allocationRuns()[0].result;
    const billed = store.reconciliationRuns()[0].result;
    assert.equal(allocated.periodStartMs, start);
    assert.equal(allocated.periodEndMs, browserNow.getTime());
    assert.equal(billed.periodStartMs, start);
    assert.equal(billed.periodEndMs, start + 2 * DAY);
    await reads(main, /Provider billed \$4\.00; we measured \$3\.25; \$0\.75 not explained/, 'Statement keeps billed and measured separate');
    const statementText = await main.innerText();
    assert.ok(statementText.includes(`${date(start)} – ${date(start + DAY)}`), 'billed run has its own inclusive dates');
    assert.ok(statementText.includes(`${date(start)} – ${date(browserNow.getTime() - 1)}`), 'allocated run has its own inclusive dates');
    assert.match(statementText, /covers part of the month only/, 'partial run is not prorated into the month');
    assert.equal(await button('Next month').isDisabled(), true);
    await capture(page, 'statement-phone');
    await page.setViewportSize({ width: 1440, height: 900 });
    await capture(page, 'statement-desktop');
    await button('Previous month').click();
    await reads(main, /No comparison with a provider bill covers this month\./, 'previous month billing not established');
    await reads(main, /No recorded split covers this month\./, 'previous month allocation not established');
    assert.match(await main.innerText(), /not established/i);
    await button('Next month').click();

    await page.setViewportSize({ width: 375, height: 812 });
    for (const [label, heading] of ROUTES) {
      const nav = label === 'Data' || label === 'Settings' ? page.getByRole('navigation', { name: 'Setup', exact: true }) : jobs;
      await nav.getByRole('button', { name: label, exact: true }).click();
      await main.getByRole('heading', { level: 1, name: heading, exact: typeof heading === 'string' }).waitFor();
      await ready(main, label);
      await phoneLayout(page, label);
      await capture(page, `${label.toLowerCase()}-route-phone`);
      await page.setViewportSize({ width: 1440, height: 900 });
      await capture(page, `${label.toLowerCase()}-route-desktop`);
      await page.setViewportSize({ width: 375, height: 812 });
    }
    assert.deepEqual(errors, [], 'no browser page errors');
    assert.deepEqual(external, [], 'no external browser requests');
  } finally {
    await browser?.close();
    if (server) {
      server.closeAllConnections();
      if (server.listening) await new Promise((resolve) => server.close(resolve));
    }
    store?.close();
    for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    await rm(home, { recursive: true, force: true });
  }
});
