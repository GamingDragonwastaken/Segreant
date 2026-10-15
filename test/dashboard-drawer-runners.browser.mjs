/**
 * F4: the cost-centre and provider-scope drawers finish what `segreant alloc
 * centre` and `segreant billing scope set` do, preview first, opened from the
 * parity map. These two rows say "in the GUI" only because of what this proves.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// The scope route reads the configured OpenAI upstream; keep it off the real home.
const home = mkdtempSync(join(tmpdir(), 'segreant-drawers-'));
process.env.SEGREANT_HOME = home;

const { chromium } = await import('playwright');
const { Store } = await import('../dist/store/db.js');
const { DEFAULT_CONFIG } = await import('../dist/config.js');
const { createDashboardServer } = await import('../dist/dashboard/server.js');

test('cost centres and the provider scope are finished from their drawers, preview first', async () => {
  const store = new Store(':memory:');
  const server = createDashboardServer({ store, config: structuredClone(DEFAULT_CONFIG), version: 'drawer-runner-test' });
  let browser;
  try {
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const base = `http://127.0.0.1:${server.address().port}`;
    browser = await chromium.launch({ headless: true, executablePath: process.env.SEGREANT_CHROME || undefined });
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    await page.addInitScript(() => { try { localStorage.setItem('segreant.register', 'plain'); } catch {} });

    const openFromMap = async (label) => {
      await page.goto(`${base}/#/system`);
      const main = page.getByRole('main');
      await main.getByRole('heading', { name: 'Settings', exact: true }).waitFor();
      const details = main.locator('details.parity-details');
      if (!(await details.evaluate((el) => el.open))) await details.locator('summary').click();
      await main.getByRole('button', { name: `Open ${label}`, exact: true }).click();
      const drawer = page.getByRole('dialog', { name: label });
      await drawer.waitFor();
      return drawer;
    };
    const apply = async (drawer, done) => {
      // Apply is clicked while the last field still has focus, as a person
      // does. Leaving that field fires a second change event, which once
      // re-ran the preview and disabled Apply under the pointer, so the first
      // click did nothing.
      await drawer.getByRole('button', { name: 'Apply' }).click();
      await drawer.getByRole('status').getByText(done).waitFor();
      assert.equal(await page.evaluate(() => document.activeElement?.textContent), 'Close', 'after Apply, focus rests on Close, not the page body');
      await page.keyboard.press('Enter');
      await drawer.waitFor({ state: 'detached' });
    };

    // Add: the id is derived from the name, as on the Allocate page.
    let drawer = await openFromMap('Cost centres');
    await drawer.getByLabel('Name', { exact: true }).fill('Platform Team');
    await drawer.getByLabel('Owner (optional)').fill('Ana');
    await drawer.getByText('adds a new cost centre').waitFor();
    await drawer.getByText('segreant alloc centre platform-team --name "Platform Team" --owner Ana').waitFor();
    assert.equal(store.costCentres().length, 0, 'the preview writes nothing');
    await apply(drawer, 'saved');
    assert.deepEqual(store.costCentres().map((c) => [c.costCentreId, c.name, c.owner]), [['platform-team', 'Platform Team', 'Ana']]);

    // Rename: only the drawer can, because the id stays while the name changes.
    drawer = await openFromMap('Cost centres');
    const which = drawer.getByLabel('Cost centre', { exact: true });
    await which.focus();
    await which.selectOption('platform-team');
    assert.equal(await which.evaluate((el) => el === document.activeElement), true, 'choosing a centre keeps focus on the select');
    assert.equal(await drawer.getByLabel('Name', { exact: true }).inputValue(), 'Platform Team', 'the current name is filled in');
    await drawer.getByLabel('Name', { exact: true }).fill('Platform');
    await drawer.getByText('changes its name or owner').waitFor();
    await apply(drawer, 'saved');
    assert.deepEqual(store.costCentres().map((c) => [c.costCentreId, c.name]), [['platform-team', 'Platform']]);

    // Archive, with the preview first.
    drawer = await openFromMap('Cost centres');
    await drawer.getByLabel('Cost centre', { exact: true }).selectOption('platform-team');
    await drawer.getByLabel('Change').selectOption('archive');
    await drawer.getByText('segreant alloc centre platform-team --archive').waitFor();
    assert.equal(store.costCentres()[0].archivedAtMs, null, 'the archive preview writes nothing');
    await apply(drawer, 'Archived');
    assert.notEqual(store.costCentres()[0].archivedAtMs, null);

    // Scope: the project is optional here, as it is on the command line.
    drawer = await openFromMap('Declare a provider scope');
    await drawer.getByLabel('Organisation id').fill('org_drawer_test');
    await drawer.getByText('Will declare').waitFor();
    assert.equal(store.activeOpenAiScope(), null, 'the scope preview writes nothing');
    await apply(drawer, 'Declared for future');
    const scope = store.activeOpenAiScope();
    assert.equal(scope?.billingAccountRef, 'org_drawer_test');
    assert.equal(scope?.providerProjectRef ?? null, null);

    // Clear, also previewed.
    drawer = await openFromMap('Declare a provider scope');
    await drawer.getByLabel('Change').selectOption('clear');
    await drawer.getByText('segreant billing scope clear --apply').waitFor();
    await apply(drawer, 'Cleared');
    assert.equal(store.activeOpenAiScope(), null);
  } finally {
    await browser?.close();
    server.close();
    store.close?.();
    rmSync(home, { recursive: true, force: true });
  }
});

function request(id, iso, costUsd) {
  return {
    requestId: id, sessionId: null, tsEpochMs: Date.parse(iso), provider: 'openai', model: 'gpt-5', project: 'app', taskWeight: 1,
    inputTokens: 1, outputTokens: 1, cacheWriteTokens: 0, cacheReadTokens: 0, reasoningTokens: 0, costUsd,
    estimated: false, streamed: false, statusCode: 200, durationMs: 1, source: 'claude-code', user: 'pat',
  };
}

test('an allocation run is previewed and recorded from its drawer, for exactly the days chosen', async () => {
  const store = new Store(':memory:');
  store.upsertCostCentre({ costCentreId: 'eng', name: 'Engineering' });
  store.saveAllocationRule({
    ruleId: 'app', method: 'direct', match: { project: 'app' }, targets: [{ costCentreId: 'eng', ratio: 1 }], priority: 10,
    effectiveFromMs: 0, effectiveToMs: null, revokedAtMs: null, owner: null, note: null,
  });
  store.insertRequest(request('in-a', '2026-07-15T12:00:00.000Z', 2));
  store.insertRequest(request('in-b', '2026-07-20T12:00:00.000Z', 1));
  store.insertRequest(request('outside', '2026-08-15T12:00:00.000Z', 5));
  const server = createDashboardServer({ store, config: structuredClone(DEFAULT_CONFIG), version: 'drawer-run-test' });
  let browser;
  try {
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const base = `http://127.0.0.1:${server.address().port}`;
    browser = await chromium.launch({ headless: true, executablePath: process.env.SEGREANT_CHROME || undefined });
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    await page.addInitScript(() => { try { localStorage.setItem('segreant.register', 'plain'); } catch {} });
    await page.goto(`${base}/#/system`);
    const main = page.getByRole('main');
    await main.getByRole('heading', { name: 'Settings', exact: true }).waitFor();
    await main.locator('details.parity-details summary').click();
    await main.getByRole('button', { name: 'Open Run an allocation', exact: true }).click();
    const drawer = page.getByRole('dialog', { name: 'Run an allocation' });
    await drawer.waitFor();

    await drawer.getByLabel('Period').selectOption({ label: 'Choose dates…' });
    await drawer.getByLabel('First day').fill('2026-07-01');
    await drawer.getByLabel('Last day (included)').fill('2026-07-31');
    await drawer.getByText('Engineering').waitFor();
    await drawer.getByText('$3.00').first().waitFor();
    assert.equal(store.allocationRuns().length, 0, 'the preview records nothing');

    await drawer.getByRole('button', { name: 'Apply' }).click();
    await drawer.getByRole('status').getByText('Recorded').waitFor();
    const runs = store.allocationRuns();
    assert.equal(runs.length, 1);
    assert.equal(runs[0].result.totalMicros, 3_000_000, 'August spend stays out of a July run');
    assert.deepEqual(runs[0].result.byCostCentre.map((c) => [c.costCentreId, c.allocatedMicros]), [['eng', 3_000_000]]);
  } finally {
    await browser?.close();
    server.close();
    store.close?.();
  }
});

test('an imported export is adopted and the month reconciled from their drawers, preview first', async () => {
  const { readFileSync } = await import('node:fs');
  const fixture = readFileSync(join(import.meta.dirname, 'fixtures', 'billing', 'openai-operator-export.v1.json'), 'utf8');
  const store = new Store(':memory:');
  const server = createDashboardServer({ store, config: structuredClone(DEFAULT_CONFIG), version: 'drawer-billing-test' });
  let browser;
  try {
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const base = `http://127.0.0.1:${server.address().port}`;
    const post = (body) => fetch(`${base}/api/billing/write`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-segreant-local': '1' }, body: JSON.stringify(body) });
    assert.equal((await post({ op: 'scope', accountRef: 'acct-example-001', projectRef: 'proj_alpha', apply: true })).status, 200);
    assert.equal((await post({ op: 'import', fileName: 'openai-operator-export.v1.json', contentBase64: Buffer.from(fixture).toString('base64'), apply: true })).status, 200);
    const inUse = async () => (await (await fetch(`${base}/api/billing`)).json()).imports[0].inUse;

    browser = await chromium.launch({ headless: true, executablePath: process.env.SEGREANT_CHROME || undefined });
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    await page.addInitScript(() => { try { localStorage.setItem('segreant.register', 'plain'); } catch {} });
    const openFromMap = async (label) => {
      await page.goto(`${base}/#/system`);
      const main = page.getByRole('main');
      await main.getByRole('heading', { name: 'Settings', exact: true }).waitFor();
      const details = main.locator('details.parity-details');
      if (!(await details.evaluate((el) => el.open))) await details.locator('summary').click();
      await main.getByRole('button', { name: `Open ${label}`, exact: true }).click();
      const drawer = page.getByRole('dialog', { name: label });
      await drawer.waitFor();
      return drawer;
    };

    let drawer = await openFromMap('Adopt a provider export');
    const which = drawer.getByLabel('Imported cost export');
    await which.locator('option', { hasText: 'openai-operator-export.v1.json' }).waitFor({ state: 'attached' });
    await which.selectOption({ index: 1 });
    await drawer.getByText('Matched to your project').waitFor();
    assert.equal(await inUse(), null, 'the adoption plan records nothing');
    await drawer.getByRole('button', { name: 'Apply' }).click();
    await drawer.getByRole('status').getByText('Recorded as the provider side').waitFor();
    assert.ok(await inUse(), 'the export is now the provider side');
    await page.keyboard.press('Enter');
    await drawer.waitFor({ state: 'detached' });

    drawer = await openFromMap('Reconcile');
    await drawer.getByLabel('Ignore daily differences up to ($)').fill('1');
    await drawer.getByText('Billed by the provider').waitFor();
    await drawer.getByText('segreant billing reconcile --materiality 1 --apply').waitFor();
    assert.equal(store.reconciliationRuns().length, 0, 'the comparison preview records nothing');
    await drawer.getByRole('button', { name: 'Apply' }).click();
    await drawer.getByRole('status').getByText('Recorded').waitFor();
    const runs = store.reconciliationRuns();
    assert.equal(runs.length, 1);
    assert.equal(runs[0].result.materialityUsd, 1, 'recorded under the threshold that was previewed');
  } finally {
    await browser?.close();
    server.close();
    store.close?.();
  }
});
