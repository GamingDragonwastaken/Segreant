/**
 * The analysis-snapshot path could not succeed for any input, and said so by
 * naming the wrong thing.
 *
 * MEASURED AGAINST THE COMMITTED TREE. `saveCausalAnalysis` refuses a
 * version-1 protocol as inspect-only, and then asks `causalStudyData` for the
 * study — which returns `null` for anything that is not version 1, by design.
 * So every input fails, and the version-2 input fails with:
 *
 *   Error: causal study was not found
 *
 * about a study the operator had just inspected, which exists, whose protocol
 * is registered, and which the summary surface will happily describe. The
 * message names an absence that is not the reason.
 *
 * AND THE ABSENCE IS THEN REPORTED AS A RESULT. `latestSnapshots` on the CLI
 * summary and `latestAnalysis` on every dashboard study row are therefore
 * always empty, and empty reads as "no analysis has been saved" when the
 * truth is "no analysis can be saved by this build". That is the defect class
 * this program has now found seven times: an absence of a result presented as
 * a result.
 *
 * WHAT IS NOT DONE HERE, DELIBERATELY. The capability is not removed. Immutable
 * analysis snapshots are useful and the table stays; what is unreachable is the
 * version-1 analysis path for a version-2 study, and that is a deferred
 * projection rather than an abandoned feature. Saying so precisely is the fix.
 *
 * Recorded at D-158.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { canonicalJson, commitCausalProtocol } from '../src/causal/protocol.ts';
import { Store } from '../src/store/db.ts';
import {
  CAUSAL_PROTOCOL_TYPE,
  CAUSAL_PROTOCOL_VERSION,
  CAUSAL_PROTOCOL_VERSION_V2,
  type CausalStudyProtocolDraft,
  type CausalStudyProtocolDraftV2,
} from '../src/causal/types.ts';

const H = (char: string): string => char.repeat(64);
const D = (char: string): string => 'sha256:' + H(char);

function v2Draft(): CausalStudyProtocolDraftV2 {
  return {
    type: CAUSAL_PROTOCOL_TYPE,
    version: CAUSAL_PROTOCOL_VERSION_V2,
    studyId: 'study:snapshot-v2',
    seriesId: 'series:snapshot',
    studyVersion: 1,
    ownerId: 'owner:snapshot',
    scopeId: 'scope:snapshot',
    createdAtMs: 1_700_000_000_000,
    question: 'model_cost_quality',
    eligibility: {
      cohortId: 'cohort:snapshot',
      contextSchemaId: 'schema:snapshot-v2',
      unitOfAssignment: 'task',
      inclusionRuleIds: ['rule:eligible'],
      exclusionRuleIds: [],
    },
    studyWindow: { startsAtMs: 1_700_000_001_000, endsAtMs: null },
    stoppingRule: { kind: 'fixed_enrollment', maxAssignments: 4 },
    arms: [
      { armId: 'arm:candidate', role: 'candidate', executionPlanDigest: D('a'), providerId: 'provider:alpha', modelId: 'model:new' },
      { armId: 'arm:control', role: 'control', executionPlanDigest: D('b'), providerId: 'provider:alpha', modelId: 'model:old' },
    ],
    allocation: { method: 'blocked_randomized_equal_allocation', probabilityPerArm: 0.5, blockSize: 4 },
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

function v1Draft(): CausalStudyProtocolDraft {
  return {
    type: CAUSAL_PROTOCOL_TYPE,
    version: CAUSAL_PROTOCOL_VERSION,
    studyId: 'study-snapshot',
    createdAtMs: 1_700_000_000_000,
    question: 'model_cost_quality',
    eligibility: { cohortId: 'cohort-snapshot', unitOfAssignment: 'task', contextSchemaId: 'task-v1' },
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

function withStore(action: (store: Store) => void): void {
  const temp = mkdtempSync(join(tmpdir(), 'fiscus-causal-snapshot-'));
  const store = new Store(join(temp, 'fiscus.db'));
  try {
    action(store);
  } finally {
    store.close();
    rmSync(temp, { recursive: true, force: true });
  }
}

test('a registered version-2 study is refused by name, not reported as missing', () => {
  // THE COUNTEREXAMPLE. The study exists, its protocol is registered, and every
  // summary surface will describe it — and the old message said it was not
  // found. A refusal has to name the reason it refuses or the operator debugs
  // the wrong thing.
  withStore((store) => {
    const v2 = commitCausalProtocol(v2Draft(), 1_700_000_000_500);
    assert.equal(store.registerCausalProtocol(v2), 'created');

    assert.throws(
      () => store.saveCausalAnalysis(v2.studyId, 'analysis:1', 1_700_000_000_900),
      (error: Error) => /CAUSAL_V2_ANALYSIS_DEFERRED/.test(error.message)
        && !/not found/i.test(error.message),
    );
  });
});

test('a retained version-1 study keeps refusing as inspect-only', () => {
  withStore((store) => {
    const v1 = commitCausalProtocol(v1Draft(), 1_700_000_000_100);
    store.raw().prepare(
      'INSERT INTO causal_protocols (study_id, protocol_hash, committed_at_ms, protocol_json) VALUES (?, ?, ?, ?)',
    ).run(v1.studyId, v1.protocolHash, v1.committedAtMs, canonicalJson(v1));

    assert.throws(
      () => store.saveCausalAnalysis(v1.studyId, 'analysis:1', 1_700_000_000_500),
      /CAUSAL_LEGACY_INSPECT_ONLY/,
    );
  });
});

test('a study that genuinely is not there still says so', () => {
  // The two answers must stay distinguishable, or fixing the message would just
  // move the misdescription to the other case.
  withStore((store) => {
    assert.throws(
      () => store.saveCausalAnalysis('study-absent', 'analysis:1', 1_700_000_000_500),
      (error: Error) => /not found/i.test(error.message) && !/CAUSAL_V2_ANALYSIS_DEFERRED/.test(error.message),
    );
  });
});

test('the empty snapshot list states why it is empty, and the three reasons differ', () => {
  // `latestSnapshots: []` reads as "no analysis has been saved". No analysis
  // CAN be saved by this build, and the difference is the whole point of the
  // provenance discipline this repository is built on. Three states reach an
  // empty list for three different reasons, and collapsing them into one
  // sentence would be the same defect at a lower resolution.
  withStore((store) => {
    const v2 = commitCausalProtocol(v2Draft(), 1_700_000_000_500);
    assert.equal(store.registerCausalProtocol(v2), 'created');
    const v1 = commitCausalProtocol(v1Draft(), 1_700_000_000_100);
    store.raw().prepare(
      'INSERT INTO causal_protocols (study_id, protocol_hash, committed_at_ms, protocol_json) VALUES (?, ?, ?, ?)',
    ).run(v1.studyId, v1.protocolHash, v1.committedAtMs, canonicalJson(v1));

    const absent = store.causalAnalysisSnapshotBasis('study-absent');
    const retained = store.causalAnalysisSnapshotBasis(v1.studyId);
    const deferred = store.causalAnalysisSnapshotBasis(v2.studyId);

    for (const basis of [absent, retained, deferred]) {
      assert.equal(basis.available, false, 'no study this build can hold accepts a new snapshot');
      assert.deepEqual(basis.records, []);
      assert.notEqual(basis.reason.trim(), '');
    }
    assert.match(absent.reason, /not registered/i);
    assert.match(retained.reason, /inspect-only/i);
    assert.match(deferred.reason, /deferred/i);
    assert.equal(new Set([absent.reason, retained.reason, deferred.reason]).size, 3);
  });
});

test('the CLI inspect surface carries the reason, not a bare empty list', () => {
  // The surface is the point. A basis the operator never sees would be the
  // mechanism-without-a-caller pattern this round has been working through.
  const temp = mkdtempSync(join(tmpdir(), 'fiscus-causal-snapshot-cli-'));
  const dbFile = join(temp, 'fiscus.db');
  try {
    const store = new Store(dbFile);
    let studyId: string;
    try {
      const v1 = commitCausalProtocol(v1Draft(), 1_700_000_000_100);
      store.raw().prepare(
        'INSERT INTO causal_protocols (study_id, protocol_hash, committed_at_ms, protocol_json) VALUES (?, ?, ?, ?)',
      ).run(v1.studyId, v1.protocolHash, v1.committedAtMs, canonicalJson(v1));
      studyId = v1.studyId;
    } finally {
      store.close();
    }

    const output = JSON.parse(execFileSync(
      process.execPath,
      ['--disable-warning=ExperimentalWarning', join(import.meta.dirname, '..', 'src', 'cli.ts'), 'causal', 'inspect', studyId, '--json'],
      { cwd: join(import.meta.dirname, '..'), env: { ...process.env, FISCUS_DB: dbFile, FISCUS_HOME: join(temp, 'home') }, encoding: 'utf8' },
    )) as { analysisSnapshots: { available: boolean; reason: string; latest: unknown[] } };

    assert.equal(output.analysisSnapshots.available, false);
    assert.deepEqual(output.analysisSnapshots.latest, []);
    assert.match(output.analysisSnapshots.reason, /inspect-only/i);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});
