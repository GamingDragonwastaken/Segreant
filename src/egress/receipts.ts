/**
 * Hash-chained local receipts. A genuinely absent history may establish genesis;
 * a present history must validate completely before it can be extended. This
 * detects accidental edits/truncation and fails closed before dial. The lock
 * coordinates cooperative Fiscus writers; path identity checks catch ordinary
 * replacement races, but a machine administrator can still replace local files
 * outside that cooperation boundary. Persistence is synchronous, not an fsync
 * or power-loss durability guarantee.
 */
import {
  closeSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  readFileSync,
  renameSync,
  Stats,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { StringDecoder } from 'node:string_decoder';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
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

export type EgressReceiptFailureCode = 'integrity' | 'persistence' | 'lock';

/** A typed refusal for receipt-history integrity or local persistence faults. */
export class EgressReceiptError extends Error {
  readonly code: EgressReceiptFailureCode;
  readonly errors: string[];

  constructor(code: EgressReceiptFailureCode, message: string, errors: string[] = [message]) {
    super(message);
    this.name = 'EgressReceiptError';
    this.code = code;
    this.errors = errors;
  }
}

let receiptLockReleaseHookForTests: (() => void) | undefined;
let receiptWriteHookForTests: (() => void) | undefined;
let receiptContentionLockLstatForTests: ((path: string) => Stats) | undefined;

/** @internal deterministic filesystem-failure seam used only by boundary tests. */
export function setReceiptLockReleaseHookForTests(hook: (() => void) | undefined): () => void {
  const previous = receiptLockReleaseHookForTests;
  receiptLockReleaseHookForTests = hook;
  return () => {
    receiptLockReleaseHookForTests = previous;
  };
}

/** @internal deterministic path-replacement seam used only by boundary tests. */
export function setReceiptWriteHookForTests(hook: (() => void) | undefined): () => void {
  const previous = receiptWriteHookForTests;
  receiptWriteHookForTests = hook;
  return () => {
    receiptWriteHookForTests = previous;
  };
}

/** @internal one-shot seam limited to contention lock-path inspection. */
export function setReceiptContentionLockLstatForTests(hook: ((path: string) => Stats) | undefined): () => void {
  const previous = receiptContentionLockLstatForTests;
  receiptContentionLockLstatForTests = hook;
  return () => {
    receiptContentionLockLstatForTests = previous;
  };
}

export function egressReceiptPath(): string {
  return join(fiscusHome(), 'egress-receipts.jsonl');
}

function receiptLockPath(): string {
  return join(fiscusHome(), 'egress-receipts.lock');
}

function receiptCheckpointPath(): string {
  return join(fiscusHome(), 'egress-receipts.checkpoint.json');
}

/**
 * A receipt line's predecessor must be the actual immediately preceding line.
 * Appending without a lock makes two Fiscus processes race that invariant and
 * silently fork the hash chain, so every append/verification obtains the same
 * short-lived exclusive local lock. A stale lock fails closed rather than being
 * guessed away after a crash.
 */
function errorCode(error: unknown): string | undefined {
  return error && typeof error === 'object' && 'code' in error && typeof error.code === 'string'
    ? error.code
    : undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function asReceiptError(error: unknown, code: EgressReceiptFailureCode, prefix: string): EgressReceiptError {
  if (error instanceof EgressReceiptError) return error;
  return new EgressReceiptError(code, prefix + ': ' + errorMessage(error));
}

type ContentionLockPathState = 'absent' | 'regular' | 'unsafe';

function contentionLockPathState(path: string): ContentionLockPathState {
  try {
    const injectedLstat = receiptContentionLockLstatForTests;
    receiptContentionLockLstatForTests = undefined;
    return (injectedLstat ?? lstatSync)(path).isFile() ? 'regular' : 'unsafe';
  } catch (error) {
    // This state is derived from one lstat generation. A contender can remove
    // its lock after openSync reports EEXIST; retry absence immediately rather
    // than combining it with a second path observation from a later generation.
    if (errorCode(error) === 'ENOENT') return 'absent';
    throw asReceiptError(error, 'persistence', 'egress receipt lock/persistence failed while inspecting the lock');
  }
}

function releaseReceiptLock(fd: number, lockPath: string, acquiredIdentity: ReceiptFileIdentity): void {
  let failure: EgressReceiptError | null = null;
  try {
    const current = lstatSync(lockPath);
    if (!current.isFile() || !sameReceiptObject(acquiredIdentity, receiptFileIdentity(current))) {
      failure = new EgressReceiptError(
        'lock',
        'egress receipt lock/persistence failed while releasing the lock: lock path changed or was replaced; replacement was not unlinked',
      );
    }
  } catch (error) {
    failure = asReceiptError(error, 'lock', 'egress receipt lock/persistence failed while releasing the lock');
  }
  try {
    closeSync(fd);
  } catch (error) {
    if (failure === null) failure = asReceiptError(error, 'lock', 'egress receipt lock/persistence failed while closing the lock');
  }
  if (failure === null) {
    try {
      unlinkSync(lockPath);
    } catch (error) {
      failure = asReceiptError(error, 'lock', 'egress receipt lock/persistence failed while releasing the lock');
    }
  }
  if (failure !== null) throw failure;
}

function withReceiptLock<T>(fn: () => T): T {
  const home = fiscusHome();
  try {
    mkdirSync(home, { recursive: true });
  } catch (error) {
    throw asReceiptError(error, 'persistence', 'egress receipt lock/persistence failed while preparing the Fiscus home');
  }
  const lockPath = receiptLockPath();
  let fd: number | null = null;
  let acquiredIdentity: ReceiptFileIdentity | null = null;
  // Test runners and a real CLI + proxy can briefly contend on the same local
  // receipt log. Use a monotonic ten-second deadline: on Windows, a requested
  // 5 ms wait can consume a much coarser timer slice, so attempt count is not a
  // truthful elapsed-time bound. The attempt cap also fails closed if a runtime
  // returns from the wait spuriously without advancing the clock as expected.
  const lockDeadline = performance.now() + 10_000;
  for (let attempt = 0; attempt < 2_000; attempt++) {
    try {
      const candidate = openSync(lockPath, 'wx');
      try {
        const candidateIdentity = receiptFileIdentity(fstatSync(candidate));
        const pathStat = lstatSync(lockPath);
        if (!pathStat.isFile() || !sameReceiptObject(candidateIdentity, receiptFileIdentity(pathStat))) {
          throw new EgressReceiptError('lock', 'egress receipt lock/persistence failed while opening the lock: lock path identity changed; refusing an ambiguous owner');
        }
        fd = candidate;
        acquiredIdentity = candidateIdentity;
      } catch (error) {
        try { closeSync(candidate); } catch { /* preserve the identity failure */ }
        throw error;
      }
      break;
    } catch (error) {
      const code = errorCode(error);
      // On Windows, an exclusive open of a lock held by another process can
      // transiently report EPERM/EACCES rather than EEXIST while the handle is
      // being created or released. Treat those codes as contention; a real
      // permission/open failure still reaches the bounded lock timeout and is
      // refused rather than falling through to a dial.
      if (code === 'EPERM' || code === 'EACCES') {
        const remainingMs = lockDeadline - performance.now();
        if (remainingMs <= 0) break;
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.min(5, remainingMs));
        continue;
      }
      if (code !== 'EEXIST') {
        throw asReceiptError(error, 'persistence', 'egress receipt lock/persistence failed while opening the lock');
      }
      const lockPathState = contentionLockPathState(lockPath);
      if (lockPathState === 'absent') continue;
      if (lockPathState === 'unsafe') {
        throw new EgressReceiptError('lock', 'egress receipt lock/persistence failed: lock path is not a regular file');
      }
      const remainingMs = lockDeadline - performance.now();
      if (remainingMs <= 0) break;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.min(5, remainingMs));
    }
  }
  if (fd === null) throw new EgressReceiptError('lock', 'egress receipt lock/persistence failed: lock remained busy');
  if (acquiredIdentity === null) throw new EgressReceiptError('lock', 'egress receipt lock/persistence failed: lock identity was not retained');
  try {
    return fn();
  } finally {
    // Lock cleanup is part of the critical section's success condition. If
    // release cannot be completed, report a typed refusal instead of allowing
    // the caller to proceed to DNS/socket creation with an uncertain lock
    // owner or an abandoned lock path.
    receiptLockReleaseHookForTests?.();
    releaseReceiptLock(fd, lockPath, acquiredIdentity);
  }
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function payload(receipt: Omit<EgressReceipt, 'hash'>): string {
  return JSON.stringify(receipt);
}

function receiptHash(previous: string | null, receipt: Omit<EgressReceipt, 'hash'>): string {
  return sha256((previous ?? '') + '\n' + payload(receipt));
}

const RECEIPT_EVENTS: readonly EgressReceiptEvent[] = [
  'preflight_allowed', 'preflight_denied', 'dial_started', 'response_received', 'transport_failed',
];

const RECEIPT_PURPOSES: readonly EgressPurpose[] = [
  'provider_inference', 'pricing_refresh', 'baseline_refresh', 'alert_delivery',
  'provider_cost_observation', 'team_rollup', 'hosted_judge', 'local_judge', 'local_healthcheck',
];

const RECEIPT_DATA_CLASSES: readonly EgressDataClass[] = [
  'provider_request', 'pricing_manifest', 'baseline_manifest', 'alert_metadata',
  'provider_cost_aggregate', 'team_rollup', 'judge_structural_summary',
  'judge_transcript_excerpt', 'healthcheck',
];

const RECEIPT_TARGET_CLASSES: readonly (EgressTargetClass | 'denied')[] = [
  'loopback', 'controlled_cloud', 'denied',
];

const RECEIPT_FIELDS = new Set([
  'version', 'id', 'at', 'event', 'purpose', 'dataClass', 'method', 'targetClass',
  'ruleId', 'originSha256', 'pathSha256', 'bodyBytes', 'status', 'previousHash', 'hash',
]);

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isHash(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
}

function isIsoTimestamp(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) return false;
  const parsed = Date.parse(value);
  return !Number.isNaN(parsed) && new Date(parsed).toISOString() === value;
}

function schemaErrors(value: unknown, line: number): string[] {
  if (!isObject(value)) return ['line ' + line + ': receipt must be a JSON object'];
  const failures: string[] = [];
  const unexpected = Object.keys(value).filter((key) => !RECEIPT_FIELDS.has(key));
  if (unexpected.length) failures.push('line ' + line + ': unexpected receipt field(s): ' + unexpected.join(', '));
  if (value.version !== 1) failures.push('line ' + line + ': version must be 1');
  if (typeof value.id !== 'string' || value.id.length === 0) failures.push('line ' + line + ': id must be a non-empty string');
  if (!isIsoTimestamp(value.at)) failures.push('line ' + line + ': at must be a canonical ISO date string');
  if (!RECEIPT_EVENTS.includes(value.event as EgressReceiptEvent)) failures.push('line ' + line + ': event is not a supported receipt event');
  if (!RECEIPT_PURPOSES.includes(value.purpose as EgressPurpose)) failures.push('line ' + line + ': purpose is not a supported Fiscus purpose');
  if (!RECEIPT_DATA_CLASSES.includes(value.dataClass as EgressDataClass)) failures.push('line ' + line + ': dataClass is not a supported Fiscus data class');
  if (typeof value.method !== 'string' || !/^[A-Z]+$/.test(value.method)) failures.push('line ' + line + ': method must be a non-empty uppercase token');
  if (!RECEIPT_TARGET_CLASSES.includes(value.targetClass as EgressTargetClass | 'denied')) failures.push('line ' + line + ': targetClass is not supported');
  if (value.ruleId !== null && typeof value.ruleId !== 'string') failures.push('line ' + line + ': ruleId must be a string or null');
  if (value.originSha256 !== null && !isHash(value.originSha256)) failures.push('line ' + line + ': originSha256 must be a hash or null');
  if (value.pathSha256 !== null && !isHash(value.pathSha256)) failures.push('line ' + line + ': pathSha256 must be a hash or null');
  if (typeof value.bodyBytes !== 'number' || !Number.isSafeInteger(value.bodyBytes) || value.bodyBytes < 0) failures.push('line ' + line + ': bodyBytes must be a non-negative safe integer');
  if (value.status !== null && (typeof value.status !== 'number' || !Number.isSafeInteger(value.status) || value.status < 0)) failures.push('line ' + line + ': status must be a non-negative safe integer or null');
  if (value.previousHash !== null && !isHash(value.previousHash)) failures.push('line ' + line + ': previousHash must be a hash or null');
  if (!isHash(value.hash)) failures.push('line ' + line + ': hash must be a lowercase SHA-256 value');
  return failures;
}

interface ReceiptHistoryInspection extends ReceiptVerification {
  present: boolean;
  records: Array<EgressReceipt | null>;
  identity?: ReceiptFileIdentity;
}

const RECEIPT_READ_CHUNK_BYTES = 64 * 1024;
const MAX_RECEIPT_LINE_BYTES = 1024 * 1024;

interface ReceiptFileIdentity {
  dev: number;
  ino: number;
  size: number;
  mtimeMs: number;
  ctimeMs: number;
  birthtimeMs: number;
}

function receiptFileIdentity(stat: Stats): ReceiptFileIdentity {
  return {
    dev: stat.dev,
    ino: stat.ino,
    size: stat.size,
    mtimeMs: stat.mtimeMs,
    ctimeMs: stat.ctimeMs,
    birthtimeMs: stat.birthtimeMs,
  };
}

function sameReceiptFile(a: ReceiptFileIdentity, b: ReceiptFileIdentity): boolean {
  return a.dev === b.dev
    && a.ino === b.ino
    && a.size === b.size
    && a.mtimeMs === b.mtimeMs
    && a.ctimeMs === b.ctimeMs
    && a.birthtimeMs === b.birthtimeMs;
}

interface ReceiptCheckpoint {
  version: 1;
  receiptCount: number;
  validThroughHash: string | null;
  fileIdentity: ReceiptFileIdentity;
  checkpointHash: string;
}

const CHECKPOINT_FIELDS = new Set(['version', 'receiptCount', 'validThroughHash', 'fileIdentity', 'checkpointHash']);
const FILE_IDENTITY_FIELDS = new Set(['dev', 'ino', 'size', 'mtimeMs', 'ctimeMs', 'birthtimeMs']);

function checkpointPayload(value: Omit<ReceiptCheckpoint, 'checkpointHash'>): string {
  return JSON.stringify(value);
}

function isFileIdentity(value: unknown): value is ReceiptFileIdentity {
  if (!isObject(value)) return false;
  const keys = Object.keys(value).sort();
  return keys.length === FILE_IDENTITY_FIELDS.size
    && keys.every((key) => FILE_IDENTITY_FIELDS.has(key))
    && [...FILE_IDENTITY_FIELDS].every((key) => typeof value[key] === 'number' && Number.isFinite(value[key]) && value[key] >= 0);
}

function readReceiptCheckpoint(): ReceiptCheckpoint | null {
  const path = receiptCheckpointPath();
  let stat: Stats;
  try {
    stat = lstatSync(path);
  } catch (error) {
    return errorCode(error) === 'ENOENT' ? null : null;
  }
  if (!stat.isFile() || stat.isSymbolicLink()) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown;
    if (!isObject(parsed)) return null;
    const keys = Object.keys(parsed).sort();
    if (keys.length !== CHECKPOINT_FIELDS.size || !keys.every((key) => CHECKPOINT_FIELDS.has(key))) return null;
    if (parsed.version !== 1 || typeof parsed.receiptCount !== 'number' || !Number.isSafeInteger(parsed.receiptCount) || parsed.receiptCount <= 0) return null;
    if (parsed.validThroughHash !== null && !isHash(parsed.validThroughHash)) return null;
    if (!isFileIdentity(parsed.fileIdentity) || !isHash(parsed.checkpointHash)) return null;
    const { checkpointHash, ...base } = parsed as Omit<ReceiptCheckpoint, 'checkpointHash'> & { checkpointHash: string };
    if (checkpointHash !== sha256(checkpointPayload(base))) return null;
    return parsed as unknown as ReceiptCheckpoint;
  } catch {
    return null;
  }
}

function writeReceiptCheckpoint(historyPath: string, receiptCount: number, validThroughHash: string): void {
  const historyStat = receiptHistoryStat(historyPath);
  if (historyStat === null) throw new EgressReceiptError('persistence', 'egress receipt history disappeared before checkpoint publication');
  const checkpointPath = receiptCheckpointPath();
  try {
    const existing = lstatSync(checkpointPath);
    if (!existing.isFile() || existing.isSymbolicLink()) {
      throw new EgressReceiptError('persistence', 'egress receipt checkpoint path is not a regular file; restore it before retrying');
    }
  } catch (error) {
    if (error instanceof EgressReceiptError) throw error;
    if (errorCode(error) !== 'ENOENT') throw asReceiptError(error, 'persistence', 'egress receipt checkpoint could not be inspected');
  }
  const base: Omit<ReceiptCheckpoint, 'checkpointHash'> = {
    version: 1,
    receiptCount,
    validThroughHash,
    fileIdentity: receiptFileIdentity(historyStat),
  };
  const checkpoint: ReceiptCheckpoint = { ...base, checkpointHash: sha256(checkpointPayload(base)) };
  const tempPath = `${checkpointPath}.tmp-${randomUUID()}`;
  let fd: number | null = null;
  try {
    fd = openSync(tempPath, 'wx', 0o600);
    const bytes = Buffer.from(JSON.stringify(checkpoint) + '\n', 'utf8');
    try {
      let offset = 0;
      while (offset < bytes.length) {
        const written = writeSync(fd, bytes, offset, bytes.length - offset, null);
        if (written <= 0) throw new EgressReceiptError('persistence', 'egress receipt checkpoint wrote no bytes');
        offset += written;
      }
      fsyncSync(fd);
    } finally {
      bytes.fill(0);
    }
    closeSync(fd);
    fd = null;
    renameSync(tempPath, checkpointPath);
  } catch (error) {
    if (fd !== null) {
      try { closeSync(fd); } catch { /* preserve the original persistence error */ }
    }
    try { unlinkSync(tempPath); } catch { /* no residue is best effort after a failed write */ }
    if (error instanceof EgressReceiptError) throw error;
    throw asReceiptError(error, 'persistence', 'egress receipt checkpoint persistence failed');
  }
}

function sameReceiptObject(a: ReceiptFileIdentity, b: ReceiptFileIdentity): boolean {
  return a.dev === b.dev && a.ino === b.ino && a.birthtimeMs === b.birthtimeMs;
}

function receiptHistoryStat(path: string): Stats | null {
  try {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) {
      throw new EgressReceiptError('persistence', 'egress receipt history path is a symbolic link/reparse point; restore a regular local file before retrying');
    }
    if (!stat.isFile()) {
      throw new EgressReceiptError('persistence', 'egress receipt history path is not a regular file; restore a regular local file before retrying');
    }
    return stat;
  } catch (error) {
    if (error instanceof EgressReceiptError) throw error;
    if (errorCode(error) === 'ENOENT') return null;
    throw asReceiptError(error, 'persistence', 'egress receipt history path could not be inspected');
  }
}

function inspectReceiptHistory(path: string): ReceiptHistoryInspection {
  const before = receiptHistoryStat(path);
  if (before === null) return { ok: true, receiptCount: 0, validThroughHash: null, errors: [], present: false, records: [] };
  const identity = receiptFileIdentity(before);
  let fd: number | null = null;
  try {
    fd = openSync(path, 'r');
    const openedIdentity = receiptFileIdentity(fstatSync(fd));
    if (!sameReceiptFile(identity, openedIdentity)) {
      throw new EgressReceiptError('persistence', 'egress receipt history changed before it was read; retry only after the history is stable');
    }

    const errors: string[] = [];
    const decoder = new StringDecoder('utf8');
    const chunk = Buffer.allocUnsafe(RECEIPT_READ_CHUNK_BYTES);
    let pending = '';
    let lineNumber = 0;
    let totalBytes = 0;
    let sawTerminatingNewline = false;
    let expectedPrevious: string | null = null;
    let validThroughHash: string | null = null;
    let receiptCount = 0;
    let sawLine = false;

    const inspectLine = (rawLine: string): void => {
      sawLine = true;
      lineNumber++;
      const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
      if (!line.trim()) {
        errors.push('line ' + lineNumber + ': empty receipt line');
        return;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        errors.push('line ' + lineNumber + ': not valid receipt JSON');
        return;
      }
      const failures = schemaErrors(parsed, lineNumber);
      if (failures.length) {
        errors.push(...failures);
        return;
      }
      const receipt = parsed as EgressReceipt;
      receiptCount++;
      const { hash, ...base } = receipt;
      const previousMatches = receipt.previousHash === expectedPrevious;
      const hashMatches = hash === receiptHash(expectedPrevious, base);
      if (!previousMatches) errors.push('line ' + lineNumber + ': previous-hash link does not match');
      if (!hashMatches) errors.push('line ' + lineNumber + ': receipt hash does not match');
      if (previousMatches && hashMatches) {
        expectedPrevious = hash;
        validThroughHash = hash;
      }
    };

    while (true) {
      const bytesRead = readSync(fd, chunk, 0, chunk.length, null);
      if (bytesRead === 0) break;
      totalBytes += bytesRead;
      pending += decoder.write(chunk.subarray(0, bytesRead));
      let newline = pending.indexOf('\n');
      while (newline >= 0) {
        inspectLine(pending.slice(0, newline));
        pending = pending.slice(newline + 1);
        sawTerminatingNewline = true;
        newline = pending.indexOf('\n');
      }
      if (Buffer.byteLength(pending, 'utf8') > MAX_RECEIPT_LINE_BYTES) {
        throw new EgressReceiptError('integrity', 'egress receipt history contains a line larger than the supported limit; repair it before retrying');
      }
    }
    pending += decoder.end();
    if (pending.length > 0) inspectLine(pending);
    if (totalBytes === 0) {
      return {
        ok: false,
        receiptCount: 0,
        validThroughHash: null,
        errors: ['empty receipt history is present; remove or repair it before retrying'],
        present: true,
        records: [],
        identity,
      };
    }
    if (!sawTerminatingNewline) errors.push('receipt history is not terminated by a newline; repair the truncated final record before retrying');
    const after = receiptHistoryStat(path);
    if (after === null || !sameReceiptFile(openedIdentity, receiptFileIdentity(after))) {
      throw new EgressReceiptError('persistence', 'egress receipt history changed while it was being read; retry only after the history is stable');
    }
    return {
      ok: errors.length === 0 && sawLine,
      receiptCount,
      validThroughHash,
      errors,
      present: true,
      records: [],
      identity,
    };
  } catch (error) {
    if (error instanceof EgressReceiptError) throw error;
    if (errorCode(error) === 'ENOENT') {
      throw new EgressReceiptError('persistence', 'egress receipt history disappeared after its presence was confirmed; restore it before retrying');
    }
    throw asReceiptError(error, 'persistence', 'egress receipt history could not be read');
  } finally {
    if (fd !== null) {
      try { closeSync(fd); } catch { /* preserve the original read result */ }
    }
  }
}

/**
 * Reuse a previously verified tail when the canonical file has not changed.
 * Any missing/invalid checkpoint, or any file-identity drift, falls back to a
 * complete scan; the checkpoint is never itself treated as the evidence chain.
 */
function inspectReceiptHistoryForAppend(path: string): ReceiptHistoryInspection {
  const stat = receiptHistoryStat(path);
  if (stat === null) {
    return { ok: true, receiptCount: 0, validThroughHash: null, errors: [], present: false, records: [] };
  }
  const checkpoint = readReceiptCheckpoint();
  if (checkpoint && sameReceiptFile(receiptFileIdentity(stat), checkpoint.fileIdentity)) {
    return {
      ok: true,
      receiptCount: checkpoint.receiptCount,
      validThroughHash: checkpoint.validThroughHash,
      errors: [],
      present: true,
      records: [],
      identity: receiptFileIdentity(stat),
    };
  }
  return inspectReceiptHistory(path);
}

function persistReceiptLine(path: string, history: ReceiptHistoryInspection, line: string): void {
  let fd: number | null = null;
  try {
    if (history.present) {
      if (history.identity === undefined) {
        throw new EgressReceiptError('persistence', 'egress receipt history identity was not retained; refuse to extend it');
      }
      fd = openSync(path, 'a');
      const current = receiptFileIdentity(fstatSync(fd));
      if (!sameReceiptFile(history.identity, current)) {
        throw new EgressReceiptError('persistence', 'egress receipt history changed before append; retry only after the history is stable');
      }
    } else {
      try {
        // Exclusive creation prevents an absent-path genesis decision from
        // racing a concurrent creator or a path replacement into a null
        // predecessor record.
        fd = openSync(path, 'ax');
      } catch (error) {
        if (errorCode(error) === 'EEXIST') {
          throw new EgressReceiptError('persistence', 'egress receipt history appeared after absence was confirmed; refuse to restart it as genesis');
        }
        throw error;
      }
    }
    receiptWriteHookForTests?.();
    const bytes = Buffer.from(line, 'utf8');
    let offset = 0;
    while (offset < bytes.length) {
      const written = writeSync(fd, bytes, offset, bytes.length - offset, null);
      if (written <= 0) throw new EgressReceiptError('persistence', 'egress receipt persistence wrote no bytes');
      offset += written;
    }
    const afterFd = receiptFileIdentity(fstatSync(fd));
    const afterPath = receiptHistoryStat(path);
    if (afterPath === null || !sameReceiptObject(afterFd, receiptFileIdentity(afterPath))) {
      throw new EgressReceiptError('persistence', 'egress receipt history path identity changed after append; the write was not accepted');
    }
  } catch (error) {
    if (error instanceof EgressReceiptError) throw error;
    throw asReceiptError(error, 'persistence', 'egress receipt persistence failed');
  } finally {
    if (fd !== null) {
      try {
        closeSync(fd);
      } catch (error) {
        throw asReceiptError(error, 'persistence', 'egress receipt persistence failed while closing the receipt file');
      }
    }
  }
}

/** Persistence faults are fail-closed before a request is allowed to dial. */
export function appendEgressReceipt(input: ReceiptInput): EgressReceipt {
  return withReceiptLock(() => {
    const path = egressReceiptPath();
    const history = inspectReceiptHistoryForAppend(path);
    if (!history.ok) {
      throw new EgressReceiptError(
        'integrity',
        'egress receipt history is invalid; ' + history.errors.join('; '),
        history.errors,
      );
    }
    const prior = history.validThroughHash;
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
    const receipt: EgressReceipt = { ...base, hash: receiptHash(prior, base) };
    persistReceiptLine(path, history, JSON.stringify(receipt) + '\n');
    writeReceiptCheckpoint(path, history.receiptCount + 1, receipt.hash);
    return receipt;
  });
}

export function verifyEgressReceipts(path = egressReceiptPath()): ReceiptVerification {
  try {
    return withReceiptLock(() => {
      const inspection = inspectReceiptHistory(path);
      return {
        ok: inspection.ok,
        receiptCount: inspection.receiptCount,
        validThroughHash: inspection.validThroughHash,
        errors: inspection.errors,
      };
    });
  } catch (error) {
    const failure = asReceiptError(error, 'persistence', 'egress receipt verification failed');
    return { ok: false, receiptCount: 0, validThroughHash: null, errors: failure.errors };
  }
}
