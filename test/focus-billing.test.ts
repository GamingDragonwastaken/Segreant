import { test } from 'node:test';
import assert from 'node:assert/strict';
import { billingEvidenceToFocus, type FocusBillingCompatibilityRow } from '../src/export/focusBilling.ts';
import type { BillingEvidenceRecord } from '../src/store/billing.ts';

const record: BillingEvidenceRecord = {
  recordId: 'record:focus:1', sourceSystem: 'operator-export', billingAccountRef: 'acct-1',
  sourceRecordId: 'line-1', sourceRecordSha256: 'a'.repeat(64), firstImportId: 'import-1', sourceExportId: 'export-1',
  provider: 'openai', providerProjectRef: 'project-1', service: 'api', sku: 'tokens', model: 'gpt-test', region: 'us',
  observedAtMs: Date.parse('2026-08-01T12:00:00.000Z'), chargePeriodStartMs: Date.parse('2026-08-01T00:00:00.000Z'),
  chargePeriodEndMs: Date.parse('2026-08-02T00:00:00.000Z'), chargeType: 'usage', currency: 'USD', amountMicros: 1234567,
  usageUnit: 'tokens', usageQuantity: '1000', costBasis: 'provider_reported', trust: 'operator_supplied_unverified',
};

test('FOCUS compatibility projection emits v1.4-shaped billed rows with explicit unmapped cost bases', () => {
  const row = billingEvidenceToFocus([record])[0]!;
  assert.equal(row.FocusVersion, '1.4');
  assert.equal(row.BillingAccountId, 'acct-1');
  assert.equal(row.ServiceProviderName, 'OpenAI');
  assert.equal(row.ServiceName, 'api');
  assert.equal(row.BilledCost, 1.234567);
  assert.equal(row.EffectiveCost, null);
  assert.equal(row.AllocatedCost, null);
  assert.equal(row.FiscusCostBasis, 'billed');
  assert.equal(row.FiscusEffectiveCostStatus, 'unmapped');
  assert.equal(row.FiscusAllocatedCostStatus, 'unmapped');
});

test('FOCUS compatibility projection preserves exact lineage and does not invent invoice or allocation provenance', () => {
  const row = billingEvidenceToFocus([record])[0]!;
  assert.deepEqual(row.FiscusSourceLineage, {
    recordId: 'record:focus:1', sourceRecordId: 'line-1', sourceRecordSha256: 'a'.repeat(64),
    importId: 'import-1', exportId: 'export-1', sourceSystem: 'operator-export', trust: 'operator_supplied_unverified',
  });
  assert.equal(row.InvoiceIssuerName, null);
  assert.equal(row.FiscusAllocationSource, null);
  assert.equal(Object.isFrozen(row), true);
});

test('FOCUS compatibility projection refuses unsupported monetary bases instead of laundering them', () => {
  assert.throws(() => billingEvidenceToFocus([{ ...record, costBasis: 'effective' as never }]), /unsupported cost basis/);
});

test('FOCUS compatibility projection is read-only and returns a fresh immutable collection', () => {
  const rows = billingEvidenceToFocus([record]);
  assert.notEqual(rows, [record]);
  assert.equal(Object.isFrozen(rows), true);
  assert.throws(() => (rows as FocusBillingCompatibilityRow[]).push(rows[0]!), TypeError);
});
