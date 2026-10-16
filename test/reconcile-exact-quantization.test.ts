/**
 * Real proxied OpenAI rows carry exact amounts finer than a microdollar
 * (per-token prices: gpt-4.1-mini 1,234 in / 567 out is $0.0014008). The
 * comparison refused the whole route on the first such row, so almost no real
 * user could compare a bill (found seeding the demo bill, 2026-10-16). Each
 * day is now summed exactly and only the day total is rounded half to even,
 * and the result says so.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.SEGREANT_HOME = mkdtempSync(join(tmpdir(), 'segreant-quant-'));

import { Store, type RequestRow } from '../src/store/db.ts';
import { parseBillingImportText } from '../src/billing/importer.ts';
import { halfEvenMicros } from '../src/billing/reconcile.ts';
import { money } from '../src/economics/money.ts';
import { computeCost } from '../src/cost/pricing.ts';
import { seedDemo } from '../src/demo/seed.ts';

const DAY = 24 * 60 * 60 * 1000;
const D0 = Date.UTC(2026, 6, 1);
const NOW = D0 + 30 * DAY;
const PROJECT = 'proj_quant';

test('half-even rounding to microdollars', () => {
  const m = (a: string) => money(a, 'USD', 'list');
  assert.deepEqual(halfEvenMicros(m('0.0014008')), { micros: 1401, rounded: true });
  assert.deepEqual(halfEvenMicros(m('0.0000005')), { micros: 0, rounded: true }, 'a tie rounds to even');
  assert.deepEqual(halfEvenMicros(m('0.0000015')), { micros: 2, rounded: true });
  assert.deepEqual(halfEvenMicros(m('-0.0000015')), { micros: -2, rounded: true });
  assert.deepEqual(halfEvenMicros(m('1.25')), { micros: 1_250_000, rounded: false });
});

test('a route of real per-token amounts is compared, day totals rounded once', () => {
  const store = new Store(':memory:');
  try {
    const scopeId = store.setOpenAiScope({ billingAccountRef: 'org_q', providerProjectRef: PROJECT, upstreamBase: 'https://api.openai.com', declaredAtMs: 1, activatedAtMs: 1 }).declarationId;
    const cost = computeCost('openai', 'gpt-4.1-mini', { inputTokens: 1234, outputTokens: 567, cacheWriteTokens: 0, cacheReadTokens: 0 });
    assert.ok(cost.exact, 'the price list gives an exact amount');
    // Ten requests on one day: exactly $0.014008, which no single row could be rounded to without error.
    for (let i = 0; i < 10; i += 1) {
      const row: RequestRow = {
        requestId: `q${i}`, sessionId: null, tsEpochMs: D0 + 3_600_000 + i, provider: 'openai', model: 'gpt-4.1-mini', project: 'p',
        taskWeight: 1, inputTokens: 1234, outputTokens: 567, cacheWriteTokens: 0, cacheReadTokens: 0, reasoningTokens: 0,
        costUsd: cost.costUsd, economicAmount: cost.exact!.total, estimated: false, streamed: false, statusCode: 200, durationMs: 1,
        scopeCaptureStatus: 'declared_unverified', providerScopeDeclarationId: scopeId,
      };
      store.insertRequest(row);
    }
    const file = Buffer.from(JSON.stringify({
      schemaVersion: 1,
      source: { system: 'operator-export', provider: 'openai', exportId: 'q', billingAccountRef: 'org_q', exportedAt: new Date(NOW).toISOString(), periodStart: new Date(D0).toISOString(), periodEnd: new Date(D0 + DAY).toISOString(), coverage: 'complete' },
      records: [{ sourceRecordId: 'q1', chargePeriodStart: new Date(D0).toISOString(), chargePeriodEnd: new Date(D0 + DAY).toISOString(), observedAt: new Date(D0 + DAY).toISOString(), providerProjectRef: PROJECT, chargeType: 'usage', currency: 'USD', amount: '0.015000', sku: 'x', service: 'api', model: 'gpt-4.1-mini', region: null, usageUnit: 'tokens', usageQuantity: '1' }],
    }), 'utf8');
    const importId = store.applyBillingImport(parseBillingImportText(file, 'q.segreant.json').input, NOW).run.importId;
    const plan = store.planOpenAiCostsAdoption({ importId, declaredScopeId: scopeId, providerProjectRef: PROJECT });
    assert.equal(plan.adoptable, true);
    store.adoptOpenAiCostsFromImport(plan, NOW);
    const result = store.reconcileOpenAiCosts({ now: NOW });
    assert.ok(result && result.status === 'reconciled_with_residual', `refused: ${JSON.stringify(result)}`);
    if (result.status !== 'reconciled_with_residual') return;
    assert.equal(result.localCapturedMicros, 14_008, 'the exact day total, not ten rounded rows (14,010)');
    assert.equal(result.providerReportedMicros, 15_000);
    assert.deepEqual(result.localQuantization, { rule: 'day_total_half_even_micros', daysRounded: 0 });
  } finally { store.close(); }
});

test('the sample data carries a recorded bill comparison and a recorded cost-centre split', () => {
  const store = new Store(':memory:');
  try {
    const before = seedDemo(new Store(':memory:'));
    const r = seedDemo(store);
    assert.equal(r.totalCostUsd, before.totalCostUsd, 'seeding is deterministic');
    const recon = store.raw().prepare('SELECT result_json FROM reconciliation_runs').all() as Array<{ result_json: string }>;
    assert.equal(recon.length, 1);
    const res = JSON.parse(recon[0]!.result_json) as { status: string; coverage: { daysWithBoth: number }; conditions: string[] };
    assert.equal(res.status, 'reconciled_with_residual');
    assert.ok(res.coverage.daysWithBoth > 0);
    assert.ok(res.conditions.includes('provider_report_is_operator_supplied_and_unverified'), 'the sample bill is filed as an operator export');
    assert.equal((store.raw().prepare('SELECT COUNT(*) AS n FROM allocation_runs').get() as { n: number }).n, 1);
    assert.equal(store.costCentres().length, 3);
  } finally { store.close(); }
});

test('the rounding rule travels with the published comparison', async () => {
  const { describeLocalQuantization } = await import('../src/billing/reconcile.ts');
  assert.equal(describeLocalQuantization(undefined), null, 'a run from before the rule rounded nothing');
  assert.equal(describeLocalQuantization({ rule: 'day_total_half_even_micros', daysRounded: 0 }), null);
  assert.match(describeLocalQuantization({ rule: 'day_total_half_even_micros', daysRounded: 8 })!, /8 day totals then rounded to the microdollar, half to even/);

  const store = new Store(':memory:');
  try {
    seedDemo(store);
    const run = store.reconciliationRuns(1)[0]!;
    assert.ok(run.result.status === 'reconciled_with_residual' && run.result.localQuantization, 'the recorded run carries the rule');
    const kernel = store.raw().prepare("SELECT evidence_json FROM epistemic_evidence WHERE evidence_id LIKE 'evidence:billing:local-capture:%'").all() as Array<{ evidence_json: string }>;
    assert.equal(kernel.length, 1, 'the sample comparison issued its local-capture evidence');
    assert.deepEqual(JSON.parse(kernel[0]!.evidence_json).payload.localQuantization, run.result.status === 'reconciled_with_residual' ? run.result.localQuantization : null, 'the kernel evidence carries the rule');
  } finally { store.close(); }
});

test('a billing CSV of sample data says so in every row; a real one keeps its columns', async () => {
  const { billingEvidenceToCsv } = await import('../src/export/billingCsv.ts');
  const store = new Store(':memory:');
  try {
    seedDemo(store);
    const records = store.billingEvidenceRecords();
    const real = billingEvidenceToCsv(records).split('\r\n')[0]!;
    const demo = billingEvidenceToCsv(records, true).split('\r\n').filter(Boolean);
    assert.ok(!real.includes('sample'));
    assert.ok(demo[0]!.endsWith(',sample'));
    assert.ok(demo.slice(1).every((line) => line.includes('generated sample data, not a provider bill')));
  } finally { store.close(); }
});
