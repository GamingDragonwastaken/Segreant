import { test } from 'node:test';
import assert from 'node:assert/strict';
import { claim, type ClaimInput } from '../src/epistemic/claim.ts';
import { claimProfile } from '../src/epistemic/profile.ts';
import { grain } from '../src/epistemic/grain.ts';
import { interval } from '../src/epistemic/time.ts';
import { scope } from '../src/epistemic/scope.ts';

function baseClaim(): ClaimInput {
  return {
    id: 'claim:billed-cost:1',
    proposition: {
      predicate: 'cost.reconciled',
      value: { amount: '12.34', currency: 'USD' },
    },
    subject: 'project:api',
    scope: scope({ account: 'acct-1', provider: 'openai' }),
    grain: grain(['day', 'project']),
    time: {
      validTime: interval('2026-08-01T00:00:00.000Z', '2026-08-02T00:00:00.000Z'),
      asOf: '2026-08-02T03:00:02.000Z',
    },
    epistemic: 'supported',
    profile: claimProfile({
      epistemic: 'supported',
      integrity: 'verified',
      authenticity: 'provider_authenticated',
      scope: 'established',
      coverage: 'complete',
      measurement: 'validated',
      causality: 'observational',
      monetaryBasis: 'billed',
      finality: 'provisional',
      decisionFitness: 'sufficient',
    }),
    measurementModelRef: 'measurement:provider-cost:v1',
    evidenceIds: ['evidence:invoice:1'],
    derivationRule: 'billing.reconcile.v1',
    derivationVersion: 1,
    assumptions: ['provider export covers the declared account and period'],
    uncertainty: { kind: 'interval', lower: 12.34, upper: 12.34 },
    causalStatus: 'observational',
    issuedAt: '2026-08-02T03:00:02.000Z',
    supersedes: [],
    supersededBy: null,
    revocation: null,
    decisionCertificateIds: [],
    schemaVersion: 1,
  };
}

test('canonical Claim preserves typed proposition, coordinates, profile, and aliases', () => {
  const item = claim(baseClaim());

  assert.equal(item.id, 'claim:billed-cost:1');
  assert.equal(item.proposition.predicate, 'cost.reconciled');
  assert.deepEqual(item.scope.constraints.map((constraint) => constraint.key), ['account', 'provider']);
  assert.deepEqual(item.grain.dimensions, ['day', 'project']);
  assert.equal(item.epistemic, 'supported');
  assert.equal(item.profile.epistemic, item.epistemic);
  assert.equal(item.causalStatus, item.profile.causality);
  assert.equal(item.monetaryBasis, item.profile.monetaryBasis);
  assert.equal(item.finality, item.profile.finality);
  assert.equal(item.uncertainty?.kind, 'interval');
  assert.equal(Object.hasOwn(item, 'trusted'), false);
  assert.equal(Object.hasOwn(item, 'established'), false);
  assert.equal(Object.isFrozen(item), true);
  assert.equal(Object.isFrozen(item.proposition), true);
  assert.equal(Object.isFrozen(item.time), true);
  assert.equal(Object.isFrozen(item.profile), true);
  assert.equal(Object.isFrozen(item.evidenceIds), true);
});

test('Claim clones and freezes proposition, uncertainty, assumptions, and supersession links', () => {
  const input = baseClaim();
  const item = claim(input);

  (input.proposition.value as { amount: string }).amount = '99.99';
  assert.equal((item.proposition.value as { amount: string }).amount, '12.34');
  assert.throws(() => {
    (item.proposition.value as { amount: string }).amount = '99.99';
  }, TypeError);
  assert.throws(() => {
    (item.assumptions as string[]).push('new');
  }, TypeError);
  assert.throws(() => {
    (item.evidenceIds as string[]).push('evidence:other');
  }, TypeError);
});

test('Claim rejects epistemic/profile or causal mismatches and missing measurement identity', () => {
  const base = baseClaim();
  assert.throws(() => claim({ ...base, epistemic: 'refuted' }), /must match profile/);
  assert.throws(() => claim({ ...base, causalStatus: 'randomized' }), /must match profile/);
  assert.throws(() => claim({
    ...base,
    measurementModelRef: null,
  }), /measurementModelRef/);
  assert.doesNotThrow(() => claim({
    ...base,
    profile: claimProfile({ ...base.profile, measurement: 'proxy_unvalidated' }),
    measurementModelRef: null,
  }));
});

test('Claim rejects missing/duplicate evidence, invalid coordinates, derivation version, and uncertainty', () => {
  const base = baseClaim();
  assert.throws(() => claim({ ...base, evidenceIds: [] }), /evidenceIds.*at least one/);
  assert.throws(() => claim({ ...base, evidenceIds: ['evidence:1', 'evidence:1'] }), /duplicate/);
  assert.throws(() => claim({ ...base, derivationRule: ' ' }), /non-empty/);
  assert.throws(() => claim({ ...base, derivationVersion: 0 }), /derivationVersion/);
  assert.throws(() => claim({ ...base, time: { asOf: '2026-08-02T03:00:02Z' } }), /canonical UTC ISO-8601/);
  assert.throws(() => claim({ ...base, uncertainty: { kind: 'interval', lower: 4, upper: 3 } }), /lower must be <= upper/);
  assert.throws(() => claim({ ...base, uncertainty: { kind: 'interval', lower: Number.NaN, upper: 3 } }), /finite/);
  assert.throws(() => claim({ ...base, uncertainty: { kind: 'distribution', values: 'not-an-array' as never } }), /values must be an array/);
});

test('Claim rejects unknown fields and invalid proposition/profile roots', () => {
  const base = baseClaim();
  assert.throws(() => claim({ ...base, trusted: true } as ClaimInput & { trusted: boolean }), /unknown field/);
  assert.throws(() => claim({ ...base, proposition: { predicate: 'x', value: 1, trusted: true } as never }), /unknown field/);
  assert.throws(() => claim({ ...base, time: undefined as never }), /time/);
  assert.throws(() => claim({ ...base, profile: null as never }), /claim profile must be an object/);
  assert.throws(() => claim({ ...base, profile: { ...base.profile, coverage: 'total' as never } }), /coverage/);
});
