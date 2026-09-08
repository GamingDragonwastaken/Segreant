/**
 * Every look at a causal study was invisible, and the surfaces reported the
 * single-look conclusion as if it were the only one.
 *
 * WHAT WP-E06 BUILT AND WHAT IT WAS CONNECTED TO. `src/causal/inference-ledger.ts`
 * records each reported interval as an inferential act, chains the acts so a
 * removed one is detectable, and puts the look count, the union-bound
 * family-wise error and the simultaneous confidence on the reported result's own
 * limitations. Measured against the committed tree, `openCausalInferenceLedger`,
 * `recordInferentialActs` and `reportCausalStudyEstimate` had **no caller
 * anywhere in `src/`** — not the CLI, not the dashboard, not the store, and no
 * table held an act. The two surfaces that actually reach an operator,
 * `fiscus causal summary` and `GET /api/causal`, each called
 * `estimateCausalStudy` directly, so an operator could look at the same study
 * twenty times and every answer would present itself as the first.
 *
 * The module's own assumption line had already named the hazard exactly: "Every
 * act is assumed to have been recorded through this ledger. An estimate produced
 * outside it is not counted and cannot be." Every estimate in the product was
 * produced outside it.
 *
 * WHY A LOOK IS RECORDED ON A READ PATH. Fiscus is read-only by default and
 * `--apply` persists, and this does not breach that: an inferential act is not a
 * change to the operator's data or to the world — it is an audit record of
 * something that already happened, in the same category as an egress receipt,
 * which is appended before the request it describes and whose failure stops the
 * request. `reportCausalStudyEstimate`'s own docblock is explicit that reporting
 * IS the act. Declining to record it would not leave the count unchanged; it
 * would leave it wrong.
 *
 * Recorded at D-156.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  CAUSAL_PROTOCOL_TYPE,
  CAUSAL_PROTOCOL_VERSION,
  type CausalStudyProtocolDraft,
  type CommittedCausalStudyProtocol,
} from '../src/causal/types.ts';
import { canonicalJson, commitCausalProtocol } from '../src/causal/protocol.ts';
import { Store } from '../src/store/db.ts';
import { createRetainedCausalV1AssignmentFixture } from './support/causalV1Fixture.ts';
import { repeatedCostQualityData } from './support/causalStudyFixture.ts';
import type { AddressInfo } from 'node:net';
import { createDashboardServer } from '../src/dashboard/server.ts';
import { DEFAULT_CONFIG } from '../src/config.ts';
import type { CausalPayload } from '../src/dashboard/shared-types.ts';

const H = (char: string): string => char.repeat(64);
const ROOT = join(import.meta.dirname, '..');

function draft(): CausalStudyProtocolDraft {
  return {
    type: CAUSAL_PROTOCOL_TYPE,
    version: CAUSAL_PROTOCOL_VERSION,
    studyId: 'study-looks',
    createdAtMs: 1_700_000_000_000,
    question: 'model_cost_quality',
    eligibility: { cohortId: 'cohort-looks', unitOfAssignment: 'task', contextSchemaId: 'task-v1' },
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

function seed(store: Store): CommittedCausalStudyProtocol {
  const protocol = commitCausalProtocol(draft(), 1_700_000_000_100);
  store.raw().prepare(
    'INSERT INTO causal_protocols (study_id, protocol_hash, committed_at_ms, protocol_json) VALUES (?, ?, ?, ?)',
  ).run(protocol.studyId, protocol.protocolHash, protocol.committedAtMs, canonicalJson(protocol));
  const plan = createRetainedCausalV1AssignmentFixture(protocol, {
    blockId: 'block-looks',
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
  return protocol;
}

/**
 * A study that actually earns a claim, so multiplicity has something to
 * withhold. The `collecting` fixture above cannot decide anything the
 * multiplicity rule does, because its conclusion is already `not_established`
 * and every assertion about withholding would pass without the rule running.
 */
function seedQualified(store: Store, units = Number.POSITIVE_INFINITY): string {
  const full = repeatedCostQualityData(0.95, 0.8);
  const data = {
    protocol: full.protocol,
    decisions: full.decisions.slice(0, units),
    executions: full.executions.slice(0, units),
    outcomes: full.outcomes.slice(0, units),
  };
  const raw = store.raw();
  raw.prepare(
    'INSERT INTO causal_protocols (study_id, protocol_hash, committed_at_ms, protocol_json) VALUES (?, ?, ?, ?)',
  ).run(data.protocol.studyId, data.protocol.protocolHash, data.protocol.committedAtMs, canonicalJson(data.protocol));
  const insertDecision = raw.prepare(
    'INSERT INTO causal_decisions (decision_id, study_id, protocol_hash, assigned_at_ms, event_hash, decision_json) VALUES (?, ?, ?, ?, ?, ?)',
  );
  const insertExecution = raw.prepare(
    'INSERT INTO causal_executions (execution_id, decision_id, study_id, protocol_hash, completed_at_ms, event_hash, execution_json) VALUES (?, ?, ?, ?, ?, ?, ?)',
  );
  const insertOutcome = raw.prepare(
    'INSERT INTO causal_outcomes (outcome_id, decision_id, study_id, protocol_hash, observed_at_ms, event_hash, outcome_json) VALUES (?, ?, ?, ?, ?, ?, ?)',
  );
  for (const decision of data.decisions) {
    insertDecision.run(decision.decisionId, decision.studyId, decision.protocolHash, decision.assignedAtMs, decision.eventHash, JSON.stringify(decision));
  }
  for (const execution of data.executions) {
    insertExecution.run(execution.executionId, execution.decisionId, execution.studyId, execution.protocolHash, execution.completedAtMs, execution.eventHash, JSON.stringify(execution));
  }
  for (const outcome of data.outcomes) {
    insertOutcome.run(outcome.outcomeId, outcome.decisionId, outcome.studyId, outcome.protocolHash, outcome.observedAtMs, outcome.eventHash, JSON.stringify(outcome));
  }
  return data.protocol.studyId;
}

/** Append the units `seedQualified` left out, so the next look reads new evidence. */
function extendQualified(store: Store, from: number): void {
  const full = repeatedCostQualityData(0.95, 0.8);
  const raw = store.raw();
  const insertDecision = raw.prepare(
    'INSERT INTO causal_decisions (decision_id, study_id, protocol_hash, assigned_at_ms, event_hash, decision_json) VALUES (?, ?, ?, ?, ?, ?)',
  );
  const insertExecution = raw.prepare(
    'INSERT INTO causal_executions (execution_id, decision_id, study_id, protocol_hash, completed_at_ms, event_hash, execution_json) VALUES (?, ?, ?, ?, ?, ?, ?)',
  );
  const insertOutcome = raw.prepare(
    'INSERT INTO causal_outcomes (outcome_id, decision_id, study_id, protocol_hash, observed_at_ms, event_hash, outcome_json) VALUES (?, ?, ?, ?, ?, ?, ?)',
  );
  for (const decision of full.decisions.slice(from)) {
    insertDecision.run(decision.decisionId, decision.studyId, decision.protocolHash, decision.assignedAtMs, decision.eventHash, JSON.stringify(decision));
  }
  for (const execution of full.executions.slice(from)) {
    insertExecution.run(execution.executionId, execution.decisionId, execution.studyId, execution.protocolHash, execution.completedAtMs, execution.eventHash, JSON.stringify(execution));
  }
  for (const outcome of full.outcomes.slice(from)) {
    insertOutcome.run(outcome.outcomeId, outcome.decisionId, outcome.studyId, outcome.protocolHash, outcome.observedAtMs, outcome.eventHash, JSON.stringify(outcome));
  }
}

function withStore(action: (store: Store, file: string) => void): void {
  const temp = mkdtempSync(join(tmpdir(), 'fiscus-causal-looks-'));
  const file = join(temp, 'fiscus.db');
  const store = new Store(file);
  try {
    action(store, file);
  } finally {
    store.close();
    rmSync(temp, { recursive: true, force: true });
  }
}

test('a second report of the same study is a second look, and says so', () => {
  withStore((store) => {
    seed(store);
    const first = store.reportCausalStudy('study-looks', 1_700_000_001_000);
    const second = store.reportCausalStudy('study-looks', 1_700_000_002_000);

    assert.equal(first?.multiplicity.looks, 1);
    assert.equal(second?.multiplicity.looks, 2, 'the second look must not present itself as the first');
    assert.ok(
      second!.multiplicity.limitations.some((line) => line.includes('look 2')),
      `the report must state which look it is; got ${JSON.stringify(second!.multiplicity.limitations)}`,
    );
  });
});

test('the acts survive the process, so the count is not per-session', () => {
  // A ledger held in memory would report `looks: 1` forever, which is the same
  // absence with a number attached to it.
  const temp = mkdtempSync(join(tmpdir(), 'fiscus-causal-looks-durable-'));
  const file = join(temp, 'fiscus.db');
  try {
    const first = new Store(file);
    try {
      seed(first);
      first.reportCausalStudy('study-looks', 1_700_000_001_000);
      first.reportCausalStudy('study-looks', 1_700_000_002_000);
    } finally {
      first.close();
    }

    const reopened = new Store(file);
    try {
      const third = reopened.reportCausalStudy('study-looks', 1_700_000_003_000);
      assert.equal(third?.multiplicity.looks, 3);
    } finally {
      reopened.close();
    }
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

test('the fixture this file rests on really does earn a claim on its first look', () => {
  // Without this, every assertion below about withholding would pass because
  // the study established nothing in the first place.
  withStore((store) => {
    const studyId = seedQualified(store);
    const first = store.reportCausalStudy(studyId, 1_700_000_001_000);
    assert.equal(first?.estimate.allowedClaim, 'comparative_cost_quality_supported');
    assert.equal(first?.claimAfterMultiplicity, 'comparative_cost_quality_supported');
    assert.equal(first?.claimAfterMultiplicityReason, null);
    assert.equal(first?.multiplicity.chainIntact, true);
  });
});

test('a removed act is detected, and the claim is withheld rather than recounted', () => {
  // The chain is the reason the count means anything. If a row can be deleted
  // and the remaining ledger still reads as intact, the look count is a claim
  // about whatever happens to be in the table.
  withStore((store) => {
    const studyId = seedQualified(store);
    store.reportCausalStudy(studyId, 1_700_000_001_000);
    store.reportCausalStudy(studyId, 1_700_000_002_000);
    const before = (store.raw().prepare('SELECT COUNT(*) AS n FROM causal_inference_acts').get() as { n: number }).n;
    store.raw().prepare('DELETE FROM causal_inference_acts WHERE sequence = 1').run();

    const after = store.reportCausalStudy(studyId, 1_700_000_003_000);
    assert.equal(after?.multiplicity.chainIntact, false);
    assert.equal(after?.claimAfterMultiplicity, 'not_established');
    assert.match(String(after?.claimAfterMultiplicityReason), /unknown/i);

    // A BROKEN CHAIN IS NOT EXTENDED. Appending to it would produce a chain
    // that verifies forward from a forged start, which is a smaller look count
    // wearing the appearance of an intact one.
    const now = (store.raw().prepare('SELECT COUNT(*) AS n FROM causal_inference_acts').get() as { n: number }).n;
    assert.equal(now, before - 1, 'no act may be appended to a chain that does not verify');
  });
});

test('re-reading unchanged evidence is a look that spends no error budget', () => {
  // The module's rule, reaching the product: re-reading identical evidence is
  // deterministic and is not a second chance to be wrong. Six looks at a study
  // nothing has added to therefore still support the conclusion, and the look
  // count rises anyway so the operator can see what was asked.
  withStore((store) => {
    const studyId = seedQualified(store);
    let last = store.reportCausalStudy(studyId, 1_700_000_001_000);
    for (let look = 2; look <= 6; look += 1) {
      last = store.reportCausalStudy(studyId, 1_700_000_000_000 + look * 1_000);
    }

    assert.equal(last?.multiplicity.looks, 6);
    assert.equal(last?.multiplicity.actsInErrorBudget, 2, 'only the first read of this evidence spends budget');
    assert.equal(last?.multiplicity.identicalRepeatActs, 10);
    assert.equal(last?.claimAfterMultiplicity, 'comparative_cost_quality_supported');
  });
});

test('a second look at grown evidence withholds the conclusion the first look supported', () => {
  // THE POINT OF THE WHOLE MECHANISM, and the case the surfaces could not
  // previously express. The registered joint rule pays for two endpoints at ONE
  // look; a second look at new data is outside the family it registered. The
  // single-look decision is reported unchanged and is NOT re-derived at an
  // adjusted level -- what changes is that the conclusion after multiplicity is
  // withheld and says why.
  withStore((store) => {
    const studyId = seedQualified(store, 800);
    const first = store.reportCausalStudy(studyId, 1_700_000_001_000);
    assert.equal(first?.claimAfterMultiplicity, 'comparative_cost_quality_supported');
    assert.equal(first?.multiplicity.actsInErrorBudget, 2);

    extendQualified(store, 800);
    const second = store.reportCausalStudy(studyId, 1_700_000_002_000);

    assert.equal(second?.estimate.allowedClaim, 'comparative_cost_quality_supported', 'the single-look decision is reported unchanged');
    assert.equal(second?.multiplicity.actsInErrorBudget, 4, 'new evidence is a new look and spends budget');
    assert.equal(second?.claimAfterMultiplicity, 'not_established');
    assert.match(String(second?.claimAfterMultiplicityReason), /inferential acts have been recorded/i);
    assert.ok(
      second!.estimate.limitations.some((line) => line.includes('Multiplicity withholds')),
      'the withholding must reach the limitations on the reported estimate',
    );
  });
});

test('the ledger is bound to the committed protocol, not merely to the study id', () => {
  withStore((store) => {
    const protocol = seed(store);
    store.reportCausalStudy('study-looks', 1_700_000_001_000);
    const stored = store.raw().prepare(
      'SELECT protocol_hash FROM causal_inference_acts WHERE study_id = ? ORDER BY sequence',
    ).all('study-looks') as Array<{ protocol_hash: string }>;

    assert.ok(stored.length > 0, 'a recorded look must leave a row');
    for (const row of stored) assert.equal(row.protocol_hash, protocol.protocolHash);
  });
});

test('a study with no local protocol reports nothing rather than an empty result', () => {
  withStore((store) => {
    assert.equal(store.reportCausalStudy('study-absent', 1_700_000_001_000), null);
  });
});

test('the dashboard endpoint records its own look, twice', async () => {
  // NOT A STORE METHOD STANDING IN FOR THE SURFACE. The claim is that the two
  // paths an operator actually reaches now count their looks, so this drives
  // the HTTP endpoint and reads the payload the browser would receive.
  const temp = mkdtempSync(join(tmpdir(), 'fiscus-causal-looks-http-'));
  const store = new Store(join(temp, 'fiscus.db'));
  const server = createDashboardServer({ store, config: structuredClone(DEFAULT_CONFIG), version: 'test' });
  try {
    const studyId = seedQualified(store, 800);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const base = 'http://127.0.0.1:' + String((server.address() as AddressInfo).port);
    const path = base + '/api/causal?study=' + encodeURIComponent(studyId);

    const first = await (await fetch(path)).json() as CausalPayload;
    const second = await (await fetch(path)).json() as CausalPayload;

    assert.equal(first.study?.multiplicity.looks, 1);
    assert.equal(second.study?.multiplicity.looks, 2, 'a refresh must not present itself as the first reading');
    assert.equal(second.study?.allowedClaim, 'comparative_cost_quality_supported', 'the single-look decision is reported unchanged');
    assert.equal(second.study?.multiplicity.basis, 'recorded_acts_only');
    assert.match(second.boundary, /Read-only local status/i, 'recording a look does not change what this endpoint may do');
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    store.close();
    rmSync(temp, { recursive: true, force: true });
  }
});

test('the CLI records its own look, twice', () => {
  // The other surface an operator reaches, exercised as the packaged command
  // rather than as a Store call, for the same reason `test/causal-cli.test.ts`
  // gives: a Store method is not proof that the user-facing lifecycle is wired.
  const temp = mkdtempSync(join(tmpdir(), 'fiscus-causal-looks-cli-'));
  const dbFile = join(temp, 'causal-cli.db');
  try {
    const store = new Store(dbFile);
    let studyId: string;
    try {
      studyId = seedQualified(store, 800);
    } finally {
      store.close();
    }

    type Inspected = { multiplicity: { looks: number }; allowedClaim: string; claimAfterMultiplicity: string };
    const run = (): Inspected => JSON.parse(execFileSync(
      process.execPath,
      ['--disable-warning=ExperimentalWarning', join(ROOT, 'src', 'cli.ts'), 'causal', 'inspect', studyId, '--json'],
      { cwd: ROOT, env: { ...process.env, FISCUS_DB: dbFile, FISCUS_HOME: join(temp, 'home') }, encoding: 'utf8' },
    )) as Inspected;

    const first = run();
    const second = run();
    assert.equal(first.multiplicity.looks, 1);
    assert.equal(second.multiplicity.looks, 2, 'a second inspection must not present itself as the first');
    assert.equal(second.allowedClaim, 'comparative_cost_quality_supported', 'the single-look decision is reported unchanged');
    assert.equal(second.claimAfterMultiplicity, 'comparative_cost_quality_supported', 're-reading unchanged evidence spends no budget');
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});
