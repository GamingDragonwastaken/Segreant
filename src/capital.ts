/**
 * Review-only AI-capital accounting boundary (WP-J04).
 *
 * This module is deliberately independent from provider billing and from the
 * allocation writer. It gives callers a typed, exact-money decomposition for a
 * declared observation window without pretending that a commitment is an
 * invoice, that showback is chargeback, or that a counterfactual is causal
 * value. Every amount is supplied as a decimal string and is normalised through
 * the accounting core; no binary floating point participates in a result.
 */

import {
  addMoney,
  compareMoney,
  formatMoneyAmount,
  money,
  subtractMoney,
  type EconomicBasis,
  type Money,
} from './economics/money.ts';

export const CAPITAL_VERSION = 1 as const;

export interface CapitalAmount {
  readonly amount: string;
  readonly currency: string;
}

export interface CapitalObservation {
  readonly observationId: string;
  readonly observedAtMs: number;
  readonly windowStartMs: number;
  readonly windowEndMs: number;
  /** Capacity committed by a provider or internal policy for this window. */
  readonly committed: CapitalAmount;
  /** Capacity actually consumed, not a cash invoice. */
  readonly consumed: CapitalAmount;
  /** Committed capacity held for future use, not yet consumed. */
  readonly reserved: CapitalAmount;
  /** Cash spend directly attributable to the observed unit. */
  readonly directSpend: CapitalAmount;
  /** Showback allocation from shared spend; it is not a second invoice. */
  readonly allocatedSpend: CapitalAmount;
  /** Provider/local billed cash evidence for the same observed unit. */
  readonly realizedCashSpend: CapitalAmount;
  /** Spend that the declared policy treats as avoidable; not a causal claim. */
  readonly avoidableSpend: CapitalAmount;
  /** Optional marginal scenario amount; never included in realized spend. */
  readonly marginalSpend?: CapitalAmount;
}

export interface CapitalFairnessInput {
  readonly dimension: string;
  readonly reference: 'equal_share' | 'declared_policy';
  readonly groups: Readonly<Record<string, CapitalAmount>>;
}

export interface CapitalAccountInput {
  readonly accountId: string;
  readonly policyId: string;
  readonly currency: string;
  readonly basis: EconomicBasis;
  /** Coverage of the supplied observation window, never inferred from row count. */
  readonly coverage?: 'complete' | 'partial' | 'unknown';
  readonly observations: readonly CapitalObservation[];
  /** Declared target consumption for a counterfactual opportunity analysis. */
  readonly targetConsumed?: CapitalAmount;
  readonly fairness?: CapitalFairnessInput;
}

export interface CapitalAmountResult extends CapitalAmount {
  readonly basis: EconomicBasis;
}

export interface CapitalOpportunityGap {
  readonly amount: CapitalAmountResult;
  readonly status: 'counterfactual_only';
  readonly nonClaims: string;
}

export interface CapitalFairnessResult {
  readonly dimension: string;
  readonly reference: CapitalFairnessInput['reference'];
  readonly basis: 'policy_relative';
  readonly status: 'descriptive_only';
  readonly gap: CapitalAmountResult;
  readonly nonClaims: string;
}

export interface CapitalAccountResult {
  readonly type: 'fiscus.capital.account';
  readonly version: typeof CAPITAL_VERSION;
  readonly accountId: string;
  readonly policyId: string;
  readonly currency: string;
  readonly basis: EconomicBasis;
  readonly coverage: 'complete' | 'partial' | 'unknown';
  readonly observationCount: number;
  readonly committed: CapitalAmountResult;
  readonly consumed: CapitalAmountResult;
  readonly reserved: CapitalAmountResult;
  readonly unused: CapitalAmountResult;
  readonly directSpend: CapitalAmountResult;
  readonly allocatedSpend: CapitalAmountResult;
  readonly fullSpend: CapitalAmountResult;
  readonly realizedCashSpend: CapitalAmountResult;
  readonly avoidableSpend: CapitalAmountResult;
  readonly marginalSpend: CapitalAmountResult;
  readonly commitmentConservation: 'verified';
  readonly spendConservation: 'verified';
  readonly showback: 'policy_relative_non_chargeback';
  readonly opportunityGap: CapitalOpportunityGap | null;
  readonly fairness: CapitalFairnessResult | null;
  readonly nonClaims: readonly string[];
}

export type CapitalValidationCode =
  | 'CAPITAL_INVALID'
  | 'CAPITAL_CONSERVATION'
  | 'CAPITAL_DOUBLE_COUNT';

export class CapitalValidationError extends Error {
  readonly code: CapitalValidationCode;

  constructor(code: CapitalValidationCode, message: string) {
    super(`${code}: ${message}`);
    this.name = 'CapitalValidationError';
    this.code = code;
  }
}

function fail(code: CapitalValidationCode, message: string): never {
  throw new CapitalValidationError(code, message);
}

function validIdentifier(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z][A-Za-z0-9._-]{0,127}$/.test(value);
}

function assertTimestamp(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) fail('CAPITAL_INVALID', `${label} must be a non-negative safe integer`);
  return value;
}

function asMoney(value: CapitalAmount, label: string, currency: string, basis: EconomicBasis): Money {
  if (value === null || typeof value !== 'object' || typeof value.amount !== 'string' || typeof value.currency !== 'string') {
    fail('CAPITAL_INVALID', `${label} must contain a decimal amount and currency`);
  }
  if (value.currency !== currency) fail('CAPITAL_INVALID', `${label}.currency must be ${currency}`);
  try {
    const result = money(value.amount, value.currency, basis);
    if (compareMoney(result, money('0', currency, basis)) < 0) fail('CAPITAL_INVALID', `${label} must not be negative`);
    return result;
  } catch (error) {
    if (error instanceof CapitalValidationError) throw error;
    fail('CAPITAL_INVALID', `${label} is not an exact monetary amount: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function sum(values: readonly Money[], currency: string, basis: EconomicBasis): Money {
  return values.reduce((total, value) => addMoney(total, value), money('0', currency, basis));
}

function resultAmount(value: Money): CapitalAmountResult {
  return Object.freeze({ amount: formatMoneyAmount(value), currency: value.currency, basis: value.basis });
}

function assertNonNegativeDifference(a: Money, b: Money, label: string): Money {
  const difference = subtractMoney(a, b);
  if (compareMoney(difference, money('0', a.currency, a.basis)) < 0) {
    fail('CAPITAL_CONSERVATION', `${label} would be negative`);
  }
  return difference;
}

function fairnessResult(
  input: CapitalFairnessInput | undefined,
  currency: string,
  basis: EconomicBasis,
): CapitalFairnessResult | null {
  if (input === undefined) return null;
  if (typeof input.dimension !== 'string' || input.dimension.trim() === '' || input.dimension.length > 128) {
    fail('CAPITAL_INVALID', 'fairness.dimension must be a non-empty bounded string');
  }
  if (input.reference !== 'equal_share' && input.reference !== 'declared_policy') {
    fail('CAPITAL_INVALID', 'fairness.reference is unsupported');
  }
  const entries = Object.entries(input.groups ?? {});
  if (entries.length < 2) fail('CAPITAL_INVALID', 'fairness requires at least two groups');
  const values = entries.map(([group, amount]) => {
    if (!validIdentifier(group)) fail('CAPITAL_INVALID', `fairness group identifier is invalid: ${group}`);
    return asMoney(amount, `fairness.groups.${group}`, currency, basis);
  });
  const total = sum(values, currency, basis);
  let minimum = values[0]!;
  let maximum = values[0]!;
  for (const value of values.slice(1)) {
    if (compareMoney(value, minimum) < 0) minimum = value;
    if (compareMoney(value, maximum) > 0) maximum = value;
  }
  const gap = subtractMoney(maximum, minimum);
  // Keep the declared reference in the result even though the descriptive gap
  // is the observed max-min spread. It prevents a reader mistaking a policy
  // comparison for a universal fairness theorem.
  return Object.freeze({
    dimension: input.dimension,
    reference: input.reference,
    basis: 'policy_relative',
    status: 'descriptive_only',
    gap: resultAmount(gap),
    nonClaims: 'Descriptive difference under the declared policy; not a causal, distributive-justice, or business-value judgment.',
  });
}

export function evaluateCapitalAccount(input: CapitalAccountInput): CapitalAccountResult {
  if (!validIdentifier(input.accountId) || !validIdentifier(input.policyId)) {
    fail('CAPITAL_INVALID', 'accountId and policyId must be bounded identifiers');
  }
  if (!Array.isArray(input.observations) || input.observations.length === 0) {
    fail('CAPITAL_INVALID', 'at least one capital observation is required');
  }
  if (typeof input.currency !== 'string' || input.currency.length !== 3) {
    fail('CAPITAL_INVALID', 'currency must be a three-letter code');
  }
  const coverage = input.coverage ?? 'unknown';
  if (coverage !== 'complete' && coverage !== 'partial' && coverage !== 'unknown') {
    fail('CAPITAL_INVALID', 'coverage must be complete, partial, or unknown');
  }
  const seen = new Set<string>();
  const committed: Money[] = [];
  const consumed: Money[] = [];
  const reserved: Money[] = [];
  const direct: Money[] = [];
  const allocated: Money[] = [];
  const realized: Money[] = [];
  const avoidable: Money[] = [];
  const marginal: Money[] = [];
  for (const [index, row] of input.observations.entries()) {
    const label = `observations[${index}]`;
    if (!validIdentifier(row.observationId) || seen.has(row.observationId)) {
      fail('CAPITAL_INVALID', `${label}.observationId must be unique and valid`);
    }
    seen.add(row.observationId);
    const start = assertTimestamp(row.windowStartMs, `${label}.windowStartMs`);
    const end = assertTimestamp(row.windowEndMs, `${label}.windowEndMs`);
    const observed = assertTimestamp(row.observedAtMs, `${label}.observedAtMs`);
    if (end <= start || observed < start || observed >= end) fail('CAPITAL_INVALID', `${label} timestamps do not define an observed half-open window`);
    const values = {
      committed: asMoney(row.committed, `${label}.committed`, input.currency, input.basis),
      consumed: asMoney(row.consumed, `${label}.consumed`, input.currency, input.basis),
      reserved: asMoney(row.reserved, `${label}.reserved`, input.currency, input.basis),
      direct: asMoney(row.directSpend, `${label}.directSpend`, input.currency, input.basis),
      allocated: asMoney(row.allocatedSpend, `${label}.allocatedSpend`, input.currency, input.basis),
      realized: asMoney(row.realizedCashSpend, `${label}.realizedCashSpend`, input.currency, input.basis),
      avoidable: asMoney(row.avoidableSpend, `${label}.avoidableSpend`, input.currency, input.basis),
      marginal: row.marginalSpend === undefined ? money('0', input.currency, input.basis) : asMoney(row.marginalSpend, `${label}.marginalSpend`, input.currency, input.basis),
    };
    const used = addMoney(values.consumed, values.reserved);
    if (compareMoney(values.committed, used) < 0) fail('CAPITAL_CONSERVATION', `${label} committed capacity is below consumed plus reserved capacity`);
    const full = addMoney(values.direct, values.allocated);
    if (compareMoney(full, values.realized) !== 0) fail('CAPITAL_DOUBLE_COUNT', `${label} direct plus allocated spend must equal realized cash spend; do not count an invoice twice`);
    if (compareMoney(values.avoidable, full) > 0) fail('CAPITAL_CONSERVATION', `${label} avoidable spend cannot exceed full spend`);
    committed.push(values.committed);
    consumed.push(values.consumed);
    reserved.push(values.reserved);
    direct.push(values.direct);
    allocated.push(values.allocated);
    realized.push(values.realized);
    avoidable.push(values.avoidable);
    marginal.push(values.marginal);
  }
  const totals = {
    committed: sum(committed, input.currency, input.basis),
    consumed: sum(consumed, input.currency, input.basis),
    reserved: sum(reserved, input.currency, input.basis),
    direct: sum(direct, input.currency, input.basis),
    allocated: sum(allocated, input.currency, input.basis),
    realized: sum(realized, input.currency, input.basis),
    avoidable: sum(avoidable, input.currency, input.basis),
    marginal: sum(marginal, input.currency, input.basis),
  };
  const unused = assertNonNegativeDifference(totals.committed, addMoney(totals.consumed, totals.reserved), 'total unused commitment');
  const full = addMoney(totals.direct, totals.allocated);
  if (compareMoney(full, totals.realized) !== 0) fail('CAPITAL_DOUBLE_COUNT', 'direct plus allocated spend must equal realized cash spend');

  let opportunityGap: CapitalOpportunityGap | null = null;
  if (input.targetConsumed !== undefined) {
    const target = asMoney(input.targetConsumed, 'targetConsumed', input.currency, input.basis);
    const gap = compareMoney(target, totals.consumed) > 0
      ? subtractMoney(target, totals.consumed)
      : money('0', input.currency, input.basis);
    opportunityGap = Object.freeze({
      amount: resultAmount(gap),
      status: 'counterfactual_only',
      nonClaims: 'Declared target-minus-observed capacity gap; not spend, causal effect, or business value.',
    });
  }
  return Object.freeze({
    type: 'fiscus.capital.account',
    version: CAPITAL_VERSION,
    accountId: input.accountId,
    policyId: input.policyId,
    currency: input.currency,
    basis: input.basis,
    coverage,
    observationCount: input.observations.length,
    committed: resultAmount(totals.committed),
    consumed: resultAmount(totals.consumed),
    reserved: resultAmount(totals.reserved),
    unused: resultAmount(unused),
    directSpend: resultAmount(totals.direct),
    allocatedSpend: resultAmount(totals.allocated),
    fullSpend: resultAmount(full),
    realizedCashSpend: resultAmount(totals.realized),
    avoidableSpend: resultAmount(totals.avoidable),
    marginalSpend: resultAmount(totals.marginal),
    commitmentConservation: 'verified',
    spendConservation: 'verified',
    showback: 'policy_relative_non_chargeback',
    opportunityGap,
    fairness: fairnessResult(input.fairness, input.currency, input.basis),
    nonClaims: Object.freeze([
      'Committed capacity is not an invoice and consumed capacity is not proof of provider billing.',
      'Allocated/showback spend is a policy-relative attribution, not chargeback or settlement.',
      'Avoidable and marginal amounts are declared scenarios, not causal or business-value claims.',
      'No external provider commitment, routing, budget, or payment action is authorized by this result.',
    ]),
  });
}
