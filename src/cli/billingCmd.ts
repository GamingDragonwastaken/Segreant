/**
 * Provider-billing evidence commands. This is intentionally a local-file path:
 * importing an operator-supplied export is useful before a customer authorizes
 * a least-privilege provider connector, but it cannot establish reconciliation.
 */

import { writeFileSync } from 'node:fs';
import { dbPath, loadConfig } from '../config.ts';
import {
  OpenAiCostsPullError,
  previewOpenAiCosts,
  pullOpenAiCosts,
  type OpenAiCostsPreview,
} from '../billing/openaiCosts.ts';
import { newOpenAiScopeDeclaration } from '../billing/scope.ts';
import { displayUsd, signedUsd, type ReconciliationReadiness, type ReconciliationRun } from '../billing/reconcile.ts';
import { reconciliationReadiness } from '../billing/readiness.ts';
import { formatUsdMicros } from '../billing/types.ts';
import { readBillingImportFile } from '../billing/importer.ts';
import { billingEvidenceToCsv } from '../export/billingCsv.ts';
import { Store } from '../store/db.ts';
import type { Flags } from './flags.ts';

function usage(): void {
  console.error('  Usage: fiscus billing <import|status|export|scope|openai-costs|reconcile> [options]');
  console.error('         fiscus billing import --file <evidence.json> [--apply] [--json]');
  console.error('         fiscus billing status [--json]');
  console.error('         fiscus billing export [--csv|--json] [--out <file>]');
  console.error('         fiscus billing scope <set|status|clear> [--account-ref <local-ref>] [--project-ref <local-ref>] [--apply] [--json]');
  console.error('         fiscus billing openai-costs <preview|pull> --from <YYYY-MM-DD> --to <YYYY-MM-DD> [--apply] [--json]');
  console.error('         fiscus billing openai-costs adopt --import-id <id> [--apply] [--json]   no credential needed');
  console.error('         fiscus billing openai-costs <status|coverage> [--json]');
  console.error('         fiscus billing reconcile [--apply] [--materiality <usd>] [--json]');
  console.error('  Local operator-supplied OpenAI billing evidence only. Reconciliation compares project-day totals');
  console.error('  under stated conditions; it never overwrites request estimates and never feeds budgets or RoI.');
}

function costsUsage(): void {
  console.error('  Usage: fiscus billing openai-costs preview --from <YYYY-MM-DD> --to <YYYY-MM-DD> [--json]');
  console.error('         fiscus billing openai-costs pull --from <YYYY-MM-DD> --to <YYYY-MM-DD> [--apply] [--json]');
  console.error('         fiscus billing openai-costs adopt --import-id <id> [--apply] [--json]');
  console.error('             adopt an imported operator export as an observation; no Admin key, weaker evidence');
  console.error('         fiscus billing openai-costs status [--json]');
  console.error('         fiscus billing openai-costs coverage [--json]');
  console.error('  Pull is an explicit, read-only GET to OpenAI Organization Costs. It requires OPENAI_ADMIN_API_KEY only with pull --apply.');
  console.error('  Provider observations stay separate from request spend, budgets, RoI, and model recommendations; they are not reconciliation.');
}

function costsRange(flags: Flags): { from: string; to: string } | null {
  const from = typeof flags.from === 'string' ? flags.from : null;
  const to = typeof flags.to === 'string' ? flags.to : null;
  if (!from || !to) return null;
  return { from, to };
}

function formatLocalEstimate(value: number): string {
  const text = value.toFixed(6);
  return text.includes('.') ? text.replace(/0+$/, '').replace(/\.$/, '') : text;
}

function printCostsCoverage(coverage: NonNullable<ReturnType<Store['openAiCostsCaptureCoverage']>>): void {
  const captured = coverage.capturedOnDeclaredRoute;
  const excluded = coverage.excludedFromDeclaredRoute;
  console.log('');
  console.log('  OpenAI Costs capture coverage — local readiness only');
  console.log(`  Snapshot      ${coverage.observation.observationRunId}`);
  console.log(`  Period        ${new Date(coverage.observation.periodStartMs).toISOString().slice(0, 10)} → ${new Date(coverage.observation.periodEndMs).toISOString().slice(0, 10)} (UTC, exclusive end)`);
  console.log(`  Provider rows ${coverage.observation.providerLineCount} (${coverage.observation.currencies.join(', ') || 'none'}); values intentionally not summed here`);
  console.log(`  Declared route ${captured.requestCount} live proxy request(s), $${formatLocalEstimate(captured.costUsd)} local rate-card estimate (${captured.estimatedRequestCount} estimated)`);
  console.log(`  Excluded      ${excluded.importedOrNative.requestCount} imported/native; ${excluded.unscopedOrLegacyOpenAiProxy.requestCount} unscoped/legacy OpenAI proxy; ${excluded.differentDeclaredOpenAiScope.requestCount} different OpenAI scope; ${excluded.otherProvider.requestCount} other provider`);
  console.log('  Comparison    blocked_not_reconciled — no provider/request variance is calculated.');
  console.log(`  Blockers      ${coverage.blockers.join(', ')}`);
}

function printReadiness(readiness: ReconciliationReadiness): void {
  console.log('');
  console.log('  Reconciliation is not possible yet. What is missing, in order:');
  for (const item of readiness.missing) {
    console.log(`    ${item.ownerAction ? '[you]' : '[here]'} ${item.step}`);
    console.log(`           ${item.detail}`);
  }
  const c = readiness.coverage;
  if (c && c.onDeclaredRouteUsd === 0 && (c.importedUsd > 0 || c.proxyOffScopeUsd > 0)) {
    // The expensive mistake this exists to prevent: minting an Admin key, pulling
    // a real bill, and getting a local side of zero.
    console.log('');
    console.log('  READ THIS BEFORE GETTING A CREDENTIAL. You have OpenAI spend, and none of it');
    console.log('  would count toward a reconciliation:');
    if (c.importedUsd > 0) {
      console.log(`    $${c.importedUsd.toFixed(2)} across ${c.importedRequests.toLocaleString()} request(s) arrived by NATIVE IMPORT.`);
      console.log('           An imported row records the model and the cost but nothing that ties');
      console.log('           it to your declared provider project, so counting it would invent the');
      console.log('           attribution this layer exists to refuse. Reconciliation sees only');
      console.log('           traffic you route through the proxy.');
    }
    if (c.proxyOffScopeUsd > 0) {
      console.log(`    $${c.proxyOffScopeUsd.toFixed(2)} across ${c.proxyOffScopeRequests.toLocaleString()} proxy request(s) predate your scope declaration`);
      console.log('           or carry a different one. Only rows metered AFTER the declaration count.');
    }
    console.log('  A pull would report your entire provider bill as unexplained residual. That is');
    console.log('  arithmetically true and operationally useless. Route traffic through the proxy');
    console.log('  first (fiscus start, then point your tools at it), let a period close, and the');
    console.log('  local side will have something in it.');
  }
  console.log('');
  console.log('  Steps marked [you] need an account owner. Fiscus will not create, store, or');
  console.log('  request a provider credential on your behalf. See docs/PROVIDER-RECONCILIATION.md.');
}

function printReconciliation(result: ReconciliationRun, applied: boolean): void {
  const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);
  console.log('');
  console.log('  Provider reconciliation — scope-conditional, at project-day grain');
  console.log(`  Snapshot      ${result.observationRunId}`);
  console.log(`  Project       ${result.providerProjectRef}`);
  console.log(`  Period        ${day(result.periodStartMs)} → ${day(result.periodEndMs)} (UTC, exclusive end)`);
  console.log('');
  console.log(`  Provider reported   $${displayUsd(result.providerReportedMicros)}`);
  console.log(`  Fiscus metered      $${displayUsd(result.localCapturedMicros)}  (local rate-card estimate)`);
  console.log(`  Unexplained         ${signedUsd(result.unexplainedVarianceMicros)}`);
  console.log('');
  console.log(`  Coverage      ${result.coverage.daysWithBoth} day(s) with both sides · ${result.coverage.providerOnlyDays} provider-only · ${result.coverage.localOnlyDays} local-only`);
  console.log(`  Material      ${result.coverage.materialDays} day(s) differ by more than $${result.materialityUsd.toFixed(2)}`);
  console.log(`  Stability     ${result.snapshotStability.replaceAll('_', ' ')}${result.unstableDayStartMs.length ? ` (${result.unstableDayStartMs.map(day).join(', ')})` : ''}`);
  const notable = result.days.filter((d) => d.material || d.residualReason === 'no_local_capture' || d.residualReason === 'no_provider_report');
  if (notable.length > 0) {
    console.log('');
    console.log('  Days needing an explanation');
    for (const d of notable.slice(0, 14)) {
      console.log(`    ${day(d.dayStartMs)}  provider $${displayUsd(d.providerReportedMicros).padStart(10)}  local $${displayUsd(d.localCapturedMicros).padStart(10)}  ${signedUsd(d.differenceMicros).padStart(11)}  ${d.residualReason.replaceAll('_', ' ')}`);
    }
    if (notable.length > 14) console.log(`    … ${notable.length - 14} more (use --json)`);
  }
  console.log('');
  console.log('  This is NOT a clean reconciliation and never will be. It holds only if your');
  console.log('  route declaration is true — nothing here verifies it with the provider — and');
  console.log('  usage that never passed through Fiscus is invisible, so the residual is an');
  console.log('  upper bound on off-path spend rather than a measurement of it.');
  if (result.providerSourceKind === 'operator_supplied_export') {
    console.log('  The provider side of this comparison was SUPPLIED BY AN OPERATOR, not read from');
    console.log('  the provider by Fiscus. The arithmetic is identical; the evidence is weaker,');
    console.log('  and nothing here can detect a report that was edited before it was handed over.');
  }
  console.log(`  Provider side ${result.providerSourceKind.replaceAll('_', ' ')}`);
  console.log(`  Conditions    ${result.conditions.join(', ')}`);
  console.log(`  Excluded from ${result.excludedFrom.join(', ')}`);
  console.log(applied ? '  Recorded as an immutable derived run.' : '  Not recorded. Persist it with: fiscus billing reconcile --apply');
}

/** Compare the newest complete provider snapshot with the local ledger. */
function cmdReconcile(flags: Flags): void {
  const store = new Store(dbPath());
  try {
    const materialityUsd = typeof flags.materiality === 'string' ? Number(flags.materiality) : undefined;
    if (materialityUsd !== undefined && (!Number.isFinite(materialityUsd) || materialityUsd < 0)) {
      console.error('  --materiality must be a non-negative dollar amount');
      process.exitCode = 1;
      return;
    }
    const readiness = reconciliationReadiness(store);
    const result = readiness.ready ? store.reconcileOpenAiCosts({ materialityUsd }) : null;

    if (!result) {
      if (flags.json) process.stdout.write(JSON.stringify({ status: 'not_ready', readiness }, null, 2) + '\n');
      else printReadiness(readiness);
      process.exitCode = 1;
      return;
    }
    if (result.status === 'refused') {
      if (flags.json) process.stdout.write(JSON.stringify(result, null, 2) + '\n');
      else {
        console.log('');
        console.log(`  Reconciliation refused: ${result.refusal.replaceAll('_', ' ')}`);
        console.log(`  ${result.detail}`);
      }
      process.exitCode = 1;
      return;
    }
    const applied = Boolean(flags.apply);
    const reconciliationRunId = applied ? store.saveReconciliationRun(result) : null;
    if (flags.json) process.stdout.write(JSON.stringify({ applied, reconciliationRunId, result }, null, 2) + '\n');
    else printReconciliation(result, applied);
  } finally {
    store.close();
  }
}

/**
 * Adopt an already-imported operator export as a Costs observation.
 *
 * Read-only by default like every other money-facing command here. It reads no
 * credential and makes no network request — the whole point is that this route
 * needs neither.
 */
function cmdAdoptCosts(flags: Flags): void {
  const importId = typeof flags['import-id'] === 'string' ? flags['import-id'] : null;
  const store = new Store(dbPath());
  try {
    const scope = store.activeOpenAiScope();
    if (!scope || !scope.providerProjectRef) {
      console.error('  Declare the route scope first, so the adopted lines are bound to a project:');
      console.error('    fiscus billing scope set --provider openai --base-url https://api.openai.com --account-ref <org_…> --project-ref <proj_…> --apply');
      process.exitCode = 1;
      return;
    }
    const imports = store.billingImportRuns(50).filter((r) => r.provider === 'openai');
    if (imports.length === 0) {
      console.error('  No OpenAI billing export has been imported. Import one first:');
      console.error('    fiscus billing import --file <your-costs-export.fiscus.json> --apply');
      process.exitCode = 1;
      return;
    }
    if (!importId) {
      console.log('');
      console.log('  Which import should be adopted? Re-run with --import-id <id>:');
      for (const run of imports) {
        console.log(`    ${run.importId}  ${new Date(run.periodStartMs).toISOString().slice(0, 10)} → ${new Date(run.periodEndMs).toISOString().slice(0, 10)}  ${run.recordsInserted} line(s)  coverage ${run.coverage}`);
      }
      process.exitCode = 1;
      return;
    }

    const plan = store.planOpenAiCostsAdoption({
      importId,
      declaredScopeId: scope.declarationId,
      providerProjectRef: scope.providerProjectRef,
    });
    if (!plan.adoptable) {
      if (flags.json) process.stdout.write(JSON.stringify({ applied: false, plan }, null, 2) + '\n');
      else {
        console.log('');
        console.log(`  Cannot adopt: ${plan.refusal.replaceAll('_', ' ')}`);
        console.log(`  ${plan.detail}`);
      }
      process.exitCode = 1;
      return;
    }

    const applied = Boolean(flags.apply);
    const run = applied ? store.adoptOpenAiCostsFromImport(plan) : null;
    if (flags.json) {
      process.stdout.write(JSON.stringify({ applied, observationRunId: run?.observationRunId ?? null, plan, networkAttempted: false, credentialRead: false }, null, 2) + '\n');
      return;
    }
    const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);
    console.log('');
    console.log('  Adopt an operator-supplied export as a provider observation');
    console.log(`  Import        ${plan.importId}  (file sha256 ${plan.fileSha256.slice(0, 12)}…)`);
    console.log(`  Project       ${plan.providerProjectRef}`);
    console.log(`  Period        ${day(plan.periodStartMs)} → ${day(plan.periodEndMs)} (UTC, exclusive end)`);
    console.log(`  Adopting      ${plan.matchedRecordCount} line(s), $${displayUsd(plan.matchedMicros)}, into ${plan.observations.length} daily grouping(s)`);
    if (plan.excluded.otherOrNoProjectRecordCount > 0) {
      console.log(`  NOT adopting  ${plan.excluded.otherOrNoProjectRecordCount} line(s), ${signedUsd(plan.excluded.otherOrNoProjectMicros)} — a different project, or account-level with no project reference`);
      console.log('                These cannot be attributed to your project. They are excluded and');
      console.log('                reported here rather than dropped, because a silently discarded');
      console.log('                credit would surface later as a residual that never existed.');
    }
    console.log(`  Coverage      ${plan.declaredCoverage} — an operator declaration, never verified here`);
    console.log('');
    console.log('  This route reads no credential and makes no network request. The figures are');
    console.log('  yours, not the provider’s: Fiscus validated their shape and digested the file,');
    console.log('  but obtained nothing from OpenAI. The observation is permanently stamped');
    console.log('  operator_supplied_export and every reconciliation built on it carries a fifth');
    console.log('  condition saying so. A read-only Costs pull remains the stronger evidence.');
    console.log(applied ? '  Recorded as an immutable observation.' : '  Not recorded. Persist it with: fiscus billing openai-costs adopt --import-id <id> --apply');
  } finally {
    store.close();
  }
}

function printCostsPreview(preview: OpenAiCostsPreview): void {
  console.log('');
  console.log('  OpenAI Organization Costs observation — dry run');
  console.log(`  Scope         ${preview.declaredScopeId} / ${preview.projectRef}`);
  console.log(`  Period        ${preview.range.from} → ${preview.range.to} (${preview.range.bucketCount} UTC daily bucket(s))`);
  console.log(`  Endpoint      ${preview.endpoint} (GET only)`);
  console.log('  Trust         provider_observation_unreconciled; provider finality is undocumented');
  console.log('  Excluded      request spend, budget enforcement, RoI, and model recommendations');
  console.log('  No credential was read and no network request was made. Apply with: fiscus billing openai-costs pull ... --apply');
}

/** Read-only provider observation commands. Preview deliberately never reads process.env. */
async function cmdOpenAiCosts(flags: Flags): Promise<void> {
  const action = typeof flags._[1] === 'string' ? flags._[1] : 'preview';
  if (action === 'coverage') {
    const store = new Store(dbPath());
    try {
      const coverage = store.openAiCostsCaptureCoverage();
      const payload = {
        coverage,
        reconciliationStatus: 'not_reconciled' as const,
        networkAttempted: false,
        credentialRead: false,
      };
      if (flags.json) process.stdout.write(JSON.stringify(payload, null, 2) + '\n');
      else if (!coverage) console.log('  No fully paginated OpenAI Costs snapshot is available for a local capture-coverage report.');
      else printCostsCoverage(coverage);
    } finally {
      store.close();
    }
    return;
  }
  if (action === 'status') {
    const store = new Store(dbPath());
    try {
      const status = store.openAiCostsObservationStatus();
      const latestComplete = store.latestCompleteOpenAiCostsObservation();
      if (flags.json) {
        process.stdout.write(JSON.stringify({ status, latestComplete }, null, 2) + '\n');
      } else {
        console.log('');
        console.log('  OpenAI Organization Costs observation status');
        if (!status.latestRun) console.log('  No direct provider observation runs recorded.');
        else {
          console.log(`  Latest run    ${status.latestRun.resultState} / ${new Date(status.latestRun.fetchedAtMs).toISOString()}`);
          console.log(`  Pagination    ${status.latestRun.paginationComplete ? 'complete' : 'incomplete'} (${status.latestRun.pageCount} page(s))`);
          if (status.latestRun.failureCode) console.log(`  Failure code  ${status.latestRun.failureCode}`);
          console.log(`  Latest full   ${status.latestCompleteRun ? status.latestCompleteRun.observationRunId : 'none'}`);
        }
        console.log('  Reconcile     not_reconciled — no variance or request/billing match is calculated.');
      }
    } finally {
      store.close();
    }
    return;
  }
  if (action === 'adopt') {
    cmdAdoptCosts(flags);
    return;
  }
  if (action !== 'preview' && action !== 'pull') {
    costsUsage();
    process.exitCode = 1;
    return;
  }
  const range = costsRange(flags);
  if (!range) {
    costsUsage();
    process.exitCode = 1;
    return;
  }
  const store = new Store(dbPath());
  try {
    const preview = previewOpenAiCosts(store.activeOpenAiScope(), range.from, range.to);
    // `preview` is always non-operational, even if --apply was accidentally supplied.
    if (action === 'preview' || !flags.apply) {
      const payload = {
        applied: false,
        preview,
        networkAttempted: false,
        credentialRead: false,
        message: action === 'pull'
          ? 'No data written. Add --apply to execute the fixed read-only request.'
          : 'No data written. Preview never reads a credential or makes a network request.',
      };
      if (flags.json) process.stdout.write(JSON.stringify(payload, null, 2) + '\n');
      else printCostsPreview(preview);
      return;
    }

    // The only credential read in this file is after a valid --apply pull preview.
    const apiKey = process.env.OPENAI_ADMIN_API_KEY?.trim();
    if (!apiKey) {
      const run = store.recordOpenAiCostsObservation({
        declaredScopeId: preview.declaredScopeId,
        providerProjectRef: preview.projectRef,
        periodStartMs: preview.range.startMs,
        periodEndMs: preview.range.endMs,
        fetchedAtMs: Date.now(),
        paginationComplete: false,
        pageCount: 0,
        pageDigestChainSha256: null,
        resultState: 'failed',
        failureCode: 'missing_credential',
        observations: [],
      });
      const payload = { applied: true, resultState: 'failed', run, error: 'OPENAI_ADMIN_API_KEY is required for pull --apply' };
      if (flags.json) process.stdout.write(JSON.stringify(payload, null, 2) + '\n');
      else console.error('  OpenAI Costs pull was not attempted: OPENAI_ADMIN_API_KEY is required for pull --apply.');
      process.exitCode = 1;
      return;
    }
    try {
      const collected = await pullOpenAiCosts({ preview, apiKey });
      const run = store.recordOpenAiCostsObservation({
        declaredScopeId: preview.declaredScopeId,
        providerProjectRef: preview.projectRef,
        periodStartMs: preview.range.startMs,
        periodEndMs: preview.range.endMs,
        fetchedAtMs: collected.fetchedAtMs,
        paginationComplete: collected.paginationComplete,
        pageCount: collected.pageCount,
        pageDigestChainSha256: collected.pageDigestChainSha256,
        resultState: 'succeeded',
        failureCode: null,
        observations: collected.observations,
      });
      const payload = { applied: true, resultState: 'succeeded', run, observationCount: collected.observations.length };
      if (flags.json) process.stdout.write(JSON.stringify(payload, null, 2) + '\n');
      else {
        console.log(`  Recorded ${collected.observations.length} immutable OpenAI daily cost observation(s) in run ${run.observationRunId}.`);
        console.log('  They remain unreconciled and are excluded from request spend, caps, RoI, and recommendations.');
      }
    } catch (error) {
      const failed = error instanceof OpenAiCostsPullError
        ? error.failure
        : {
            preview,
            fetchedAtMs: Date.now(),
            paginationComplete: false as const,
            pageCount: 0,
            pageDigestChainSha256: null,
            failureCode: 'network_error' as const,
          };
      const run = store.recordOpenAiCostsObservation({
        declaredScopeId: failed.preview.declaredScopeId,
        providerProjectRef: failed.preview.projectRef,
        periodStartMs: failed.preview.range.startMs,
        periodEndMs: failed.preview.range.endMs,
        fetchedAtMs: failed.fetchedAtMs,
        paginationComplete: false,
        pageCount: failed.pageCount,
        pageDigestChainSha256: failed.pageDigestChainSha256,
        resultState: 'failed',
        failureCode: failed.failureCode,
        observations: [],
      });
      const payload = { applied: true, resultState: 'failed', run, error: `OpenAI Costs pull failed (${failed.failureCode})` };
      if (flags.json) process.stdout.write(JSON.stringify(payload, null, 2) + '\n');
      else console.error(`  OpenAI Costs pull failed (${failed.failureCode}); the failed audit run was retained without a response body or credential.`);
      process.exitCode = 1;
    }
  } catch (error) {
    console.error(`  OpenAI Costs observation failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  } finally {
    store.close();
  }
}

function scopeUsage(): void {
  console.error('  Usage: fiscus billing scope set --account-ref <non-secret-local-ref> [--project-ref <non-secret-local-ref>] [--apply] [--json]');
  console.error('         fiscus billing scope status [--json]');
  console.error('         fiscus billing scope clear [--apply] [--json]');
  console.error('  Scope covers only future OpenAI-proxy rows routed to the exact configured upstream. It is operator-declared and unverified.');
}

function cmdScope(flags: Flags): void {
  const action = typeof flags._[1] === 'string' ? flags._[1] : 'status';
  if (action === 'set') {
    const accountRef = typeof flags['account-ref'] === 'string' ? flags['account-ref'] : null;
    const projectRef = typeof flags['project-ref'] === 'string' ? flags['project-ref'] : null;
    if (!accountRef) {
      scopeUsage();
      process.exitCode = 1;
      return;
    }
    try {
      const upstreamBase = loadConfig().upstreams.openai;
      const preview = newOpenAiScopeDeclaration({ billingAccountRef: accountRef, providerProjectRef: projectRef, upstreamBase });
      if (!flags.apply) {
        const payload = {
          applied: false,
          preview: {
            ...preview,
            capture: 'future OpenAI proxy rows only when the resolved configured endpoint exactly matches',
            trust: 'operator_declared_unverified',
            reconciliationStatus: 'not_reconciled',
          },
        };
        if (flags.json) process.stdout.write(JSON.stringify(payload, null, 2) + '\n');
        else {
          console.log(`  Scope preview  OpenAI → ${preview.upstreamDisplay}`);
          console.log(`  Account ref    ${preview.billingAccountRef}${preview.providerProjectRef ? ` / ${preview.providerProjectRef}` : ''}`);
          console.log('  Trust          operator_declared_unverified — no provider login, credential, or invoice was checked');
          console.log('  No data written. Apply with: fiscus billing scope set ... --apply');
        }
        return;
      }
      const store = new Store(dbPath());
      try {
        const declaration = store.setOpenAiScope({ billingAccountRef: accountRef, providerProjectRef: projectRef, upstreamBase });
        const payload = { applied: true, declaration, reconciliationStatus: 'not_reconciled' };
        if (flags.json) process.stdout.write(JSON.stringify(payload, null, 2) + '\n');
        else {
          console.log(`  Active local OpenAI scope ${declaration.declarationId}`);
          console.log(`  ${declaration.billingAccountRef} → ${declaration.upstreamDisplay}`);
          console.log('  Future matching proxy rows are declared_unverified; historical and imported rows are unchanged.');
        }
      } finally {
        store.close();
      }
    } catch (error) {
      console.error(`  Billing scope failed: ${error instanceof Error ? error.message : String(error)}`);
      process.exitCode = 1;
    }
    return;
  }
  const store = new Store(dbPath());
  try {
    if (action === 'status') {
      const active = store.activeOpenAiScope();
      const payload = { active, trust: 'operator_declared_unverified', reconciliationStatus: 'not_reconciled' };
      if (flags.json) process.stdout.write(JSON.stringify(payload, null, 2) + '\n');
      else if (active) {
        console.log(`  Active local OpenAI scope: ${active.billingAccountRef} → ${active.upstreamDisplay}`);
        console.log('  Status: operator_declared_unverified; it applies only to future matching proxy traffic.');
      } else console.log('  No active local OpenAI scope. New proxy rows remain unscoped.');
      return;
    }
    if (action === 'clear') {
      const active = store.activeOpenAiScope();
      if (!flags.apply) {
        const payload = { applied: false, active, message: 'No data written; only future matching proxy rows would become unscoped.' };
        if (flags.json) process.stdout.write(JSON.stringify(payload, null, 2) + '\n');
        else console.log(active ? `  Would clear local scope ${active.declarationId}; historical request snapshots remain unchanged.` : '  No active local OpenAI scope to clear.');
        return;
      }
      const cleared = store.clearOpenAiScope();
      if (flags.json) process.stdout.write(JSON.stringify({ applied: true, cleared, reconciliationStatus: 'not_reconciled' }, null, 2) + '\n');
      else console.log(cleared ? '  Cleared active local OpenAI scope. Future matching proxy rows are unscoped.' : '  No active local OpenAI scope to clear.');
      return;
    }
  } finally {
    store.close();
  }
  scopeUsage();
  process.exitCode = 1;
}

function writeOrPrint(value: string, out: unknown): void {
  if (typeof out === 'string') {
    writeFileSync(out, value, 'utf8');
    console.log(`  Wrote ${out}`);
  } else {
    process.stdout.write(value);
  }
}

function renderPreview(preview: ReturnType<typeof readBillingImportFile>['preview']): void {
  console.log('');
  console.log('  Provider billing evidence — dry run');
  console.log('  This is an operator-supplied provider report, not an invoice close or request-level match.');
  console.log(`  File          ${preview.fileName}  sha256:${preview.fileSha256}`);
  console.log(`  Scope         ${preview.source.provider} / ${preview.source.billingAccountRef} / ${preview.source.exportId}`);
  console.log(`  Period        ${new Date(preview.source.periodStartMs).toISOString()} → ${new Date(preview.source.periodEndMs).toISOString()}`);
  console.log(`  Coverage      ${preview.source.coverage}`);
  console.log(`  Charge lines  ${preview.recordsSeen}`);
  console.log(`  Declared USD  $${formatUsdMicros(preview.providerReportedUsdMicros)}`);
  console.log('  Reconcile     not_reconciled (no verified provider-account binding on local request rows)');
  console.log('');
  console.log('  No data written. Apply with: fiscus billing import --file <evidence.json> --apply');
}

/** `fiscus billing` — immutable local provider-cost evidence, never an implicit reconciliation. */
export async function cmdBilling(flags: Flags): Promise<void> {
  const action = typeof flags._[0] === 'string' ? flags._[0] : 'status';
  if (action === 'scope') {
    cmdScope(flags);
    return;
  }
  if (action === 'openai-costs') {
    await cmdOpenAiCosts(flags);
    return;
  }
  if (action === 'reconcile') {
    cmdReconcile(flags);
    return;
  }
  if (action === 'import') {
    if (typeof flags.file !== 'string') {
      usage();
      process.exitCode = 1;
      return;
    }
    if (flags.format && flags.format !== 'json') {
      console.error('  Billing evidence v1 accepts strict JSON only; CSV/provider-specific parsing is intentionally not guessed.');
      process.exitCode = 1;
      return;
    }
    try {
      const parsed = readBillingImportFile(flags.file);
      if (!flags.apply) {
        if (flags.json) process.stdout.write(JSON.stringify({ applied: false, preview: parsed.preview }, null, 2) + '\n');
        else renderPreview(parsed.preview);
        return;
      }
      const store = new Store(dbPath());
      try {
        const result = store.applyBillingImport(parsed.input);
        const payload = { applied: true, duplicateFile: result.duplicateFile, preview: parsed.preview, run: result.run };
        if (flags.json) {
          process.stdout.write(JSON.stringify(payload, null, 2) + '\n');
        } else if (result.duplicateFile) {
          console.log(`  Identical billing evidence was already imported as ${result.run.importId}; no duplicate records written.`);
        } else {
          console.log(`  Imported ${result.run.recordsInserted} provider-declared charge line(s); ${result.run.recordsDuplicate} already existed.`);
          console.log('  Status remains not_reconciled. Provider-reported totals are stored separately from local metered estimates.');
        }
      } finally {
        store.close();
      }
    } catch (error) {
      console.error(`  Billing import failed: ${error instanceof Error ? error.message : String(error)}`);
      process.exitCode = 1;
    }
    return;
  }

  const store = new Store(dbPath());
  try {
    if (action === 'status') {
      const summary = store.billingSummary();
      const imports = store.billingImportRuns();
      if (flags.json) {
        process.stdout.write(JSON.stringify({ summary, imports }, null, 2) + '\n');
      } else {
        console.log('');
        console.log('  Provider billing evidence');
        console.log(`  Imports       ${summary.importCount}`);
        console.log(`  Charge lines  ${summary.recordCount}`);
        console.log(`  Declared USD  $${formatUsdMicros(summary.providerReportedUsdMicros)}`);
        console.log('  Reconcile     not_reconciled — imported reports and local request estimates are not yet scope-comparable.');
        if (summary.lastImportedAtMs !== null) console.log(`  Last import   ${new Date(summary.lastImportedAtMs).toISOString()}`);
        if (imports.length > 0) console.log(`  Latest file   ${imports[0]!.fileName}  sha256:${imports[0]!.fileSha256}`);
        console.log('');
      }
      return;
    }
    if (action === 'export') {
      const records = store.billingEvidenceRecords();
      const summary = store.billingSummary();
      if (flags.json) {
        writeOrPrint(JSON.stringify({ summary, records }, null, 2) + '\n', flags.out);
      } else {
        writeOrPrint(billingEvidenceToCsv(records), flags.out);
      }
      return;
    }
  } finally {
    store.close();
  }
  usage();
  process.exitCode = 1;
}
