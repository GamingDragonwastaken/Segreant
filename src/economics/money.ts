/**
 * Exact monetary amount for the accounting core.
 *
 * Coefficients are arbitrary-precision integers and `scale` is the number of
 * decimal places. No binary floating-point number is accepted at this boundary.
 * Economic basis is part of the type-level runtime identity: billed dollars may
 * not be silently added to allocated/list-price dollars merely because both are
 * denominated in USD.
 */

export const ECONOMIC_BASES = [
  'list',
  'estimated',
  'provider_observed',
  'billed',
  'effective',
  'allocated',
  'full_cost',
] as const;

export type EconomicBasis = (typeof ECONOMIC_BASES)[number];

export interface Money {
  readonly coefficient: bigint;
  readonly scale: number;
  readonly currency: string;
  readonly basis: EconomicBasis;
}

export interface MoneyJson {
  readonly coefficient: string;
  readonly scale: number;
  readonly currency: string;
  readonly basis: EconomicBasis;
}

/**
 * Resource limits are part of the untrusted interchange boundary.  Exact
 * arithmetic remains arbitrary precision within these deliberately generous
 * limits, while malformed input cannot request an unbounded power of ten or
 * an impractically large coefficient before validation has a chance to fail.
 */
export const MAX_MONEY_SCALE = 1_000;
export const MAX_MONEY_COEFFICIENT_DIGITS = 16_384;

const PLAIN_DECIMAL = /^-?(?:0|[1-9]\d*)(?:\.(\d+))?$/;
const CURRENCY = /^[A-Z]{3}$/;
const BASIS_SET = new Set<string>(ECONOMIC_BASES);
const MONEY_KEYS = new Set(['coefficient', 'scale', 'currency', 'basis']);

function assertCurrency(currency: string): string {
  if (typeof currency !== 'string') throw new Error('currency must be a three-letter uppercase code');
  if (!CURRENCY.test(currency)) throw new Error(`currency must be a three-letter uppercase code: ${currency}`);
  return currency;
}

function assertBasis(basis: string): asserts basis is EconomicBasis {
  if (typeof basis !== 'string') throw new Error(`unsupported economic basis: ${String(basis)}`);
  if (!BASIS_SET.has(basis)) throw new Error(`unsupported economic basis: ${basis}`);
}

function pow10(exponent: number): bigint {
  if (!Number.isSafeInteger(exponent) || exponent < 0 || exponent > MAX_MONEY_SCALE) {
    throw new Error(`decimal scale must be between 0 and ${MAX_MONEY_SCALE}`);
  }
  return 10n ** BigInt(exponent);
}

function assertScale(scale: number): void {
  if (!Number.isSafeInteger(scale) || scale < 0 || scale > MAX_MONEY_SCALE) {
    throw new Error(`money scale must be between 0 and ${MAX_MONEY_SCALE}`);
  }
}

function coefficientDigits(coefficient: bigint): number {
  return (coefficient < 0n ? -coefficient : coefficient).toString().length;
}

function assertCoefficientSize(coefficient: bigint): void {
  if (coefficientDigits(coefficient) > MAX_MONEY_COEFFICIENT_DIGITS) {
    throw new Error(`money coefficient exceeds the ${MAX_MONEY_COEFFICIENT_DIGITS}-digit limit`);
  }
}

function normalize(coefficient: bigint, scale: number, currency: string, basis: EconomicBasis): Money {
  assertScale(scale);
  assertCoefficientSize(coefficient);
  let nextCoefficient = coefficient;
  let nextScale = scale;
  if (nextCoefficient === 0n) nextScale = 0;
  while (nextScale > 0 && nextCoefficient % 10n === 0n) {
    nextCoefficient /= 10n;
    nextScale -= 1;
  }
  return Object.freeze({ coefficient: nextCoefficient, scale: nextScale, currency, basis });
}

export function money(amount: string, currency: string, basis: EconomicBasis): Money {
  if (typeof amount !== 'string') throw new Error('money amount must be a plain decimal string');
  const match = PLAIN_DECIMAL.exec(amount);
  if (!match) throw new Error(`money amount must be a plain decimal string: ${amount}`);
  const canonicalCurrency = assertCurrency(currency);
  assertBasis(basis);

  const negative = amount.startsWith('-');
  const unsigned = negative ? amount.slice(1) : amount;
  const [whole = '0', fraction = ''] = unsigned.split('.');
  const scale = fraction.length;
  assertScale(scale);
  const digits = `${whole}${fraction}`;
  if (digits.length > MAX_MONEY_COEFFICIENT_DIGITS) {
    throw new Error(`money coefficient exceeds the ${MAX_MONEY_COEFFICIENT_DIGITS}-digit limit`);
  }
  let coefficient = BigInt(digits);
  if (negative) coefficient = -coefficient;
  return normalize(coefficient, scale, canonicalCurrency, basis);
}

function assertCompatible(a: Money, b: Money): void {
  if (a.currency !== b.currency) throw new Error(`money currency mismatch: ${a.currency} != ${b.currency}`);
  if (a.basis !== b.basis) throw new Error(`money economic basis mismatch: ${a.basis} != ${b.basis}`);
}

function alignedCoefficients(a: Money, b: Money): readonly [bigint, bigint, number] {
  assertCompatible(a, b);
  const scale = Math.max(a.scale, b.scale);
  return [
    a.coefficient * pow10(scale - a.scale),
    b.coefficient * pow10(scale - b.scale),
    scale,
  ] as const;
}

export function addMoney(a: Money, b: Money): Money {
  const [ac, bc, scale] = alignedCoefficients(a, b);
  return normalize(ac + bc, scale, a.currency, a.basis);
}

export function negateMoney(value: Money): Money {
  return normalize(-value.coefficient, value.scale, value.currency, value.basis);
}

export function subtractMoney(a: Money, b: Money): Money {
  return addMoney(a, negateMoney(b));
}

export function compareMoney(a: Money, b: Money): -1 | 0 | 1 {
  const [ac, bc] = alignedCoefficients(a, b);
  if (ac < bc) return -1;
  if (ac > bc) return 1;
  return 0;
}

export function formatMoneyAmount(value: Money): string {
  const negative = value.coefficient < 0n;
  const digits = (negative ? -value.coefficient : value.coefficient).toString();
  if (value.scale === 0) return `${negative ? '-' : ''}${digits}`;
  const padded = digits.padStart(value.scale + 1, '0');
  const split = padded.length - value.scale;
  return `${negative ? '-' : ''}${padded.slice(0, split)}.${padded.slice(split)}`;
}

export function moneyToJson(value: Money): MoneyJson {
  return Object.freeze({
    coefficient: value.coefficient.toString(),
    scale: value.scale,
    currency: value.currency,
    basis: value.basis,
  });
}

export function moneyFromJson(value: MoneyJson): Money {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('money JSON must be an object');
  }
  const keys = Object.keys(value);
  for (const key of keys) if (!MONEY_KEYS.has(key)) throw new Error(`money JSON contains unknown field: ${key}`);
  for (const key of MONEY_KEYS) if (!Object.prototype.hasOwnProperty.call(value, key)) {
    throw new Error(`money JSON is missing field: ${key}`);
  }
  if (typeof value.coefficient !== 'string' || !/^-?(?:0|[1-9]\d*)$/.test(value.coefficient)) {
    throw new Error('money coefficient must be a canonical integer string');
  }
  if (value.coefficient === '-0') throw new Error('money coefficient must use canonical zero');
  const unsignedCoefficient = value.coefficient.startsWith('-') ? value.coefficient.slice(1) : value.coefficient;
  if (unsignedCoefficient.length > MAX_MONEY_COEFFICIENT_DIGITS) {
    throw new Error(`money coefficient exceeds the ${MAX_MONEY_COEFFICIENT_DIGITS}-digit limit`);
  }
  assertScale(value.scale);
  const currency = assertCurrency(value.currency);
  assertBasis(value.basis);
  const parsed = normalize(BigInt(value.coefficient), value.scale, currency, value.basis);
  if (parsed.coefficient.toString() !== value.coefficient || parsed.scale !== value.scale) {
    throw new Error('money JSON must use normalized coefficient and scale');
  }
  return parsed;
}
