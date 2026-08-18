import type { Overview, BillingPayload, AllocationPayload, ValuePayload } from './contracts.ts';
import type { Layer } from './claimTypes.ts';

export interface ClaimInputs {
  overview: Overview | null;
  billing: BillingPayload | null;
  allocation: AllocationPayload | null;
  value: ValuePayload | null;
}

const iso = (ms: number | null | undefined): string => typeof ms === 'number' ? new Date(ms).toISOString() : 'not established';

export function buildClaimLayers(input: ClaimInputs, range: string): Layer[] {
  const { overview: o, billing: b, allocation: a, value: v } = input;
  const estimatedShare = o?.pricing.estimatedSpendShare ?? null;
  const metered: Layer = {
    id: 'metered', label: 'Metered', claim: 'what we observed', valueUsd: o?.summary.costUsd ?? null,
    established: o !== null,
    basis: o === null ? 'could not read the ledger' : 'counted from requests, priced from a rate card',
    nextStep: o === null ? 'Check that Fiscus is running.' : undefined,
    inspection: {
      provenance: 'local request ledger + recorded pricing basis',
      scope: o ? `${range}; ${o.summary.requests} recorded request(s)` : range,
      freshness: o?.generatedAt ?? 'computed from the current ledger read',
      coverage: estimatedShare === null ? 'pricing coverage unavailable' : `${Math.round((1 - estimatedShare) * 100)}% of spend not estimated`,
      enforceability: 'observation claim; local caps can govern future in-path requests but do not make metered cost billed cost',
      evidenceSource: 'local request ledger',
      assumptions: ['Rate-card cost is an estimate unless provider billing evidence establishes a billed amount.'],
      missingEvidence: o === null ? ['readable local ledger'] : estimatedShare && estimatedShare > 0 ? ['exact rate-card matches for estimated rows'] : [],
    },
  };

  const latestRun = b?.reconciliation?.runs?.[0] ?? null;
  const runs = b?.reconciliation?.runs?.length ?? 0;
  const billed: Layer = {
    id: 'billed', label: 'Billed', claim: 'what the provider charged', valueUsd: null, established: runs > 0,
    basis: runs > 0 ? 'reconciled against a provider report, with a residual' : b && b.summary.recordCount > 0 ? `${b.summary.recordCount} provider records held, none reconciled yet` : 'no provider bill has been compared against this ledger',
    nextStep: runs > 0 ? undefined : 'Check readiness in Evidence before spending a credential on it.',
    inspection: {
      provenance: latestRun?.result.providerSourceKind ?? (b?.summary.recordCount ? 'operator-supplied provider evidence' : 'none'),
      scope: latestRun ? `reconciliation run ${latestRun.reconciliationRunId}` : 'no reconciled provider scope',
      freshness: latestRun ? iso(latestRun.computedAtMs) : 'not established',
      coverage: b ? `${b.summary.recordCount} provider evidence record(s); ${runs} reconciliation run(s)` : 'billing endpoint unavailable',
      enforceability: 'evidence claim only; reconciliation does not change provider billing or local caps',
      evidenceSource: latestRun?.result.providerSourceKind ?? 'provider evidence not established',
      assumptions: latestRun?.result.conditions ? [...latestRun.result.conditions] : [],
      missingEvidence: runs > 0 ? [] : ['a compatible provider observation/export', 'a completed reconciliation run'],
    },
  };

  const allocRuns = Array.isArray(a?.runs) ? a.runs.length : 0;
  const centres = Array.isArray(a?.costCentres) ? a.costCentres.length : 0;
  const allocated: Layer = {
    id: 'allocated', label: 'Allocated', claim: 'whose cost it is', valueUsd: null, established: allocRuns > 0,
    basis: allocRuns > 0 ? 'apportioned by recorded rules — showback only' : centres > 0 ? `${centres} cost centre${centres === 1 ? '' : 's'} defined, no allocation recorded` : 'no cost centres and no rules yet',
    nextStep: allocRuns > 0 ? undefined : 'Define a cost centre, then run an allocation.',
    inspection: {
      provenance: a?.basis ?? 'no allocation basis recorded',
      scope: a ? `${centres} cost centre(s); ${a.rules.length} rule version(s); ${allocRuns} immutable run(s)` : 'allocation endpoint unavailable',
      freshness: a?.reconciliation?.latestComputedAtMs ? iso(a.reconciliation.latestComputedAtMs) : 'no related reconciliation timestamp established',
      coverage: a?.excludedFrom?.length ? `excluded from: ${a.excludedFrom.join(', ')}` : (a ? 'allocation payload available' : 'unavailable'),
      enforceability: 'showback/accounting claim; allocation does not enforce provider spend or chargeback by itself',
      evidenceSource: 'recorded local cost centres, rule versions, and immutable allocation runs',
      assumptions: a ? [`trust class: ${a.trust}`, `allocation kind: ${a.kind}`] : [],
      missingEvidence: allocRuns > 0 ? [] : ['at least one reviewed allocation rule', 'an applied immutable allocation run'],
    },
  };

  const matured = v?.realization?.matured;
  const realizedUnits = matured?.realizedUnits ?? 0;
  const ret = v?.roi?.returnRatio ?? null;
  const valued = ret?.basis === 'usd' && typeof ret.realizedValueUsd === 'number';
  const realized: Layer = {
    id: 'realized', label: 'Realized', claim: 'what it produced', valueUsd: valued ? (ret?.realizedValueUsd ?? null) : null,
    established: realizedUnits > 0 && valued,
    basis: realizedUnits === 0 ? 'no work units have matured into verified outcomes' : valued ? `${realizedUnits} of ${matured?.units ?? 0} matured units shipped and survived; manual-equivalent value, net of rework` : `${realizedUnits} of ${matured?.units ?? 0} units matured, but no labour rate is set to price what they produced`,
    nextStep: realizedUnits === 0 ? 'Connect a repository so outcomes can be observed.' : valued ? undefined : 'Set a labour rate so realized work can be priced.',
    inspection: {
      provenance: v?.valueSource ?? 'no outcome source established',
      scope: v?.projectScoped === true ? 'project-scoped outcomes and attributed spend' : v?.projectScoped === false ? 'window-scoped cost basis; may include unrelated spend' : 'scope not established',
      freshness: v?.gitRepo ? 'derived from live repository history on read' : 'derived from persisted outcome evidence on read',
      coverage: typeof v?.roi?.coverage === 'number' ? `${Math.round(v.roi.coverage * 100)}% RoI lens coverage` : 'RoI coverage not established',
      enforceability: 'outcome/value claim; it is never used as proof that a provider or local budget was enforced',
      evidenceSource: v?.gitRepo ? 'repository history + recorded outcome signals' : (v?.valueSource ?? 'none'),
      assumptions: v?.roi?.notes ?? [],
      missingEvidence: realizedUnits === 0 ? ['matured outcome evidence'] : valued ? [] : ['labour-rate/value basis for monetary realization'],
    },
  };
  return [metered, billed, allocated, realized];
}
