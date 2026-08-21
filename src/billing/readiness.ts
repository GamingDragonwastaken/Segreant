/**
 * Reconciliation readiness — shared by the CLI and the dashboard.
 *
 * This lived inside `src/cli/billingCmd.ts`, which meant the terminal could
 * warn an operator that a reconciliation would match nothing and the GUI could
 * not. The warning exists to be read BEFORE an OpenAI Admin key is minted, so
 * the surface an operator actually has open is the one that has to carry it.
 *
 * It stays a single implementation on purpose. Two hand-written copies of one
 * rule drift, and this repository has already paid for a GUI-side statement
 * that disagreed with the server.
 */

import type { Store } from '../store/db.ts';
import type { ReconciliationReadiness } from './reconcile.ts';

export type { ReconciliationReadiness };

/**
 * What still stands between this machine and a reconciliation run, in the order
 * an operator has to do it. Two of these are OWNER actions — creating a
 * least-privilege Admin key and supplying it — and Fiscus deliberately cannot
 * perform them. The rest it can check.
 */
export function reconciliationReadiness(store: Store): ReconciliationReadiness {
  const missing: ReconciliationReadiness['missing'] = [];
  const scope = store.activeOpenAiScope();
  if (!scope) {
    missing.push({
      step: 'declare the route scope',
      detail: 'fiscus billing scope set --provider openai --base-url https://api.openai.com --account-ref <org_…> --project-ref <proj_…> --apply',
      ownerAction: false,
    });
  } else if (scope.upstreamDisplay !== 'https://api.openai.com' || !scope.providerProjectRef) {
    missing.push({
      step: 'the active scope cannot address the Costs API',
      detail: 'it must be exactly https://api.openai.com and carry a proj_… project reference',
      ownerAction: false,
    });
  }
  const status = store.openAiCostsObservationStatus();
  if (!status.latestCompleteRun) {
    // Two routes to the same grain, and the weaker one is offered because being
    // blocked on a CREDENTIAL rather than on the DATA was the wrong place to be
    // stuck: an owner who can export a bill should not be unable to reconcile
    // because minting an Admin key needs a different permission than reading
    // one. The pull is better evidence and stays first.
    missing.push({
      step: 'observe a closed period — route A, a direct read-only pull (better evidence)',
      detail: 'needs an OpenAI Admin key with the Costs read scope, exported as OPENAI_ADMIN_API_KEY for one command; Fiscus never stores or logs it. Then: fiscus billing openai-costs pull --from <YYYY-MM-DD> --to <YYYY-MM-DD> --apply',
      ownerAction: true,
    });
    missing.push({
      step: 'observe a closed period — route B, adopt an export you already have (no credential)',
      detail: 'fiscus billing import --file <your-costs-export.fiscus.json> --apply, then fiscus billing openai-costs adopt --import-id <id> --apply. The result reconciles identically and is permanently stamped operator-supplied.',
      ownerAction: true,
    });
  }
  return {
    ready: missing.length === 0,
    missing,
    coverage: store.openAiReconciliationCoverage(scope?.declarationId ?? null),
  };
}
