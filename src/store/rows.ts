/**
 * Row decoders shared by more than one store domain.
 *
 * Split out of db.ts so a domain module can decode a column set without
 * importing the facade back (which would make the module graph circular). Only
 * helpers that genuinely have two or more domain callers belong here — a
 * decoder used by one domain lives with that domain.
 */

import { legacyPricingEvidence, type RequestPricingEvidence } from '../cost/pricing.ts';

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
    costBasis: typeof costBasis === 'string' ? costBasis as RequestPricingEvidence['costBasis'] : fallback.costBasis,
    rateCardSha256: typeof rateCardSha256 === 'string' ? rateCardSha256 : null,
    rateCardSourceKind: typeof rateCardSourceKind === 'string'
      ? rateCardSourceKind as RequestPricingEvidence['rateCardSourceKind']
      : fallback.rateCardSourceKind,
    rateMatchKind: typeof rateMatchKind === 'string' ? rateMatchKind as RequestPricingEvidence['rateMatchKind'] : fallback.rateMatchKind,
    rateMatchProvider: typeof rateMatchProvider === 'string' ? rateMatchProvider : null,
    rateMatchModel: typeof rateMatchModel === 'string' ? rateMatchModel : null,
  };
}
