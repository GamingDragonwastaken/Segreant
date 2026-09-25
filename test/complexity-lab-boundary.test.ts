import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
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

test('WP-J03 status in PACKET-INVENTORY.md records the research-only boundary and explicit prerequisites', () => {
  const inventory = read('docs/program/PACKET-INVENTORY.md');
  const match = /\|\s*`WP-J03`\s*\|\s*Complexity Lab\s*\|\s*`([^`]+)`\s*\|\s*([^|]+)\|/.exec(inventory);
  assert.ok(match, 'WP-J03 row must exist in PACKET-INVENTORY.md');
  const status = match[1]!;
  const notes = match[2]!;
  assert.equal(status, 'COMPLETED', 'WP-J03 closes its research-only admission boundary without promoting an estimator');
  assert.match(
    notes,
    /docs\/program\/WP-J03-COMPLEXITY-LAB-REPORT\.md/,
    'WP-J03 notes must reference the comprehensive design and precondition report',
  );
  assert.match(
    notes,
    /TOKEN-GOVERNANCE-AND-COMPLEXITY-LAB\.md/,
    'WP-J03 notes must cite the controlling promotion rules in TOKEN-GOVERNANCE-AND-COMPLEXITY-LAB.md',
  );
  assert.match(notes, /research-only|promotion rules/i, 'WP-J03 notes must state the research-only boundary and prerequisites');
  assert.match(notes, /promotion rules/i, 'WP-J03 notes must state the explicit research prerequisites');
});

test('WP-J03 design and precondition report exists and covers all 10 research promotion rules', () => {
  const reportPath = join(ROOT, 'docs', 'program', 'WP-J03-COMPLEXITY-LAB-REPORT.md');
  assert.ok(existsSync(reportPath), 'WP-J03 report must exist on disk');
  const report = readFileSync(reportPath, 'utf8');
  assert.match(report, /Complexity Lab/);
  assert.match(report, /Structural complexity/);
  assert.match(report, /Execution complexity/);
  assert.match(report, /Promotion Rules/);
  assert.match(report, /\*\*Status:\*\*\s*`COMPLETED`[^\n]*(?:research|read-only)/i);
  assert.doesNotMatch(report, /\bBLOCKED\b/, 'the report must use the packet vocabulary and not invent BLOCKED');
  assert.match(report, /promotion gates? remain|promotion rules.*unfulfilled|not.*production/i, 'completion must not be confused with production promotion');
  for (let rule = 1; rule <= 10; rule++) {
    assert.match(report, new RegExp(`Rule\\s+${rule}\\b`, 'i'), `Report must address promotion Rule ${rule}`);
  }
});
