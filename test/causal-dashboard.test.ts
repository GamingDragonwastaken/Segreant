/**
 * The dashboard gets a deliberately redacted, read-only causal inspector:
 * evidence state and allocation replay verdicts belong in the UI, whereas
 * randomisation material and raw event records do not.
 */

import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDashboardServer } from '../src/dashboard/server.ts';
import { createBlockedAssignmentPlan } from '../src/causal/assignment.ts';
import { commitCausalProtocol } from '../src/causal/protocol.ts';
import { CAUSAL_PROTOCOL_TYPE, CAUSAL_PROTOCOL_VERSION, type CausalStudyProtocolDraft } from '../src/causal/types.ts';
import { DEFAULT_CONFIG } from '../src/config.ts';
import { Store } from '../src/store/db.ts';

const H = (char: string): string => char.repeat(64);

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
    assert.match(emptyPayload.causalEvidence, /No registered causal study/i);

    const protocol = commitCausalProtocol(draft(), 1_700_000_000_100);
    store.registerCausalProtocol(protocol);
    store.saveCausalAssignmentPlan(createBlockedAssignmentPlan(protocol, {
      blockId: 'block-dashboard',
      createdAtMs: 1_700_000_000_200,
      unitIdHashes: [H('1'), H('2'), H('3'), H('4')],
      randomizationMaterial: Buffer.from('0123456789abcdef0123456789abcdef', 'hex'),
    }));
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
