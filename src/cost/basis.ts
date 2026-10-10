/**
 * How a total was priced, in parts — the one basis read model for every surface.
 *
 * The ledger records, per request, what kind of number its amount is (cost
 * basis) and how its model was matched against the rate card. Totals used to
 * throw that away: `today`, `week` and `month` called every dollar "priced from
 * the rate card", so an amount opencode reported for a model the card does not
 * know was printed as API list price, and a model missing from the card (priced
 * at the generic fallback rate) sat inside a headline with nothing to say so.
 *
 * `summarizeBasis` keeps the parts. Every surface prints a total together with
 * the cohorts that make it up, and the headline word follows the weakest part:
 * a total is "list cost" only when every dollar in it was priced from a model's
 * own rate on the card.
 *
 * Pure: it takes rows a store read already produced. No surface computes this
 * itself, so the CLI and the dashboard cannot describe one total two ways.
 */

import type { CostBasis, RateMatchKind } from './pricing.ts';

/** One store row: an amount, grouped by how it was priced. */
export interface BasisRow {
  provider: string;
  model: string;
  costBasis: CostBasis | string;
  rateMatchKind: RateMatchKind | string;
  requests: number;
  costUsd: number;
}

/**
 * The parts a total can be made of, strongest first. Exact and family matches
 * share a cost basis in the ledger (`local_list_price`), but a family match
 * prices one model at another's rate, so the two are kept apart here.
 */
export const BASIS_COHORTS = [
  'list_exact',
  'list_family',
  'fallback',
  'tool_reported',
  'demo',
  'unpriced',
  'unrecorded',
] as const;
export type BasisCohortId = (typeof BASIS_COHORTS)[number];

export interface BasisCohort {
  id: BasisCohortId;
  costUsd: number;
  requests: number;
  /** Short label for a table cell or a chip. */
  label: string;
  /** One sentence saying what this part of the total is. */
  meaning: string;
  /** Models in this part, costliest first (at most five), so a reader can see what fell back. */
  models: Array<{ provider: string; model: string; costUsd: number; requests: number }>;
}

export type BasisHeadline = 'list_cost' | 'estimated_cost' | 'sample_cost' | 'tool_reported_cost' | 'no_cost';

export interface BasisSummary {
  totalUsd: number;
  requests: number;
  headline: BasisHeadline;
  /** The word for the total: "List cost", "Estimated cost", "Sample cost", "Tool-reported cost", or "Cost". */
  headlineLabel: string;
  /** Cohorts with any requests, strongest first. */
  cohorts: BasisCohort[];
  /** Share of the dollar total priced at a model's own card rate (0..1), or null with no dollars. */
  exactShare: number | null;
  /** The sentence that travels with every basis summary. */
  boundary: string;
}

export const BASIS_BOUNDARY =
  'None of these amounts is a provider bill. List price is what the use would cost at the provider\'s published API rates; a plan, discount, credit or tax is not in it.';

const TEXT: Record<BasisCohortId, { label: string; meaning: string }> = {
  list_exact: {
    label: 'list price',
    meaning: "priced at the model's own published API rate on the rate card",
  },
  list_family: {
    label: 'list price, nearest model',
    meaning: 'the model is not on the rate card by name; priced at the rate of the closest model that is',
  },
  fallback: {
    label: 'fallback rate',
    meaning: 'the model is not on the rate card; priced at a generic mid-tier rate, a rough estimate',
  },
  tool_reported: {
    label: 'tool-reported',
    meaning: 'the amount the tool itself recorded; Segreant has not verified it against any rate card or bill',
  },
  demo: {
    label: 'sample data',
    meaning: 'synthetic demo data, not measured on this machine',
  },
  unpriced: {
    label: 'not priced',
    meaning: 'no rate applies (for example a custom provider); counted in requests, not in dollars',
  },
  unrecorded: {
    label: 'basis not recorded',
    meaning: 'recorded before Segreant kept how each amount was priced',
  },
};

export function cohortOf(row: Pick<BasisRow, 'costBasis' | 'rateMatchKind'>): BasisCohortId {
  switch (row.costBasis) {
    case 'local_list_price':
      return row.rateMatchKind === 'exact_provider' || row.rateMatchKind === 'exact_cross_provider'
        ? 'list_exact'
        : 'list_family';
    case 'fallback_estimate': return 'fallback';
    case 'tool_reported_unverified': return 'tool_reported';
    case 'synthetic_demo': return 'demo';
    case 'unpriced': return 'unpriced';
    default: return 'unrecorded';
  }
}

export function summarizeBasis(rows: readonly BasisRow[]): BasisSummary {
  const by = new Map<BasisCohortId, BasisCohort>();
  let totalUsd = 0;
  let requests = 0;
  for (const row of rows) {
    if (row.requests <= 0) continue;
    const id = cohortOf(row);
    let c = by.get(id);
    if (!c) {
      c = { id, costUsd: 0, requests: 0, ...TEXT[id], models: [] };
      by.set(id, c);
    }
    c.costUsd += row.costUsd;
    c.requests += row.requests;
    const m = c.models.find((x) => x.provider === row.provider && x.model === row.model);
    if (m) {
      m.costUsd += row.costUsd;
      m.requests += row.requests;
    } else {
      c.models.push({ provider: row.provider, model: row.model, costUsd: row.costUsd, requests: row.requests });
    }
    totalUsd += row.costUsd;
    requests += row.requests;
  }
  const cohorts = BASIS_COHORTS.flatMap((id) => {
    const c = by.get(id);
    if (!c) return [];
    c.models.sort((a, b) => b.costUsd - a.costUsd || b.requests - a.requests);
    c.models = c.models.slice(0, 5);
    return [c];
  });
  const has = (id: BasisCohortId): boolean => by.has(id);
  const only = (...ids: BasisCohortId[]): boolean => cohorts.length > 0 && cohorts.every((c) => ids.includes(c.id));
  const headline: BasisHeadline = cohorts.length === 0
    ? 'no_cost'
    : only('demo')
      ? 'sample_cost'
      : only('tool_reported', 'unpriced') && has('tool_reported')
        ? 'tool_reported_cost'
        : only('list_exact', 'list_family', 'unpriced') && (has('list_exact') || has('list_family'))
          ? 'list_cost'
          : 'estimated_cost';
  const exact = by.get('list_exact')?.costUsd ?? 0;
  return {
    totalUsd,
    requests,
    headline,
    headlineLabel: HEADLINE_LABEL[headline],
    cohorts,
    exactShare: totalUsd > 0 ? exact / totalUsd : null,
    boundary: BASIS_BOUNDARY,
  };
}

const HEADLINE_LABEL: Record<BasisHeadline, string> = {
  list_cost: 'List cost',
  estimated_cost: 'Estimated cost',
  sample_cost: 'Sample cost',
  tool_reported_cost: 'Tool-reported cost',
  no_cost: 'Cost',
};

/** "gpt-6.1-sol, codex-auto-review and 2 more" — the models a cohort holds, for one line of text. */
export function cohortModels(c: Pick<BasisCohort, 'models' | 'requests'>, shown = 2): string {
  const names = c.models.map((m) => m.model);
  if (names.length <= shown) return names.join(', ');
  return `${names.slice(0, shown).join(', ')} and ${names.length - shown} more`;
}
