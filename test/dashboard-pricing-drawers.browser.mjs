import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const home = mkdtempSync(join(tmpdir(), 'segreant-pricing-drawers-'));
process.env.SEGREANT_HOME = home;
process.env.SEGREANT_DEMO = '';
const { chromium } = await import('playwright');
const { Store } = await import('../dist/store/db.js');
const { DEFAULT_CONFIG } = await import('../dist/config.js');
const { createDashboardServer } = await import('../dist/dashboard/server.js');
const { loadPriceOverrides } = await import('../dist/cost/overrides.js');
const { legacyPricingEvidence } = await import('../dist/cost/pricing.js');

test('unpriced models: skip and all three declarations; re-price previews, confirms and reports what changed', async () => {
  const store = new Store(':memory:');
  const models = ['private-like', 'private-rate', 'local-model', 'skip-model', 'claude-sonnet-4-6-20990101'];
  for (const [i, model] of models.entries()) store.insertRequest({
    requestId: `r${i}`, model, provider: 'anthropic', costUsd: 9, estimated: true,
    sessionId: null, tsEpochMs: 1000, project: 'test', taskWeight: 1, inputTokens: 1_000_000,
    outputTokens: 0, cacheWriteTokens: 0, cacheReadTokens: 0, reasoningTokens: 0,
    streamed: false, statusCode: 200, durationMs: 1,
    pricing: { ...legacyPricingEvidence(), costBasis: 'fallback_estimate', rateMatchKind: 'fallback' },
  });
  const server = createDashboardServer({ store, config: structuredClone(DEFAULT_CONFIG), version: 'pricing-drawer-test' });
  let browser;
  try {
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const base = `http://127.0.0.1:${server.address().port}`;
    browser = await chromium.launch({ headless: true, executablePath: process.env.SEGREANT_CHROME || undefined });
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    page.setDefaultTimeout(7000);
    const errors = [];
    const external = [];
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('request', (req) => { if (!req.url().startsWith(base)) external.push(req.url()); });
    await page.addInitScript(() => localStorage.setItem('segreant.register', 'plain'));
    await page.goto(`${base}/#/system`);
    await page.getByRole('main').locator('details.parity-details summary').click();
    await page.getByRole('button', { name: 'Open Unpriced models', exact: true }).click();
    let drawer = page.getByRole('dialog', { name: 'Unpriced models' });
    await drawer.getByText('nearest model on the card', { exact: true }).waitFor();
    await drawer.getByText('generic rate', { exact: true }).first().waitFor();
    assert.equal(store.estimatedRequestRows().length, 5);
    await drawer.getByLabel('Price for skip-model', { exact: true }).selectOption('skip');
    assert.equal(await drawer.getByRole('button', { name: 'Apply', exact: true }).isDisabled(), true);
    const save = async (model) => {
      const apply = drawer.getByRole('button', { name: 'Apply', exact: true });
      await apply.click();
      await drawer.getByRole('status').getByText(`Saved your price for ${model}.`).waitFor();
      await drawer.getByLabel(`Price for ${model}`, { exact: true }).waitFor({ state: 'detached' });
      await drawer.getByText('Recorded requests keep their estimate until you re-price them', { exact: true }).waitFor();
      assert.equal(store.estimatedRequestRows().length, 5);
    };
    await drawer.getByLabel('Price for private-like', { exact: true }).selectOption('like');
    await drawer.getByLabel('Exact card model for private-like', { exact: true }).fill('not-on-card');
    await drawer.getByRole('button', { name: 'Apply', exact: true }).click();
    await drawer.getByRole('status').getByText(/not an exact rate-card match/).waitFor();
    await drawer.getByLabel('Exact card model for private-like', { exact: true }).fill('claude-haiku-4-5');
    await save('private-like');
    await drawer.getByLabel('Price for private-rate', { exact: true }).selectOption('rate');
    await drawer.getByLabel('Input for private-rate (USD per 1M tokens)', { exact: true }).fill('2');
    await drawer.getByLabel('Output for private-rate (USD per 1M tokens)', { exact: true }).fill('3');
    await drawer.getByLabel('Cache read for private-rate, optional (USD per 1M tokens)', { exact: true }).fill('0.2');
    await save('private-rate');
    assert.equal(loadPriceOverrides().models['private-rate']?.cacheRead, '0.2', 'the dashboard saves a cache price (PR #146 review)');
    await drawer.getByLabel('Price for local-model', { exact: true }).selectOption('free');
    await save('local-model');
    assert.deepEqual(Object.keys(loadPriceOverrides().models).sort(), ['local-model', 'private-like', 'private-rate']);
    assert.deepEqual(store.requestPriceEvents('r0'), []);

    // A price you set is listed and can be removed, preview first (PR #146 review).
    await drawer.getByText('Your prices', { exact: true }).waitFor();
    const keepOrRemove = drawer.getByLabel('local-model: free (local model)', { exact: true });
    await keepOrRemove.selectOption('remove');
    await drawer.getByText(/Remove your price for local-model/).waitFor();
    assert.ok(loadPriceOverrides().models['local-model'], 'choosing Remove previews; it does not write');
    await drawer.getByRole('button', { name: 'Apply', exact: true }).click();
    await drawer.getByRole('status').getByText('Removed your price for local-model.').waitFor();
    assert.equal(loadPriceOverrides().models['local-model'], undefined);
    await drawer.getByLabel('Price for local-model', { exact: true }).selectOption('free');
    await save('local-model');

    await drawer.getByRole('button', { name: 'Re-price recorded requests', exact: true }).click();
    drawer = page.getByRole('dialog', { name: 'Reprice history' });
    await drawer.getByText(/3 requests can be re-priced/).waitFor();
    await drawer.getByText(/recorded \(estimated\).*your price/).first().waitFor();
    const apply = drawer.getByRole('button', { name: 'Apply re-pricing', exact: true });
    assert.equal(await apply.isDisabled(), true);
    assert.equal(store.estimatedRequestRows().length, 5, 'preview writes nothing');
    await drawer.getByLabel(/Type reprice to enable/).fill('wrong');
    assert.equal(await apply.isDisabled(), true);
    await drawer.getByLabel(/Type reprice to enable/).fill('reprice');
    const refreshedOverview = page.waitForResponse((res) => res.url().startsWith(base + '/api/overview'));
    await apply.click();
    await drawer.getByRole('status').getByText(/Re-priced 3 requests/).waitFor();
    await drawer.getByText('Changes applied', { exact: true }).waitFor();
    assert.equal((await refreshedOverview).status(), 200, 're-pricing refreshes the metered claim above the drawer');
    assert.equal(store.estimatedRequestRows().length, 2);
    for (const id of ['r0', 'r1', 'r2']) assert.equal(store.requestPriceEvents(id).length, 1);
    assert.deepEqual(store.requestPriceEvents('r3'), []);

    // After re-pricing, private-rate is no longer a guessed model, so it never
    // returns to the list; its price is still changed in place (PR #146 review).
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: 'Open Unpriced models', exact: true }).click();
    drawer = page.getByRole('dialog', { name: 'Unpriced models' });
    await drawer.getByText('Your prices', { exact: true }).waitFor();
    assert.equal(await drawer.getByLabel('Price for private-rate', { exact: true }).count(), 0, 'not in the unpriced list any more');
    await drawer.getByLabel(/^private-rate: input \$2, output \$3, cache read \$0\.2/).selectOption('rate');
    assert.equal(await drawer.getByLabel('New cache read for private-rate, optional (USD per 1M tokens)', { exact: true }).inputValue(), '0.2',
      'the edit form starts from the stored cache price (PR #146 review)');
    await drawer.getByLabel('New input for private-rate (USD per 1M tokens)', { exact: true }).fill('4');
    await drawer.getByLabel('New output for private-rate (USD per 1M tokens)', { exact: true }).fill('5');
    await drawer.getByRole('button', { name: 'Apply', exact: true }).click();
    await drawer.getByRole('status').getByText('Saved your price for private-rate.').waitFor();
    const changed = loadPriceOverrides().models['private-rate'];
    assert.ok(changed?.kind === 'rate' && changed.input === '4' && changed.output === '5');
    assert.equal(changed.cacheRead, '0.2', 'changing the input price keeps the cache price');

    // A model already on the card has no guessed rows and no declaration, but
    // can still be given your price by name (PR #146 review).
    await drawer.getByLabel('Model name', { exact: true }).fill('gpt-4o');
    await drawer.getByLabel('Price for another model', { exact: true }).selectOption('rate');
    await drawer.getByLabel('Input for another model (USD per 1M tokens)', { exact: true }).fill('1.5');
    await drawer.getByLabel('Output for another model (USD per 1M tokens)', { exact: true }).fill('6');
    await drawer.getByRole('button', { name: 'Apply', exact: true }).click();
    await drawer.getByRole('status').getByText('Saved your price for gpt-4o.').waitFor();
    const negotiated = loadPriceOverrides().models['gpt-4o'];
    assert.ok(negotiated?.kind === 'rate' && negotiated.input === '1.5' && negotiated.output === '6');
    assert.deepEqual(errors, []);
    assert.deepEqual(external, []);
  } finally {
    await browser?.close();
    await new Promise((resolve) => server.close(resolve));
    store.close();
    rmSync(home, { recursive: true, force: true });
  }
});
