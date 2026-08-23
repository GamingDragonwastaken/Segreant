/**
 * The operator surface starts local, explicit, and review-first. These checks
 * exercise the packaged CLI rather than treating a Store method as proof that
 * the user-facing causal lifecycle is wired.
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CAUSAL_PROTOCOL_TYPE, CAUSAL_PROTOCOL_VERSION, type CausalStudyProtocolDraft } from '../src/causal/types.ts';

const H = (char: string): string => char.repeat(64);
const ROOT = join(import.meta.dirname, '..');
// Direct source execution keeps this focused test independent of a stale dist
// folder. The full npm test runs the production build before all test files.
const BIN = join(ROOT, 'src', 'cli.ts');

function draft(): CausalStudyProtocolDraft {
  return {
    type: CAUSAL_PROTOCOL_TYPE,
    version: CAUSAL_PROTOCOL_VERSION,
    studyId: 'study-cli',
    createdAtMs: 1_700_000_000_000,
    question: 'model_cost_quality',
    eligibility: { cohortId: 'cohort-cli', unitOfAssignment: 'task', contextSchemaId: 'task-v1' },
    arms: [
      { armId: 'candidate', role: 'candidate', executionPlanHash: H('a'), providerId: 'provider-a', modelId: 'model-new' },
      { armId: 'control', role: 'control', executionPlanHash: H('b'), providerId: 'provider-a', modelId: 'model-old' },
    ],
    allocation: { method: 'blocked_randomized_equal_allocation', probabilityPerArm: 0.5, blockSize: 4 },
    costOutcome: { metricId: 'direct_cost_usd', boundsUsd: { low: 0, high: 100 }, acceptedSourceClasses: ['actual_observed'] },
    qualityOutcome: { metricId: 'verified_quality', bounds: { low: 0, high: 1 }, evidenceClass: 'deterministic', nonInferiorityMargin: 0.05 },
    economicOutcome: null,
    analysis: { estimand: 'intention_to_treat', confidenceLevel: 0.95, minCompletedPerArm: 2, maxMissingFractionPerArm: 0.25 },
  };
}

function options(temp: string): { cwd: string; env: NodeJS.ProcessEnv; encoding: 'utf8' } {
  return {
    cwd: ROOT,
    env: {
      ...process.env,
      FISCUS_DB: join(temp, 'causal-cli.db'),
      FISCUS_HOME: join(temp, 'home'),
    },
    encoding: 'utf8',
  };
}

function argsFor(args: string[]): string[] {
  return ['--disable-warning=ExperimentalWarning', BIN, 'causal', ...args];
}

function run(temp: string, args: string[]): Record<string, unknown> {
  const output = execFileSync(process.execPath, argsFor(args), options(temp));
  return JSON.parse(output) as Record<string, unknown>;
}

test('causal CLI requires explicit local apply, records/replays an assignment, and reports collecting', () => {
  const temp = mkdtempSync(join(tmpdir(), 'fiscus-causal-cli-'));
  try {
    const protocolFile = join(temp, 'protocol.json');
    const unitsFile = join(temp, 'units.txt');
    writeFileSync(protocolFile, JSON.stringify(draft()), 'utf8');
    writeFileSync(unitsFile, [H('1'), H('2'), H('3'), H('4')].join('\n'), 'utf8');

    const initial = run(temp, ['status', '--json']);
    assert.equal(initial.causalEvidence, 'No registered causal study. Current Fiscus value output remains an observed/manual-equivalent scenario.');

    const preview = run(temp, ['register', '--file', protocolFile, '--json']);
    assert.equal(preview.operation, 'register_preview');
    assert.equal((run(temp, ['status', '--json']).studies as unknown[]).length, 0, 'preview cannot mutate the ledger');

    const registered = run(temp, ['register', '--file', protocolFile, '--apply', '--json']);
    assert.equal(registered.operation, 'registered');
    assert.equal(registered.boundary, 'Protocol registration does not collect traffic or alter routing.');

    const assigned = run(temp, [
      'assign', '--study', 'study-cli', '--block', 'block-cli', '--units-file', unitsFile, '--apply', '--json',
    ]);
    assert.equal(assigned.operation, 'assigned');
    assert.equal(assigned.decisions, 4);

    const verified = run(temp, ['verify', 'study-cli', '--json']);
    const replay = verified.assignmentReplay as Array<{ errors: string[] }>;
    assert.deepEqual(replay.map((item) => item.errors), [[]]);
    assert.equal((verified.qualification as { state: string }).state, 'collecting');

    const analysis = run(temp, ['analyze', '--study', 'study-cli', '--json']);
    assert.equal(analysis.operation, 'analysis_preview');
    assert.equal(((analysis.estimate as { qualification: { state: string } }).qualification).state, 'collecting');
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

test('causal CLI refuses an undeclared raw protocol field instead of silently dropping it', () => {
  const temp = mkdtempSync(join(tmpdir(), 'fiscus-causal-cli-invalid-'));
  try {
    const protocolFile = join(temp, 'protocol.json');
    writeFileSync(protocolFile, JSON.stringify({ ...draft(), prompt: 'do not store this raw prompt' }), 'utf8');
    const failed = spawnSync(process.execPath, argsFor(['register', '--file', protocolFile, '--apply', '--json']), options(temp));
    assert.equal(failed.status, 1);
    assert.match(failed.stderr, /unsupported field: prompt/i);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});
