/**
 * Provider-billing evidence commands. This is intentionally a local-file path:
 * importing an operator-supplied export is useful before a customer authorizes
 * a least-privilege provider connector, but it cannot establish reconciliation.
 */

import { writeFileSync } from 'node:fs';
import { dbPath, loadConfig } from '../config.ts';
import { newOpenAiScopeDeclaration } from '../billing/scope.ts';
import { formatUsdMicros } from '../billing/types.ts';
import { readBillingImportFile } from '../billing/importer.ts';
import { billingEvidenceToCsv } from '../export/billingCsv.ts';
import { Store } from '../store/db.ts';
import type { Flags } from './flags.ts';

function usage(): void {
  console.error('  Usage: fiscus billing <import|status|export|scope> [options]');
  console.error('         fiscus billing import --file <evidence.json> [--apply] [--json]');
  console.error('         fiscus billing status [--json]');
  console.error('         fiscus billing export [--csv|--json] [--out <file>]');
  console.error('         fiscus billing scope <set|status|clear> [--account-ref <local-ref>] [--project-ref <local-ref>] [--apply] [--json]');
  console.error('  Local operator-supplied OpenAI billing evidence only. It never overwrites request estimates or claims reconciliation.');
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
export function cmdBilling(flags: Flags): void {
  const action = typeof flags._[0] === 'string' ? flags._[0] : 'status';
  if (action === 'scope') {
    cmdScope(flags);
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
