import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { chromium } from 'playwright';
import { Store } from '../dist/store/db.js';
import { DEFAULT_CONFIG } from '../dist/config.js';
import { createDashboardServer } from '../dist/dashboard/server.js';

const cases = [
  { name: 'provider snapshots disagree', snapshotStability: 'changed_across_observations', offPathBound: 'upper_bound_conditional', expected: /provider reported different figures for the same days/i },
  { name: 'retention removed local requests', snapshotStability: 'single_observation', offPathBound: 'unknown_local_total_truncated_by_retention', expected: /retention deleted.*remainder.*cannot bound/i },
  { name: 'local estimate exceeds provider', snapshotStability: 'single_observation', offPathBound: 'none_local_estimate_exceeds_provider', expected: /local estimate exceeds.*remainder.*cannot bound/i },
  { name: 'legacy evidence lacks bound and stability', expected: /bound.*not recorded/i },
  { name: 'different evidence belongs to each overlapping project run', snapshotStability: 'changed_across_observations', offPathBound: 'unknown_local_total_truncated_by_retention', expected: /retention deleted.*remainder.*cannot bound/i, mixed: true },
];

for (const fixture of cases) test(`Statement discloses ${fixture.name} within the recorded run`, async () => {
  const home = mkdtempSync(join(tmpdir(), 'segreant-statement-evidence-'));
  const keys = ['SEGREANT_HOME', 'SEGREANT_DB', 'SEGREANT_DEMO'];
  const saved = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  process.env.SEGREANT_HOME = home; delete process.env.SEGREANT_DB; delete process.env.SEGREANT_DEMO;
  const dbPath = join(home, 'segreant.db');
  const store = new Store(dbPath);
  const result = {
    status: 'reconciled_with_residual', observationRunId: 'synthetic-observation', declaredScopeId: 'synthetic-declaration', providerProjectRef: 'proj_statement_evidence',
    periodStartMs: Date.UTC(2026, 5, 30), periodEndMs: Date.UTC(2026, 7, 2), currency: 'USD', materialityUsd: 1,
    providerReportedMicros: 4_000_000, localCapturedMicros: fixture.offPathBound === 'none_local_estimate_exceeds_provider' ? 5_000_000 : 3_000_000,
    unexplainedVarianceMicros: fixture.offPathBound === 'none_local_estimate_exceeds_provider' ? -1_000_000 : 1_000_000,
    coverage: { providerDays: 33, localDays: 2, daysWithBoth: 2, providerOnlyDays: 31, localOnlyDays: 0, materialDays: 1 }, days: [],
    snapshotStability: fixture.snapshotStability ?? 'single_observation',
    ...(fixture.offPathBound ? { offPathBound: fixture.offPathBound } : {}),
    unstableDayStartMs: fixture.snapshotStability === 'changed_across_observations' ? [Date.UTC(2026, 6, 1)] : [],
    providerSourceKind: 'operator_supplied_export', conditions: ['provider_report_is_operator_supplied_and_unverified'],
    trust: 'scope_conditional_reconciliation', excludedFrom: ['request_metered_spend', 'budget_enforcement', 'roi', 'model_recommendations'],
  };
  const runId = store.saveReconciliationRun(result);
  if (!fixture.snapshotStability) {
    // Materialize a synthetic legacy serialized record whose newer evidence
    // fields were never written. Production's current writer requires stability.
    const legacy = { ...result }; delete legacy.snapshotStability;
    const db = new DatabaseSync(dbPath);
    try { db.prepare('UPDATE reconciliation_runs SET result_json = ? WHERE reconciliation_run_id = ?').run(JSON.stringify(legacy), runId); }
    finally { db.close(); }
  }
  if (fixture.mixed) store.saveReconciliationRun({
    ...result, observationRunId: 'synthetic-other-observation', providerProjectRef: 'proj_other_statement',
    providerReportedMicros: 9_000_000, localCapturedMicros: 8_000_000, unexplainedVarianceMicros: 1_000_000,
    snapshotStability: 'stable_across_observations', offPathBound: 'upper_bound_conditional', unstableDayStartMs: [],
  });
  const server = createDashboardServer({ store, config: structuredClone(DEFAULT_CONFIG), version: 'statement-evidence-fixture' });
  let browser;
  try {
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    const base = `http://127.0.0.1:${server.address().port}`;
    const wire = await (await fetch(`${base}/api/statement?month=2026-07`)).json();
    assert.equal(wire.billed.monthCoverage, 'whole');
    browser = await chromium.launch({ headless: true, executablePath: process.env.SEGREANT_CHROME || undefined });
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    await page.clock.setFixedTime(new Date('2026-07-15T12:00:00Z'));
    await page.goto(base); await page.getByRole('button', { name: /look after the money/ }).click();
    await page.getByRole('link', { name: 'Open Close', exact: true }).waitFor();
    const text = await page.getByRole('main').innerText();
    assert.match(text, fixture.expected);
    if (!fixture.snapshotStability) assert.match(text, /snapshot stability.*not recorded/i);
    assert.match(text, /proj_statement_evidence/);
    assert.doesNotMatch(text, /^checked$/im, 'calendar coverage must not claim the comparison is supported');
    assert.match(text, /Provider billed \$4\.00/);
    assert.match(text, /covers the whole month/);
    const ownWire = wire.billed.runs.find((run) => run.providerProjectRef === 'proj_statement_evidence');
    assert.ok(ownWire);
    assert.equal(ownWire.snapshotStability, fixture.snapshotStability ?? null);
    assert.equal(ownWire.offPathBound, fixture.offPathBound ?? null);
    if (fixture.mixed) {
      const own = page.getByRole('group', { name: 'Provider comparison for proj_statement_evidence', exact: true });
      const other = page.getByRole('group', { name: 'Provider comparison for proj_other_statement', exact: true });
      const ownText = await own.innerText(); const otherText = await other.innerText();
      assert.match(ownText, /Provider billed \$4\.00/);
      assert.match(ownText, /different figures for the same days/);
      assert.match(ownText, /retention deleted.*cannot bound/i);
      assert.doesNotMatch(ownText, /Repeated provider observations agreed|\$9\.00/);
      assert.match(otherText, /Provider billed \$9\.00/);
      assert.match(otherText, /Repeated provider observations agreed/);
      assert.match(otherText, /bounds spend.*only if/);
      assert.doesNotMatch(otherText, /conflicted|Retention deleted|\$4\.00/);
      assert.equal(wire.billed.runs.length, 2);
    }
    if (process.env.SEGREANT_CAPTURE_DIR) {
      for (const [width, height] of [[1440, 900], [375, 812]]) {
        await page.setViewportSize({ width, height });
        await page.screenshot({ path: join(process.env.SEGREANT_CAPTURE_DIR, `statement-${cases.indexOf(fixture)}-${width}.png`), fullPage: true });
      }
    }
  } finally {
    await browser?.close(); server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); store.close();
    for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    rmSync(home, { recursive: true, force: true });
  }
});
