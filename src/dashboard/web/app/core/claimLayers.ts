/**
 * Derives the four claims, and their evidence, from the live payloads.
 *
 * The rule this module exists to enforce: a layer is `established` only when
 * evidence actually substantiates it. Not when the API returned a number, not
 * when the number is zero, not when a related feature exists. An unestablished
 * layer reports what is missing and what would close the gap — because the most
 * useful thing this product can tell an operator is where their evidence stops.
 *
 * This is a PURE function of four payloads. The fetching lives in `chain.ts`,
 * which is the half that can fail per-endpoint; the split exists so that the
 * derivation — which is where the product's claims are actually made, and so
 * where a mistake is most expensive — can be tested against fixtures with no
 * server, no sockets, and no ledger. Every `null` input here means "that
 * endpoint did not answer", and each layer degrades on its own.
 */

import type { Overview, BillingPayload, AllocationPayload, ValuePayload } from './api.ts';
import type { Layer } from './claimTypes.ts';

export interface ClaimInputs {
  overview: Overview | null;
  billing: BillingPayload | null;
  allocation: AllocationPayload | null;
  value: ValuePayload | null;
}

/**
 * Freshness is either a real recorded instant or the words "not established".
 * It is never `new Date()` — a timestamp invented at render time would report
 * the age of the screen as the age of the evidence.
 */
const iso = (ms: number | null | undefined): string =>
  typeof ms === 'number' ? new Date(ms).toISOString() : 'not established';

export function buildClaimLayers(input: ClaimInputs, range: string): Layer[] {
  const { overview: o, billing: b, allocation: a, value: v } = input;

  const estimatedShare = o?.pricing.estimatedSpendShare ?? null;
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
    inspection: {
      provenance: 'local request ledger + recorded pricing basis',
      scope: o ? `${range}; ${o.summary.requests} recorded request(s)` : range,
      freshness: o?.generatedAt ?? 'not established',
      coverage: estimatedShare === null
        ? 'pricing coverage unavailable'
        : `${Math.round((1 - estimatedShare) * 100)}% of spend priced from a matched rate card, not estimated`,
      // The distinction the whole product is built on, stated where someone is
      // most likely to reach for the metered figure as if it were the bill.
      enforceability: 'observation claim; local caps can govern future in-path requests, but metered cost does not become billed cost',
      evidenceSource: 'local request ledger',
      assumptions: ['Rate-card cost is an estimate unless provider billing evidence establishes a billed amount.'],
      missingEvidence: o === null
        ? ['a readable local ledger']
        : estimatedShare !== null && estimatedShare > 0
          ? ['exact rate-card matches for the estimated rows']
          : [],
    },
  };

  // Billed is established only by a recorded reconciliation run. Holding
  // provider records is not the same claim — an imported bill nobody compared
  // against anything proves only that a file was read.
  //
  // `.length`, not the array itself. `runs` is the immutable run COLLECTION the
  // server sends; comparing the array to 0 coerced it through NaN, so Billed
  // read "not established" even with reconciliations recorded.
  const latestRun = b?.reconciliation?.runs?.[0] ?? null;
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
    inspection: {
      provenance: latestRun?.result.providerSourceKind
        ?? (b && b.summary.recordCount > 0 ? 'operator-supplied provider evidence, unreconciled' : 'none'),
      scope: latestRun ? `reconciliation run ${latestRun.reconciliationRunId}` : 'no reconciled provider scope',
      freshness: latestRun ? iso(latestRun.computedAtMs) : 'not established',
      coverage: b
        ? `${b.summary.recordCount} provider evidence record(s); ${runs} reconciliation run(s)`
        : 'billing endpoint unavailable',
      enforceability: 'evidence claim only; a reconciliation changes neither provider billing nor local caps',
      evidenceSource: latestRun?.result.providerSourceKind ?? 'provider evidence not established',
      // The provider report's own conditions ARE the assumptions. An export the
      // operator typed in and a provider-authenticated pull are both "billed"
      // here, and only this line distinguishes them.
      assumptions: latestRun?.result.conditions ? [...latestRun.result.conditions] : [],
      missingEvidence: runs > 0
        ? []
        : ['a compatible provider observation or export', 'a completed reconciliation run'],
    },
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
    inspection: {
      provenance: a?.basis ?? 'no allocation basis recorded',
      scope: a
        ? `${centres} cost centre(s); ${a.rules.length} rule version(s); ${allocRuns} immutable run(s)`
        : 'allocation endpoint unavailable',
      // The allocation runs' OWN timestamp. `a.reconciliation.latestComputedAtMs`
      // sits right there and looks like the answer, but it is a cross-reference
      // to the BILLING reconciliation — reading it here dated an allocation with
      // zero recorded runs by the moment someone reconciled a provider bill.
      freshness: iso(a?.runs?.[0]?.computedAtMs),
      coverage: a
        ? (a.excludedFrom.length ? `excluded from: ${a.excludedFrom.join(', ')}` : 'no exclusions recorded')
        : 'allocation endpoint unavailable',
      enforceability: 'showback claim; an allocation moves no money and enforces no chargeback by itself',
      evidenceSource: 'recorded local cost centres, rule versions, and immutable allocation runs',
      // The billing cross-reference belongs here rather than in freshness: an
      // allocation apportions metered ESTIMATES, so whether that residual has
      // ever been checked against a provider bill is something this claim rests
      // on, not something that says when it was computed.
      assumptions: a
        ? [
            `trust class: ${a.trust}`,
            `allocation kind: ${a.kind}`,
            a.reconciliation?.everRun
              ? `Apportions metered estimates last reconciled against a provider report at ${iso(a.reconciliation.latestComputedAtMs)}.`
              : 'Apportions metered estimates whose residual against a provider bill has never been checked.',
          ]
        : [],
      missingEvidence: allocRuns > 0
        ? []
        : ['at least one reviewed allocation rule', 'an applied immutable allocation run'],
    },
  };

  // Realized value counts only MATURED units that actually shipped. A proposal
  // that was accepted but never survived is not value; conflating the two is the
  // headline number every other tool in this category reports.
  //
  // The FIGURE, though, must be the value claim rather than a cost.
  // `matured.spendOnRealizedUnitsUsd` is the attributed SPEND on units that
  // realized; `roi.returnRatio.manualEquivalentValueUsd` is the VALUE those
  // units produced. This band sat on the first one, so the fourth claim in
  // `metered != billed != allocated != realized value` was rendering a cost --
  // the precise collapse the spine exists to refuse, committed by the spine.
  // Both fields were then spelled `realizedValueUsd`, which is why nothing
  // caught it; they are distinct identifiers now (AII-012).
  const matured = v?.realization?.matured;
  const realizedUnits = matured?.realizedUnits ?? 0;
  const ret = v?.roi?.returnRatio ?? null;
  // `basis: 'usd'` is the payload's own statement that the value figure is
  // priced. Without it there is a ratio but no dollars, and a dollar figure must
  // not be invented from one.
  const valued = ret?.basis === 'usd' && typeof ret.manualEquivalentValueUsd === 'number';

  const realized: Layer = {
    id: 'realized',
    label: 'Realized',
    claim: 'what it produced',
    valueUsd: valued ? (ret?.manualEquivalentValueUsd ?? null) : null,
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
    inspection: {
      provenance: v?.valueSource ?? 'no outcome source established',
      scope: v?.projectScoped === true
        ? 'project-scoped outcomes and attributed spend'
        : v?.projectScoped === false
          ? 'window-scoped cost basis; may include spend unrelated to these outcomes'
          : 'scope not established',
      freshness: v
        ? (v.gitRepo ? 'derived from live repository history on read' : 'derived from persisted outcome evidence on read')
        : 'not established',
      coverage: typeof v?.roi?.coverage === 'number'
        ? `${Math.round(v.roi.coverage * 100)}% RoI lens coverage`
        : 'RoI lens coverage not established',
      enforceability: 'outcome/value claim; it is never evidence that a provider bill or a local budget was enforced',
      evidenceSource: v?.gitRepo
        ? 'repository history + recorded outcome signals'
        : (v?.valueSource ?? 'none'),
      assumptions: v?.roi?.notes ? [...v.roi.notes] : [],
      missingEvidence: realizedUnits === 0
        ? ['matured outcome evidence']
        : valued
          ? []
          : ['a labour rate, so realized work can be priced'],
    },
  };

  return [metered, billed, allocated, realized];
}
