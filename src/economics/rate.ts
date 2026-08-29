/** Exact rational rates with explicit source/target units and optional validity. */

import { formatMoneyAmount, money, type EconomicBasis, type Money } from './money.ts';
import type { TimeInterval } from '../epistemic/time.ts';

export interface ExactRateInput {
  readonly numerator: bigint;
  readonly denominator: bigint;
  readonly sourceUnit: string;
  readonly targetUnit: string;
  readonly validTime?: TimeInterval;
}

export interface ExactRate extends ExactRateInput {
  readonly denominator: bigint;
}

export interface ExactRateJson {
  readonly numerator: string;
  readonly denominator: string;
  readonly sourceUnit: string;
  readonly targetUnit: string;
  readonly validTime?: TimeInterval;
}

function nonEmpty(value: string, label: string): string {
  const normalized = value.trim();
  if (normalized.length === 0) throw new Error(`${label} must be non-empty`);
  return normalized;
}

function abs(value: bigint): bigint { return value < 0n ? -value : value; }
function gcd(a: bigint, b: bigint): bigint {
  let x = abs(a);
  let y = abs(b);
  while (y !== 0n) [x, y] = [y, x % y];
  return x;
}

export function exactRate(input: ExactRateInput): ExactRate {
  if (input.denominator === 0n) throw new Error('rate denominator must be non-zero');
  const sourceUnit = nonEmpty(input.sourceUnit, 'rate source unit');
  const targetUnit = nonEmpty(input.targetUnit, 'rate target unit');
  const sign = input.denominator < 0n ? -1n : 1n;
  let numerator = input.numerator * sign;
  let denominator = input.denominator * sign;
  const common = gcd(numerator, denominator);
  if (common !== 0n) {
    numerator /= common;
    denominator /= common;
  }
  return Object.freeze({ numerator, denominator, sourceUnit, targetUnit, ...(input.validTime ? { validTime: input.validTime } : {}) });
}

function terminatingDecimal(numerator: bigint, denominator: bigint): string | null {
  if (denominator <= 0n) throw new Error('internal denominator must be positive');
  if (numerator === 0n) return '0';
  const negative = numerator < 0n;
  let n = abs(numerator);
  let d = denominator;
  const common = gcd(n, d);
  n /= common;
  d /= common;

  let twos = 0;
  let fives = 0;
  while (d % 2n === 0n) { d /= 2n; twos += 1; }
  while (d % 5n === 0n) { d /= 5n; fives += 1; }
  if (d !== 1n) return null;

  const scale = Math.max(twos, fives);
  const scaled = n * (2n ** BigInt(scale - twos)) * (5n ** BigInt(scale - fives));
  const digits = scaled.toString().padStart(scale + 1, '0');
  if (scale === 0) return `${negative ? '-' : ''}${digits}`;
  const split = digits.length - scale;
  return `${negative ? '-' : ''}${digits.slice(0, split)}.${digits.slice(split)}`;
}

/**
 * Exact conversion only. If the rational result has a non-terminating decimal
 * representation, Fiscus refuses to invent a rounding mode or precision. A later
 * quantization API must make that policy explicit.
 */
export function applyExactRate(value: Money, rate: ExactRate, targetBasis: EconomicBasis): Money {
  if (value.currency !== rate.sourceUnit) {
    throw new Error(`rate source unit mismatch: ${rate.sourceUnit} cannot convert ${value.currency}`);
  }
  const sourceScale = 10n ** BigInt(value.scale);
  const numerator = value.coefficient * rate.numerator;
  const denominator = sourceScale * rate.denominator;
  const decimal = terminatingDecimal(numerator, denominator);
  if (decimal === null) throw new Error('non-terminating conversion requires an explicit quantization policy');
  return money(decimal, rate.targetUnit, targetBasis);
}

export function rateToJson(rate: ExactRate): ExactRateJson {
  return Object.freeze({
    numerator: rate.numerator.toString(),
    denominator: rate.denominator.toString(),
    sourceUnit: rate.sourceUnit,
    targetUnit: rate.targetUnit,
    ...(rate.validTime ? { validTime: rate.validTime } : {}),
  });
}

export function rateFromJson(value: ExactRateJson): ExactRate {
  if (!/^-?(?:0|[1-9]\d*)$/.test(value.numerator)) throw new Error('rate numerator must be a canonical integer string');
  if (!/^-?(?:0|[1-9]\d*)$/.test(value.denominator)) throw new Error('rate denominator must be a canonical integer string');
  return exactRate({
    numerator: BigInt(value.numerator),
    denominator: BigInt(value.denominator),
    sourceUnit: value.sourceUnit,
    targetUnit: value.targetUnit,
    ...(value.validTime ? { validTime: value.validTime } : {}),
  });
}

// Type-level import is intentionally exercised so refactors cannot silently
// change Money formatting assumptions used by rate tests.
void formatMoneyAmount;
