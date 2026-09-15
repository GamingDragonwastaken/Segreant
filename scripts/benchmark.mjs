#!/usr/bin/env node
/**
 * Reproducible local performance observations for the M14 gate.
 *
 * This is deliberately a measurement harness, not a pass/fail benchmark. It
 * uses synthetic in-memory ledgers, binds the dashboard only to loopback, and
 * never reads provider credentials or the user's Fiscus home.
 */

import { performance } from 'node:perf_hooks';
import { mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Store } from '../src/store/db.ts';
import { DEFAULT_CONFIG } from '../src/config.ts';
import { computeFrontier } from '../src/value/frontier.ts';
import { createDashboardServer } from '../src/dashboard/server.ts';
import { buildOverview } from '../src/dashboard/routes.ts';
import { claim } from '../src/epistemic/claim.ts';
import { evidence } from '../src/epistemic/evidence.ts';
import { claimProfile } from '../src/epistemic/profile.ts';
import { grain } from '../src/epistemic/grain.ts';
import { scope } from '../src/epistemic/scope.ts';
import { interval } from '../src/epistemic/time.ts';

const DAY_MS = 24 * 60 * 60 * 1000;
const SCALE_ROWS = Object.freeze({ small: 100, current: 1_000, '10x': 10_000, '100x': 100_000 });
const DEFAULT_SCALES = ['small', 'current', '10x'];
const EPISTEMIC_OCCURRED_AT = '2026-01-01T00:00:00.000Z';
const EPISTEMIC_OBSERVED_AT = '2026-01-01T00:00:01.000Z';
const EPISTEMIC_ISSUED_AT = '2026-01-01T00:00:02.000Z';
const EPISTEMIC_VALID_TIME = interval('2026-01-01T00:00:00.000Z', '2026-01-02T00:00:00.000Z');

function parseArgs(argv) {
  const scalesArg = argv.find((arg) => arg.startsWith('--scale='));
  const requested = scalesArg ? scalesArg.slice('--scale='.length).split(',').filter(Boolean) : DEFAULT_SCALES;
  const stress = argv.includes('--stress');
  const unsupported = requested.filter((name) => !Object.hasOwn(SCALE_ROWS, name));
  if (unsupported.length > 0) throw new Error(`unsupported scale(s): ${unsupported.join(', ')}`);
  if (requested.includes('100x') && !stress) throw new Error('the 100x scale is opt-in; add --stress');
  const scales = requested;
  if (scales.length === 0) throw new Error('choose at least one supported scale: small,current,10x (add --stress for 100x)');
  const iterationsArg = argv.find((arg) => arg.startsWith('--iterations='));
  const iterations = iterationsArg ? Number(iterationsArg.slice('--iterations='.length)) : 3;
  if (!Number.isSafeInteger(iterations) || iterations < 1 || iterations > 20) throw new Error('--iterations must be an integer from 1 to 20');
  return { scales, iterations };
}

function observe(fn, iterations) {
  // One warmup removes the first-call module/JIT cost from the reported sample.
  fn();
  const samples = [];
  for (let i = 0; i < iterations; i++) {
    const started = performance.now();
    fn();
    samples.push(performance.now() - started);
  }
  samples.sort((a, b) => a - b);
  const percentile = (p) => samples[Math.min(samples.length - 1, Math.floor((samples.length - 1) * p))];
  return {
    samples: samples.length,
    minMs: samples[0],
    medianMs: percentile(0.5),
    p95Ms: percentile(0.95),
    maxMs: samples.at(-1),
  };
}

async function observeAsync(fn, iterations) {
  await fn();
  const samples = [];
  for (let i = 0; i < iterations; i++) {
    const started = performance.now();
    await fn();
    samples.push(performance.now() - started);
  }
  samples.sort((a, b) => a - b);
  const percentile = (p) => samples[Math.min(samples.length - 1, Math.floor((samples.length - 1) * p))];
  return {
    samples: samples.length,
    minMs: samples[0],
    medianMs: percentile(0.5),
    p95Ms: percentile(0.95),
    maxMs: samples.at(-1),
  };
}

function insertRows(store, count) {
  const now = Date.now();
  for (let i = 0; i < count; i++) {
    const provider = i % 3 === 0 ? 'anthropic' : 'openai';
    store.insertRequest({
      requestId: `benchmark-${count}-${i}`,
      sessionId: `benchmark-session-${i % 32}`,
      tsEpochMs: now - (i % 30) * DAY_MS + i,
      provider,
      model: provider === 'openai' ? (i % 2 === 0 ? 'gpt-4o' : 'gpt-4o-mini') : 'claude-3-5-sonnet',
      project: `benchmark-project-${i % 8}`,
      taskWeight: 1,
      inputTokens: 200 + (i % 100),
      outputTokens: 80 + (i % 40),
      cacheWriteTokens: 0,
      cacheReadTokens: i % 5 === 0 ? 20 : 0,
      reasoningTokens: 0,
      costUsd: 0.002 + (i % 17) / 10_000,
      estimated: false,
      streamed: i % 4 === 0,
      statusCode: i % 37 === 0 ? 429 : 200,
      durationMs: 100 + (i % 500),
      via: 'proxy',
      source: 'benchmark',
    });
  }
}

function syntheticUnits(count) {
  const units = [];
  for (let i = 0; i < count; i++) {
    const realized = i % 7 !== 0;
    units.push({
      hash: `benchmark-commit-${i}`,
      tsEpochMs: 1_700_000_000_000 + i,
      subject: 'benchmark',
      linesAdded: 20 + (i % 30),
      linesDeleted: i % 5,
      filesChanged: 1 + (i % 4),
      windowStartMs: 1_699_999_000_000 + i,
      windowEndMs: 1_700_000_000_000 + i,
      attributedCostUsd: 0.04 + (i % 11) / 100,
      attributedRequests: 4 + (i % 9),
      attributedOutputTokens: 100 + (i % 100),
      costPerHundredLines: 0.2,
      ageDays: 30,
      maturing: false,
      survivalRatio: realized ? 1 : 0.8,
      reverted: !realized,
      hadProposal: true,
      acceptance: realized ? 0.9 : 0.4,
      taskType: ['feature', 'fix', 'refactor', 'test'][i % 4],
      dominantModel: i % 2 === 0 ? 'gpt-4o' : 'gpt-4o-mini',
      dominantModelCostUsd: 0.04 + (i % 11) / 100,
      dominantModelCostShare: 1,
      costStale: false,
      dominantModelCostBasis: 'modeled_price_card',
      dominantModelRateCard: 'benchmark-card',
      funnel: {
        results: [],
        reachedIndex: realized ? 7 : 5,
        reached: realized ? 'clean' : 'shipped',
        diedAt: realized ? null : 'survived',
        diedAtIndex: realized ? null : 6,
        realized,
        passes: realized ? 8 : 6,
        fails: realized ? 0 : 1,
        unknowns: 0,
        instrumented: realized ? 8 : 7,
        realizationScore: realized ? 1 : 6 / 7,
      },
    });
  }
  return units;
}

/**
 * Exercise the canonical Evidence/Claim issuance boundary with a deterministic
 * workload. This intentionally constructs records in memory rather than
 * appending them to SQLite: the first H06 slice measures canonicalization and
 * validation, while persistent graph replay is a separate future slice.
 *
 * The returned counts are quality checks, not timing metadata. Keeping them in
 * the report prevents a benchmark from passing while its workload silently
 * becomes empty or stops checking the Evidence -> Claim relationship.
 */
function benchmarkEpistemicIssuance(count) {
  const benchmarkScope = scope({ account: 'benchmark' });
  const benchmarkGrain = grain(['day', 'project']);
  const benchmarkProfile = claimProfile({
    epistemic: 'supported',
    integrity: 'verified',
    authenticity: 'provider_authenticated',
    scope: 'established',
    coverage: 'complete',
    measurement: 'proxy_unvalidated',
    causality: 'none',
    monetaryBasis: 'billed',
    finality: 'provisional',
    decisionFitness: 'not_assessed',
  });
  let evidenceIssued = 0;
  let claimsIssued = 0;
  let claimsLinkedToEvidence = 0;
  let immutableEvidence = 0;
  let immutableClaims = 0;

  for (let i = 0; i < count; i++) {
    const item = evidence({
      id: `benchmark:evidence:${i}`,
      evidenceType: 'benchmark.observation',
      sourceIdentity: 'benchmark:synthetic',
      sourceClass: 'synthetic_fixture',
      payload: { index: i, value: 'deterministic' },
      scope: benchmarkScope,
      grain: benchmarkGrain,
      occurredAt: EPISTEMIC_OCCURRED_AT,
      observedAt: EPISTEMIC_OBSERVED_AT,
      integrity: 'verified',
      authenticity: 'provider_authenticated',
      completeness: { status: 'complete', method: 'deterministic_fixture' },
      monetaryBasis: 'billed',
      schemaVersion: 1,
      sensitivity: 'internal',
      redaction: 'none',
    });
    const assertion = claim({
      id: `benchmark:claim:${i}`,
      proposition: { predicate: 'benchmark.observed', value: { index: i, value: 'deterministic' } },
      subject: `benchmark:project:${i % 8}`,
      scope: benchmarkScope,
      grain: benchmarkGrain,
      time: { validTime: EPISTEMIC_VALID_TIME, asOf: EPISTEMIC_ISSUED_AT },
      epistemic: 'supported',
      profile: benchmarkProfile,
      measurementModelRef: null,
      evidenceIds: [item.id],
      derivationRule: 'benchmark.issuance.v1',
      derivationVersion: 1,
      causalStatus: 'none',
      issuedAt: EPISTEMIC_ISSUED_AT,
      schemaVersion: 1,
    });
    evidenceIssued++;
    claimsIssued++;
    if (assertion.evidenceIds.includes(item.id)) claimsLinkedToEvidence++;
    if (Object.isFrozen(item)) immutableEvidence++;
    if (Object.isFrozen(assertion)) immutableClaims++;
  }

  let invalidClaimsRefused = 0;
  try {
    claim({
      id: 'benchmark:claim:invalid',
      proposition: { predicate: 'benchmark.invalid', value: null },
      subject: 'benchmark:invalid',
      scope: benchmarkScope,
      grain: benchmarkGrain,
      time: { validTime: EPISTEMIC_VALID_TIME, asOf: EPISTEMIC_ISSUED_AT },
      epistemic: 'supported',
      profile: benchmarkProfile,
      measurementModelRef: null,
      evidenceIds: [],
      derivationRule: 'benchmark.issuance.v1',
      derivationVersion: 1,
      causalStatus: 'none',
      issuedAt: EPISTEMIC_ISSUED_AT,
      schemaVersion: 1,
    });
  } catch {
    invalidClaimsRefused++;
  }

  if (count < 1 || evidenceIssued !== count || claimsIssued !== count || claimsLinkedToEvidence !== count
      || immutableEvidence !== count || immutableClaims !== count || invalidClaimsRefused !== 1) {
    throw new Error('epistemic benchmark quality checks failed');
  }
  return {
    requestedRecords: count,
    evidenceIssued,
    claimsIssued,
    claimsLinkedToEvidence,
    immutableEvidence,
    immutableClaims,
    invalidClaimsRefused,
  };
}

function directoryBytes(path) {
  try {
    let total = 0;
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      const child = join(path, entry.name);
      total += entry.isDirectory() ? directoryBytes(child) : statSync(child).size;
    }
    return total;
  } catch {
    return 0;
  }
}

function listen(server) {
  return new Promise((resolvePort, reject) => {
    const onError = (error) => { server.off('listening', onListening); reject(error); };
    const onListening = () => {
      server.off('error', onError);
      const address = server.address();
      if (!address || typeof address === 'string') reject(new Error('dashboard did not expose a TCP port'));
      else resolvePort(address.port);
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(0, '127.0.0.1');
  });
}

async function dashboardApiObservation(store) {
  const server = createDashboardServer({ store, config: DEFAULT_CONFIG, version: 'benchmark' });
  const port = await listen(server);
  try {
    const url = `http://127.0.0.1:${port}/api/overview?range=all`;
    return await observeAsync(async () => {
      const response = await fetch(url);
      await response.arrayBuffer();
      if (!response.ok) throw new Error(`overview returned ${response.status}`);
    }, 3);
  } finally {
    await new Promise((resolveClose) => server.close(() => resolveClose()));
  }
}

async function runCase(name, rows, iterations) {
  const startup = observe(() => {
    const store = new Store(':memory:');
    store.close();
  }, Math.max(2, Math.min(iterations, 5)));

  const ingestStore = new Store(':memory:');
  const rssBefore = process.memoryUsage().rss;
  const ingestStarted = performance.now();
  insertRows(ingestStore, rows);
  const ingestMs = performance.now() - ingestStarted;
  const rssAfter = process.memoryUsage().rss;
  const startMs = 0;
  const endMs = Date.now() + 1000;
  const units = syntheticUnits(Math.max(24, Math.min(rows, 100_000)));
  const epistemicQuality = benchmarkEpistemicIssuance(rows);
  const observations = {
    startup,
    ingest: { samples: 1, minMs: ingestMs, medianMs: ingestMs, p95Ms: ingestMs, maxMs: ingestMs },
    summary: observe(() => ingestStore.summary(startMs, endMs), iterations),
    byProject: observe(() => ingestStore.byProject(startMs, endMs), iterations),
    byModel: observe(() => ingestStore.byModel(startMs, endMs), iterations),
    overviewAssembly: observe(() => buildOverview(ingestStore, DEFAULT_CONFIG, 'all'), iterations),
    frontier: observe(() => computeFrontier(units), iterations),
    epistemicIssuance: observe(() => benchmarkEpistemicIssuance(rows), iterations),
    apiOverviewHttp: await dashboardApiObservation(ingestStore),
  };
  ingestStore.close();
  return {
    scale: name,
    rows,
    frontierUnits: units.length,
    rssDeltaBytes: Math.max(0, rssAfter - rssBefore),
    observations,
    quality: { epistemicIssuance: epistemicQuality },
  };
}

async function main() {
  const { scales, iterations } = parseArgs(process.argv.slice(2));
  const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
  const isolatedHome = mkdtempSync(join(tmpdir(), 'fiscus-benchmark-home-'));
  const previousHome = process.env.FISCUS_HOME;
  const previousDb = process.env.FISCUS_DB;
  const previousDemo = process.env.FISCUS_DEMO;
  process.env.FISCUS_HOME = isolatedHome;
  delete process.env.FISCUS_DB;
  delete process.env.FISCUS_DEMO;
  let sourceRevision = 'unknown';
  try {
    try {
      sourceRevision = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim() || 'unknown';
    } catch {
      // A source archive may not include Git metadata; the measurements remain useful.
    }
    const cases = [];
    for (const scale of scales) cases.push(await runCase(scale, SCALE_ROWS[scale], iterations));
    process.stdout.write(JSON.stringify({
      benchmarkVersion: 1,
      generatedAt: new Date().toISOString(),
      node: process.version,
      platform: process.platform,
      arch: process.arch,
      cpuCount: os.cpus().length,
      totalMemoryBytes: os.totalmem(),
      sourceRevision,
      iterations,
      scales,
      externalNetworkAttempted: false,
      credentialRead: false,
      isolatedHome: true,
      packagedDistBytes: directoryBytes(join(root, 'dist')),
      cases,
      interpretation: 'Measurements are local synthetic observations. No threshold or release budget is asserted; choose budgets only after comparing repeated runs on the intended release machine.',
    }, null, 2) + '\n');
  } finally {
    if (previousHome === undefined) delete process.env.FISCUS_HOME;
    else process.env.FISCUS_HOME = previousHome;
    if (previousDb === undefined) delete process.env.FISCUS_DB;
    else process.env.FISCUS_DB = previousDb;
    if (previousDemo === undefined) delete process.env.FISCUS_DEMO;
    else process.env.FISCUS_DEMO = previousDemo;
    rmSync(isolatedHome, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
