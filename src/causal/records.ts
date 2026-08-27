/**
 * Strict, v2-only causal terminal-record decoders.
 *
 * This module is intentionally independent from the retained v1 record types.
 * Unknown input is fully shape-checked before any property is read.  The
 * decoder exposes only bounded validation failures; callers must not use its
 * error text as a disclosure channel.
 */

import { createHash } from 'node:crypto';
import { canonicalJson } from './protocol.ts';
import type {
  CausalExecutionRecordV2,
  CausalTerminalOutcomeRecordV2,
  CausalEvidenceClassV2,
  CostSourceClass,
  ExecutionAdherence,
  OrdinaryLedgerVerifierResultV2,
} from './types.ts';

const ID_RE = /^[a-z][a-z0-9._-]{0,31}:[A-Za-z0-9][A-Za-z0-9._-]{0,126}$/;
const DIGEST_RE = /^sha256:[a-f0-9]{64}$/;
const EXECUTION_KEYS = [
  'type', 'version', 'executionId', 'decisionId', 'studyId', 'protocolHash',
  'startedAtMs', 'completedAtMs', 'assignedExecutionPlanDigest',
  'actualExecutionPlanDigest', 'adherence', 'requestIds', 'directAiCostUsd',
  'directCostSourceClass', 'priceLineageDigests', 'fullArmCostUsd',
  'fullCostSourceClass', 'ordinaryLedgerVerifier', 'previousEventHash',
  'eventHash',
] as const;
const VERIFIER_KEYS = [
  'type', 'version', 'state', 'checkedAtMs', 'requestCount',
  'evidenceManifestHash', 'reasonCodes', 'resultHash',
] as const;
const COST_CLASSES: readonly CostSourceClass[] = [
  'actual_reconciled', 'actual_observed', 'modeled_price_card', 'incomplete_or_unknown',
];
const ADHERENCE: readonly ExecutionAdherence[] = ['confirmed', 'deviated', 'incomplete', 'unverifiable'];
const TERMINAL_OUTCOME_KEYS = [
  'type', 'version', 'outcomeId', 'decisionId', 'studyId', 'protocolHash',
  'observedAtMs', 'maturity', 'qualityValue', 'qualityEvidenceClass',
  'economicValueUsd', 'economicEvidenceClass', 'outcomeEvidenceDigests',
  'censoredReason', 'invalidReason', 'previousEventHash', 'eventHash',
] as const;
const EVIDENCE_CLASSES: readonly CausalEvidenceClassV2[] = [
  'deterministic', 'independent_operational', 'structured_human', 'operator_attested',
];
const CENSORED_REASON_CODES = [
  'follow_up_expired', 'source_unavailable', 'not_observable', 'unit_withdrawn',
] as const;
const INVALID_REASON_CODES = [
  'protocol_violation', 'measurement_conflict', 'integrity_failure', 'ineligible_unit',
] as const;

export class CausalRecordValidationError extends Error {
  readonly code = 'CAUSAL_RECORD_INVALID';

  constructor() {
    super('CAUSAL_RECORD_INVALID: causal execution record is invalid');
    this.name = 'CausalRecordValidationError';
  }
}

export class CausalTerminalOutcomeValidationError extends Error {
  readonly code = 'CAUSAL_RECORD_INVALID';

  constructor() {
    super('CAUSAL_RECORD_INVALID: causal terminal outcome record is invalid');
    this.name = 'CausalTerminalOutcomeValidationError';
  }
}

function plainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/**
 * Capture an exact plain input object before projecting any fields.  This is
 * deliberately descriptor-based: accessors and symbol/hidden properties are
 * not production records, and rejecting them prevents a getter/proxy from
 * changing the shape after the unknown-input boundary has been checked.
 */
function captureExactRecord(value: unknown, keys: readonly string[]): Record<string, unknown> | null {
  if (!plainRecord(value)) return null;
  try {
    const actual = Reflect.ownKeys(value);
    if (actual.some((key) => typeof key !== 'string')) return null;
    const expected = [...keys].sort();
    const actualStrings = (actual as string[]).sort();
    if (actualStrings.length !== expected.length
        || !actualStrings.every((key, index) => key === expected[index])) return null;

    const captured: Record<string, unknown> = {};
    for (const key of keys) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !('value' in descriptor) || descriptor.enumerable !== true) return null;
      captured[key] = descriptor.value;
    }
    return captured;
  } catch {
    return null;
  }
}

function safeScalar(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0 || value !== value.trim()) return false;
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (code < 0x20 || code > 0x7e || code === 0x7f) return false;
  }
  return !(/:\/\//.test(value)
    || /^(?:https?|file|data|javascript|mailto):/i.test(value)
    || /[\\/]/.test(value)
    || /^[A-Za-z]:[\\/]/.test(value)
    || /^\\\\/.test(value)
    || /^(?:bearer|basic)\s/i.test(value)
    || /api[_-]?key|secret|password|token/i.test(value)
    || /(?:^|[:._-])(?:sk|rk|pk)-[A-Za-z0-9]/i.test(value)
    || /(?:^|:)[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}$/.test(value));
}

function id(value: unknown): value is string {
  return safeScalar(value) && ID_RE.test(value) && value.length >= 3 && value.length <= 160;
}

function digest(value: unknown): value is string {
  return safeScalar(value) && DIGEST_RE.test(value);
}

function epoch(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function finiteOrNull(value: unknown): value is number | null {
  return value === null || (typeof value === 'number' && Number.isFinite(value));
}

function denseArray(value: unknown): value is unknown[] {
  if (!Array.isArray(value)) return false;
  for (let index = 0; index < value.length; index += 1) {
    if (!Object.prototype.hasOwnProperty.call(value, index)) return false;
  }
  return Object.keys(value).every((key) => /^(0|[1-9][0-9]*)$/.test(key) && Number(key) < value.length);
}

function sortedUnique(values: unknown, validator: (value: unknown) => value is string): values is string[] {
  if (!denseArray(values)) return false;
  const strings = values.map((value) => validator(value));
  if (strings.some((valid) => !valid)) return false;
  const typed = values as string[];
  return new Set(typed).size === typed.length
    && typed.every((value, index) => index === 0 || typed[index - 1]! < value);
}

/**
 * Snapshot an input array without retaining a caller-owned mutable reference.
 * Invalid array shape becomes a scalar sentinel so the normal decoder rejects
 * it; a hostile getter/proxy cannot change the returned validated record after
 * this boundary has completed.
 */
function snapshotArray(value: unknown): unknown {
  if (!Array.isArray(value)) return value;
  try {
    const lengthDescriptor = Object.getOwnPropertyDescriptor(value, 'length');
    if (!lengthDescriptor || !('value' in lengthDescriptor)) return null;
    const length = lengthDescriptor.value;
    const keys = Reflect.ownKeys(value);
    if (!Number.isSafeInteger(length) || length < 0
        || keys.some((key) => typeof key !== 'string')
        || keys.length !== length + 1
        || !keys.includes('length')
        || (keys as string[]).some((key) => key !== 'length'
          && (!/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= length))) {
      return null;
    }
    const copy = new Array<unknown>(length);
    for (let index = 0; index < length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (!descriptor || !('value' in descriptor) || descriptor.enumerable !== true) return null;
      copy[index] = descriptor.value;
    }
    return copy;
  } catch {
    return null;
  }
}

function snapshotVerifier(value: unknown): unknown {
  const captured = captureExactRecord(value, VERIFIER_KEYS);
  if (!captured) return null;
  return {
    ...captured,
    reasonCodes: snapshotArray(captured.reasonCodes),
  };
}

function snapshotExecution(value: unknown): unknown {
  const captured = captureExactRecord(value, EXECUTION_KEYS);
  if (!captured) return null;
  return {
    ...captured,
    requestIds: snapshotArray(captured.requestIds),
    priceLineageDigests: snapshotArray(captured.priceLineageDigests),
    ordinaryLedgerVerifier: snapshotVerifier(captured.ordinaryLedgerVerifier),
  };
}

function snapshotTerminalOutcome(value: unknown): unknown {
  const captured = captureExactRecord(value, TERMINAL_OUTCOME_KEYS);
  if (!captured) return null;
  return {
    ...captured,
    outcomeEvidenceDigests: snapshotArray(captured.outcomeEvidenceDigests),
  };
}

function domainHash(domain: string, material: unknown): string {
  return 'sha256:' + createHash('sha256')
    .update(domain + '\n2\n' + canonicalJson(material))
    .digest('hex');
}

function verifierHash(value: Omit<OrdinaryLedgerVerifierResultV2, 'resultHash'>): string {
  return domainHash('fiscus.causal.ordinary-ledger-verifier', value);
}

function executionHash(value: Omit<CausalExecutionRecordV2, 'eventHash'>): string {
  return domainHash('fiscus.causal.execution', value);
}

function decodeVerifier(value: unknown): OrdinaryLedgerVerifierResultV2 {
  const snapshot = snapshotVerifier(value);
  if (!plainRecord(snapshot)
      || snapshot.type !== 'fiscus.causal-ordinary-ledger-verifier'
      || snapshot.version !== 2
      || snapshot.state !== 'unresolved'
      || snapshot.checkedAtMs !== null
      || snapshot.requestCount !== 0
      || snapshot.evidenceManifestHash !== null
      || !denseArray(snapshot.reasonCodes)
      || snapshot.reasonCodes.length !== 1
      || snapshot.reasonCodes[0] !== 'task4_not_implemented'
      || !digest(snapshot.resultHash)) {
    throw new CausalRecordValidationError();
  }
  const { resultHash, ...material } = snapshot as Omit<OrdinaryLedgerVerifierResultV2, 'resultHash'> & { resultHash: string };
  if (verifierHash(material) !== resultHash) throw new CausalRecordValidationError();
  return {
    ...snapshot,
    reasonCodes: [...snapshot.reasonCodes],
  } as OrdinaryLedgerVerifierResultV2;
}

/** Decode one exact production execution record from unknown input. */
function decodeCausalExecutionV2Unchecked(value: unknown): CausalExecutionRecordV2 {
  const snapshot = snapshotExecution(value);
  if (!plainRecord(snapshot)
      || snapshot.type !== 'fiscus.causal-execution'
      || snapshot.version !== 2) {
    throw new CausalRecordValidationError();
  }
  if (!id(snapshot.executionId) || !id(snapshot.decisionId) || !id(snapshot.studyId)
      || !digest(snapshot.protocolHash) || !epoch(snapshot.startedAtMs)
      || !epoch(snapshot.completedAtMs) || snapshot.completedAtMs < snapshot.startedAtMs
      || !digest(snapshot.assignedExecutionPlanDigest)
      || (snapshot.actualExecutionPlanDigest !== null && !digest(snapshot.actualExecutionPlanDigest))
      || !ADHERENCE.includes(snapshot.adherence as ExecutionAdherence)
      || !sortedUnique(snapshot.requestIds, id)
      || !finiteOrNull(snapshot.directAiCostUsd)
      || !COST_CLASSES.includes(snapshot.directCostSourceClass as CostSourceClass)
      || !sortedUnique(snapshot.priceLineageDigests, digest)
      || !finiteOrNull(snapshot.fullArmCostUsd)
      || !COST_CLASSES.includes(snapshot.fullCostSourceClass as CostSourceClass)
      || !digest(snapshot.previousEventHash)
      || !digest(snapshot.eventHash)) {
    throw new CausalRecordValidationError();
  }
  if (snapshot.directAiCostUsd === null) {
    if (snapshot.directCostSourceClass !== 'incomplete_or_unknown'
        || (snapshot.fullArmCostUsd === null && snapshot.priceLineageDigests.length !== 0)) {
      throw new CausalRecordValidationError();
    }
  } else if ((snapshot.directCostSourceClass !== 'actual_observed' && snapshot.directCostSourceClass !== 'actual_reconciled')
      || snapshot.priceLineageDigests.length === 0) {
    throw new CausalRecordValidationError();
  }
  if (snapshot.fullArmCostUsd === null) {
    if (snapshot.fullCostSourceClass !== 'incomplete_or_unknown') throw new CausalRecordValidationError();
  } else {
    if (snapshot.fullCostSourceClass !== 'actual_observed' && snapshot.fullCostSourceClass !== 'actual_reconciled') {
      throw new CausalRecordValidationError();
    }
    if (snapshot.priceLineageDigests.length === 0) throw new CausalRecordValidationError();
  }
  if (snapshot.adherence === 'confirmed'
      && (snapshot.actualExecutionPlanDigest === null || snapshot.actualExecutionPlanDigest !== snapshot.assignedExecutionPlanDigest)) {
    throw new CausalRecordValidationError();
  }
  if ((snapshot.adherence === 'incomplete' || snapshot.adherence === 'unverifiable')
      && (snapshot.directAiCostUsd !== null || snapshot.fullArmCostUsd !== null)) {
    throw new CausalRecordValidationError();
  }
  const ordinaryLedgerVerifier = decodeVerifier(snapshot.ordinaryLedgerVerifier);
  const { eventHash, ...material } = snapshot as Omit<CausalExecutionRecordV2, 'eventHash'> & { eventHash: string };
  if (executionHash(material) !== eventHash) throw new CausalRecordValidationError();
  return {
    ...snapshot,
    requestIds: [...snapshot.requestIds],
    priceLineageDigests: [...snapshot.priceLineageDigests],
    ordinaryLedgerVerifier,
  } as CausalExecutionRecordV2;
}

/**
 * Convert hostile proxy/getter/runtime failures into the same bounded decoder
 * result as ordinary malformed input.  The Store must never expose a raw
 * TypeError/RangeError from an unknown mutation object.
 */
export function decodeCausalExecutionV2(value: unknown): CausalExecutionRecordV2 {
  try {
    return decodeCausalExecutionV2Unchecked(value);
  } catch (error) {
    if (error instanceof CausalRecordValidationError) throw error;
    throw new CausalRecordValidationError();
  }
}

export function ordinaryLedgerVerifierHash(
  value: Omit<OrdinaryLedgerVerifierResultV2, 'resultHash'>,
): string {
  return verifierHash(value);
}

export function causalExecutionV2EventHash(
  value: Omit<CausalExecutionRecordV2, 'eventHash'>,
): string {
  const { eventHash: _ignored, ...material } = value as Omit<CausalExecutionRecordV2, 'eventHash'> & {
    eventHash?: string;
  };
  return executionHash(material);
}

function terminalOutcomeHash(value: Omit<CausalTerminalOutcomeRecordV2, 'eventHash'>): string {
  return domainHash('fiscus.causal.terminal-outcome', value);
}

function terminalOutcomeEvidenceClass(value: unknown): value is CausalEvidenceClassV2 {
  return EVIDENCE_CLASSES.includes(value as CausalEvidenceClassV2);
}

/** Decode one exact production terminal outcome from unknown input. */
function decodeCausalTerminalOutcomeV2Unchecked(value: unknown): CausalTerminalOutcomeRecordV2 {
  const snapshot = snapshotTerminalOutcome(value);
  if (!plainRecord(snapshot)
      || snapshot.type !== 'fiscus.causal-terminal-outcome'
      || snapshot.version !== 2
      || !id(snapshot.outcomeId) || !id(snapshot.decisionId) || !id(snapshot.studyId)
      || !digest(snapshot.protocolHash) || !epoch(snapshot.observedAtMs)
      || typeof snapshot.maturity !== 'string'
      || !['matured', 'censored', 'invalid'].includes(snapshot.maturity)
      || !finiteOrNull(snapshot.qualityValue)
      || (snapshot.qualityEvidenceClass !== null && !terminalOutcomeEvidenceClass(snapshot.qualityEvidenceClass))
      || !finiteOrNull(snapshot.economicValueUsd)
      || (snapshot.economicEvidenceClass !== null && !terminalOutcomeEvidenceClass(snapshot.economicEvidenceClass))
      || !sortedUnique(snapshot.outcomeEvidenceDigests, digest)
      || (snapshot.censoredReason !== null && !CENSORED_REASON_CODES.includes(snapshot.censoredReason as typeof CENSORED_REASON_CODES[number]))
      || (snapshot.invalidReason !== null && !INVALID_REASON_CODES.includes(snapshot.invalidReason as typeof INVALID_REASON_CODES[number]))
      || !digest(snapshot.previousEventHash) || !digest(snapshot.eventHash)) {
    throw new CausalTerminalOutcomeValidationError();
  }

  const maturity = snapshot.maturity as CausalTerminalOutcomeRecordV2['maturity'];
  if (maturity === 'matured') {
    if (snapshot.qualityValue === null || snapshot.qualityEvidenceClass === null
        || snapshot.outcomeEvidenceDigests.length === 0
        || snapshot.censoredReason !== null || snapshot.invalidReason !== null) {
      throw new CausalTerminalOutcomeValidationError();
    }
    if ((snapshot.economicValueUsd === null) !== (snapshot.economicEvidenceClass === null)) {
      throw new CausalTerminalOutcomeValidationError();
    }
  } else if (snapshot.qualityValue !== null || snapshot.qualityEvidenceClass !== null
      || snapshot.economicValueUsd !== null || snapshot.economicEvidenceClass !== null
      || snapshot.outcomeEvidenceDigests.length !== 0) {
    throw new CausalTerminalOutcomeValidationError();
  } else if (maturity === 'censored') {
    if (snapshot.censoredReason === null || snapshot.invalidReason !== null) {
      throw new CausalTerminalOutcomeValidationError();
    }
  } else if (snapshot.censoredReason !== null || snapshot.invalidReason === null) {
    throw new CausalTerminalOutcomeValidationError();
  }

  const { eventHash, ...material } = snapshot as Omit<CausalTerminalOutcomeRecordV2, 'eventHash'> & { eventHash: string };
  if (terminalOutcomeHash(material) !== eventHash) throw new CausalTerminalOutcomeValidationError();
  return {
    ...snapshot,
    outcomeEvidenceDigests: [...snapshot.outcomeEvidenceDigests],
  } as CausalTerminalOutcomeRecordV2;
}

/** Convert hostile runtime/getter failures into the bounded outcome error. */
export function decodeCausalTerminalOutcomeV2(value: unknown): CausalTerminalOutcomeRecordV2 {
  try {
    return decodeCausalTerminalOutcomeV2Unchecked(value);
  } catch (error) {
    if (error instanceof CausalTerminalOutcomeValidationError) throw error;
    throw new CausalTerminalOutcomeValidationError();
  }
}

export function causalTerminalOutcomeV2EventHash(
  value: Omit<CausalTerminalOutcomeRecordV2, 'eventHash'>,
): string {
  const { eventHash: _ignored, ...material } = value as Omit<CausalTerminalOutcomeRecordV2, 'eventHash'> & {
    eventHash?: string;
  };
  return terminalOutcomeHash(material);
}
