/**
 * A revoked claim must not be served as supported (WP-R07).
 *
 * THE DEFECT. `Store.billingKernelClaims`, `openAiCostsKernelClaims` and
 * `billingReconciliationKernelClaims` are the only product surface for kernel
 * claims — `/api/billing` serves all three (`src/dashboard/routes.ts:461-463`).
 * Each one calls `readClaim` and returns the stored profile verbatim. None of
 * them consults `revocationProjection()`. So after the evidence a claim rests on
 * is revoked, the kernel's own projection lists the claim as revoked while the
 * dashboard payload still reports `profile.epistemic = 'supported'` and
 * `integrity = 'verified'`, with no field anywhere in the response saying
 * otherwise.
 *
 * WHY THIS IS THE SHARP CASE. Revocation closure is not decoration here: it is
 * the mechanism by which withdrawn evidence stops supporting what was derived
 * from it. `revocationClosure` computes it correctly — the kernel knows. The
 * failure is entirely at the read boundary, which is the worst place for it,
 * because every consumer downstream of that payload inherits a strength the
 * evidence no longer licenses. "Authentic is not true" and "unknown stays
 * unknown" are both violated by the same line.
 *
 * WITHDRAWN, NOT DISAPPEARED. The claim is still returned. Dropping revoked
 * claims from the list would trade one dishonesty for another: the reader would
 * then assert an absence it has not established, and a page showing four claims
 * where five exist says nothing about the fifth. What changes is that the
 * profile can no longer read `supported`, and an explicit `revoked` flag names
 * the event that withdrew it.
 *
 * WHAT THIS DOES NOT ESTABLISH, STATED RATHER THAN IMPLIED. It exercises ONE of
 * the three readers end to end. `openAiCostsKernelClaims` and
 * `billingReconciliationKernelClaims` are repaired through the same shared
 * helper and are NOT asserted here: both look up claims keyed on a persisted
 * costs-observation or reconciliation run, and seeding one is a materially
 * larger fixture than this defect needs. A fixture that produced zero rows would
 * have passed every assertion below while proving nothing, which is worse than
 * an admitted gap.
 *
 * It also says nothing about as-of reads. `revocationProjectionAsOf` exists and
 * these readers take no boundary at all, so a caller still cannot ask what was
 * known at a past instant — a revocation recorded today rewrites how every past
 * read renders. Recorded at D-094.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store/db.ts';
import type { BillingEvidenceRecord, BillingImportRun } from '../src/store/billing.ts';

const run: BillingImportRun = {
  importId: 'import:revocation:1', importedAtMs: Date.parse('2026-08-10T12:00:00.000Z'), format: 'json', schemaVersion: 1,
  importerVersion: '1.0.0', fileName: 'operator-export.json', fileSha256: 'a'.repeat(64), fileSizeBytes: 100,
  sourceSystem: 'operator-export', sourceExportId: 'export:revocation:1', provider: 'openai', billingAccountRef: 'acct-revocation',
  exportedAtMs: Date.parse('2026-08-10T11:00:00.000Z'), periodStartMs: Date.parse('2026-08-01T00:00:00.000Z'),
  periodEndMs: Date.parse('2026-08-03T00:00:00.000Z'), coverage: 'complete', trust: 'operator_supplied_unverified', rawRetention: 'digest_only',
  recordsSeen: 1, recordsInserted: 1, recordsDuplicate: 0,
};

const records: BillingEvidenceRecord[] = [
  {
    recordId: 'record:revocation:1', sourceSystem: 'operator-export', billingAccountRef: run.billingAccountRef,
    sourceRecordId: 'line-1', sourceRecordSha256: '1'.repeat(64), firstImportId: run.importId, sourceExportId: run.sourceExportId,
    provider: 'openai', providerProjectRef: 'project-a', service: 'api', sku: 'tokens', model: 'gpt-test', region: null,
    observedAtMs: Date.parse('2026-08-01T12:00:00.000Z'), chargePeriodStartMs: run.periodStartMs, chargePeriodEndMs: Date.parse('2026-08-02T00:00:00.000Z'),
    chargeType: 'usage', currency: 'USD', amountMicros: 100000, usageUnit: 'tokens', usageQuantity: '1000',
    costBasis: 'provider_reported', trust: 'operator_supplied_unverified',
  },
];

function seed(store: Store): string {
  const normalized = {
    schemaVersion: 1 as const,
    source: {
      system: 'operator-export' as const, provider: 'openai' as const, exportId: run.sourceExportId,
      billingAccountRef: run.billingAccountRef, exportedAt: new Date(run.exportedAtMs).toISOString(),
      periodStart: new Date(run.periodStartMs).toISOString(), periodEnd: new Date(run.periodEndMs).toISOString(), coverage: run.coverage,
    },
    exportedAtMs: run.exportedAtMs, periodStartMs: run.periodStartMs, periodEndMs: run.periodEndMs,
    records: records.map((record) => ({
      sourceRecordId: record.sourceRecordId, sourceRecordSha256: record.sourceRecordSha256, observedAtMs: record.observedAtMs,
      chargePeriodStartMs: record.chargePeriodStartMs, chargePeriodEndMs: record.chargePeriodEndMs, service: record.service,
      sku: record.sku, model: record.model, region: record.region, providerProjectRef: record.providerProjectRef,
      chargeType: record.chargeType, currency: record.currency, amountMicros: record.amountMicros,
      usageUnit: record.usageUnit, usageQuantity: record.usageQuantity,
    })),
  };
  const imported = store.applyBillingImport({
    document: normalized, fileName: 'operator-export.json', fileSha256: run.fileSha256, fileSizeBytes: run.fileSizeBytes, format: 'json',
  }, run.importedAtMs);
  store.issueBillingImportToKernel(imported.run.importId);
  return imported.run.importId;
}

function revokeAllEvidence(store: Store): void {
  const evidenceIds = store.epistemic().graph().nodes.filter((node) => node.kind === 'evidence').map((node) => node.id);
  assert.ok(evidenceIds.length > 0, 'the fixture must issue evidence, or the revocation below withdraws nothing');
  for (const id of evidenceIds) {
    store.epistemic().appendRevocation({
      eventId: `event:revoke:${id}`,
      targetId: id,
      recordedAt: '2026-08-11T00:00:00.000Z',
      reason: 'the operator withdrew the export',
    });
  }
}

test('a billed claim whose evidence is revoked is no longer served as supported', () => {
  const store = new Store(':memory:');
  try {
    seed(store);
    const before = store.billingKernelClaims(25);
    assert.equal(before.length, 1, 'the fixture must produce exactly one aggregate claim');
    const claimId = before[0]!.id;
    assert.equal(before[0]!.profile.epistemic, 'supported', 'the claim must start supported, or the assertion below is vacuous');
    assert.equal(before[0]!.revoked, false);

    revokeAllEvidence(store);

    // The kernel already knows. This is the premise of the defect, not the
    // defect: closure is computed correctly and the read boundary ignored it.
    const projection = store.epistemic().revocationProjection();
    assert.ok(
      projection.revokedIds.includes(claimId),
      `the kernel projection should list ${claimId} as revoked; got ${JSON.stringify([...projection.revokedIds])}`,
    );

    const after = store.billingKernelClaims(25);
    const served = after.find((claim) => claim.id === claimId);
    assert.ok(served, 'a revoked claim must remain visible: dropping it would assert an absence nobody established');
    assert.equal(served.revoked, true, 'the payload must say the claim was revoked');
    assert.notEqual(served.profile.epistemic, 'supported', 'a claim whose evidence was withdrawn cannot still read as supported');
  } finally {
    store.close();
  }
});

test('an unrevoked claim is untouched, so the repair withdraws rather than blanks', () => {
  // A reader that reported everything as revoked would satisfy both assertions
  // above and destroy the surface. The stored profile has to survive intact
  // when nothing was withdrawn.
  const store = new Store(':memory:');
  try {
    seed(store);
    const claims = store.billingKernelClaims(25);
    assert.equal(claims.length, 1);
    assert.equal(claims[0]!.revoked, false);
    assert.equal(claims[0]!.profile.epistemic, 'supported');
    assert.equal(claims[0]!.profile.integrity, 'verified');
    assert.equal(claims[0]!.monetaryBasis, 'billed');
  } finally {
    store.close();
  }
});
