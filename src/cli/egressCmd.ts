/**
 * Operator control surface for Fiscus-process egress.
 *
 * The command changes only the local config or inspects local receipts. It
 * never probes a remote endpoint; a rule is reviewed as data before the
 * feature that needs it may make a request.
 */
import { loadConfig, saveConfig, type EgressConfig, type EgressRule } from '../config.ts';
import { validateEgressRule } from '../egress/policy.ts';
import { egressReceiptPath, verifyEgressReceipts, type ReceiptVerification } from '../egress/receipts.ts';
import type { Flags } from './flags.ts';
import { C, color, printJson } from './ui.ts';

function requestedMode(flags: Flags): EgressConfig['mode'] | null {
  const value = typeof flags.mode === 'string' ? flags.mode : null;
  return value === 'local_locked' || value === 'controlled_cloud' ? value : null;
}

function ruleFromFlags(flags: Flags): EgressRule | null {
  const keys = ['id', 'purpose', 'data-class', 'method', 'origin', 'path-prefix'] as const;
  if (!keys.some((key) => typeof flags[key] === 'string')) return null;
  if (!keys.every((key) => typeof flags[key] === 'string')) return null;
  return {
    id: String(flags.id),
    enabled: flags.disabled !== true,
    purpose: String(flags.purpose) as EgressRule['purpose'],
    dataClass: String(flags['data-class']) as EgressRule['dataClass'],
    method: String(flags.method).toUpperCase() as EgressRule['method'],
    origin: String(flags.origin),
    pathPrefix: String(flags['path-prefix']),
  };
}

function printUsage(tty: boolean): void {
  console.log('');
  console.log(color(tty, C.bold, '  Fiscus egress — process-scoped high-assurance transport'));
  console.log(color(tty, C.gray, '  Default is local_locked: literal loopback only. No remote probe is made by this command.'));
  console.log('');
  console.log(color(tty, C.gray, '  fiscus egress status'));
  console.log(color(tty, C.gray, '  fiscus egress plan --mode controlled_cloud --id openai-main --purpose provider_inference --data-class provider_request --method POST --origin https://api.openai.com --path-prefix /v1/'));
  console.log(color(tty, C.gray, '  fiscus egress apply --apply --mode controlled_cloud --id openai-main --purpose provider_inference --data-class provider_request --method POST --origin https://api.openai.com --path-prefix /v1/'));
  console.log(color(tty, C.gray, '  fiscus egress apply --apply --mode local_locked'));
  console.log(color(tty, C.gray, '  fiscus egress receipts | fiscus egress verify'));
  console.log('');
}

function statusPayload(): Record<string, unknown> {
  const cfg = loadConfig();
  const verified = verifyEgressReceipts();
  return {
    scope: 'Fiscus-process HTTP(S) transport only; it does not control other apps, direct clients, OS DNS/VPN/firewall, or provider retention.',
    mode: cfg.egress.mode,
    rules: cfg.egress.rules,
    receipts: { path: egressReceiptPath(), ...verified },
  };
}

/**
 * A chain verification is not a verdict on outbound traffic, and it was being
 * printed as one.
 *
 * `fiscus egress verify` said "Receipt chain valid" in GREEN, over "Receipts:
 * 0", and exited 0 on a home that had never recorded anything. That is the
 * single question this command exists to answer, answered with the wrong claim:
 * a hash chain over an empty set verifies vacuously, so the reassuring line was
 * printed exactly when Fiscus knew least. Green is now reserved for the one
 * basis that earns it, and every basis states its own window and its own limit
 * on the same screen as the result. Recorded at D-148.
 */
function chainHeadline(verification: ReceiptVerification): string {
  switch (verification.basis) {
    case 'no_record': return 'No receipt recorded — this establishes nothing about what left this machine';
    case 'chain_intact': return 'Receipt chain intact over the recorded window';
    case 'discontinuity': return 'Receipt history removed — the chain is discontinuous';
    case 'chain_broken': return 'Receipt chain invalid';
  }
}

function chainTone(verification: ReceiptVerification): string {
  if (verification.state === 'supported') return C.green;
  // `unknown` is deliberately not red. Nothing is wrong; nothing is known, and
  // dressing an absence of evidence as a fault is the same collapse in the
  // other direction.
  return verification.state === 'unknown' ? C.yellow : C.red;
}

function coveredSuffix(verification: ReceiptVerification): string {
  if (verification.coveredFrom === null) return '';
  return ' (' + verification.coveredFrom + ' through ' + String(verification.coveredThrough) + ')';
}

function chainLine(verification: ReceiptVerification): string {
  switch (verification.basis) {
    case 'no_record': return 'no chain recorded';
    case 'chain_intact': return 'chain intact' + coveredSuffix(verification);
    case 'discontinuity': return 'chain DISCONTINUOUS';
    case 'chain_broken': return 'chain INVALID';
  }
}

const RECEIPT_REPAIR_ACTION = 'preserve and repair/restore the present receipt history before retrying; if the lock is stale, confirm no Fiscus writer is active, then remove only that lock and rerun verify; Fiscus will not restart history as genesis.';

function printReceiptAction(ok: boolean): void {
  if (ok) return;
  console.error('  Action: ' + RECEIPT_REPAIR_ACTION);
}

export function cmdEgress(flags: Flags): void {
  const tty = process.stdout.isTTY ?? false;
  const sub = typeof flags._[0] === 'string' ? flags._[0] : 'status';
  if (sub === 'status') {
    const payload = statusPayload();
    if (flags.json) printJson(payload);
    else {
      console.log('');
      console.log(color(tty, C.bold, '  Fiscus egress status'));
      console.log('  Mode: ' + payload.mode);
      const rules = payload.rules as EgressRule[];
      console.log('  Rules: ' + (rules.length ? rules.map((rule) => rule.id + ' (' + (rule.enabled ? 'enabled' : 'disabled') + ')').join(', ') : 'none'));
      const receipts = payload.receipts as ReturnType<typeof verifyEgressReceipts> & { path: string };
      console.log('  Receipts: ' + receipts.receiptCount + ' local receipt(s), ' + chainLine(receipts));
      console.log(color(tty, C.gray, '  Does not establish: ' + receipts.doesNotEstablish));
      if (!receipts.ok) {
        for (const failure of receipts.errors) console.error(color(tty, C.red, '  ' + failure));
        printReceiptAction(false);
      }
      console.log(color(tty, C.gray, '  Scope: ' + payload.scope));
      console.log('');
    }
    return;
  }

  if (sub === 'receipts' || sub === 'verify') {
    const verified = verifyEgressReceipts();
    const payload = {
      path: egressReceiptPath(),
      ...verified,
      ...(verified.ok ? {} : { action: RECEIPT_REPAIR_ACTION }),
    };
    if (flags.json) printJson(payload);
    else {
      console.log('');
      console.log(color(tty, chainTone(payload), '  ' + chainHeadline(payload)));
      console.log('  Receipts: ' + payload.receiptCount + coveredSuffix(payload));
      console.log('  Path: ' + payload.path);
      console.log('  Establishes: ' + payload.establishes);
      console.log(color(tty, C.gray, '  Does not establish: ' + payload.doesNotEstablish));
      for (const failure of payload.errors) console.error(color(tty, C.red, '  ' + failure));
      printReceiptAction(payload.ok);
      console.log('');
    }
    if (!payload.ok) process.exitCode = 1;
    return;
  }

  if (sub !== 'plan' && sub !== 'apply') {
    printUsage(tty);
    process.exitCode = 1;
    return;
  }

  const current = loadConfig();
  const mode = requestedMode(flags);
  const candidate = ruleFromFlags(flags);
  if (typeof flags.mode === 'string' && mode === null) {
    console.error('  --mode must be local_locked or controlled_cloud');
    process.exitCode = 1;
    return;
  }
  if (candidate === null && ['id', 'purpose', 'data-class', 'method', 'origin', 'path-prefix'].some((key) => typeof flags[key] === 'string')) {
    console.error('  A rule needs all of: --id --purpose --data-class --method --origin --path-prefix');
    process.exitCode = 1;
    return;
  }
  if (candidate) {
    const failures = validateEgressRule(candidate);
    if (failures.length) {
      console.error('  Rule refused: ' + failures.join('; '));
      process.exitCode = 1;
      return;
    }
  }
  const next: EgressConfig = {
    mode: mode ?? current.egress.mode,
    rules: candidate
      ? [...current.egress.rules.filter((rule) => rule.id !== candidate.id), candidate].sort((a, b) => a.id.localeCompare(b.id))
      : current.egress.rules,
  };
  if (next.mode === 'controlled_cloud' && next.rules.length === 0) {
    console.error('  controlled_cloud needs at least one exact rule; use local_locked to remove all remote permission');
    process.exitCode = 1;
    return;
  }
  const payload = { wouldWrite: sub === 'apply' && flags.apply === true, mode: next.mode, rules: next.rules };
  if (sub === 'plan' || flags.apply !== true) {
    if (flags.json) printJson(payload);
    else {
      console.log('');
      console.log(color(tty, C.yellow, '  Egress plan only — configuration unchanged.'));
      console.log('  Mode: ' + next.mode + '; rules: ' + next.rules.map((rule) => rule.id).join(', '));
      console.log(color(tty, C.gray, '  To persist this exact plan, rerun with: fiscus egress apply --apply ...'));
      console.log('');
    }
    return;
  }
  saveConfig({ ...current, egress: next });
  if (flags.json) printJson(payload);
  else {
    console.log('');
    console.log(color(tty, C.green, '  Egress configuration saved.'));
    console.log('  Mode: ' + next.mode + '; rules: ' + next.rules.map((rule) => rule.id).join(', '));
    console.log(color(tty, C.gray, '  This changes only Fiscus-process transport; it does not impose a machine-wide network policy.'));
    console.log('');
  }
}
