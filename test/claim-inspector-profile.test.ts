import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ClaimProfilePayload } from '../src/dashboard/web/app/core/generated-types.ts';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const PROFILE: ClaimProfilePayload = {
  epistemic: 'conflicted',
  integrity: 'unknown',
  authenticity: 'self_asserted',
  scope: 'conditional',
  coverage: 'partial',
  measurement: 'proxy_unvalidated',
  causality: 'none',
  monetaryBasis: 'mixed',
  finality: 'provisional',
  decisionFitness: 'not_assessed',
};

test('Claim Inspector profile projection preserves each kernel axis and withheld figures', async () => {
  const module = await import('../src/dashboard/web/app/core/claimTypes.ts') as typeof import('../src/dashboard/web/app/core/claimTypes.ts') & {
    claimProfileRows?: (profile: ClaimProfilePayload, figure: 'shown' | 'withheld_unsupported' | 'withheld_uncosted' | 'not_a_money_claim') => ReadonlyArray<{ axis: string; value: string }>;
  };

  assert.equal(typeof module.claimProfileRows, 'function', 'the inspector needs a typed profile projection');
  if (!module.claimProfileRows) return;

  const rows = module.claimProfileRows(PROFILE, 'withheld_uncosted');
  assert.deepEqual(rows.map((row) => row.axis), [
    'epistemic', 'integrity', 'authenticity', 'scope', 'coverage',
    'measurement', 'causality', 'monetaryBasis', 'finality', 'decisionFitness', 'figure',
  ]);
  assert.equal(rows.find((row) => row.axis === 'epistemic')?.value, 'conflicted');
  assert.equal(rows.find((row) => row.axis === 'integrity')?.value, 'unknown');
  assert.equal(rows.find((row) => row.axis === 'figure')?.value, 'withheld_uncosted');

  const refuted = module.claimProfileRows({ ...PROFILE, epistemic: 'refuted' }, 'withheld_unsupported');
  assert.equal(refuted.find((row) => row.axis === 'epistemic')?.value, 'refuted');
  assert.equal(refuted.find((row) => row.axis === 'figure')?.value, 'withheld_unsupported');
});

test('the read-only panel mounts the transported profile and separate figure rows', () => {
  const source = readFileSync(join(import.meta.dirname, '..', 'src', 'dashboard', 'web', 'app', 'components', 'claimInspector.ts'), 'utf8');
  assert.match(source, /function profileCard\(layer: Layer\)/);
  assert.match(source, /claimProfileRows\(layer\.support\.profile, layer\.support\.figure\)/);
  assert.match(source, /profileCard\(layer\)/, 'the panel must actually mount the profile card');
  assert.match(source, /class: 'claim-profile'/);
  assert.doesNotMatch(source, /claim-profile[\s\S]{0,500}onclick:/, 'the profile card must not become an action surface');
});
