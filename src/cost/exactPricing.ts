/**
 * Exact local pricing boundary.
 *
 * The legacy cost engine intentionally returns JavaScript numbers for its
 * compatibility surfaces. This module is the stricter path used by accounting
 * and economic-event code: rates arrive as canonical decimal strings, token
 * counts are safe integers, and every component is returned as exact Money.
 * Numeric rates are refused instead of being rounded into a misleading claim
 * of exactness.
 */

import { addMoney, formatMoneyAmount, money, type EconomicBasis, type Money } from '../economics/money.ts';
import { applyExactRate, exactRate } from '../economics/rate.ts';

export interface ExactModelRate {
  /** USD per 1,000,000 uncached input tokens. */
  readonly input: string;
  /** USD per 1,000,000 output tokens. */
  readonly output: string;
  /** USD per 1,000,000 tokens written to a five-minute cache. */
  readonly cache_write_5m?: string;
  /** USD per 1,000,000 tokens written to a one-hour cache. */
  readonly cache_write_1h?: string;
  /** USD per 1,000,000 tokens read from cache. */
  readonly cache_read?: string;
}

export interface ExactNormalizedUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheWriteTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheWriteTtl?: '5m' | '1h';
  readonly reasoningTokens?: number;
}

export interface ExactCostBreakdown {
  readonly total: Money;
  readonly components: Readonly<{
    input: Money;
    output: Money;
    cacheWrite: Money;
    cacheRead: Money;
  }>;
}

const RATE_KEYS = new Set(['input', 'output', 'cache_write_5m', 'cache_write_1h', 'cache_read']);
const USAGE_KEYS = new Set(['inputTokens', 'outputTokens', 'cacheWriteTokens', 'cacheReadTokens', 'cacheWriteTtl', 'reasoningTokens']);

function assertObject(value: unknown, label: string): asserts value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`);
  for (const key of Object.keys(value)) {
    if (key === '__proto__' || key === 'constructor' || key === 'prototype') throw new Error(`${label} contains unsafe field: ${key}`);
  }
}

function requireField(value: Record<string, unknown>, field: string, label: string): unknown {
  if (!Object.prototype.hasOwnProperty.call(value, field)) throw new Error(`${label} is missing field: ${field}`);
  return value[field];
}

function positiveRate(value: unknown, label: string, basis: EconomicBasis): string {
  if (typeof value !== 'string') throw new Error(`${label} must be a canonical decimal string`);
  const parsed = money(value, 'USD', basis);
  if (parsed.coefficient <= 0n) throw new Error(`${label} must be positive`);
  return formatMoneyAmount(parsed);
}

function canonicalRateSet(value: ExactModelRate, basis: EconomicBasis): ExactModelRate {
  assertObject(value, 'exact model rate');
  for (const key of Object.keys(value)) if (!RATE_KEYS.has(key)) throw new Error(`exact model rate contains unknown field: ${key}`);
  const input = positiveRate(requireField(value, 'input', 'exact model rate'), 'exact model rate input', basis);
  const output = positiveRate(requireField(value, 'output', 'exact model rate'), 'exact model rate output', basis);
  const cacheWrite5m = value.cache_write_5m === undefined
    ? undefined
    : positiveRate(value.cache_write_5m, 'exact model rate cache_write_5m', basis);
  const cacheWrite1h = value.cache_write_1h === undefined
    ? undefined
    : positiveRate(value.cache_write_1h, 'exact model rate cache_write_1h', basis);
  const cacheRead = value.cache_read === undefined
    ? undefined
    : positiveRate(value.cache_read, 'exact model rate cache_read', basis);
  return Object.freeze({
    input,
    output,
    ...(cacheWrite5m === undefined ? {} : { cache_write_5m: cacheWrite5m }),
    ...(cacheWrite1h === undefined ? {} : { cache_write_1h: cacheWrite1h }),
    ...(cacheRead === undefined ? {} : { cache_read: cacheRead }),
  });
}

function tokenCount(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative safe integer`);
  }
  return value;
}

function canonicalUsage(value: ExactNormalizedUsage): ExactNormalizedUsage {
  assertObject(value, 'exact normalized usage');
  for (const key of Object.keys(value)) if (!USAGE_KEYS.has(key)) throw new Error(`exact normalized usage contains unknown field: ${key}`);
  const inputTokens = tokenCount(requireField(value, 'inputTokens', 'exact normalized usage'), 'exact normalized usage inputTokens');
  const outputTokens = tokenCount(requireField(value, 'outputTokens', 'exact normalized usage'), 'exact normalized usage outputTokens');
  const cacheWriteTokens = tokenCount(requireField(value, 'cacheWriteTokens', 'exact normalized usage'), 'exact normalized usage cacheWriteTokens');
  const cacheReadTokens = tokenCount(requireField(value, 'cacheReadTokens', 'exact normalized usage'), 'exact normalized usage cacheReadTokens');
  const cacheWriteTtl = value.cacheWriteTtl;
  if (cacheWriteTtl !== undefined && cacheWriteTtl !== '5m' && cacheWriteTtl !== '1h') {
    throw new Error('exact normalized usage cacheWriteTtl must be 5m or 1h');
  }
  if (value.reasoningTokens !== undefined) tokenCount(value.reasoningTokens, 'exact normalized usage reasoningTokens');
  return Object.freeze({
    inputTokens,
    outputTokens,
    cacheWriteTokens,
    cacheReadTokens,
    ...(cacheWriteTtl === undefined ? {} : { cacheWriteTtl }),
    ...(value.reasoningTokens === undefined ? {} : { reasoningTokens: value.reasoningTokens }),
  });
}

function multiplyRate(rateText: string, numerator: bigint, denominator: bigint, basis: EconomicBasis): string {
  const value = money(rateText, 'USD', basis);
  const multiplier = exactRate({ numerator, denominator, sourceUnit: 'USD', targetUnit: 'USD' });
  return formatMoneyAmount(applyExactRate(value, multiplier, basis));
}

function costForTokens(rateText: string, tokens: number, basis: EconomicBasis): Money {
  const perMillion = money(rateText, 'USD', basis);
  const perToken = exactRate({
    numerator: perMillion.coefficient,
    denominator: (10n ** BigInt(perMillion.scale)) * 1_000_000n,
    sourceUnit: 'TOK',
    targetUnit: 'USD',
  });
  return applyExactRate(money(String(tokens), 'TOK', 'list'), perToken, basis);
}

/** Compute a token-cost breakdown using only exact decimal/rational arithmetic. */
export function computeExactCost(
  rate: ExactModelRate,
  usage: ExactNormalizedUsage,
  basis: EconomicBasis = 'list',
): ExactCostBreakdown {
  const exactRateSet = canonicalRateSet(rate, basis);
  const exactUsage = canonicalUsage(usage);
  const writeRate = exactUsage.cacheWriteTtl === '1h'
    ? exactRateSet.cache_write_1h ?? multiplyRate(exactRateSet.input, 2n, 1n, basis)
    : exactRateSet.cache_write_5m ?? multiplyRate(exactRateSet.input, 5n, 4n, basis);
  const readRate = exactRateSet.cache_read ?? multiplyRate(exactRateSet.input, 1n, 10n, basis);
  const components = Object.freeze({
    input: costForTokens(exactRateSet.input, exactUsage.inputTokens, basis),
    output: costForTokens(exactRateSet.output, exactUsage.outputTokens, basis),
    cacheWrite: costForTokens(writeRate, exactUsage.cacheWriteTokens, basis),
    cacheRead: costForTokens(readRate, exactUsage.cacheReadTokens, basis),
  });
  const total = addMoney(
    addMoney(components.input, components.output),
    addMoney(components.cacheWrite, components.cacheRead),
  );
  return Object.freeze({ total, components });
}

/** Validate one optional rate without computing a request. */
export function validateExactModelRate(rate: ExactModelRate, basis: EconomicBasis = 'list'): ExactModelRate {
  return canonicalRateSet(rate, basis);
}

/** Canonicalize usage for callers that want a validation-only boundary. */
export function validateExactUsage(usage: ExactNormalizedUsage): ExactNormalizedUsage {
  return canonicalUsage(usage);
}
