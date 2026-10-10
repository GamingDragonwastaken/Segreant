/**
 * The lines that say how a CLI total was priced. Every command that prints a
 * total with more than one part prints these under it, so the parts read the
 * same everywhere (`today`, `week`, `month`, the first-run summary).
 */

import { cohortModels, type BasisSummary } from '../cost/basis.ts';
import { num, usd } from './ui.ts';

export function basisLines(basis: BasisSummary, indent = '              '): string[] {
  const out: string[] = [];
  for (const c of basis.cohorts) {
    if (c.id === 'unpriced') {
      out.push(`${indent}${num(c.requests)} requests not priced: ${cohortModels(c)} (no rate applies)`);
      continue;
    }
    if (c.id === 'tool_reported' && c.costUsd < 0.005) {
      // A free model is a real answer ("the tool said $0"), not a missing price.
      out.push(`${indent}${''.padStart(10)}  ${num(c.requests)} requests the tool reported at no charge: ${cohortModels(c)}`);
      continue;
    }
    const models = c.id === 'fallback' || c.id === 'list_family' || c.id === 'unrecorded'
      ? `: ${cohortModels(c)}`
      : '';
    out.push(`${indent}${usd(c.costUsd).padStart(10)}  ${c.label}${models}`);
  }
  if (basis.cohorts.some((c) => c.id === 'fallback')) {
    out.push(`${indent}            fallback = the model was not on the rate card when imported; a generic rate, a rough estimate`);
    out.push(`${indent}            segreant reprice  previews new prices for models the card has learned since (nothing changes without --apply)`);
  }
  if (basis.cohorts.some((c) => c.id === 'tool_reported')) {
    out.push(`${indent}            tool-reported = what the tool recorded; not checked against any rate card or bill`);
  }
  out.push(`${indent}None of these is your bill.`);
  return out;
}
