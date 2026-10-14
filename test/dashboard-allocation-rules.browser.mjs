// A rule written in the GUI must be the same rule `segreant alloc rule` writes,
// field by field, for every condition the engine matches on, plus priority and
// effective dates. A custom period's last day must be included and the next
// day excluded.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { Store } from '../dist/store/db.js';
import { DEFAULT_CONFIG } from '../dist/config.js';
import { createDashboardServer } from '../dist/dashboard/server.js';

const root = join(import.meta.dirname, '..');
const RULE = { project: 'app', model: 'gpt-5', provider: 'openai', source: 'claude-code', user: 'pat' };

function request(id, iso, costUsd, overrides = {}) {
  return {
    requestId: id, sessionId: null, tsEpochMs: Date.parse(iso), provider: 'openai', model: 'gpt-5', project: 'app', taskWeight: 1,
    inputTokens: 1, outputTokens: 1, cacheWriteTokens: 0, cacheReadTokens: 0, reasoningTokens: 0, costUsd,
    estimated: false, streamed: false, statusCode: 200, durationMs: 1, source: 'claude-code', user: 'pat', ...overrides,
  };
}

const comparable = (r) => ({
  method: r.method, match: Object.fromEntries(Object.entries(r.match).filter(([, v]) => v != null)), targets: r.targets,
  priority: r.priority, effectiveFromMs: r.effectiveFromMs, effectiveToMs: r.effectiveToMs, revokedAtMs: r.revokedAtMs,
});

test('a GUI rule with every condition equals the CLI rule, and a custom period includes its last day', async () => {
  const home = mkdtempSync(join(tmpdir(), 'segreant-alloc-rules-'));
  const cliHome = mkdtempSync(join(tmpdir(), 'segreant-alloc-rules-cli-'));
  const saved = Object.fromEntries(['SEGREANT_HOME', 'SEGREANT_DB', 'SEGREANT_DEMO', 'TZ'].map((k) => [k, process.env[k]]));
  process.env.SEGREANT_HOME = home; delete process.env.SEGREANT_DB; delete process.env.SEGREANT_DEMO;
  const store = new Store(':memory:');
  store.insertRequest(request('july-match', '2026-07-15T12:00:00.000Z', 2));
  store.insertRequest(request('july-last-day', '2026-07-31T23:30:00.000Z', 1));
  store.insertRequest(request('july-other-user', '2026-07-20T12:00:00.000Z', 0.25, { user: 'sam' }));
  store.insertRequest(request('august-first', '2026-08-01T00:30:00.000Z', 5));
  const server = createDashboardServer({ store, config: structuredClone(DEFAULT_CONFIG), version: 'alloc-rules' });
  let browser;
  try {
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    const base = `http://127.0.0.1:${server.address().port}`;
    const post = async (body) => {
      const res = await fetch(`${base}/api/allocation/write`, { method: 'POST', headers: { 'x-segreant-local': '1', 'content-type': 'application/json' }, body: JSON.stringify(body) });
      assert.equal(res.status, 200, await res.clone().text());
      return res.json();
    };
    await post({ op: 'centre', id: 'eng', name: 'Engineering' });

    browser = await chromium.launch({ headless: true, executablePath: process.env.SEGREANT_CHROME || undefined });
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: 'en-GB', timezoneId: 'UTC' });
    await context.addInitScript(() => { try { localStorage.setItem('segreant.register', 'plain'); } catch {} });
    const page = await context.newPage();
    const main = page.getByRole('main');
    await page.goto(`${base}/#/allocation`, { waitUntil: 'networkidle' });
    await main.getByRole('button', { name: 'Save rule', exact: true }).waitFor();

    await main.getByLabel('Which spend', { exact: true }).fill(RULE.project);
    await main.getByText('More conditions and dates', { exact: true }).click();
    await main.getByLabel('Model', { exact: true }).fill(RULE.model);
    await main.getByLabel('Provider', { exact: true }).fill(RULE.provider);
    await main.getByLabel('Tool', { exact: true }).fill(RULE.source);
    await main.getByLabel('User', { exact: true }).fill(RULE.user);
    await main.getByLabel('Priority', { exact: true }).fill('7');
    await main.getByLabel('Applies from', { exact: true }).fill('2026-07-01');
    await main.getByLabel('Stops on', { exact: true }).fill('2026-08-01');
    const artifacts = process.env.SEGREANT_BROWSER_ARTIFACTS;
    if (artifacts) { mkdirSync(artifacts, { recursive: true }); await main.locator('form.inline-form').last().screenshot({ path: join(artifacts, 'rule-form-1280.png') }); }
    await main.getByRole('button', { name: 'Save rule', exact: true }).click();
    await main.getByText(/Spend where project app, model gpt-5, provider openai, source claude-code, user pat goes to Engineering/).waitFor();

    const gui = store.allocationRules();
    assert.equal(gui.length, 1);
    const listText = await main.innerText();
    assert.match(listText, /from 1 Jul 2026 · ended 1 Aug 2026/, 'the rule list states its dates');
    assert.doesNotMatch(listText, /superseded/, 'an end date is not a supersession');

    // The same rule through the CLI, in its own home.
    const env = { ...process.env, SEGREANT_HOME: cliHome };
    const cli = (...args) => spawnSync(process.execPath, [join(root, 'dist/cli.js'), ...args], { env, encoding: 'utf8', timeout: 30_000 });
    assert.equal(cli('alloc', 'centre', 'eng', '--name', 'Engineering').status, 0);
    const written = cli('alloc', 'rule', gui[0].ruleId, '--method', 'direct', '--centre', 'eng',
      '--match-project', RULE.project, '--match-model', RULE.model, '--match-provider', RULE.provider,
      '--match-source', RULE.source, '--match-user', RULE.user, '--priority', '7',
      '--from', '2026-07-01T00:00:00.000Z', '--until', '2026-08-01T00:00:00.000Z');
    assert.equal(written.status, 0, written.stderr);
    const cliRules = JSON.parse(cli('alloc', 'rules', '--json').stdout).rules;
    assert.equal(cliRules.length, 1);
    assert.deepEqual(comparable(gui[0]), comparable(cliRules[0]), 'GUI and CLI wrote the same rule');

    // A custom period, both days included: July 1 through July 31.
    await main.getByLabel('Period', { exact: true }).selectOption({ label: 'Choose dates…' });
    await main.getByLabel('First day', { exact: true }).fill('2026-07-01');
    await main.getByLabel('Last day', { exact: true }).fill('2026-07-31');
    await main.getByRole('button', { name: 'Preview split', exact: true }).click();
    await main.locator('.run-result table').waitFor();
    const preview = await main.locator('.run-result').innerText();
    assert.match(preview, /Engineering\s+\$3\.00/, 'both matching July requests, including 23:30 on the last day');
    assert.match(preview, /Unallocated[^\n]*\n?[^$]*\$0\.25/, 'the other user\'s request is not claimed');
    assert.match(preview, /Total estimated spend\s+\$3\.25/, 'the August request is outside the period');
    if (artifacts) {
      await main.locator('.run-panel').screenshot({ path: join(artifacts, 'custom-period-1280.png') });
      await page.setViewportSize({ width: 375, height: 812 });
      await main.locator('form.inline-form').last().screenshot({ path: join(artifacts, 'rule-form-375.png') });
      await main.locator('.run-panel').screenshot({ path: join(artifacts, 'custom-period-375.png') });
    }
  } finally {
    await browser?.close();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    store.close();
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    rmSync(home, { recursive: true, force: true });
    rmSync(cliHome, { recursive: true, force: true });
  }
});
