import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  assessCausalDesign,
  type CausalDesignPlan,
  CausalDesignValidationError,
} from '../src/causal/design.ts';

const HASH = 'a'.repeat(64);

function plan(overrides: Partial<CausalDesignPlan> = {}): CausalDesignPlan {
  return {
    type: 'fiscus.causal-design',
    version: 1,
    designId: 'design-1',
    protocolHash: `sha256:${HASH}`,
    targetPopulation: { populationId: 'eligible-v1', scope: 'registered_eligible_population' },
    missingness: {
      mechanism: 'unknown',
      indicatorIds: ['outcome-observed', 'execution-complete'],
      reasonCodes: ['pending', 'rejected', 'absent'],
      attritionSensitivity: { low: 0, high: 1 },
    },
    interference: {
      assumption: 'not_established',
      clusterIdSource: 'assignment-block',
      exposureMapping: null,
    },
    estimands: ['itt'],
    ...overrides,
  };
}

test('causal design contract records missingness, attrition, population and interference without treating declarations as evidence', () => {
  const result = assessCausalDesign(plan());
  assert.equal(result.status, 'withheld');
  assert.equal(result.protocolHash, `sha256:${HASH}`);
  assert.equal(result.missingness.mechanism, 'unknown');
  assert.deepEqual(result.missingness.indicatorIds, ['outcome-observed', 'execution-complete']);
  assert.deepEqual(result.missingness.attritionSensitivity, { low: 0, high: 1 });
  assert.equal(result.interference.exposureMapping, null);
  assert.ok(result.reasons.some((reason) => /interference/i.test(reason)));
  assert.ok(result.nonClaims.some((claim) => /evidence/i.test(claim)));
});

test('clustered exposure estimands require an explicit cluster source and exposure mapping', () => {
  const result = assessCausalDesign(plan({
    interference: {
      assumption: 'clustered',
      clusterIdSource: 'team-id',
      exposureMapping: { mappingId: 'team-neighbour-v1', variables: ['peer-treatment'], digest: `sha256:${HASH}` },
    },
    estimands: ['cluster_itt', 'exposure_effect'],
  }));
  assert.equal(result.status, 'qualified');
  assert.deepEqual(result.estimands, ['cluster_itt', 'exposure_effect']);
  assert.equal(result.interference.exposureMapping?.mappingId, 'team-neighbour-v1');
});

test('invalid designs fail before they can be read as a causal qualification', () => {
  assert.throws(
    () => assessCausalDesign(plan({ protocolHash: 'not-a-digest' as CausalDesignPlan['protocolHash'] })),
    (error: unknown) => error instanceof CausalDesignValidationError && /protocolHash/i.test(error.message),
  );
  assert.throws(
    () => assessCausalDesign(plan({ missingness: { ...plan().missingness, attritionSensitivity: { low: 0.8, high: 0.2 } } })),
    (error: unknown) => error instanceof CausalDesignValidationError && /sensitivity/i.test(error.message),
  );
});

test('exposure-effect design refuses an undeclared mapping and a missing cluster identity', () => {
  const result = assessCausalDesign(plan({
    interference: { assumption: 'clustered', clusterIdSource: null, exposureMapping: null },
    estimands: ['exposure_effect'],
  }));
  assert.equal(result.status, 'withheld');
  assert.ok(result.reasons.some((reason) => /cluster/i.test(reason)));
  assert.ok(result.reasons.some((reason) => /mapping/i.test(reason)));
});

test('a no-interference declaration is still labelled an assumption, not a measured absence', () => {
  const result = assessCausalDesign(plan({
    interference: { assumption: 'none_declared', clusterIdSource: null, exposureMapping: null },
  }));
  assert.equal(result.status, 'qualified');
  assert.ok(result.limitations.some((line) => /not establish/i.test(line)));
});

test('causal design CLI is a bounded review-only consumer', () => {
  const root = mkdtempSync(join(tmpdir(), 'fiscus-causal-design-'));
  const options = join(root, 'design.json');
  try {
    writeFileSync(options, JSON.stringify(plan({ interference: { assumption: 'none_declared', clusterIdSource: null, exposureMapping: null } })));
    const stdout = execFileSync(process.execPath, ['bin/fiscus.mjs', 'causal', 'design', '--options', options, '--json'], {
      cwd: process.cwd(),
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const payload = JSON.parse(stdout) as { operation: string; assessment: { status: string }; boundary: string };
    assert.equal(payload.operation, 'causal_design_assessment');
    assert.equal(payload.assessment.status, 'qualified');
    assert.match(payload.boundary, /not observed.*evidence/i);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
