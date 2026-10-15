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
