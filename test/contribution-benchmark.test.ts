import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { CONTRIBUTION_CORPUS } from './fixtures/contribution-corpus.ts';
import {
  corpusDigest,
  defaultContributionEvaluator,
  frozenCorpus,
  runContributionBenchmark,
} from './support/contribution-benchmark.ts';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = resolve(ROOT, 'scripts', 'contribution-benchmark.mjs');

test('WP-D04 evaluates a non-empty synthetic contribution corpus', () => {
  const report = runContributionBenchmark();

  assert.ok(CONTRIBUTION_CORPUS.length > 0);
  assert.equal(report.total, CONTRIBUTION_CORPUS.length);
  assert.equal(report.failed, 0);
});

test('WP-D04 report checks every corpus case and preserves association-only boundaries', () => {
  const report = runContributionBenchmark();

  assert.equal(report.version, 'wp-d04-benchmark/1');
  assert.equal(report.corpusVersion, 'wp-d04-corpus/1');
  assert.match(report.corpusDigest, /^[0-9a-f]{64}$/);
  assert.equal(report.total, 42);
  assert.equal(report.passed, 42);
  assert.equal(report.failed, 0);
  assert.equal(report.rows.length, report.total);

  for (const row of report.rows) {
    assert.equal(row.passed, true, `${row.id}: ${row.issues.join(', ')}`);
    assert.deepEqual(row.actual, row.expected);
    assert.ok(row.evidence.limitations.length > 0);
    for (const nonClaim of ['ai_authorship', 'outcome_success', 'code_quality', 'realized_value']) {
      assert.ok(row.evidence.nonClaims.includes(nonClaim as never), `${row.id}: missing ${nonClaim}`);
    }
    for (const forbidden of ['quality', 'value', 'success', 'realized', 'aiYield', 'survivalRatio']) {
      assert.equal(forbidden in row.evidence, false, `${row.id}: leaked ${forbidden}`);
    }
  }

  for (const category of ['exact', 'structural', 'temporal', 'unresolved', 'confounder', 'boundary', 'evidence-removal']) {
    assert.ok((report.categoryCounts[category] ?? 0) > 0, `missing category ${category}`);
  }
  assert.equal(report.nonClaimsHonored.ai_authorship, true);
  assert.equal(report.nonClaimsHonored.outcome_success, true);
  assert.equal(report.nonClaimsHonored.code_quality, true);
  assert.equal(report.nonClaimsHonored.realized_value, true);

  const boilerplate = report.rows.find((row) => row.id === 'c014-boilerplate-confounder');
  assert.ok(boilerplate);
  assert.equal(boilerplate.actual.status, 'unresolved');
  assert.equal(boilerplate.baselineSimpleDiffOverlap, 1, 'baseline must expose the confounder trap');
});

test('WP-D04 output is deterministic and deeply immutable', () => {
  const first = runContributionBenchmark();
  const second = runContributionBenchmark();

  assert.deepEqual(first, second);
  assert.equal(Object.isFrozen(first), true);
  assert.equal(Object.isFrozen(first.rows), true);
  assert.equal(Object.isFrozen(first.rows[0]), true);
  assert.equal(first.corpusDigest, corpusDigest(CONTRIBUTION_CORPUS));

  const frozen = frozenCorpus(CONTRIBUTION_CORPUS.slice(0, 1));
  assert.equal(Object.isFrozen(frozen), true);
  assert.equal(Object.isFrozen(frozen[0]), true);
  assert.equal(Object.isFrozen(frozen[0]!.categories), true);
  assert.equal(Reflect.set(frozen[0]!, 'id', 'mutated'), false);
  assert.equal(frozen[0]!.id, CONTRIBUTION_CORPUS[0]!.id);
});

test('WP-D04 detects a deliberately wrong evaluator instead of trusting baselines', () => {
  const report = runContributionBenchmark({
    evaluate: (input) => ({
      ...defaultContributionEvaluator(input),
      status: 'exact',
      method: 'exact_patch_identity',
    }),
  });

  assert.ok(report.failed > 0);
  assert.ok(report.rows.some((row) => row.issues.includes('status')));
  assert.ok(report.rows.some((row) => row.issues.includes('method')));
});

test('WP-D04 rejects empty, duplicate, and non-synthetic corpus entries', () => {
  const first = CONTRIBUTION_CORPUS[0]!;
  assert.throws(() => runContributionBenchmark({ cases: [] }), /Empty contribution corpus/);
  assert.throws(() => runContributionBenchmark({ cases: [first, first] }), /Missing or duplicate case identity/);
  assert.throws(
    () => runContributionBenchmark({ cases: [{ ...first, provenance: 'field' as never }] }),
    /Missing synthetic provenance or oracle rationale/,
  );
  assert.throws(
    () => runContributionBenchmark({ cases: [{ ...first, rationale: '' }] }),
    /Missing synthetic provenance or oracle rationale/,
  );
});

test('WP-D04 evaluator input is isolated from the corpus fixture', () => {
  const before = corpusDigest(CONTRIBUTION_CORPUS);
  runContributionBenchmark({
    cases: CONTRIBUTION_CORPUS.slice(0, 1),
    evaluate: (input) => {
      if ('source' in input) {
        (input.source as { id: string }).id = 'mutated-evaluator-input';
      }
      return defaultContributionEvaluator(input);
    },
  });
  assert.equal(corpusDigest(CONTRIBUTION_CORPUS), before);
});

test('WP-D04 command emits a machine-readable all-pass report', () => {
  const result = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', SCRIPT], {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 1024 * 1024,
  });
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout) as { total: number; passed: number; failed: number; corpusDigest: string };
  assert.equal(report.total, 42);
  assert.equal(report.passed, 42);
  assert.equal(report.failed, 0);
  assert.match(report.corpusDigest, /^[0-9a-f]{64}$/);
});
