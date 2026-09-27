/**
 * `segreant plugin run` — the operator face of the plugin host (D-234).
 *
 * Runs one bounded exchange with a plugin process and previews the kernel
 * Evidence it would append; `--apply` appends it. The manifest and the
 * request are files the operator wrote, the executable is a path the operator
 * chose, and the scope is a declaration the operator makes — the host infers
 * none of them. What the plugin said is recorded as what the plugin said.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { dbPath } from '../config.ts';
import { Store } from '../store/db.ts';
import { createPluginManifest } from '../plugins/contract.ts';
import { runPluginProcess } from '../plugins/host.ts';
import { applyPluginIntake, planPluginIntake } from '../plugins/intake.ts';
import type { Flags } from './flags.ts';
import { C, color, printJson } from './ui.ts';

function printUsage(): void {
  console.log('  segreant plugin run --manifest <file> --request <file> --exec <path> [--args "a b c"] [--cwd <dir>]');
  console.log('                    --scope key=value[,key=value] [--grain dim,dim] [--sensitivity internal|confidential] [--apply] [--json]');
  console.log('  Preview is the default: nothing is written without --apply.');
}

function stringFlag(flags: Flags, name: string): string | null {
  const value = flags[name];
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}

function readJson(path: string, label: string): unknown {
  try {
    return JSON.parse(readFileSync(resolve(path), 'utf8'));
  } catch (error) {
    throw new Error(`cannot read ${label} at ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function parseScope(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const pair of text.split(',')) {
    const at = pair.indexOf('=');
    if (at <= 0) throw new Error(`--scope entries are key=value; got ${pair}`);
    out[pair.slice(0, at).trim()] = pair.slice(at + 1).trim();
  }
  return out;
}

async function cmdPluginRun(flags: Flags): Promise<void> {
  const manifestPath = stringFlag(flags, 'manifest');
  const requestPath = stringFlag(flags, 'request');
  const executable = stringFlag(flags, 'exec');
  const scopeText = stringFlag(flags, 'scope');
  if (manifestPath === null || requestPath === null || executable === null || scopeText === null) {
    printUsage();
    process.exitCode = 1;
    return;
  }
  let manifest; let invocation; let scope;
  try {
    manifest = createPluginManifest(readJson(manifestPath, 'plugin manifest') as never);
    invocation = readJson(requestPath, 'plugin invocation');
    scope = parseScope(scopeText);
  } catch (error) {
    console.error(`  ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
    return;
  }
  // The flag parser keeps the last value of a repeated flag, so the child's
  // arguments travel as one whitespace-separated string.
  const args = (stringFlag(flags, 'args') ?? '').split(/\s+/).filter(Boolean);
  const grain = (stringFlag(flags, 'grain') ?? 'day,project').split(',').map((part) => part.trim()).filter(Boolean);
  const sensitivity = stringFlag(flags, 'sensitivity');
  if (sensitivity !== null && sensitivity !== 'internal' && sensitivity !== 'confidential') {
    console.error('  --sensitivity must be internal or confidential');
    process.exitCode = 1;
    return;
  }

  const hosted = await runPluginProcess({
    manifest, invocation, executable: resolve(executable), args, cwd: resolve(stringFlag(flags, 'cwd') ?? process.cwd()),
  });
  const tty = process.stdout.isTTY ?? false;
  if (hosted.status !== 'completed' || hosted.output === null) {
    process.exitCode = 1;
    if (flags.json) { printJson({ status: hosted.status, errors: hosted.errors, applied: false }); return; }
    console.log(color(tty, C.red, `  Plugin exchange ${hosted.status}`));
    for (const error of hosted.errors) console.log(`  - ${error}`);
    return;
  }

  const plan = planPluginIntake({
    manifest, output: hosted.output, scope, grain,
    ...(sensitivity === null ? {} : { sensitivity }),
  });
  const store = flags.apply ? new Store(dbPath()) : null;
  try {
    const result = store === null ? null : applyPluginIntake(store.epistemic(), plan);
    const refusals = result === null ? plan.refusals : result.refusals;
    if (refusals.length > 0) process.exitCode = 1;
    if (flags.json) {
      printJson({
        status: hosted.status, pid: hosted.pid, applied: result !== null && refusals.length === 0,
        evidence: plan.evidence.map((item) => ({ id: item.id, evidenceType: item.evidenceType, integrity: item.integrity, authenticity: item.authenticity, completeness: item.completeness.status })),
        integrity: plan.integrity, refusals,
        ...(result === null ? {} : { inserted: result.inserted, duplicate: result.duplicate }),
        notEnforced: hosted.notEnforcedControls,
      });
      return;
    }
    console.log('');
    console.log(color(tty, C.bold, `  Plugin ${manifest.pluginId}@${manifest.pluginVersion}`) + color(tty, C.gray, `   ${hosted.status}, pid ${hosted.pid ?? '—'}`));
    for (const item of plan.evidence) {
      const why = plan.integrity.find((entry) => entry.evidenceId === item.id)?.because ?? '';
      console.log(`    ${item.id}`);
      console.log(color(tty, C.gray, `      ${item.evidenceType} · integrity ${item.integrity} (${why}) · authenticity ${item.authenticity} · completeness ${item.completeness.status}`));
    }
    for (const refusal of refusals) console.log(color(tty, C.red, `  ✗ ${refusal}`));
    if (result === null) {
      console.log(color(tty, C.yellow, `  Preview: ${plan.evidence.length} Evidence envelope(s) would be appended. Re-run with --apply to append.`));
    } else if (refusals.length > 0) {
      console.log(color(tty, C.red, '  Refused: nothing was written.'));
    } else {
      console.log(color(tty, C.green, `  Appended ${result.inserted.length}, duplicate ${result.duplicate.length}.`));
    }
    console.log(color(tty, C.gray, `  Not enforced by this host: ${hosted.notEnforcedControls.join(', ')}`));
    console.log('');
  } finally {
    store?.close();
  }
}

export async function cmdPlugin(flags: Flags): Promise<void> {
  if (flags._[0] === 'run') await cmdPluginRun(flags);
  else { printUsage(); process.exitCode = 1; }
}
