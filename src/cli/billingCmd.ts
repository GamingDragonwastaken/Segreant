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
import { formatUsdMicros } from '../billing/types.ts';
import { readBillingImportFile } from '../billing/importer.ts';
import { billingEvidenceToCsv } from '../export/billingCsv.ts';
import { Store } from '../store/db.ts';
import type { Flags } from './flags.ts';

function usage(): void {
  console.error('  Usage: fiscus billing <import|status|export|scope|openai-costs> [options]');
  console.error('         fiscus billing import --file <evidence.json> [--apply] [--json]');
  console.error('         fiscus billing status [--json]');
  console.error('         fiscus billing export [--csv|--json] [--out <file>]');
  console.error('         fiscus billing scope <set|status|clear> [--account-ref <local-ref>] [--project-ref <local-ref>] [--apply] [--json]');
  console.error('         fiscus billing openai-costs <preview|pull|status> --from <YYYY-MM-DD> --to <YYYY-MM-DD> [--apply] [--json]');
  console.error('  Local operator-supplied OpenAI billing evidence only. It never overwrites request estimates or claims reconciliation.');
}

function costsUsage(): void {
  console.error('  Usage: fiscus billing openai-costs preview --from <YYYY-MM-DD> --to <YYYY-MM-DD> [--json]');
  console.error('         fiscus billing openai-costs pull --from <YYYY-MM-DD> --to <YYYY-MM-DD> [--apply] [--json]');
  console.error('         fiscus billing openai-costs status [--json]');
  console.error('  Pull is an explicit, read-only GET to OpenAI Organization Costs. It requires OPENAI_ADMIN_API_KEY only with pull --apply.');
  console.error('  Provider observations stay separate from request spend, budgets, RoI, and model recommendations; they are not reconciliation.');
}

function costsRange(flags: Flags): { from: string; to: string } | null {
  const from = typeof flags.from === 'string' ? flags.from : null;
  const to = typeof flags.to === 'string' ? flags.to : null;
  if (!from || !to) return null;
  return { from, to };
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
