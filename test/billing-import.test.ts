import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { readBillingImportFile } from '../src/billing/importer.ts';
import { parseBillingImportDocument } from '../src/billing/types.ts';
import { billingEvidenceToCsv } from '../src/export/billingCsv.ts';
import { Store, type RequestRow } from '../src/store/db.ts';

const FIXTURE = join(import.meta.dirname, 'fixtures', 'billing', 'openai-operator-export.v1.json');

function request(): RequestRow {
  return {
    requestId: 'metered-request', sessionId: null, tsEpochMs: 1_722_470_400_000, provider: 'openai', model: 'gpt-5',
    project: 'local-project', taskWeight: 1, inputTokens: 1, outputTokens: 1, cacheWriteTokens: 0, cacheReadTokens: 0,
    reasoningTokens: 0, costUsd: 2.5, estimated: false, streamed: false, statusCode: 200, durationMs: 1,
  };
}

function changedDocument(): ReturnType<typeof parseBillingImportDocument> {
  const raw = JSON.parse(readFileSync(FIXTURE, 'utf8')) as { records: Array<{ amount: string }> };
  raw.records[0]!.amount = '12.345679';
  return parseBillingImportDocument(raw);
}

function repeatedExportDocument(): ReturnType<typeof parseBillingImportDocument> {
  const raw = JSON.parse(readFileSync(FIXTURE, 'utf8')) as { source: { exportId: string; exportedAt: string } };
  raw.source.exportId = 'synthetic-openai-cost-export-2026-08-repeat';
  raw.source.exportedAt = '2026-09-03T09:00:00Z';
  return parseBillingImportDocument(raw);
}

test('billing import keeps provider-declared lines immutable and separate from request metering', () => {
  const parsed = readBillingImportFile(FIXTURE);
  const store = new Store(':memory:');
  try {
    store.insertRequest(request());
    const before = store.summary(0, Date.now() + 1).costUsd;
    const first = store.applyBillingImport(parsed.input, 1_777);
    assert.equal(first.duplicateFile, false);
    assert.equal(first.run.recordsInserted, 2);
    assert.equal(first.run.recordsDuplicate, 0);
    assert.equal(store.summary(0, Date.now() + 1).costUsd, before, 'billing evidence never changes request-ledger spend');
    assert.equal(store.billingEvidenceRecords().length, 2);

    const summary = store.billingSummary();
    assert.deepEqual(summary, {
      importCount: 1,
      recordCount: 2,
      providerReportedUsdMicros: 11_345_678,
      lastImportedAtMs: 1_777,
      reconciliationStatus: 'not_reconciled',
    });

    const replay = store.applyBillingImport(parsed.input, 1_778);
    assert.equal(replay.duplicateFile, true, 'an identical raw evidence file is a no-op');
    assert.equal(store.billingSummary().importCount, 1);
    assert.equal(store.billingSummary().recordCount, 2);

    const repeatedExport = store.applyBillingImport({
      ...parsed.input,
      document: repeatedExportDocument(),
      fileName: 'repeated-export.json',
      fileSha256: createHash('sha256').update('later-export-same-lines').digest('hex'),
    }, 1_778);
    assert.equal(repeatedExport.duplicateFile, false);
    assert.equal(repeatedExport.run.recordsInserted, 0);
    assert.equal(repeatedExport.run.recordsDuplicate, 2, 'a later export may restate immutable charge lines without double-counting');
    assert.equal(store.billingSummary().importCount, 2);
    assert.equal(store.billingSummary().recordCount, 2);

    const conflictInput = {
      ...parsed.input,
      document: changedDocument(),
      fileName: 'conflict.json',
      fileSha256: createHash('sha256').update('different-file').digest('hex'),
    };
    assert.throws(() => store.applyBillingImport(conflictInput, 1_779), /source-record conflict/i);
    assert.equal(store.billingSummary().importCount, 2, 'a conflict leaves the full import transaction untouched');
    assert.equal(store.billingSummary().recordCount, 2);

    store.prune(Date.now() + 1);
    assert.equal(store.billingEvidenceRecords().length, 2, 'request retention does not erase financial evidence');
  } finally {
    store.close();
  }
});

test('billing CSV exports provenance and protects operator-supplied spreadsheet formulas', () => {
  const parsed = readBillingImportFile(FIXTURE);
  const store = new Store(':memory:');
  try {
    store.applyBillingImport(parsed.input, 1);
    const rows = store.billingEvidenceRecords();
    rows[0]!.sourceRecordId = '=not-a-formula';
    const csv = billingEvidenceToCsv(rows);
    assert.match(csv, /sourceRecordSha256/);
    assert.match(csv, /'=not-a-formula/);
    assert.match(csv, /provider_reported/);
    assert.match(csv, /operator_supplied_unverified/);
  } finally {
    store.close();
  }
});
