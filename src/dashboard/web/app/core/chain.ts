/**
 * Builds the four-layer evidence chain from the live payloads.
 *
 * The rule this module exists to enforce: a layer is `established` only when
 * evidence actually substantiates it. Not when the API returned a number, not
 * when the number is zero, not when a related feature exists. An unestablished
 * layer reports what is missing and what would close the gap — because the most
 * useful thing this product can tell an operator is where their evidence stops.
 */

import { api } from './api.ts';
import type { Layer } from '../components/spine.ts';

export async function loadChain(range: string): Promise<Layer[]> {
  // Independent reads: one slow endpoint should not delay the whole spine, and a
  // failing one should degrade its own layer rather than the page.
  const [overview, billing, allocation, value] = await Promise.allSettled([
    api.overview(range),
    api.billing(),
    api.allocation(),
    api.value(),
  ]);

  const ok = <T,>(r: PromiseSettledResult<T>): T | null => (r.status === 'fulfilled' ? r.value : null);

  const o = ok(overview);
  const b = ok(billing);
  const a = ok(allocation);
  const v = ok(value);

  const metered: Layer = {
    id: 'metered',
    label: 'Metered',
    claim: 'what we observed',
    valueUsd: o?.summary.costUsd ?? null,
    established: o !== null,
    basis: o === null
      ? 'could not read the ledger'
      : 'counted from requests, priced from a rate card',
    nextStep: o === null ? 'Check that Fiscus is running.' : undefined,
  };

  // Billed is established only by a recorded reconciliation run. Holding
  // provider records is not the same claim — an imported bill nobody compared
  // against anything proves only that a file was read.
  const runs = b?.reconciliation?.runs ?? 0;
  const billed: Layer = {
    id: 'billed',
    label: 'Billed',
    claim: 'what the provider charged',
    valueUsd: null,
    established: runs > 0,
    basis: runs > 0
      ? 'reconciled against a provider report, with a residual'
      : b && b.summary.recordCount > 0
        ? `${b.summary.recordCount} provider records held, none reconciled yet`
        : 'no provider bill has been compared against this ledger',
    nextStep: runs > 0 ? undefined : 'Check readiness in Evidence before spending a credential on it.',
  };

  const allocRuns = Array.isArray(a?.runs) ? a.runs.length : 0;
  const centres = Array.isArray(a?.costCentres) ? a.costCentres.length : 0;
  const allocated: Layer = {
    id: 'allocated',
    label: 'Allocated',
    claim: 'whose cost it is',
    valueUsd: null,
    established: allocRuns > 0,
    basis: allocRuns > 0
      ? 'apportioned by recorded rules — showback only'
      : centres > 0
        ? `${centres} cost centre${centres === 1 ? '' : 's'} defined, no allocation recorded`
        : 'no cost centres and no rules yet',
    nextStep: allocRuns > 0 ? undefined : 'Define a cost centre, then run an allocation.',
  };

  // Realized value counts only MATURED units that actually shipped. A proposal
  // that was accepted but never survived is not value; conflating the two is the
  // headline number every other tool in this category reports.
  const matured = (v as { realization?: { matured?: { realizedUnits?: number; realizedValueUsd?: number; units?: number } } } | null)?.realization?.matured;
  const realizedUnits = matured?.realizedUnits ?? 0;
  const realized: Layer = {
    id: 'realized',
    label: 'Realized',
    claim: 'what it produced',
    valueUsd: matured?.realizedValueUsd ?? null,
    established: realizedUnits > 0 && typeof matured?.realizedValueUsd === 'number',
    basis: realizedUnits > 0
      ? `${realizedUnits} of ${matured?.units ?? 0} matured units shipped and survived`
      : 'no work units have matured into verified outcomes',
    nextStep: realizedUnits > 0 ? undefined : 'Connect a repository so outcomes can be observed.',
  };

  return [metered, billed, allocated, realized];
}
