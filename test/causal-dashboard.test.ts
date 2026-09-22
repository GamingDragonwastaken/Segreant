/**
 * The dashboard gets a deliberately redacted, read-only causal inspector:
 * evidence state and allocation replay verdicts belong in the UI, whereas
 * randomisation material and raw event records do not.
 */

import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDashboardServer } from '../src/dashboard/server.ts';
import { canonicalJson, commitCausalProtocol } from '../src/causal/protocol.ts';
import {
  CAUSAL_PROTOCOL_TYPE,
  CAUSAL_PROTOCOL_VERSION,
  CAUSAL_PROTOCOL_VERSION_V2,
  type CausalStudyProtocolDraft,
  type CausalStudyProtocolDraftV2,
} from '../src/causal/types.ts';
import { DEFAULT_CONFIG } from '../src/config.ts';
import { Store } from '../src/store/db.ts';
import { createRetainedCausalV1AssignmentFixture } from './support/causalV1Fixture.ts';

const H = (char: string): string => char.repeat(64);
const D = (char: string): string => 'sha256:' + H(char);

function draft(): CausalStudyProtocolDraft {
  return {
    type: CAUSAL_PROTOCOL_TYPE,
    version: CAUSAL_PROTOCOL_VERSION,
    studyId: 'study-dashboard',
    createdAtMs: 1_700_000_000_000,
    question: 'model_cost_quality',
    eligibility: { cohortId: 'cohort-dashboard', unitOfAssignment: 'task', contextSchemaId: 'task-v1' },
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
    studyId: 'study:dashboard-v2',
    seriesId: 'series:dashboard-v2',
    studyVersion: 1,
    ownerId: 'owner:dashboard',
    scopeId: 'scope:dashboard',
    createdAtMs: 1_700_000_000_000,
    question: 'model_cost_quality',
    eligibility: {
      cohortId: 'cohort:dashboard', contextSchemaId: 'schema:dashboard',
      unitOfAssignment: 'task', inclusionRuleIds: ['rule:eligible'], exclusionRuleIds: [],
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

test('causal dashboard endpoint shows no-study boundary then redacted collecting state', async () => {
  const store = new Store(':memory:');
  const server = createDashboardServer({ store, config: structuredClone(DEFAULT_CONFIG), version: 'test' });
  try {
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as AddressInfo).port;
    const base = 'http://127.0.0.1:' + String(port);

    const empty = await fetch(base + '/api/causal');
    assert.equal(empty.status, 200);
    const emptyPayload = await empty.json() as { study: null; causalEvidence: string };
    assert.equal(emptyPayload.study, null);
    assert.equal(
      emptyPayload.causalEvidence,
      'No publicly inspectable retained version-1 causal study. Version-2 public projection is deferred. Value output remains an observed/manual-equivalent scenario.',
    );

    const v2 = commitCausalProtocol(v2Draft(), 1_700_000_000_500);
    assert.equal(store.registerCausalProtocol(v2), 'created');
    assert.deepEqual(store.causalStudySummaries(), [], 'legacy summaries must hide Store-only v2 protocols');
    const v2Default = await fetch(base + '/api/causal');
    const v2Explicit = await fetch(base + '/api/causal?study=' + encodeURIComponent(v2.studyId));
    assert.equal(v2Default.status, 200, 'v2-only Store state must not become the default legacy projection');
    const v2DefaultPayload = await v2Default.json() as { study: unknown; causalEvidence: string };
    assert.equal(v2DefaultPayload.study, null);
    assert.equal(
      v2DefaultPayload.causalEvidence,
      'No publicly inspectable retained version-1 causal study. Version-2 public projection is deferred. Value output remains an observed/manual-equivalent scenario.',
    );
    assert.equal(v2Explicit.status, 404, 'explicit v2 selection must remain bounded and hidden, never 500');
    assert.doesNotMatch(await v2Explicit.text(), /Error:|TypeError|protocol_json|causal summary exists/i);

    const protocol = commitCausalProtocol(draft(), 1_700_000_000_100);
    store.raw().prepare(
      'INSERT INTO causal_protocols (study_id, protocol_hash, committed_at_ms, protocol_json) VALUES (?, ?, ?, ?)',
    ).run(protocol.studyId, protocol.protocolHash, protocol.committedAtMs, canonicalJson(protocol));
    const plan = createRetainedCausalV1AssignmentFixture(protocol, {
      blockId: 'block-dashboard',
      createdAtMs: 1_700_000_000_200,
      unitIdHashes: [H('1'), H('2'), H('3'), H('4')],
      randomizationMaterial: Buffer.from('0123456789abcdef0123456789abcdef', 'hex'),
    });
    store.raw().prepare(
      'INSERT INTO causal_assignment_plans (study_id, block_id, protocol_hash, created_at_ms, allocation_hash, material_sha256, plan_json) VALUES (?, ?, ?, ?, ?, ?, ?)',
    ).run(plan.studyId, plan.blockId, plan.protocolHash, plan.createdAtMs, plan.allocationHash, plan.randomizationMaterialSha256, JSON.stringify(plan));
    const insertDecision = store.raw().prepare(
      'INSERT INTO causal_decisions (decision_id, study_id, protocol_hash, assigned_at_ms, event_hash, decision_json) VALUES (?, ?, ?, ?, ?, ?)',
    );
    for (const decision of plan.decisions) {
      insertDecision.run(
        decision.decisionId, decision.studyId, decision.protocolHash,
        decision.assignedAtMs, decision.eventHash, JSON.stringify(decision),
      );
    }
    const populated = await fetch(base + '/api/causal?study=study-dashboard');
    assert.equal(populated.status, 200);
    const raw = await populated.text();
    assert.doesNotMatch(raw, /randomizationMaterialHex/i, 'dashboard must not expose assignment material');
    const payload = JSON.parse(raw) as {
      study: {
        qualification: { state: string };
        assignmentReplay: Array<{ errors: string[] }>;
      };
      boundary: string;
    };
    assert.equal(payload.study.qualification.state, 'collecting');
    assert.deepEqual(payload.study.assignmentReplay.map((item) => item.errors), [[]]);
    assert.match(payload.boundary, /Read-only local status/i);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    store.close();
  }
});

test('causal API maps stored protocol corruption to one redacted 409 boundary', async () => {
  const v1 = commitCausalProtocol(draft(), 1_700_000_000_100);
  const v2 = commitCausalProtocol(v2Draft(), 1_700_000_000_500);
  const v1Extra = canonicalJson({ ...v1, rawPrompt: 'dashboard-credential-secret' });
  const fixtures = [
    { name: 'physical study', studyId: 'study-dashboard-cross-secret', hash: v1.protocolHash, at: v1.committedAtMs, raw: canonicalJson(v1) },
    { name: 'physical hash', studyId: v1.studyId, hash: H('f'), at: v1.committedAtMs, raw: canonicalJson(v1) },
    { name: 'physical time', studyId: v1.studyId, hash: v1.protocolHash, at: 1_700_000_099_996, raw: canonicalJson(v1) },
    { name: 'malformed JSON', studyId: v1.studyId, hash: v1.protocolHash, at: v1.committedAtMs, raw: '{"dashboard-secret":' },
    { name: 'v1 extra key', studyId: v1.studyId, hash: v1.protocolHash, at: v1.committedAtMs, raw: v1Extra },
    { name: 'noncanonical v2', studyId: v2.studyId, hash: v2.protocolHash, at: v2.committedAtMs, raw: JSON.stringify(v2) },
  ];

  for (const fixture of fixtures) {
    const store = new Store(':memory:');
    store.raw().prepare(
      'INSERT INTO causal_protocols (study_id, protocol_hash, committed_at_ms, protocol_json) VALUES (?, ?, ?, ?)',
    ).run(fixture.studyId, fixture.hash, fixture.at, fixture.raw);
    const server = createDashboardServer({ store, config: structuredClone(DEFAULT_CONFIG), version: 'test' });
    try {
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      const port = (server.address() as AddressInfo).port;
      for (const suffix of ['', '?study=' + encodeURIComponent(fixture.studyId)]) {
        const response = await fetch('http://127.0.0.1:' + String(port) + '/api/causal' + suffix);
        const raw = await response.text();
        assert.equal(response.status, 409, fixture.name + ' must map to Conflict rather than absence or HTTP 500');
        assert.deepEqual(JSON.parse(raw), {
          error: 'CAUSAL_INTEGRITY_FAILURE',
          causalEvidence: 'Stored causal evidence failed integrity verification. Public causal projection is unavailable until the local Store is repaired.',
        });
        assert.doesNotMatch(raw, /Error:|TypeError|protocol_json|sqlite|syntax|dashboard-secret|dashboard-credential-secret|study-dashboard-cross-secret|f{32,}/i);
      }
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      store.close();
    }
  }
});

test('causal API maps latest-analysis timestamp corruption to one redacted 409 boundary', async () => {
  const protocol = commitCausalProtocol(draft(), 1_700_000_000_100);
  const store = new Store(':memory:');
  store.raw().prepare(
    'INSERT INTO causal_protocols (study_id, protocol_hash, committed_at_ms, protocol_json) VALUES (?, ?, ?, ?)',
  ).run(protocol.studyId, protocol.protocolHash, protocol.committedAtMs, canonicalJson(protocol));
  store.raw().prepare(
    'INSERT INTO causal_analysis_snapshots (analysis_id, study_id, protocol_hash, computed_at_ms, state, analysis_json) VALUES (?, ?, ?, 9223372036854775807, ?, ?)',
  ).run('analysis:latest', protocol.studyId, protocol.protocolHash, 'qualified', JSON.stringify({ secret: 'dashboard-analysis-secret' }));
  const server = createDashboardServer({ store, config: structuredClone(DEFAULT_CONFIG), version: 'test' });
  try {
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as AddressInfo).port;
    for (const suffix of ['', '?study=' + encodeURIComponent(protocol.studyId)]) {
      const response = await fetch('http://127.0.0.1:' + String(port) + '/api/causal' + suffix);
      const raw = await response.text();
      assert.equal(response.status, 409);
      assert.deepEqual(JSON.parse(raw), {
        error: 'CAUSAL_INTEGRITY_FAILURE',
        causalEvidence: 'Stored causal evidence failed integrity verification. Public causal projection is unavailable until the local Store is repaired.',
      });
      assert.doesNotMatch(raw, /Error:|TypeError|RangeError|ERR_OUT_OF_RANGE|analysis:latest|dashboard-analysis-secret|protocol_json|sqlite|f{32,}/i);
    }
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    store.close();
  }
});
