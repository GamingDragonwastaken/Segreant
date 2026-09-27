import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { DASHBOARD_API_CONTRACTS } from '../src/dashboard/contracts.ts';

const ROOT = join(import.meta.dirname, '..');
const read = (rel: string): string => readFileSync(join(ROOT, rel), 'utf8');

function sourceFiles(): string[] {
  return readdirSync(join(ROOT, 'src'), { recursive: true, encoding: 'utf8' })
    .filter((entry) => entry.endsWith('.ts'));
}

test('complexity has no operational production surface before research prerequisites are met', () => {
  const files = sourceFiles();
  assert.ok(files.length > 0, 'the source inventory must be non-empty before it can establish absence');
  const sourceComplexityMatches = files.filter((entry) => /\bcomplexity\b/i.test(read(join('src', entry)))
    && entry.replaceAll('\\', '/').startsWith('research/complexity/') === false);
  assert.deepEqual(
    sourceComplexityMatches,
    [],
    'production src must not expose an uncalibrated complexity implementation or routing hook; research-only profile code is permitted',
  );
  const researchProfile = read('src/research/complexity/profile.ts');
  assert.match(researchProfile, /uncalibrated_research/);

  const cli = read('src/cli.ts');
  assert.ok(cli.length > 0, 'the CLI source must be present before its dispatch can establish absence');
  assert.equal(
    /\bcase\s+['"]lab['"]/.test(cli),
    false,
    'segreant lab must not be dispatched in production without satisfying the promotion gate',
  );
  assert.equal(
    /\bcase\s+['"]complexity['"]/.test(cli),
    false,
    'segreant complexity must not be dispatched as a top-level CLI command',
  );

  const dashboardRoutes = DASHBOARD_API_CONTRACTS.map((c) => c.path);
  assert.ok(dashboardRoutes.length > 0, 'the dashboard contract inventory must be non-empty before it can establish absence');
  assert.equal(
    dashboardRoutes.some((p) => p.includes('complexity')),
    false,
    'dashboard API must not expose an uncalibrated complexity endpoint',
  );

  const benchmark = read('scripts/benchmark.mjs');
  assert.ok(benchmark.length > 0, 'the benchmark source must be present before its operation inventory can establish absence');
  assert.doesNotMatch(benchmark, /\bcomplexity\b/i, 'the current benchmark must not claim to run a complexity operation');
});

test('frontier model comparison conditions on task type and unit size without scalar complexity collapse', () => {
  const frontier = read('src/value/frontier.ts');
  assert.match(
    frontier,
    /taskType/i,
    'frontier comparisons must explicitly condition on taskType',
  );
  assert.match(
    frontier,
    /candidateMedianUnitLines/,
    'frontier must report unit size (changed lines) as an observational dimension rather than a collapsed complexity scalar',
  );
});
