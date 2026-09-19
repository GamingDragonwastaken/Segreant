/**
 * EVERY DECLARED DIMENSION ROLL-UP IS VALIDATED AGAINST THE PRODUCER THAT MAKES
 * IT TRUE (WP-R03, D-244).
 *
 * `DIMENSION_ROLLUPS` in `src/epistemic/grain.ts` is data, and its own header
 * says what an entry asserts: a real partition — every thing named by the finer
 * dimension belongs to exactly one thing named by the coarser. Until now the
 * table was hand-maintained and checked by nothing: an entry could be added,
 * `grainIsSupportedBy` would start licensing the aggregation, and no producer
 * would be asked whether the partition holds.
 *
 * The gate: every entry must be listed here with the PRODUCER that enforces
 * containment, and a probe that shows the producer REFUSING a finer record that
 * falls outside its coarser unit. Two directions are checked: a new entry with
 * no probe fails, and a probe whose producer stops refusing fails. The table
 * must also stay acyclic and every dimension it names must be one some
 * `grain([...])` in the product actually declares — a roll-up nobody produces
 * is a licence with no user.
 *
 * What this does not establish: that a producer's containment check is the
 * whole of the partition (a record inside the period but double-counted across
 * two runs is a different question, answered by the duplicate-id refusals in
 * the same producers); nor anything about scope hierarchies, which stay
 * structural in `scope.ts`.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DIMENSION_ROLLUPS, grainRollsUpInto } from '../src/epistemic/grain.ts';
import { buildBillingKernelIssuance, buildOpenAiCostsKernelIssuance } from '../src/billing/epistemic.ts';
import type { BillingEvidenceRecord, BillingImportRun, OpenAiCostsObservationLine, OpenAiCostsObservationRun } from '../src/store/billing.ts';

const ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)), '..');

// ---------------------------------------------------------------------------
// Fixtures: one well-formed input per producer, and a mutation that moves one
// finer record outside its coarser unit.
// ---------------------------------------------------------------------------

const importRun: BillingImportRun = {
  importId: 'import:rollup:1', importedAtMs: Date.parse('2026-08-10T12:00:00.000Z'), format: 'json', schemaVersion: 1,
  importerVersion: '1.0.0', fileName: 'operator-export.json', fileSha256: 'a'.repeat(64), fileSizeBytes: 100,
  sourceSystem: 'operator-export', sourceExportId: 'export:rollup:1', provider: 'openai', billingAccountRef: 'acct-rollup',
  exportedAtMs: Date.parse('2026-08-10T11:00:00.000Z'), periodStartMs: Date.parse('2026-08-01T00:00:00.000Z'),
  periodEndMs: Date.parse('2026-08-03T00:00:00.000Z'), coverage: 'complete', trust: 'operator_supplied_unverified', rawRetention: 'digest_only',
  recordsSeen: 1, recordsInserted: 1, recordsDuplicate: 0,
};

function billingRecord(chargePeriodEndMs: number): BillingEvidenceRecord {
  return {
    recordId: 'record:rollup:1', sourceSystem: 'operator-export', billingAccountRef: importRun.billingAccountRef,
    sourceRecordId: 'line-1', sourceRecordSha256: '1'.repeat(64), firstImportId: importRun.importId, sourceExportId: importRun.sourceExportId,
    provider: 'openai', providerProjectRef: 'project-a', service: 'api', sku: 'tokens', model: 'gpt-test', region: null,
    observedAtMs: Date.parse('2026-08-01T12:00:00.000Z'), chargePeriodStartMs: importRun.periodStartMs, chargePeriodEndMs,
    chargeType: 'usage', currency: 'USD', amountMicros: 100000, usageUnit: 'tokens', usageQuantity: '1000', costBasis: 'provider_reported', trust: 'operator_supplied_unverified',
  };
}

const costsRun: OpenAiCostsObservationRun = {
  observationRunId: 'observation:rollup:1', declaredScopeId: 'scope_rollup', providerProjectRef: 'proj_rollup',
  periodStartMs: Date.parse('2026-08-01T00:00:00.000Z'), periodEndMs: Date.parse('2026-08-03T00:00:00.000Z'),
  fetchedAtMs: Date.parse('2026-08-05T12:00:00.000Z'), paginationComplete: true, pageCount: 1, pageDigestChainSha256: 'c'.repeat(64),
  resultState: 'succeeded', failureCode: null, providerFinality: 'undocumented', trust: 'provider_observation_unreconciled', rawRetention: 'digest_only',
  observationsStored: 1, sourceKind: 'provider_api_pull',
};

function costsLine(bucketStartMs: number): OpenAiCostsObservationLine {
  return {
    observationId: 'line:rollup:1', observationRunId: costsRun.observationRunId, declaredScopeId: costsRun.declaredScopeId, fetchedAtMs: costsRun.fetchedAtMs,
    providerProjectRef: costsRun.providerProjectRef, bucketStartMs, bucketEndMs: bucketStartMs + 24 * 60 * 60 * 1000,
    lineItem: 'completions', currency: 'USD', amountDecimal: '1.234567',
  };
}

/** Every declared roll-up, the producer that enforces its partition, and the refusal that proves it. */
const VALIDATED: ReadonlyArray<{
  finer: string;
  coarser: string;
  producer: string;
  holds: () => void;
  violated: () => void;
  refusal: RegExp;
}> = [
  {
    finer: 'billing_record', coarser: 'billing_period', producer: 'buildBillingKernelIssuance (validateRecord)',
    holds: () => { buildBillingKernelIssuance({ run: importRun, records: [billingRecord(Date.parse('2026-08-02T00:00:00.000Z'))] }); },
    violated: () => { buildBillingKernelIssuance({ run: importRun, records: [billingRecord(Date.parse('2026-08-04T00:00:00.000Z'))] }); },
    refusal: /charge period falls outside import/,
  },
  {
    finer: 'provider_project_day_line_item', coarser: 'provider_project_period', producer: 'buildOpenAiCostsKernelIssuance (validateOpenAiObservation)',
    holds: () => { buildOpenAiCostsKernelIssuance({ run: costsRun, observations: [costsLine(costsRun.periodStartMs)] }); },
    violated: () => { buildOpenAiCostsKernelIssuance({ run: costsRun, observations: [costsLine(Date.parse('2026-08-03T00:00:00.000Z'))] }); },
    refusal: /bucket is invalid/,
  },
];

function sourceFiles(dir = join(ROOT, 'src')): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...sourceFiles(full));
    else if (entry.endsWith('.ts')) out.push(full);
  }
  return out;
}

test('every declared roll-up has a producer that refuses a finer record outside its coarser unit', () => {
  assert.ok(DIMENSION_ROLLUPS.length >= 2, 'the roll-up table must be found');
  const declared = DIMENSION_ROLLUPS.map(([finer, coarser]) => `${finer} -> ${coarser}`);
  const validated = VALIDATED.map((entry) => `${entry.finer} -> ${entry.coarser}`);
  assert.deepEqual([...declared].sort(), [...validated].sort(), 'a roll-up was declared without a producer probe, or a probe outlived its declaration');
  for (const entry of VALIDATED) {
    assert.ok(grainRollsUpInto(entry.finer, entry.coarser), `${entry.finer} -> ${entry.coarser} must be a declared roll-up`);
    assert.doesNotThrow(entry.holds, `${entry.producer} must accept a contained record`);
    assert.throws(entry.violated, entry.refusal, `${entry.producer} must refuse a record outside the coarser unit`);
  }
});

test('the roll-up table is acyclic and names only dimensions the product declares in a grain', () => {
  for (const [finer, coarser] of DIMENSION_ROLLUPS) {
    assert.equal(grainRollsUpInto(coarser, finer), false, `${coarser} -> ${finer} would be refinement, which is the laundering this table refuses`);
  }
  // Transitive cycle check over the small table.
  const edges = new Map<string, string[]>();
  for (const [finer, coarser] of DIMENSION_ROLLUPS) edges.set(finer, [...(edges.get(finer) ?? []), coarser]);
  for (const start of edges.keys()) {
    const seen = new Set<string>();
    const stack = [start];
    while (stack.length > 0) {
      const node = stack.pop()!;
      for (const next of edges.get(node) ?? []) {
        assert.notEqual(next, start, `roll-up cycle through ${start}`);
        if (!seen.has(next)) { seen.add(next); stack.push(next); }
      }
    }
  }
  const source = sourceFiles().filter((file) => !file.includes(`${join('src', 'epistemic')}${'\\'}grain.ts`) && !file.endsWith('/grain.ts')).map((file) => readFileSync(file, 'utf8')).join('\n');
  const declaredGrains = new Set<string>();
  for (const match of source.matchAll(/grain\(\[([^\]]*)\]\)/g)) {
    for (const part of match[1]!.split(',')) {
      const name = part.trim().replace(/^['"]|['"]$/g, '');
      if (name) declaredGrains.add(name);
    }
  }
  assert.ok(declaredGrains.size >= 5, `grain declarations must be found (${declaredGrains.size})`);
  for (const [finer, coarser] of DIMENSION_ROLLUPS) {
    assert.ok(declaredGrains.has(finer), `${finer} is declared as a roll-up source but no producer issues at that grain`);
    assert.ok(declaredGrains.has(coarser), `${coarser} is declared as a roll-up target but no producer issues at that grain`);
  }
});
