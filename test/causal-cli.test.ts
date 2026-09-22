/**
 * The operator surface starts local, explicit, and review-first. These checks
 * exercise the packaged CLI rather than treating a Store method as proof that
 * the user-facing causal lifecycle is wired.
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CAUSAL_PROTOCOL_TYPE,
  CAUSAL_PROTOCOL_VERSION,
  CAUSAL_PROTOCOL_VERSION_V2,
  type CausalStudyProtocolDraft,
  type CausalStudyProtocolDraftV2,
} from '../src/causal/types.ts';
import { canonicalJson, commitCausalProtocol } from '../src/causal/protocol.ts';
import { Store } from '../src/store/db.ts';

const H = (char: string): string => char.repeat(64);
const D = (char: string): string => 'sha256:' + H(char);
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

function v2Draft(): CausalStudyProtocolDraftV2 {
  return {
    type: CAUSAL_PROTOCOL_TYPE,
    version: CAUSAL_PROTOCOL_VERSION_V2,
    studyId: 'study:cli-v2',
    seriesId: 'series:cli-v2',
    studyVersion: 1,
    ownerId: 'owner:cli',
    scopeId: 'scope:cli',
    createdAtMs: 1_700_000_000_000,
    question: 'model_cost_quality',
    eligibility: {
      cohortId: 'cohort:cli',
      contextSchemaId: 'schema:cli-v2',
      unitOfAssignment: 'task',
      inclusionRuleIds: ['rule:eligible'],
      exclusionRuleIds: [],
    },
    studyWindow: { startsAtMs: 1_700_000_001_000, endsAtMs: null },
    stoppingRule: { kind: 'fixed_enrollment', maxAssignments: 4 },
    arms: [
      {
        armId: 'arm:candidate', role: 'candidate', executionPlanDigest: D('a'),
        providerId: 'provider:alpha', modelId: 'model:new',
      },
      {
        armId: 'arm:control', role: 'control', executionPlanDigest: D('b'),
        providerId: 'provider:alpha', modelId: 'model:old',
      },
    ],
    allocation: {
      method: 'blocked_randomized_equal_allocation', probabilityPerArm: 0.5, blockSize: 4,
    },
    costOutcome: {
      metricId: 'metric:direct-cost', currency: 'USD', boundsUsd: { low: 0, high: 100 },
      acceptedSourceClasses: ['actual_observed'],
      priceLineageRule: 'every_included_cost_has_retained_sha256_lineage',
    },
    qualityOutcome: {
      metricId: 'metric:quality', collectionMethodId: 'collector:deterministic',
      bounds: { low: 0, high: 1 }, evidenceClass: 'deterministic', nonInferiorityMargin: 0.05,
    },
    economicOutcome: null,
    analysis: {
      estimand: 'intention_to_treat', confidenceLevel: 0.95, minCompletedPerArm: 2,
      maxMissingFractionPerArm: 0.25, exclusionPolicyId: 'policy:none',
    },
    dataGovernance: {
      minimizedSourceIds: ['source:usage-metadata'], retentionClassId: 'retention:local',
      egressReceiptDigests: [],
    },
    claimTemplateIds: {
      qualified: 'claim:qualified-v2', inconclusive: 'claim:inconclusive-v2', invalid: 'claim:invalid-v2',
    },
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

function databaseFile(temp: string): string {
  return join(temp, 'causal-cli.db');
}

function argsFor(args: string[]): string[] {
  return ['--disable-warning=ExperimentalWarning', BIN, 'causal', ...args];
}

function run(temp: string, args: string[]): Record<string, unknown> {
  const output = execFileSync(process.execPath, argsFor(args), options(temp));
  return JSON.parse(output) as Record<string, unknown>;
}

test('causal CLI defers valid v2 registration preview and apply without mutation or disclosure', () => {
  const temp = mkdtempSync(join(tmpdir(), 'fiscus-causal-cli-'));
  try {
    const protocolFile = join(temp, 'protocol.json');
    writeFileSync(protocolFile, JSON.stringify(v2Draft()), 'utf8');
    const attempts = [false, true].map((apply) => spawnSync(
      process.execPath,
      argsFor([
        'register', '--file', protocolFile, '--at', '1700000000500',
        ...(apply ? ['--apply'] : []), '--json',
      ]),
      options(temp),
    ));
    for (const [index, attempt] of attempts.entries()) {
      assert.equal(attempt.status, 1, index === 0 ? 'v2 preview must defer' : 'v2 apply must defer');
      assert.match(attempt.stderr, /CAUSAL_V2_CLI_DEFERRED/i);
      assert.doesNotMatch(attempt.stdout, /register_preview|registered|protocolHash|study:cli-v2/i);
    }
    assert.equal(existsSync(databaseFile(temp)), false, 'deferred registration must refuse before opening or mutating the Store');
    const verify = new Store(databaseFile(temp));
    try {
      const count = verify.raw().prepare('SELECT COUNT(*) AS count FROM causal_protocols').get() as { count: number };
      assert.equal(count.count, 0, 'deferred v2 registration cannot mutate the Store');
    } finally {
      verify.close();
    }
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

test('causal CLI refuses retained v1 registration preview and apply as inspect-only', () => {
  const temp = mkdtempSync(join(tmpdir(), 'fiscus-causal-cli-v1-register-'));
  try {
    const protocolFile = join(temp, 'protocol.json');
    writeFileSync(protocolFile, JSON.stringify(draft()), 'utf8');
    const attempts = [false, true].map((apply) => spawnSync(
      process.execPath,
      argsFor(['register', '--file', protocolFile, ...(apply ? ['--apply'] : []), '--json']),
      options(temp),
    ));
    for (const attempt of attempts) {
      assert.equal(attempt.status, 1);
      assert.match(attempt.stderr, /CAUSAL_LEGACY_INSPECT_ONLY|inspect-only/i);
      assert.doesNotMatch(attempt.stdout, /register_preview|registered|protocolHash/i);
    }
    assert.equal((run(temp, ['status', '--json']).studies as unknown[]).length, 0);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

test('causal CLI hides Store-only v2 state from legacy status and refuses reads before units access', () => {
  const temp = mkdtempSync(join(tmpdir(), 'fiscus-causal-cli-v2-hidden-'));
  try {
    const protocol = commitCausalProtocol(v2Draft(), 1_700_000_000_500);
    const store = new Store(databaseFile(temp));
    try {
      assert.equal(store.registerCausalProtocol(protocol), 'created');
    } finally {
      store.close();
    }

    const status = run(temp, ['status', '--json']);
    const inspect = spawnSync(process.execPath, argsFor(['inspect', protocol.studyId, '--json']), options(temp));
    const verify = spawnSync(process.execPath, argsFor(['verify', protocol.studyId, '--json']), options(temp));
    const missingUnits = join(temp, 'must-not-be-read-units.txt');
    const assign = spawnSync(process.execPath, argsFor([
      'assign', '--study', protocol.studyId, '--block', 'block:deferred',
      '--units-file', missingUnits, '--json',
    ]), options(temp));

    assert.deepEqual(status.studies, []);
    assert.match(String(status.causalEvidence), /no publicly inspectable|v2.*deferred/i);
    for (const result of [inspect, verify, assign]) {
      assert.equal(result.status, 1);
      assert.match(result.stderr, /deferred|not found/i);
      assert.doesNotMatch(result.stderr, /version-1|\bv1\b|CAUSAL_LEGACY_INSPECT_ONLY/i);
    }
    assert.doesNotMatch(assign.stderr, /must-not-be-read-units|ENOENT/i);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

test('causal CLI surfaces stored protocol integrity failures as typed redacted errors', () => {
  const v1 = commitCausalProtocol(draft(), 1_700_000_000_100);
  const v2 = commitCausalProtocol(v2Draft(), 1_700_000_000_500);
  const cases = [
    {
      name: 'physical study divergence', studyId: 'study-cli-cross-secret',
      hash: v1.protocolHash, at: v1.committedAtMs, raw: canonicalJson(v1),
      secrets: ['study-cli-cross-secret', v1.studyId],
    },
    {
      name: 'physical hash divergence', studyId: v1.studyId,
      hash: H('f'), at: v1.committedAtMs, raw: canonicalJson(v1),
      secrets: [H('f'), v1.protocolHash],
    },
    {
      name: 'physical time divergence', studyId: v1.studyId,
      hash: v1.protocolHash, at: 1_700_000_099_997, raw: canonicalJson(v1),
      secrets: ['1700000099997'],
    },
    {
      name: 'malformed JSON', studyId: v1.studyId,
      hash: v1.protocolHash, at: v1.committedAtMs, raw: '{"credential-secret":',
      secrets: ['credential-secret'],
    },
    {
      name: 'noncanonical v2', studyId: v2.studyId,
      hash: v2.protocolHash, at: v2.committedAtMs, raw: JSON.stringify(v2),
      secrets: [v2.studyId, v2.protocolHash],
    },
  ];

  for (const fixture of cases) {
    const temp = mkdtempSync(join(tmpdir(), 'fiscus-causal-cli-integrity-'));
    try {
      const store = new Store(databaseFile(temp));
      try {
        store.raw().prepare(
          'INSERT INTO causal_protocols (study_id, protocol_hash, committed_at_ms, protocol_json) VALUES (?, ?, ?, ?)',
        ).run(fixture.studyId, fixture.hash, fixture.at, fixture.raw);
      } finally {
        store.close();
      }
      const status = spawnSync(process.execPath, argsFor(['status', '--json']), options(temp));
      const inspect = spawnSync(process.execPath, argsFor(['inspect', fixture.studyId, '--json']), options(temp));
      for (const result of [status, inspect]) {
        assert.equal(result.status, 1, fixture.name + ' must fail closed');
        assert.match(result.stderr, /CAUSAL_INTEGRITY_FAILURE: stored causal protocol failed integrity verification/);
        assert.doesNotMatch(result.stderr, /protocol_json|sqlite|syntax|unexpected|rawPrompt|study-cli-cross-secret|f{32,}/i);
        for (const secret of fixture.secrets) assert.equal(result.stderr.includes(secret), false);
        assert.equal(result.stdout.trim(), '', 'integrity failure must not emit a partial public projection');
      }
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  }
});

test('causal CLI redacts latest-analysis timestamp materialization failures', () => {
  const temp = mkdtempSync(join(tmpdir(), 'fiscus-causal-cli-analysis-integrity-'));
  try {
    const protocol = commitCausalProtocol(draft(), 1_700_000_000_100);
    const store = new Store(databaseFile(temp));
    try {
      store.raw().prepare(
        'INSERT INTO causal_protocols (study_id, protocol_hash, committed_at_ms, protocol_json) VALUES (?, ?, ?, ?)',
      ).run(protocol.studyId, protocol.protocolHash, protocol.committedAtMs, canonicalJson(protocol));
      store.raw().prepare(
        'INSERT INTO causal_analysis_snapshots (analysis_id, study_id, protocol_hash, computed_at_ms, state, analysis_json) VALUES (?, ?, ?, 9223372036854775807, ?, ?)',
      ).run('analysis:latest', protocol.studyId, protocol.protocolHash, 'qualified', JSON.stringify({ secret: 'cli-analysis-secret' }));
    } finally {
      store.close();
    }

    const status = spawnSync(process.execPath, argsFor(['status', '--json']), options(temp));
    assert.equal(status.status, 1);
    assert.match(status.stderr, /CAUSAL_INTEGRITY_FAILURE: stored causal protocol failed integrity verification/);
    assert.doesNotMatch(status.stderr, /ERR_OUT_OF_RANGE|analysis:latest|cli-analysis-secret|protocol_json|sqlite|syntax|f{32,}/i);
    assert.equal(status.stdout.trim(), '', 'latest-analysis integrity failure must not emit a partial status projection');
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

test('causal CLI refuses v1 assignment preview and apply before allocating or disclosing an arm', () => {
  const temp = mkdtempSync(join(tmpdir(), 'fiscus-causal-cli-v1-assign-'));
  try {
    const protocol = commitCausalProtocol(draft(), 1_700_000_000_100);
    const store = new Store(databaseFile(temp));
    try {
      store.raw().prepare(
        'INSERT INTO causal_protocols (study_id, protocol_hash, committed_at_ms, protocol_json) VALUES (?, ?, ?, ?)',
      ).run(protocol.studyId, protocol.protocolHash, protocol.committedAtMs, canonicalJson(protocol));
    } finally {
      store.close();
    }
    const unitsFile = join(temp, 'units.txt');
    writeFileSync(unitsFile, [H('1'), H('2'), H('3'), H('4')].join('\n') + '\n', 'utf8');

    for (const apply of [false, true]) {
      const args = [
        'assign', '--study', protocol.studyId, '--block', 'block-cli-v1',
        '--units-file', unitsFile, '--json',
      ];
      if (apply) args.push('--apply');
      const refused = spawnSync(process.execPath, argsFor(args), options(temp));
      assert.equal(refused.status, 1, apply ? 'v1 apply must refuse' : 'v1 preview must refuse');
      assert.match(refused.stderr, /CAUSAL_LEGACY_INSPECT_ONLY|inspect-only/i);
      assert.doesNotMatch(refused.stdout, /assignedArmId|allocationHash|randomizationMaterial|arm:(?:candidate|control)/i);
    }

    const verify = new Store(databaseFile(temp));
    try {
      const counts = verify.raw().prepare(
        'SELECT (SELECT COUNT(*) FROM causal_assignment_plans) AS plans, ' +
        '(SELECT COUNT(*) FROM causal_decisions) AS decisions',
      ).get() as { plans: number; decisions: number };
      assert.equal(counts.plans, 0);
      assert.equal(counts.decisions, 0);
    } finally {
      verify.close();
    }
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});
