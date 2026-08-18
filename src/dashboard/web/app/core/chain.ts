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
  const runs = b?.reconciliation?.runs?.length ?? 0;
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
  //
  // The FIGURE, though, must be the value claim rather than a cost. The payload
  // carries two fields spelled `realizedValueUsd`: `matured.realizedValueUsd` is
  // the attributed SPEND on units that realized, and `roi.returnRatio
  // .realizedValueUsd` is the manual-equivalent VALUE those units produced. This
  // band sat on the first one, so the fourth claim in
  // `metered != billed != allocated != realized value` was rendering a cost --
  // the precise collapse the spine exists to refuse, committed by the spine.
  const v2 = v as {
    realization?: { matured?: { realizedUnits?: number; units?: number } };
    roi?: { returnRatio?: { realizedValueUsd?: number | null; basis?: string } | null };
  } | null;
  const matured = v2?.realization?.matured;
  const realizedUnits = matured?.realizedUnits ?? 0;
  const ret = v2?.roi?.returnRatio ?? null;
  // `basis: 'usd'` is the payload's own statement that the value figure is
  // priced. Without it there is a ratio but no dollars, and a dollar figure must
  // not be invented from one.
  const valued = ret?.basis === 'usd' && typeof ret.realizedValueUsd === 'number';

  const realized: Layer = {
    id: 'realized',
    label: 'Realized',
    claim: 'what it produced',
    valueUsd: valued ? (ret?.realizedValueUsd ?? null) : null,
    established: realizedUnits > 0 && valued,
    basis: realizedUnits === 0
      ? 'no work units have matured into verified outcomes'
      : valued
        ? `${realizedUnits} of ${matured?.units ?? 0} matured units shipped and survived; manual-equivalent value, net of rework`
        : `${realizedUnits} of ${matured?.units ?? 0} units matured, but no labour rate is set to price what they produced`,
    nextStep: realizedUnits === 0
      ? 'Connect a repository so outcomes can be observed.'
      : valued
        ? undefined
        : 'Set a labour rate so realized work can be priced.',
  };

  return [metered, billed, allocated, realized];
}
