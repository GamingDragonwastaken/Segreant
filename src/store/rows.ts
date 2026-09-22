/**
 * Row decoders shared by more than one store domain.
 *
 * Split out of db.ts so a domain module can decode a column set without
 * importing the facade back (which would make the module graph circular). Only
 * helpers that genuinely have two or more domain callers belong here — a
 * decoder used by one domain lives with that domain.
 */

import {
  COST_BASES,
  RATE_CARD_SOURCE_KINDS,
  RATE_MATCH_KINDS,
  legacyPricingEvidence,
  type RequestPricingEvidence,
} from '../cost/pricing.ts';

/**
 * A provenance column is `TEXT NOT NULL` with the legacy sentinel as its
 * default, so a selected column holds a string from its vocabulary or the row
 * is damaged. `undefined` means the query did not select the column and reads
 * as the sentinel; `null`, a number, or a string outside the vocabulary was
 * never written by any Fiscus path and refuses rather than reading as the
 * sentinel — laundering corruption into "unknown" would hide it behind the one
 * label the column exists to keep honest (D-251).
 */
export function vocabularyValue<const T extends readonly string[]>(
  value: unknown,
  vocabulary: T,
  column: string,
  fallback: T[number],
): T[number] {
  if (value === undefined) return fallback;
  if (typeof value === 'string' && (vocabulary as readonly string[]).includes(value)) return value as T[number];
  throw new Error(`ledger integrity: column ${column} holds an unrecognized value ${JSON.stringify(value)}; no Fiscus writer produces it, so the row is damaged or tampered`);
}

/**
 * Read the six pricing-provenance columns off a row.
 *
 * `prefix` selects which copy: request rows carry them unprefixed, while a
 * price event carries a `previous`/`new` pair side by side. Anything missing or
 * non-textual falls back to the legacy sentinel rather than to a plausible
 * value — a basis inferred from context is exactly the failure these columns
 * exist to prevent.
 */
export function pricingEvidenceFromRecord(record: Record<string, unknown>, prefix = ''): RequestPricingEvidence {
  const fallback = legacyPricingEvidence();
  const value = (name: string): unknown => record[prefix ? `${prefix}${name}` : `${name[0]!.toLowerCase()}${name.slice(1)}`];
  const costBasis = value('CostBasis');
  const rateCardSha256 = value('RateCardSha256');
  const rateCardSourceKind = value('RateCardSourceKind');
  const rateMatchKind = value('RateMatchKind');
  const rateMatchProvider = value('RateMatchProvider');
  const rateMatchModel = value('RateMatchModel');
  return {
    costBasis: vocabularyValue(costBasis, COST_BASES, `${prefix}costBasis`, fallback.costBasis),
    rateCardSha256: typeof rateCardSha256 === 'string' ? rateCardSha256 : null,
    rateCardSourceKind: vocabularyValue(rateCardSourceKind, RATE_CARD_SOURCE_KINDS, `${prefix}rateCardSourceKind`, fallback.rateCardSourceKind),
    rateMatchKind: vocabularyValue(rateMatchKind, RATE_MATCH_KINDS, `${prefix}rateMatchKind`, fallback.rateMatchKind),
    rateMatchProvider: typeof rateMatchProvider === 'string' ? rateMatchProvider : null,
    rateMatchModel: typeof rateMatchModel === 'string' ? rateMatchModel : null,
  };
}
