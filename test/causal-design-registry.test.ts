import { test } from 'node:test';
import assert from 'node:assert/strict';
import { estimateCausalStudy } from '../src/causal/estimate.ts';
import { buildCausalStudyKernelIssuance } from '../src/causal/epistemic.ts';
import type { CausalStudyEstimate } from '../src/causal/types.ts';
import { DESIGN_ESTIMATOR_REGISTRY, getDesignEstimatorDefinition, resolveCausalDesignEstimator } from '../src/causal/registry.ts';
import { Store } from '../src/store/db.ts';
import { canonicalJson } from '../src/causal/protocol.ts';
import { completedData } from './support/causalStudyFixture.ts';

test('the estimator reports one versioned design/estimator identity without changing protocol bytes', () => {
  const data = completedData();
  const before = JSON.stringify(data);
  const estimate = estimateCausalStudy(data);
  assert.equal(estimate.designEstimatorId, 'blocked_equal_itt_hoeffding_v1');
  assert.equal(JSON.stringify(data), before);
});

test('kernel issuance refuses an estimate with a missing or foreign design/estimator identity', () => {
  const data = completedData();
  for (const designEstimatorId of [undefined, null, 'paired_return_v1', 'unknown']) {
    const estimate = { ...estimateCausalStudy(data), designEstimatorId };
    assert.throws(
      () => buildCausalStudyKernelIssuance(data, estimate as CausalStudyEstimate, 1_700_100_000_000),
      /design\/estimator/,
    );
  }
});

test('registry is immutable and keeps deferred, archived, and noncausal lanes out of causal issuance', () => {
  assert.ok(Object.isFrozen(DESIGN_ESTIMATOR_REGISTRY));
  assert.equal(new Set(DESIGN_ESTIMATOR_REGISTRY.map((entry) => entry.id)).size, 4);
  for (const entry of DESIGN_ESTIMATOR_REGISTRY) {
    assert.ok(Object.isFrozen(entry));
    if (entry.status !== 'retained_analysis') assert.equal(entry.estimandId, null);
  }
  assert.equal(getDesignEstimatorDefinition('paired_return_v1')?.status, 'archived');
  assert.equal(getDesignEstimatorDefinition('unknown'), undefined);
  const data = completedData();
  data.protocol = { ...data.protocol, protocolHash: '0'.repeat(64) };
  assert.equal(resolveCausalDesignEstimator(data.protocol), undefined);
  assert.equal(estimateCausalStudy(data).designEstimatorId, null);
});

test('legacy stored snapshots gain only an unknown method projection and retain exact bytes', () => {
  const store = new Store(':memory:');
  try {
    const data = completedData();
    const legacy = { ...estimateCausalStudy(data) } as Partial<CausalStudyEstimate>;
    delete legacy.designEstimatorId;
    const snapshot = { analysisId: 'analysis:old', computedAtMs: 1_700_100_000_000, estimate: legacy };
    const bytes = canonicalJson(snapshot);
    store.raw().prepare('INSERT INTO causal_protocols (study_id, protocol_hash, committed_at_ms, protocol_json) VALUES (?, ?, ?, ?)')
      .run(data.protocol.studyId, data.protocol.protocolHash, data.protocol.committedAtMs, canonicalJson(data.protocol));
    store.raw().prepare('INSERT INTO causal_analysis_snapshots (analysis_id, study_id, protocol_hash, computed_at_ms, state, analysis_json) VALUES (?, ?, ?, ?, ?, ?)')
      .run(snapshot.analysisId, data.protocol.studyId, data.protocol.protocolHash, snapshot.computedAtMs, 'qualified', bytes);
    for (let replay = 0; replay < 2; replay += 1) {
      const read = store.causalAnalysisSnapshots(data.protocol.studyId)[0]!;
      assert.equal(read.estimate.designEstimatorId, null);
      assert.throws(() => buildCausalStudyKernelIssuance(data, read.estimate, snapshot.computedAtMs), /design\/estimator/);
      assert.equal((store.raw().prepare('SELECT analysis_json FROM causal_analysis_snapshots').get() as { analysis_json: string }).analysis_json, bytes);
    }
  } finally {
    store.close();
  }
});
