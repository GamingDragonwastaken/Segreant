/**
 * JSON serialization for Fiscus-owned wire surfaces.
 *
 * Monetary values are calculated from integer microdollar-oriented paths, but
 * aggregate SQLite/JavaScript arithmetic can expose a binary floating-point
 * tail when a response is serialized. Only numeric properties whose names end
 * in `Usd` are rounded to six decimal places here. Internal objects, hashes,
 * signatures, timestamps, ratios, and non-Fiscus payloads remain untouched.
 */

const MICRODOLLARS_PER_USD = 1_000_000;

function roundWireUsd(value: number): number {
  if (!Number.isFinite(value)) return value;
  const micros = Math.round(value * MICRODOLLARS_PER_USD);
  return Number.isSafeInteger(micros) ? micros / MICRODOLLARS_PER_USD : value;
}

/** Serialize a Fiscus-owned JSON response without leaking binary money tails. */
export function stringifyJson(value: unknown, space: number | string = 2): string {
  return JSON.stringify(value, (key, nested) => {
    if (typeof nested === 'number' && /Usd$/.test(key)) return roundWireUsd(nested);
    return nested;
  }, space);
}
