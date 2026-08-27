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

export class CausalRecordValidationError extends Error {
  readonly code = 'CAUSAL_RECORD_INVALID';

  constructor() {
    super('CAUSAL_RECORD_INVALID: causal execution record is invalid');
    this.name = 'CausalRecordValidationError';
  }
}

function plainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function exactKeys(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (!plainRecord(value)) return false;
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
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
  if (!exactKeys(value, VERIFIER_KEYS)
      || value.type !== 'fiscus.causal-ordinary-ledger-verifier'
      || value.version !== 2
      || value.state !== 'unresolved'
      || value.checkedAtMs !== null
      || value.requestCount !== 0
      || value.evidenceManifestHash !== null
      || !denseArray(value.reasonCodes)
      || value.reasonCodes.length !== 1
      || value.reasonCodes[0] !== 'task4_not_implemented'
      || !digest(value.resultHash)) {
    throw new CausalRecordValidationError();
  }
  const { resultHash, ...material } = value as Omit<OrdinaryLedgerVerifierResultV2, 'resultHash'> & { resultHash: string };
  if (verifierHash(material) !== resultHash) throw new CausalRecordValidationError();
  return value as unknown as OrdinaryLedgerVerifierResultV2;
}

/** Decode one exact production execution record from unknown input. */
function decodeCausalExecutionV2Unchecked(value: unknown): CausalExecutionRecordV2 {
  if (!exactKeys(value, EXECUTION_KEYS)
      || value.type !== 'fiscus.causal-execution'
      || value.version !== 2) {
    throw new CausalRecordValidationError();
  }
  if (!id(value.executionId) || !id(value.decisionId) || !id(value.studyId)
      || !digest(value.protocolHash) || !epoch(value.startedAtMs)
      || !epoch(value.completedAtMs) || value.completedAtMs < value.startedAtMs
      || !digest(value.assignedExecutionPlanDigest)
      || (value.actualExecutionPlanDigest !== null && !digest(value.actualExecutionPlanDigest))
      || !ADHERENCE.includes(value.adherence as ExecutionAdherence)
      || !sortedUnique(value.requestIds, id)
      || !finiteOrNull(value.directAiCostUsd)
      || !COST_CLASSES.includes(value.directCostSourceClass as CostSourceClass)
      || !sortedUnique(value.priceLineageDigests, digest)
      || !finiteOrNull(value.fullArmCostUsd)
      || !COST_CLASSES.includes(value.fullCostSourceClass as CostSourceClass)
      || !digest(value.previousEventHash)
      || !digest(value.eventHash)) {
    throw new CausalRecordValidationError();
  }
  if (value.directAiCostUsd === null) {
    if (value.directCostSourceClass !== 'incomplete_or_unknown'
        || (value.fullArmCostUsd === null && value.priceLineageDigests.length !== 0)) {
      throw new CausalRecordValidationError();
    }
  } else if ((value.directCostSourceClass !== 'actual_observed' && value.directCostSourceClass !== 'actual_reconciled')
      || value.priceLineageDigests.length === 0) {
    throw new CausalRecordValidationError();
  }
  if (value.fullArmCostUsd === null) {
    if (value.fullCostSourceClass !== 'incomplete_or_unknown') throw new CausalRecordValidationError();
  } else {
    if (value.fullCostSourceClass !== 'actual_observed' && value.fullCostSourceClass !== 'actual_reconciled') {
      throw new CausalRecordValidationError();
    }
    if (value.priceLineageDigests.length === 0) throw new CausalRecordValidationError();
  }
  if (value.adherence === 'confirmed'
      && (value.actualExecutionPlanDigest === null || value.actualExecutionPlanDigest !== value.assignedExecutionPlanDigest)) {
    throw new CausalRecordValidationError();
  }
  if ((value.adherence === 'incomplete' || value.adherence === 'unverifiable')
      && (value.directAiCostUsd !== null || value.fullArmCostUsd !== null)) {
    throw new CausalRecordValidationError();
  }
  decodeVerifier(value.ordinaryLedgerVerifier);
  const { eventHash, ...material } = value as Omit<CausalExecutionRecordV2, 'eventHash'> & { eventHash: string };
  if (executionHash(material) !== eventHash) throw new CausalRecordValidationError();
  return value as unknown as CausalExecutionRecordV2;
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
