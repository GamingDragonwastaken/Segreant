import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { tmpdir } from 'node:os';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = resolve(ROOT, 'scripts', 'benchmark.mjs');

test('benchmark harness emits a finite, isolated observation contract', () => {
  const sentinelHome = mkdtempSync(resolve(tmpdir(), 'fiscus-benchmark-sentinel-'));
  const sentinel = resolve(sentinelHome, 'pricing', 'models.json');
  const env: NodeJS.ProcessEnv = { ...process.env, FISCUS_HOME: sentinelHome };
  mkdirSync(resolve(sentinelHome, 'pricing'), { recursive: true });
  writeFileSync(sentinel, 'sentinel pricing cache that the benchmark must not consult', 'utf8');
  const before = createHash('sha256').update(readFileSync(sentinel)).digest('hex');
  delete env.FISCUS_DB;
  delete env.FISCUS_DEMO;
  let output = '';
  try {
    output = execFileSync(
      process.execPath,
      ['--disable-warning=ExperimentalWarning', SCRIPT, '--scale=small', '--iterations=1'],
      { cwd: ROOT, encoding: 'utf8', env },
    );
  } finally {
    const after = createHash('sha256').update(readFileSync(sentinel)).digest('hex');
    assert.equal(after, before, 'caller Fiscus home sentinel must remain untouched');
    const source = readFileSync(SCRIPT, 'utf8');
    assert.match(source, /mkdtempSync/);
    assert.match(source, /process\.env\.FISCUS_HOME\s*=/);
    rmSync(sentinelHome, { recursive: true, force: true });
  }
  const report = JSON.parse(output) as {
    benchmarkVersion: number;
    scales: string[];
    externalNetworkAttempted: boolean;
    credentialRead: boolean;
    isolatedHome: boolean;
    packagedDistBytes: number;
    sourceRevision: string;
    cases: Array<{
      scale: string;
      rows: number;
      observations: Record<string, Record<string, number>>;
      quality?: {
        epistemicIssuance?: {
          requestedRecords: number;
          evidenceIssued: number;
          claimsIssued: number;
          claimsLinkedToEvidence: number;
          immutableEvidence: number;
          immutableClaims: number;
          invalidClaimsRefused: number;
        };
        epistemicPersistence?: {
          requestedPairs: number;
          evidenceAppended: number;
          claimsAppended: number;
          edgesStored: number;
          historicalNodes: number;
          activeNodes: number;
          edgesReplayed: number;
          latestClaims: number;
          idempotentDuplicatesIgnored: number;
          divergentRefused: number;
          missingDependencyRefused: number;
        };
        revocationClosure?: { requestedPairs: number; nodesRevoked: number; claimsRevoked: number; traceEntries: number };
        fiscuspackRoundTrip?: { included: number; omitted: number; redacted: number; envelopeBytes: number };
        exactProjection?: { rows: number; requestCount: number; unresolvedRequests: number; complete: boolean; amountText: string };
        allocationRun?: { rows: number; costCentres: number; lines: number; totalMicros: number; allocatedMicros: number; unallocatedMicros: number; conserves: boolean };
        dashboardContractWalk?: { typeName: string; fields: number; problems: number; firstProblem: string | null };
      };
    }>;
  };
  assert.equal(report.benchmarkVersion, 1);
  assert.deepEqual(report.scales, ['small']);
  assert.equal(report.externalNetworkAttempted, false);
  assert.equal(report.credentialRead, false);
  assert.equal(report.isolatedHome, true);
  assert.equal(report.packagedDistBytes > 0, true);
  assert.equal(report.sourceRevision.length > 0, true);
  assert.equal(report.cases.length, 1);
  assert.equal(report.cases[0]?.scale, 'small');
  assert.equal(report.cases[0]?.rows, 100);
  assert.ok(
    Object.hasOwn(report.cases[0]?.observations ?? {}, 'epistemicIssuance'),
    'the benchmark must exercise the canonical Evidence/Claim truth boundary',
  );
  const epistemicQuality = report.cases[0]?.quality?.epistemicIssuance;
  assert.ok(epistemicQuality, 'the benchmark must publish non-vacuous epistemic quality checks');
  assert.equal(epistemicQuality.requestedRecords, 100);
  assert.equal(epistemicQuality.evidenceIssued, 100);
  assert.equal(epistemicQuality.claimsIssued, 100);
  assert.equal(epistemicQuality.claimsLinkedToEvidence, 100);
  assert.equal(epistemicQuality.immutableEvidence, 100);
  assert.equal(epistemicQuality.immutableClaims, 100);
  assert.equal(epistemicQuality.invalidClaimsRefused, 1);
  assert.ok(
    Object.hasOwn(report.cases[0]?.observations ?? {}, 'epistemicPersistence'),
    'the benchmark must exercise persistent epistemic storage and DAG replay',
  );
  const persistenceQuality = report.cases[0]?.quality?.epistemicPersistence;
  assert.ok(persistenceQuality, 'the benchmark must publish non-vacuous epistemic persistence quality checks');
  assert.equal(persistenceQuality.requestedPairs, 25);
  assert.equal(persistenceQuality.evidenceAppended, 25);
  assert.equal(persistenceQuality.claimsAppended, 25);
  assert.equal(persistenceQuality.edgesStored, 25);
  assert.equal(persistenceQuality.historicalNodes, 0);
  assert.equal(persistenceQuality.activeNodes, 50);
  assert.equal(persistenceQuality.edgesReplayed, 25);
  assert.equal(persistenceQuality.latestClaims, 25);
  assert.equal(persistenceQuality.idempotentDuplicatesIgnored, 1);
  assert.equal(persistenceQuality.divergentRefused, 1);
  assert.equal(persistenceQuality.missingDependencyRefused, 1);
  // D-238: revocation closure and .fiscuspack round-trip are observed, and each
  // observation is backed by a quality block the script computed from the same
  // ledger, so a timing over an empty or half-built graph cannot pass.
  for (const key of ['revocationClosure', 'fiscuspackRoundTrip'] as const) {
    assert.ok(Object.hasOwn(report.cases[0]?.observations ?? {}, key), `the benchmark must observe ${key}`);
  }
  const revocation = report.cases[0]?.quality?.revocationClosure;
  assert.ok(revocation, 'the benchmark must publish revocation closure quality checks');
  assert.equal(revocation.requestedPairs, 25);
  assert.equal(revocation.claimsRevoked, 25, 'revoking the shared root must reach every claim');
  assert.equal(revocation.nodesRevoked, 27, 'root, one leaf, every claim — and no other leaf');
  const pack = report.cases[0]?.quality?.fiscuspackRoundTrip;
  assert.ok(pack, 'the benchmark must publish .fiscuspack round-trip quality checks');
  assert.equal(pack.included, 51, 'the whole revocation graph is packed');
  assert.equal(pack.omitted, 0);
  assert.ok(pack.envelopeBytes > 0);
  // D-253: the exact effective-money projection, an allocation run over the
  // same rows, and the browser's deep interface walk are observed, each with a
  // quality block from the same data — a resolved-nothing projection, a
  // non-conserving run or a walk that found problems cannot pass as a timing.
  for (const key of ['exactProjection', 'allocationRun', 'dashboardContractWalk'] as const) {
    assert.ok(Object.hasOwn(report.cases[0]?.observations ?? {}, key), `the benchmark must observe ${key}`);
  }
  const projection = report.cases[0]?.quality?.exactProjection;
  assert.ok(projection, 'the benchmark must publish exact projection quality checks');
  assert.equal(projection.rows, 100);
  assert.equal(projection.unresolvedRequests, 0, 'every benchmark row carries an exact amount');
  assert.equal(projection.complete, true);
  assert.equal(projection.amountText, '0.2785');
  const allocation = report.cases[0]?.quality?.allocationRun;
  assert.ok(allocation, 'the benchmark must publish allocation run quality checks');
  assert.equal(allocation.rows, 100);
  assert.equal(allocation.costCentres, 8);
  assert.equal(allocation.conserves, true);
  assert.equal(allocation.allocatedMicros + allocation.unallocatedMicros, allocation.totalMicros);
  assert.equal(allocation.unallocatedMicros, 0, 'one direct rule per project places every row');
  const walk = report.cases[0]?.quality?.dashboardContractWalk;
  assert.ok(walk, 'the benchmark must publish the contract walk quality checks');
  assert.equal(walk.typeName, 'Overview');
  assert.ok(walk.fields >= 10);
  assert.equal(walk.problems, 0, walk.firstProblem ?? '');
  for (const observation of Object.values(report.cases[0]?.observations ?? {})) {
    const samples = observation.samples;
    assert.equal(typeof samples, 'number');
    assert.equal((samples ?? 0) >= 1, true);
    for (const key of ['minMs', 'medianMs', 'p95Ms', 'maxMs']) {
      const value = observation[key];
      assert.equal(Number.isFinite(value), true, `${key} must be finite`);
      assert.equal((value ?? -1) >= 0, true, `${key} must be non-negative`);
    }
  }
});
