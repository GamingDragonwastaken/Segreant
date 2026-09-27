import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  evaluateCapitalAccount,
  type CapitalAccountInput,
  type CapitalObservation,
  CapitalValidationError,
} from '../src/capital.ts';

const USD = (amount: string) => ({ amount, currency: 'USD' as const });

function observation(overrides: Partial<CapitalObservation> = {}): CapitalObservation {
  return {
    observationId: 'obs-1',
    observedAtMs: 1_000,
    windowStartMs: 0,
    windowEndMs: 2_000,
    committed: USD('100'),
    consumed: USD('40'),
    reserved: USD('20'),
    directSpend: USD('30'),
    allocatedSpend: USD('10'),
    realizedCashSpend: USD('40'),
    avoidableSpend: USD('25'),
    ...overrides,
  };
}

function input(overrides: Partial<CapitalAccountInput> = {}): CapitalAccountInput {
  return {
    accountId: 'account-1',
    policyId: 'policy-1',
    currency: 'USD',
    basis: 'billed',
    coverage: 'complete',
    observations: [observation()],
    ...overrides,
  };
}

test('capital evaluation conserves committed capacity and separates spend decomposition', () => {
  const result = evaluateCapitalAccount(input());
  assert.equal(result.accountId, 'account-1');
  assert.equal(result.committed.amount, '100');
  assert.equal(result.consumed.amount, '40');
  assert.equal(result.reserved.amount, '20');
  assert.equal(result.unused.amount, '40');
  assert.equal(result.directSpend.amount, '30');
  assert.equal(result.allocatedSpend.amount, '10');
  assert.equal(result.fullSpend.amount, '40');
  assert.equal(result.realizedCashSpend.amount, '40');
  assert.equal(result.avoidableSpend.amount, '25');
  assert.equal(result.commitmentConservation, 'verified');
  assert.equal(result.spendConservation, 'verified');
  assert.equal(result.showback, 'policy_relative_non_chargeback');
  assert.equal(result.coverage, 'complete');
});

test('unused commitment and opportunity gap remain a counterfactual, not spend or causal value', () => {
  const result = evaluateCapitalAccount(input({
    targetConsumed: USD('80'),
    observations: [observation({ committed: USD('100'), consumed: USD('40'), reserved: USD('10') })],
  }));
  assert.equal(result.unused.amount, '50');
  assert.equal(result.opportunityGap?.amount.amount, '40');
  assert.equal(result.opportunityGap?.status, 'counterfactual_only');
  assert.match(result.opportunityGap?.nonClaims ?? '', /causal|business value/i);
});

test('policy-relative fairness does not become a value or causal claim', () => {
  const result = evaluateCapitalAccount(input({
    observations: [
      observation({ observationId: 'a', directSpend: USD('20'), allocatedSpend: USD('10'), realizedCashSpend: USD('30') }),
      observation({ observationId: 'b', directSpend: USD('40'), allocatedSpend: USD('0'), realizedCashSpend: USD('40') }),
    ],
    fairness: { dimension: 'cost_centre', reference: 'equal_share', groups: { alpha: USD('30'), beta: USD('40') } },
  }));
  assert.equal(result.fairness?.basis, 'policy_relative');
  assert.equal(result.fairness?.status, 'descriptive_only');
  assert.equal(result.fairness?.gap.amount, '10');
  assert.match(result.fairness?.nonClaims ?? '', /causal|value/i);
});

test('capital evaluation refuses double counting and invalid conservation', () => {
  assert.throws(
    () => evaluateCapitalAccount(input({ observations: [observation({ directSpend: USD('31'), allocatedSpend: USD('10'), realizedCashSpend: USD('40') })] })),
    (error: unknown) => error instanceof CapitalValidationError && /direct plus allocated spend/i.test(error.message),
  );
  assert.throws(
    () => evaluateCapitalAccount(input({ observations: [observation({ committed: USD('40'), consumed: USD('40'), reserved: USD('20') })] })),
    (error: unknown) => error instanceof CapitalValidationError && /committed capacity/i.test(error.message),
  );
});

test('capital CLI is a bounded review-only consumer of the typed evaluator', () => {
  const root = mkdtempSync(join(tmpdir(), 'segreant-capital-'));
  const options = join(root, 'options.json');
  try {
    writeFileSync(options, JSON.stringify(input({ targetConsumed: USD('80') })));
    const stdout = execFileSync(process.execPath, ['bin/segreant.mjs', 'capital', 'evaluate', '--options', options, '--json'], {
      cwd: process.cwd(),
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const payload = JSON.parse(stdout) as { operation: string; result: { opportunityGap: { amount: { amount: string } } | null }; boundary: string };
    assert.equal(payload.operation, 'capital_evaluation');
    assert.equal(payload.result.opportunityGap?.amount.amount, '40');
    assert.match(payload.boundary, /no provider.*routing/i);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
