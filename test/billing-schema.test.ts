import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { formatUsdMicros, parseBillingImportDocument, usdMicros } from '../src/billing/types.ts';

const FIXTURE = join(import.meta.dirname, 'fixtures', 'billing', 'openai-operator-export.v1.json');

function fixture(): Record<string, unknown> {
  return JSON.parse(readFileSync(FIXTURE, 'utf8')) as Record<string, unknown>;
}

test('billing evidence v1 accepts a strict OpenAI operator-export envelope and preserves fixed-point USD', () => {
  const parsed = parseBillingImportDocument(fixture());
  assert.equal(parsed.source.provider, 'openai');
  assert.equal(parsed.source.coverage, 'partial');
  assert.equal(parsed.records.length, 2);
  assert.equal(parsed.records[0]!.amountMicros, 12_345_678);
  assert.equal(parsed.records[1]!.amountMicros, -1_000_000);
  assert.match(parsed.records[0]!.sourceRecordSha256, /^[a-f0-9]{64}$/);
  assert.equal(formatUsdMicros(parsed.records.reduce((sum, row) => sum + row.amountMicros, 0)), '11.345678');
});

test('billing evidence rejects unknown fields, floats, unsupported currency, and duplicate source ids', () => {
  const unknown = fixture();
  unknown.unexpected = true;
  assert.throws(() => parseBillingImportDocument(unknown), /exactly these fields/i);

  const floatAmount = fixture();
  ((floatAmount.records as Array<Record<string, unknown>>)[0]!).amount = 12.3;
  assert.throws(() => parseBillingImportDocument(floatAmount), /decimal string/i);

  const nonUsd = fixture();
  ((nonUsd.records as Array<Record<string, unknown>>)[0]!).currency = 'EUR';
  assert.throws(() => parseBillingImportDocument(nonUsd), /must be USD/i);

  const duplicate = fixture();
  const records = duplicate.records as Array<Record<string, unknown>>;
  records[1]!.sourceRecordId = records[0]!.sourceRecordId;
  assert.throws(() => parseBillingImportDocument(duplicate), /duplicate sourceRecordId/i);
});

test('USD microdollars do not accept binary-float values or excess precision', () => {
  assert.equal(usdMicros('-0.000001'), -1);
  assert.equal(usdMicros('100'), 100_000_000);
  assert.throws(() => usdMicros(1.25), /decimal string/i);
  assert.throws(() => usdMicros('1.0000001'), /at most six/i);
});
