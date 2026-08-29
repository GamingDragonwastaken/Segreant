/**
 * Hash-chained local receipts. They detect accidental edits/truncation, but are
 * not a defence against a machine administrator who can replace local files.
 */
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, unlinkSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { fiscusHome, type EgressDataClass, type EgressPurpose } from '../config.ts';
import type { EgressTargetClass } from './policy.ts';

export type EgressReceiptEvent = 'preflight_allowed' | 'preflight_denied' | 'dial_started' | 'response_received' | 'transport_failed';

export interface EgressReceipt {
  version: 1;
  id: string;
  at: string;
  event: EgressReceiptEvent;
  purpose: EgressPurpose;
  dataClass: EgressDataClass;
  method: string;
  targetClass: EgressTargetClass | 'denied';
  ruleId: string | null;
  originSha256: string | null;
  pathSha256: string | null;
  bodyBytes: number;
  status: number | null;
  previousHash: string | null;
  hash: string;
}

export interface ReceiptInput {
  event: EgressReceiptEvent;
  purpose: EgressPurpose;
  dataClass: EgressDataClass;
  method: string;
  targetClass: EgressTargetClass | 'denied';
  ruleId?: string;
  target?: URL;
  bodyBytes?: number;
  status?: number;
  at?: Date;
}

export interface ReceiptVerification {
  ok: boolean;
  receiptCount: number;
  validThroughHash: string | null;
  errors: string[];
}

export function egressReceiptPath(): string {
  return join(fiscusHome(), 'egress-receipts.jsonl');
}

function receiptLockPath(): string {
  return join(fiscusHome(), 'egress-receipts.lock');
}

/**
 * A receipt line's predecessor must be the actual immediately preceding line.
 * Appending without a lock makes two Fiscus processes race that invariant and
 * silently fork the hash chain, so every append/verification obtains the same
 * short-lived exclusive local lock. A stale lock fails closed rather than being
 * guessed away after a crash.
 */
function withReceiptLock<T>(fn: () => T): T {
  const lockPath = receiptLockPath();
  let fd: number | null = null;
  // Test runners and a real CLI + proxy can briefly contend on the same local
  // receipt log. Ten seconds is bounded, but comfortably exceeds a synchronous
  // hash/append/verification critical section on a large local ledger.
  for (let attempt = 0; attempt < 2_000; attempt++) {
    try {
      fd = openSync(lockPath, 'wx');
      break;
    } catch (error) {
      if (!(error instanceof Error) || !('code' in error) || error.code !== 'EEXIST') throw error;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
    }
  }
  if (fd === null) throw new Error('egress receipt lock remained busy');
  try {
    return fn();
  } finally {
    closeSync(fd);
    try {
      unlinkSync(lockPath);
    } catch {
      /* the next append fails closed if another fault leaves a lock behind */
    }
  }
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function payload(receipt: Omit<EgressReceipt, 'hash'>): string {
  return JSON.stringify(receipt);
}

function priorHash(path: string): string | null {
  if (!existsSync(path)) return null;
  const text = readFileSync(path, 'utf8').trim();
  if (!text) return null;
  try {
    const parsed = JSON.parse(text.slice(text.lastIndexOf('\n') + 1)) as Partial<EgressReceipt>;
    return typeof parsed.hash === 'string' && /^[a-f0-9]{64}$/.test(parsed.hash) ? parsed.hash : null;
  } catch {
    return null;
  }
}

/** Persistence faults are fail-closed before a request is allowed to dial. */
export function appendEgressReceipt(input: ReceiptInput): EgressReceipt {
  const home = fiscusHome();
  if (!existsSync(home)) mkdirSync(home, { recursive: true });
  return withReceiptLock(() => {
    const path = egressReceiptPath();
    const prior = priorHash(path);
    const base: Omit<EgressReceipt, 'hash'> = {
      version: 1,
      id: randomUUID(),
      at: (input.at ?? new Date()).toISOString(),
      event: input.event,
      purpose: input.purpose,
      dataClass: input.dataClass,
      method: input.method,
      targetClass: input.targetClass,
      ruleId: input.ruleId ?? null,
      originSha256: input.target ? sha256(input.target.origin) : null,
      pathSha256: input.target ? sha256(input.target.pathname) : null,
      bodyBytes: input.bodyBytes ?? 0,
      status: input.status ?? null,
      previousHash: prior,
    };
    const receipt: EgressReceipt = { ...base, hash: sha256((prior ?? '') + '\n' + payload(base)) };
    appendFileSync(path, JSON.stringify(receipt) + '\n', 'utf8');
    return receipt;
  });
}

export function verifyEgressReceipts(path = egressReceiptPath()): ReceiptVerification {
  if (!existsSync(path)) return { ok: true, receiptCount: 0, validThroughHash: null, errors: [] };
  return withReceiptLock(() => {
    const errors: string[] = [];
    let expectedPrevious: string | null = null;
    let count = 0;
    for (const [index, line] of readFileSync(path, 'utf8').split(/\r?\n/).filter(Boolean).entries()) {
      try {
        const receipt = JSON.parse(line) as EgressReceipt;
        const { hash, ...base } = receipt;
        if (receipt.previousHash !== expectedPrevious) errors.push('line ' + (index + 1) + ': previous-hash link does not match');
        if (hash !== sha256((expectedPrevious ?? '') + '\n' + payload(base))) errors.push('line ' + (index + 1) + ': receipt hash does not match');
        expectedPrevious = typeof hash === 'string' ? hash : expectedPrevious;
        count++;
      } catch {
        errors.push('line ' + (index + 1) + ': not valid receipt JSON');
      }
    }
    return { ok: errors.length === 0, receiptCount: count, validThroughHash: expectedPrevious, errors };
  });
}
