/** Local, review-first ledger backup and restore-to-new-path commands. */

import { resolve } from 'node:path';
import { dbPath } from '../config.ts';
import { Store, type BackupResult } from '../store/db.ts';
import type { Flags } from './flags.ts';
import { C, color, printJson } from './ui.ts';

function requiredPath(flags: Flags, name: string): string | null {
  const value = flags[name];
  if (typeof value !== 'string' || value.trim() === '') {
    console.error(`  --${name} is required`);
    process.exitCode = 1;
    return null;
  }
  return value;
}

function emit(result: BackupResult, flags: Flags, action: string): void {
  if (flags.json) {
    printJson({ action, ...result });
    if (!result.ok) process.exitCode = 1;
    return;
  }
  if (!result.ok) {
    console.error(color(process.stderr.isTTY ?? false, C.red, `  ${action} refused: ${result.reason}`));
    process.exitCode = 1;
    return;
  }
  console.log(color(process.stdout.isTTY ?? false, C.green, `  ${action} verified: ${result.path}`));
  console.log(`  SHA-256       ${result.sha256}`);
  console.log(`  Bytes         ${result.bytes}`);
  console.log(`  Schema        ${result.schemaFingerprint}`);
  console.log(`  Manifest      ${result.manifestPath}`);
  console.log(color(process.stdout.isTTY ?? false, C.gray, '  This is a local sensitive ledger artifact; it is not encrypted or an independent audit attestation.'));
}

export function cmdBackup(flags: Flags): void {
  const destination = requiredPath(flags, 'out');
  if (!destination) return;
  const store = new Store(dbPath());
  try {
    emit(store.backupTo(destination), flags, 'Backup');
  } finally {
    store.close();
  }
}

export function cmdRestore(flags: Flags): void {
  const source = requiredPath(flags, 'from');
  const destination = requiredPath(flags, 'out');
  if (!source || !destination) return;
  const sourcePath = resolve(source);
  const destinationPath = resolve(destination);
  if (sourcePath.toLowerCase() === resolve(dbPath()).toLowerCase()) {
    const result: BackupResult = {
      ok: false,
      path: destinationPath,
      bytes: 0,
      sha256: null,
      schemaFingerprint: null,
      requiredTables: [],
      manifestPath: `${destinationPath}.manifest.json`,
      manifestPresent: false,
      reason: 'restore source must be a backup artifact, not the active database',
    };
    emit(result, flags, 'Restore');
    return;
  }
  const preview = Store.inspectBackup(sourcePath);
  if (!preview.ok) {
    emit({
      ok: false,
      path: destinationPath,
      bytes: preview.bytes,
      sha256: preview.sha256,
      schemaFingerprint: preview.schemaFingerprint,
      requiredTables: preview.requiredTables,
      manifestPath: `${destinationPath}.manifest.json`,
      manifestPresent: false,
      reason: `source backup is invalid: ${preview.reason}`,
    }, flags, 'Restore');
    return;
  }
  if (!flags.apply) {
    if (flags.json) {
      printJson({ action: 'Restore', applied: false, preview, destination: destinationPath, note: 'No data written. Re-run with --apply to create a new verified database; the active ledger is never overwritten.' });
    } else {
      console.log(color(process.stdout.isTTY ?? false, C.yellow, '  Restore preview only — no data written.'));
      console.log(`  Source        ${preview.path}`);
      console.log(`  SHA-256       ${preview.sha256}`);
      console.log(`  Destination   ${destinationPath}`);
      console.log(color(process.stdout.isTTY ?? false, C.gray, '  Re-run with --apply to create a new verified database. The active ledger is never overwritten.'));
    }
    return;
  }
  emit(Store.restoreBackup(sourcePath, destinationPath), flags, 'Restore');
}
