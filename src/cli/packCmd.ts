/**
 * `segreant pack export|verify|inspect` — the CLI face of `src/pack/` (D-229).
 *
 * `export` reads the local epistemic ledger and writes a `.segreantpack`
 * envelope to `--out`; nothing is written without `--out`, and an existing
 * file is never overwritten. `--sign <private-key.pem>` signs the manifest
 * with Ed25519 and embeds the public key. `verify` runs the same verifier the
 * standalone script runs and prints integrity / authenticity / truth as three
 * separate outcomes; `--trust <public-key.pem|base64>` is the only way
 * authenticity becomes `verified`. `inspect` prints what the manifest SAYS —
 * counts, omissions, redactions, signature presence — and evaluates nothing.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { dbPath } from '../config.ts';
import { Store } from '../store/db.ts';
import { exportLedgerPack } from '../pack/export.ts';
import { serializeSegreantPack } from '../pack/manifest.ts';
import { verifySegreantPack } from '../pack/verifier.ts';
import type { Flags } from './flags.ts';
import { C, color, printJson } from './ui.ts';

function printUsage(): void {
  console.log('  segreant pack export --out <file> [--sign <private-key.pem>] [--json]');
  console.log('  segreant pack verify <file> [--trust <public-key.pem|base64>] [--json]');
  console.log('  segreant pack inspect <file> [--json]');
}

function stringFlag(flags: Flags, name: string): string | null {
  const value = flags[name];
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}

function readKeyMaterial(pathOrValue: string): string {
  const path = resolve(pathOrValue);
  if (existsSync(path)) return readFileSync(path, 'utf8');
  return pathOrValue;
}

function cmdPackExport(flags: Flags): void {
  const out = stringFlag(flags, 'out');
  if (out === null) {
    console.error('  --out is required: a pack is written only where you say');
    process.exitCode = 1;
    return;
  }
  const destination = resolve(out);
  if (existsSync(destination)) {
    console.error(`  refusing to overwrite ${destination}`);
    process.exitCode = 1;
    return;
  }
  const sign = stringFlag(flags, 'sign');
  const store = new Store(dbPath());
  try {
    const createdAt = new Date().toISOString();
    const { pack, summary } = exportLedgerPack({
      ledger: store.epistemic(),
      packId: `segreantpack:ledger:${createdAt}`,
      createdAt,
      ...(sign === null ? {} : { signingKey: readKeyMaterial(sign) }),
    });
    const encoded = serializeSegreantPack(pack);
    writeFileSync(destination, encoded, { encoding: 'utf8', flag: 'wx' });
    const result = { path: destination, bytes: Buffer.byteLength(encoded, 'utf8'), manifestDigest: pack.manifestDigest, ...summary };
    if (flags.json) { printJson(result); return; }
    const tty = process.stdout.isTTY ?? false;
    console.log(color(tty, C.green, `  Pack written: ${destination}`));
    console.log(`  Manifest      ${pack.manifestDigest}`);
    console.log(`  Records       ${summary.included} included · ${summary.omitted} omitted · ${summary.redacted} redacted`);
    console.log(`  Signature     ${summary.signed ? 'Ed25519, public key embedded (integrity only until a verifier pins it)' : 'none'}`);
    console.log(color(tty, C.gray, '  A pack binds bytes. It does not evaluate whether the claims inside hold.'));
  } finally {
    store.close();
  }
}

function readPack(flags: Flags): string | null {
  const path = flags._[1];
  if (typeof path !== 'string' || path.trim() === '') {
    printUsage();
    process.exitCode = 1;
    return null;
  }
  try {
    return readFileSync(resolve(path), 'utf8');
  } catch (error) {
    console.error(`  cannot read ${path}: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
    return null;
  }
}

function cmdPackVerify(flags: Flags): void {
  const input = readPack(flags);
  if (input === null) return;
  const trust = stringFlag(flags, 'trust');
  const result = verifySegreantPack(input, trust === null ? {} : { trustedPublicKey: readKeyMaterial(trust) });
  if (!result.ok) process.exitCode = 1;
  if (flags.json) { printJson(result); return; }
  const tty = process.stdout.isTTY ?? false;
  console.log(color(tty, result.ok ? C.green : C.red, `  ${result.ok ? 'Pack verified' : 'Pack NOT verified'}`));
  console.log(`  Integrity     ${result.integrity}`);
  console.log(`  Authenticity  ${result.authenticity}${result.signature.status === 'valid' && !result.signature.pinned ? ' (embedded key only; pass --trust to establish it)' : ''}`);
  console.log(`  Truth         ${result.truth}`);
  console.log(`  Attachments   ${result.attachments.status} (${result.attachments.present}/${result.attachments.declared})`);
  for (const error of result.errors) console.log(color(tty, C.red, `  - ${error}`));
}

function cmdPackInspect(flags: Flags): void {
  const input = readPack(flags);
  if (input === null) return;
  let parsed: unknown;
  try { parsed = JSON.parse(input); } catch { console.error('  not JSON'); process.exitCode = 1; return; }
  const manifest = (parsed as { manifest?: Record<string, unknown> } | null)?.manifest;
  if (typeof manifest !== 'object' || manifest === null) { console.error('  no manifest'); process.exitCode = 1; return; }
  const count = (value: unknown): number => (Array.isArray(value) ? value.length : 0);
  const summary = {
    packId: manifest.packId ?? null,
    createdAt: manifest.createdAt ?? null,
    includedRecords: count(manifest.includedRecords),
    omissions: Array.isArray(manifest.omissions) ? manifest.omissions : [],
    redactions: Array.isArray(manifest.redactions) ? manifest.redactions : [],
    attachments: count(manifest.attachments),
    signed: typeof manifest.signature === 'object' && manifest.signature !== null,
    evaluated: 'nothing — inspect reads what the manifest says; run verify to check the bytes',
  };
  if (flags.json) { printJson(summary); return; }
  console.log(`  Pack          ${String(summary.packId)} (${String(summary.createdAt)})`);
  console.log(`  Records       ${summary.includedRecords} included`);
  for (const omission of summary.omissions as Array<{ kind?: string; count?: number; reason?: string }>) {
    console.log(`  Omitted       ${omission.count ?? '?'} ${omission.kind ?? '?'} — ${omission.reason ?? ''}`);
  }
  for (const redaction of summary.redactions as Array<{ kind?: string; ids?: string[]; fields?: string[]; reason?: string }>) {
    console.log(`  Redacted      ${redaction.ids?.length ?? '?'} ${redaction.kind ?? '?'} (${(redaction.fields ?? []).join(', ')}) — ${redaction.reason ?? ''}`);
  }
  console.log(`  Attachments   ${summary.attachments}`);
  console.log(`  Signed        ${summary.signed ? 'yes (unverified here)' : 'no'}`);
  console.log(color(process.stdout.isTTY ?? false, C.gray, `  ${summary.evaluated}`));
}

export function cmdPack(flags: Flags): void {
  const action = flags._[0];
  if (action === 'export') cmdPackExport(flags);
  else if (action === 'verify') cmdPackVerify(flags);
  else if (action === 'inspect') cmdPackInspect(flags);
  else { printUsage(); process.exitCode = 1; }
}
