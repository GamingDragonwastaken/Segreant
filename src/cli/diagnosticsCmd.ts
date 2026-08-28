import { buildDiagnostics, redactDiagnosticPath, writeDiagnosticsBundle } from '../diagnostics.ts';
import type { Flags } from './flags.ts';
import { C, color, printJson } from './ui.ts';

export function cmdDiagnostics(flags: Flags): void {
  const bundle = buildDiagnostics();
  let exported: string | null = null;
  if (typeof flags.out === 'string' && flags.out.trim() !== '') {
    try {
      exported = writeDiagnosticsBundle(bundle, flags.out);
    } catch (error) {
      console.error(`  Diagnostics export refused: ${error instanceof Error ? error.constructor.name : 'Error'}`);
      process.exitCode = 1;
      return;
    }
  }
  if (flags.json) {
    printJson({ ...bundle, export: exported ? { ok: true, path: redactDiagnosticPath(exported) } : null });
    return;
  }
  const tty = process.stdout.isTTY ?? false;
  console.log('');
  console.log(color(tty, C.bold, '  Fiscus — redacted diagnostics'));
  console.log(`  Operation     ${bundle.operationId}`);
  console.log(`  Config        ${bundle.config.valid ? 'valid' : 'INVALID'} (${bundle.config.path})`);
  console.log(`  Database      ${bundle.database.status.toUpperCase()} (${bundle.database.bytes ?? 'unknown'} bytes)`);
  console.log(`  Egress        ${bundle.egress.status.toUpperCase()} (${bundle.egress.receiptCount} receipt(s))`);
  console.log(`  External net  ${bundle.boundaries.externalNetworkAttempted ? 'attempted' : 'not attempted'}`);
  console.log(`  Credentials   ${bundle.boundaries.credentialRead ? 'read' : 'not read'}`);
  if (exported) console.log(color(tty, C.green, `  Exported      ${exported}`));
  console.log(color(tty, C.gray, '  Bundle is redacted: no prompts, source, credentials, raw ledger rows, or absolute user paths.'));
  console.log('');
}
