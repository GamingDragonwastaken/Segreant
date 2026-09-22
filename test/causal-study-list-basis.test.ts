/**
 * The dashboard's study list drops studies without saying so, and every row's
 * `latestAnalysis: null` means something it does not say.
 *
 * TWO SILENCES ON ONE PAYLOAD, both the class D-158 closed on the CLI.
 *
 * FIRST. `causalStudySummaries()` filters version-2 protocols out of its result
 * (`if (decoded.version === 2) return []`). That omission is deliberate --
 * version-2 public projection is deferred and the endpoint must not invent one
 * -- and it is invisible. With ONLY version-2 studies registered, the response
 * says so in as many words: "No publicly inspectable retained version-1 causal
 * study. Version-2 public projection is deferred." With one version-1 study
 * beside them, that sentence is replaced by "Local randomized-study evidence
 * only", `studies` has one row, and the registered version-2 studies are
 * reported nowhere at all. The reader is shown a list of one and given no way
 * to tell it from a store that holds exactly one study.
 *
 * SECOND. Every row carries `latestAnalysis: { ... } | null`, and for every row
 * this build can produce that field is null -- the list holds only version-1
 * studies, and retained version-1 evidence is inspect-only, so no analysis
 * snapshot CAN be written for any of them. Null reads as "none has been saved".
 * The truth is "none can be". D-158 fixed exactly this on `fiscus causal
 * inspect`, which now emits `analysisSnapshots: { available, reason, latest }`,
 * and recorded the dashboard half as open. This closes it.
 *
 * WHY THE BASIS GOES ON THE SUMMARY AND NOT ON THE RESPONSE. `latestAnalysis`
 * is a per-study field, its reason is per-study (not registered, version-1
 * inspect-only, version-2 deferred are three different sentences), and the
 * repository's first rule is that a figure carries its basis -- not that a
 * basis is available somewhere else in the same document. Putting it on the row
 * also means the CLI's `causal status` gets it without a second mechanism.
 *
 * WHAT THIS DOES NOT ESTABLISH. It does not make version-2 studies inspectable;
 * the projection is still deferred and the rows are still omitted. It states
 * the omission and its size, which is what lets a reader tell an empty result
 * from an unexamined one. And `analysisBasis.available` is false for every
 * study this build can hold, so nothing yet exercises a true branch -- that
 * arrives with the version-2 analysis projection, exactly as D-158 recorded.
 *
 * Recorded at D-165.
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

const H = (char: string): string => char.repeat(64);
const D = (char: string): string => 'sha256:' + H(char);

function v1Draft(): CausalStudyProtocolDraft {
  return {
    type: CAUSAL_PROTOCOL_TYPE,
    version: CAUSAL_PROTOCOL_VERSION,
    studyId: 'study-list-basis',
    createdAtMs: 1_700_000_000_000,
    question: 'model_cost_quality',
    eligibility: { cohortId: 'cohort-list', unitOfAssignment: 'task', contextSchemaId: 'task-v1' },
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

function v2Draft(studyId: string): CausalStudyProtocolDraftV2 {
  return {
    type: CAUSAL_PROTOCOL_TYPE,
    version: CAUSAL_PROTOCOL_VERSION_V2,
    studyId,
    seriesId: 'series:list-basis',
    studyVersion: 1,
    ownerId: 'owner:list',
    scopeId: 'scope:list',
    createdAtMs: 1_700_000_000_000,
    question: 'model_cost_quality',
    eligibility: {
      cohortId: 'cohort:list', contextSchemaId: 'schema:list',
      unitOfAssignment: 'task', inclusionRuleIds: ['rule:eligible'], exclusionRuleIds: [],
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

interface CausalListPayload {
  studies: Array<{
    studyId: string;
    latestAnalysis: unknown;
    analysisBasis: { available: boolean; reason: string };
  }>;
  studiesOmitted: { count: number; reason: string };
}

/**
 * A retained version-1 study, inserted the only way one can exist.
 *
 * `registerCausalProtocol` refuses a version-1 protocol outright -- retained
 * version-1 evidence is inspect-only, which is precisely the reason
 * `analysisBasis` has to state -- so a version-1 row can only arrive as legacy
 * data. This mirrors what `test/causal-dashboard.test.ts` already does for the
 * same reason.
 */
function seedRetainedV1(store: Store): void {
  const protocol = commitCausalProtocol(v1Draft(), 1_700_000_000_100);
  store.raw().prepare(
    'INSERT INTO causal_protocols (study_id, protocol_hash, committed_at_ms, protocol_json) VALUES (?, ?, ?, ?)',
  ).run(protocol.studyId, protocol.protocolHash, protocol.committedAtMs, canonicalJson(protocol));
}

async function withServer(store: Store, run: (base: string) => Promise<void>): Promise<void> {
  const server = createDashboardServer({ store, config: structuredClone(DEFAULT_CONFIG), version: 'test' });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    await run('http://127.0.0.1:' + String((server.address() as AddressInfo).port));
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

test('a study row says why its analysis is absent, not merely that it is', () => {
  // SECOND SILENCE, at the source. Every row this build can produce is a
  // retained version-1 study, and no analysis snapshot can be written for one.
  const store = new Store(':memory:');
  try {
    seedRetainedV1(store);
    const summaries = store.causalStudySummaries();

    assert.equal(summaries.length, 1);
    assert.equal(summaries[0]!.latestAnalysis, null, 'the fixture must have no snapshot, or the assertion below is vacuous');
    assert.equal(summaries[0]!.analysisBasis.available, false);
    assert.match(
      summaries[0]!.analysisBasis.reason,
      /inspect-only/,
      `the row must say WHY no analysis exists; got ${JSON.stringify(summaries[0]!.analysisBasis)}`,
    );
  } finally {
    store.close();
  }
});

test('the dashboard reports how many studies its list could not include', async () => {
  // FIRST SILENCE, and the sharp case: version-2 studies alongside a version-1
  // one. With only version-2 studies the response says the projection is
  // deferred; add one version-1 study and that sentence is replaced, the list
  // shows a single row, and the two omitted studies are named nowhere.
  const store = new Store(':memory:');
  try {
    seedRetainedV1(store);
    store.registerCausalProtocol(commitCausalProtocol(v2Draft('study:list-v2-a'), 1_700_000_000_500));
    store.registerCausalProtocol(commitCausalProtocol(v2Draft('study:list-v2-b'), 1_700_000_000_600));

    await withServer(store, async (base) => {
      const payload = await (await fetch(base + '/api/causal')).json() as CausalListPayload;

      assert.equal(payload.studies.length, 1, 'the version-2 rows must still be omitted; this states the omission, it does not undo it');
      assert.equal(payload.studiesOmitted.count, 2);
      assert.match(
        payload.studiesOmitted.reason,
        /version-2/i,
        `the omission must name its reason; got ${JSON.stringify(payload.studiesOmitted)}`,
      );
    });
  } finally {
    store.close();
  }
});

test('a store with nothing omitted reports zero, and that zero is established', async () => {
  // The control. A reader must be able to tell "two studies are missing from
  // this list" from "nothing is missing", and a field that only ever appears
  // when something is wrong cannot support the second reading.
  const store = new Store(':memory:');
  try {
    seedRetainedV1(store);

    await withServer(store, async (base) => {
      const payload = await (await fetch(base + '/api/causal')).json() as CausalListPayload;
      assert.equal(payload.studies.length, 1);
      assert.equal(payload.studiesOmitted.count, 0);
      assert.match(payload.studiesOmitted.reason, /^$|none|no /i);
    });
  } finally {
    store.close();
  }
});

test('an empty store omits nothing and still carries the field', async () => {
  // The other end of the same control. The no-study branch returns early with
  // its own payload, and a field present on one branch and absent on the other
  // is a field a consumer cannot read.
  const store = new Store(':memory:');
  try {
    await withServer(store, async (base) => {
      const payload = await (await fetch(base + '/api/causal')).json() as CausalListPayload;
      assert.deepEqual(payload.studies, []);
      assert.equal(payload.studiesOmitted.count, 0);
    });
  } finally {
    store.close();
  }
});

test('a version-2-only store reports its studies as omitted rather than as absent', async () => {
  // The case that was already disclosed in prose, now disclosed as data. The
  // `causalEvidence` sentence said the projection was deferred; nothing said
  // how many studies that deferral was hiding, so "no studies" and "two
  // studies this build cannot project" read identically in the payload.
  const store = new Store(':memory:');
  try {
    store.registerCausalProtocol(commitCausalProtocol(v2Draft('study:list-v2-a'), 1_700_000_000_500));
    store.registerCausalProtocol(commitCausalProtocol(v2Draft('study:list-v2-b'), 1_700_000_000_600));

    await withServer(store, async (base) => {
      const payload = await (await fetch(base + '/api/causal')).json() as CausalListPayload;
      assert.deepEqual(payload.studies, []);
      assert.equal(payload.studiesOmitted.count, 2);
    });
  } finally {
    store.close();
  }
});
