import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { EpistemicLedger } from '../src/epistemic/ledger.ts';
import { claim, type ClaimInput } from '../src/epistemic/claim.ts';

const base = {
  id: 'claim:negative:1',
  proposition: { predicate: 'ops.no_incident', value: { project: 'atlas' } },
  subject: 'atlas',
  scope: { constraints: [{ key: 'project', value: 'atlas' }] },
  grain: { dimensions: ['project', 'period'] },
  time: { asOf: '2026-09-03T00:00:00.000Z' },
  epistemic: 'supported',
  profile: { epistemic: 'supported', integrity: 'verified', authenticity: 'pinned', scope: 'established', coverage: 'complete', measurement: 'validated', causality: 'none', monetaryBasis: 'none', finality: 'provisional', decisionFitness: 'sufficient' },
  measurementModelRef: 'model:ops-v1',
  evidenceIds: ['evidence:scan'],
  derivationRule: 'negative-claim.v1',
  derivationVersion: 1,
  causalStatus: 'none',
  issuedAt: '2026-09-03T00:00:00.000Z',
  schemaVersion: 1,
} satisfies ClaimInput;

test('negative claims require a typed completeness witness contract', () => {
  assert.throws(() => claim({ ...base, negativeClaim: { eventType: 'linked_incident', completenessWitnessIds: [] } } as ClaimInput), /completenessWitnessIds must contain at least one entry/);
  const item = claim({ ...base, evidenceIds: ['cw:incidents'], negativeClaim: { eventType: 'linked_incident', completenessWitnessIds: ['cw:incidents'] } } as ClaimInput);
  assert.deepEqual(item.negativeClaim, { eventType: 'linked_incident', completenessWitnessIds: ['cw:incidents'] });
});

test('positive claims remain valid without the opt-in contract', () => {
  assert.equal(claim(base).negativeClaim, undefined);
});

test('append boundary refuses a negative claim whose witness ID is not cited', () => {
  const ledger = new EpistemicLedger(new DatabaseSync(':memory:'));
  const item = claim({ ...base, negativeClaim: { eventType: 'linked_incident', completenessWitnessIds: ['cw:missing'] } });
  assert.throws(() => ledger.appendClaim(item), /must be cited in evidenceIds/);
});
