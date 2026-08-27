import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import {
  billingMappingKey,
  evaluateBillingMapping,
  newBillingRecordMapping,
  type ImportedBillingRecordIdentity,
} from '../src/billing/mapping.ts';
import { readBillingImportFile } from '../src/billing/importer.ts';
import { Store } from '../src/store/db.ts';

const FIXTURE = join(import.meta.dirname, 'fixtures', 'billing', 'openai-operator-export.v1.json');

function importedRecord(overrides: Partial<ImportedBillingRecordIdentity> = {}): ImportedBillingRecordIdentity {
  return {
    recordId: 'record-1',
    sourceSystem: 'operator-export',
    provider: 'openai',
    billingAccountRef: 'acct-1',
    sourceRecordId: 'source-1',
    sourceRecordSha256: 'a'.repeat(64),
    firstImportId: 'import-1',
    amountMicros: 12_345_678,
    ...overrides,
  };
}

function mappingFor(record: ImportedBillingRecordIdentity, overrides: Partial<Parameters<typeof newBillingRecordMapping>[0]> = {}) {
  return newBillingRecordMapping({
    sourceSystem: record.sourceSystem,
    provider: record.provider,
    billingAccountRef: record.billingAccountRef,
    sourceRecordId: record.sourceRecordId,
    sourceRecordSha256: record.sourceRecordSha256,
    firstImportId: record.firstImportId,
    targetProject: 'fiscus-project',
    targetAccountRef: 'fiscus-account',
    mappingVersion: 1,
    declaredAtMs: 1_000,
    ...overrides,
  });
}

function fixtureStore(): Store {
  const store = new Store(':memory:');
  store.applyBillingImport(readBillingImportFile(FIXTURE).input, 10);
  return store;
}

test('mapping evaluates only exact source identities and reports residuals without force-fitting', () => {
  const first = importedRecord();
  const second = importedRecord({ recordId: 'record-2', sourceRecordId: 'source-2', amountMicros: -1_000_000 });
  const coverage = evaluateBillingMapping({
    records: [first, second],
    mappings: [mappingFor(first)],
    asOfMs: 2_000,
  });

  assert.equal(coverage.coverageStatus, 'partially_mapped');
  assert.equal(coverage.reconciliationStatus, 'blocked_incomplete_mapping');
  assert.equal(coverage.mappedRecordCount, 1);
  assert.equal(coverage.unmappedRecordCount, 1);
  assert.equal(coverage.mappedMicros, 12_345_678);
  assert.equal(coverage.residualMicros, -1_000_000);
  assert.deepEqual(coverage.targets, [{
    targetProject: 'fiscus-project',
    targetAccountRef: 'fiscus-account',
    recordCount: 1,
    amountMicros: 12_345_678,
  }]);
  assert.equal(coverage.records[1]!.status, 'unmapped');
  assert.match(coverage.records[1]!.detail, /no exact operator mapping/i);
  assert.deepEqual(coverage.excludedFrom, ['budget_enforcement', 'roi', 'model_recommendations']);
});

test('mapping digest and import anchors detect stale declarations instead of selecting their target', () => {
  const record = importedRecord();
  const stale = mappingFor(record, { sourceRecordSha256: 'b'.repeat(64) });
  const coverage = evaluateBillingMapping({ records: [record], mappings: [stale], asOfMs: 2_000 });
  assert.equal(coverage.coverageStatus, 'unmapped');
  assert.equal(coverage.staleMappingRecordCount, 1);
  assert.equal(coverage.records[0]!.status, 'stale_mapping');
  assert.equal(coverage.records[0]!.targetProject, null);

  const wrongImport = mappingFor(record, { firstImportId: 'import-other', mappingId: 'mapping-wrong-import' });
  const importCoverage = evaluateBillingMapping({ records: [record], mappings: [wrongImport], asOfMs: 2_000 });
  assert.equal(importCoverage.records[0]!.status, 'stale_mapping');
  assert.equal(importCoverage.residualMicros, record.amountMicros);
});

test('same source key and version is ambiguous in memory and never silently picks a target', () => {
  const record = importedRecord();
  const left = mappingFor(record, { mappingId: 'mapping-left', targetProject: 'project-left' });
  const right = mappingFor(record, { mappingId: 'mapping-right', targetProject: 'project-right' });
  const coverage = evaluateBillingMapping({ records: [record], mappings: [left, right], asOfMs: 2_000 });
  assert.equal(coverage.records[0]!.status, 'ambiguous_mapping');
  assert.equal(coverage.ambiguousMappingRecordCount, 1);
  assert.equal(coverage.records[0]!.targetProject, null);
});

test('complete operator mappings remain blocked and excluded until provider scope authority is explicit', () => {
  const record = importedRecord();
  const mapping = mappingFor(record);
  const blocked = evaluateBillingMapping({ records: [record], mappings: [mapping], asOfMs: 2_000 });
  assert.equal(blocked.coverageStatus, 'fully_mapped');
  assert.equal(blocked.reconciliationStatus, 'blocked_provider_scope_not_authoritative');
  assert.deepEqual(blocked.excludedFrom, ['budget_enforcement', 'roi', 'model_recommendations']);

  const eligible = evaluateBillingMapping({
    records: [record],
    mappings: [mapping],
    asOfMs: 2_000,
    providerScopeAuthority: 'provider_verified',
  });
  assert.equal(eligible.reconciliationStatus, 'eligible_for_authoritative_reconciliation');
  assert.deepEqual(eligible.excludedFrom, []);
});

test('Store declarations are exact, append-only, versioned, and do not mutate provider evidence', () => {
  const store = fixtureStore();
  try {
    const recordsBefore = store.billingEvidenceRecords();
    const first = recordsBefore[0]!;
    const declared = store.declareBillingRecordMapping({
      recordId: first.recordId,
      targetProject: 'alpha-local',
      targetAccountRef: 'finance-local',
      declaredAtMs: 1_000,
    });
    assert.equal(declared.created, true);
    assert.equal(declared.mapping.mappingVersion, 1);
    assert.equal(declared.mapping.sourceRecordSha256, first.sourceRecordSha256);

    const replay = store.declareBillingRecordMapping({
      recordId: first.recordId,
      targetProject: 'alpha-local',
      targetAccountRef: 'finance-local',
      declaredAtMs: 1_001,
    });
    assert.equal(replay.created, false);
    assert.equal(replay.mapping.mappingId, declared.mapping.mappingId);

    const changed = store.declareBillingRecordMapping({
      recordId: first.recordId,
      targetProject: 'alpha-renamed',
      targetAccountRef: 'finance-local',
      declaredAtMs: 2_000,
    });
    assert.equal(changed.created, true);
    assert.equal(changed.mapping.mappingVersion, 2);
    assert.equal(store.billingRecordMappings(first.recordId).length, 2);

    const beforeRemap = store.billingMappingCoverage({ asOfMs: 1_500 });
    assert.equal(beforeRemap.records.find((row) => row.recordId === first.recordId)!.targetProject, 'alpha-local');
    const afterRemap = store.billingMappingCoverage({ asOfMs: 2_500 });
    assert.equal(afterRemap.records.find((row) => row.recordId === first.recordId)!.targetProject, 'alpha-renamed');
    assert.equal(afterRemap.reconciliationStatus, 'blocked_incomplete_mapping');

    assert.deepEqual(store.billingEvidenceRecords(), recordsBefore);
    assert.throws(
      () => store.declareBillingRecordMapping({ recordId: 'not-a-record', targetProject: 'p', targetAccountRef: 'a' }),
      /no imported billing evidence record/i,
    );
    assert.throws(
      () => store.raw().prepare('UPDATE billing_record_mapping_versions SET target_project = ?').run('forged'),
      /append-only/i,
    );
    assert.throws(
      () => store.raw().prepare('DELETE FROM billing_record_mapping_versions').run(),
      /append-only/i,
    );
    assert.throws(
      () => store.raw().prepare('INSERT OR REPLACE INTO billing_record_mapping_versions (mapping_id, mapping_key, mapping_version, schema_version, source_system, provider, billing_account_ref, source_record_id, source_record_sha256, first_import_id, target_project, target_account_ref, declared_at_ms, trust) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(
        declared.mapping.mappingId, declared.mapping.mappingKey, declared.mapping.mappingVersion, 1, 'operator-export', 'openai',
        declared.mapping.billingAccountRef, declared.mapping.sourceRecordId, declared.mapping.sourceRecordSha256, declared.mapping.firstImportId,
        'forged', declared.mapping.targetAccountRef, declared.mapping.declaredAtMs, declared.mapping.trust,
      ),
      /append-only|UNIQUE/i,
    );
  } finally {
    store.close();
  }
});

test('mapping key is stable and does not include target accounting choices', () => {
  const record = importedRecord();
  assert.equal(billingMappingKey(record), mappingFor(record).mappingKey);
  assert.notEqual(
    mappingFor(record, { targetProject: 'different-project' }).mappingKey,
    undefined,
  );
});

test('empty imports are explicit and cannot be treated as a zero-dollar ready reconciliation', () => {
  const coverage = evaluateBillingMapping({ records: [], mappings: [], asOfMs: 1_000 });
  assert.equal(coverage.coverageStatus, 'no_records');
  assert.equal(coverage.reconciliationStatus, 'blocked_no_records');
  assert.equal(coverage.totalRecordCount, 0);
  assert.equal(coverage.totalMicros, 0);
  assert.equal(coverage.residualMicros, 0);
});
