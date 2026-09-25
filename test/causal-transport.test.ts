import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  assessTransportBridge,
  assessStudyPooling,
  type CausalTransportDeclaration,
  type CausalStudyDescriptor,
  CausalTransportValidationError,
} from '../src/causal/transport.ts';

const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);

function bridge(overrides: Partial<CausalTransportDeclaration> = {}): CausalTransportDeclaration {
  return {
    type: 'segreant.causal-transport',
    version: 1,
    bridgeId: 'bridge-1',
    sourceProtocolHash: `sha256:${HASH_A}`,
    targetProtocolHash: `sha256:${HASH_B}`,
    sourcePopulationId: 'population-source',
    targetPopulationId: 'population-target',
    sourceTreatmentIdentity: `sha256:${HASH_A}`,
    targetTreatmentIdentity: `sha256:${HASH_B}`,
    sourceMeasurementModelId: 'quality-v1',
    targetMeasurementModelId: 'quality-v1',
    sourceTimeHorizonId: 'horizon-30d',
    targetTimeHorizonId: 'horizon-30d',
    targetEvidence: { evidenceId: 'evidence-target', digest: `sha256:${HASH_B}` },
    assumptions: { consistency: true, exchangeability: true, positivity: true },
    ...overrides,
  };
}

function study(overrides: Partial<CausalStudyDescriptor> = {}): CausalStudyDescriptor {
  return {
    studyId: 'study-a',
    protocolHash: `sha256:${HASH_A}`,
    populationId: 'population-a',
    treatmentIdentity: `sha256:${HASH_A}`,
    measurementModelId: 'quality-v1',
    timeHorizonId: 'horizon-30d',
    ...overrides,
  };
}

test('transport bridge requires explicit target population evidence and assumptions', () => {
  const result = assessTransportBridge(bridge());
  assert.equal(result.status, 'supported_for_review');
  assert.equal(result.sourcePopulationId, 'population-source');
  assert.equal(result.targetPopulationId, 'population-target');
  assert.ok(result.targetEvidence);
  assert.equal(result.targetEvidence.evidenceId, 'evidence-target');
  assert.ok(result.nonClaims.some((claim) => /external validity|causal effect/i.test(claim)));
});

test('missing target evidence or an undeclared assumption withholds transport', () => {
  const result = assessTransportBridge(bridge({
    targetEvidence: null,
    assumptions: { consistency: true, exchangeability: false, positivity: true },
  }));
  assert.equal(result.status, 'withheld');
  assert.ok(result.reasons.some((reason) => /target evidence/i.test(reason)));
  assert.ok(result.reasons.some((reason) => /exchangeability/i.test(reason)));
});

test('cross-study pooling is refused unless every estimand coordinate matches exactly', () => {
  const same = assessStudyPooling([study(), study({ studyId: 'study-b', protocolHash: `sha256:${HASH_B}` })]);
  assert.equal(same.status, 'poolable');
  const changed = assessStudyPooling([study(), study({ studyId: 'study-c', populationId: 'population-other' })]);
  assert.equal(changed.status, 'refused');
  assert.ok(changed.reasons.some((reason) => /population/i.test(reason)));
});

test('transport refuses self-pairs, malformed digests, and missing target identifiers', () => {
  assert.throws(
    () => assessTransportBridge(bridge({ sourceProtocolHash: `sha256:${HASH_B}` })),
    (error: unknown) => error instanceof CausalTransportValidationError && /distinct/i.test(error.message),
  );
  assert.throws(
    () => assessTransportBridge(bridge({ targetPopulationId: '' })),
    (error: unknown) => error instanceof CausalTransportValidationError && /targetPopulationId/i.test(error.message),
  );
});

test('a changed treatment or measurement coordinate remains visible in the bridge result', () => {
  const result = assessTransportBridge(bridge({
    sourcePopulationId: 'population-same',
    targetPopulationId: 'population-same',
    sourceTreatmentIdentity: `sha256:${HASH_A}`,
    targetTreatmentIdentity: `sha256:${HASH_A}`,
    targetMeasurementModelId: 'quality-v2',
    targetTimeHorizonId: 'horizon-90d',
  }));
  assert.deepEqual([...result.changedCoordinates].sort(), ['measurement_model', 'time_horizon']);
  assert.equal(result.status, 'supported_for_review');
});

test('causal transport CLI is a bounded review-only consumer', () => {
  const root = mkdtempSync(join(tmpdir(), 'segreant-causal-transport-'));
  const options = join(root, 'bridge.json');
  try {
    writeFileSync(options, JSON.stringify(bridge()));
    const stdout = execFileSync(process.execPath, ['bin/segreant.mjs', 'causal', 'transport', '--options', options, '--json'], {
      cwd: process.cwd(),
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const payload = JSON.parse(stdout) as { operation: string; assessment: { status: string }; boundary: string };
    assert.equal(payload.operation, 'causal_transport_assessment');
    assert.equal(payload.assessment.status, 'supported_for_review');
    assert.match(payload.boundary, /no automatic pooling/i);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
