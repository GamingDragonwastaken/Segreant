import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { canonicalJson, type EvidenceGrade } from './execution.ts';

export type PolicyStage = 'observe' | 'simulate' | 'recommend' | 'canary' | 'enforce';

export interface DecisionCandidate {
  planKey: string;
  qualityLower: number | null;
  costUpperMicros: number | null;
  latencyUpperMs: number | null;
  riskUpper: number | null;
  valueLowerMicros: number | null;
  assumptions: string[];
}

export interface DecisionBody {
  decisionId: string;
  decidedAtMs: number;
  /** Hash/address of privacy-preserving context features, not raw prompt text. */
  contextHash: string;
  candidatePlans: DecisionCandidate[];
  selectedPlanKey: string | null;
  policyVersion: string;
  /** Required for later off-policy evaluation when the policy was stochastic. */
  selectionProbability: number | null;
  constraints: Record<string, string | number | boolean | null>;
  remainingBudgetMicros: number | null;
  stage: PolicyStage;
  evidenceGrade: EvidenceGrade;
  outcomeRef?: string | null;
}

export interface DecisionEntry {
  sequence: number;
  prevHash: string | null;
  body: DecisionBody;
  recordHash: string;
}

function assertFiniteOrNull(value: number | null, field: string, opts: { nonNegative?: boolean; unitInterval?: boolean } = {}): void {
  if (value === null) return;
  if (!Number.isFinite(value)) throw new Error(`${field} must be finite or null`);
  if (opts.nonNegative && value < 0) throw new Error(`${field} must be non-negative`);
  if (opts.unitInterval && (value < 0 || value > 1)) throw new Error(`${field} must be in [0,1]`);
}

export function validateDecisionBody(body: DecisionBody): void {
  if (!body.decisionId.trim()) throw new Error('decisionId is required');
  if (!Number.isSafeInteger(body.decidedAtMs) || body.decidedAtMs < 0) throw new Error('decidedAtMs must be a non-negative epoch-ms integer');
  if (!body.contextHash.trim()) throw new Error('contextHash is required');
  if (!body.policyVersion.trim()) throw new Error('policyVersion is required');
  assertFiniteOrNull(body.selectionProbability, 'selectionProbability', { unitInterval: true });
  assertFiniteOrNull(body.remainingBudgetMicros, 'remainingBudgetMicros', { nonNegative: true });
  if (body.remainingBudgetMicros !== null && !Number.isSafeInteger(body.remainingBudgetMicros)) throw new Error('remainingBudgetMicros must be an integer');

  const keys = new Set<string>();
  for (const [index, candidate] of body.candidatePlans.entries()) {
    if (!candidate.planKey.trim()) throw new Error(`candidatePlans[${index}].planKey is required`);
    if (keys.has(candidate.planKey)) throw new Error(`duplicate candidate plan: ${candidate.planKey}`);
    keys.add(candidate.planKey);
    assertFiniteOrNull(candidate.qualityLower, `candidatePlans[${index}].qualityLower`);
    assertFiniteOrNull(candidate.costUpperMicros, `candidatePlans[${index}].costUpperMicros`, { nonNegative: true });
    assertFiniteOrNull(candidate.latencyUpperMs, `candidatePlans[${index}].latencyUpperMs`, { nonNegative: true });
    assertFiniteOrNull(candidate.riskUpper, `candidatePlans[${index}].riskUpper`, { unitInterval: true });
    assertFiniteOrNull(candidate.valueLowerMicros, `candidatePlans[${index}].valueLowerMicros`);
  }
  if (body.selectedPlanKey !== null && !keys.has(body.selectedPlanKey)) {
    throw new Error('selectedPlanKey must name one of candidatePlans');
  }
}

export function decisionRecordHash(sequence: number, prevHash: string | null, body: DecisionBody): string {
  validateDecisionBody(body);
  return createHash('sha256').update(canonicalJson({ sequence, prevHash, body })).digest('hex');
}

export function verifyDecisionEntries(entries: readonly DecisionEntry[]): void {
  let prev: string | null = null;
  const ids = new Set<string>();
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index]!;
    const expectedSequence = index + 1;
    if (entry.sequence !== expectedSequence) throw new Error(`decision ledger sequence break at ${expectedSequence}`);
    if (entry.prevHash !== prev) throw new Error(`decision ledger chain break at ${expectedSequence}`);
    if (ids.has(entry.body.decisionId)) throw new Error(`duplicate decisionId at ${expectedSequence}`);
    ids.add(entry.body.decisionId);
    const expectedHash = decisionRecordHash(entry.sequence, entry.prevHash, entry.body);
    if (entry.recordHash !== expectedHash) throw new Error(`decision ledger hash mismatch at ${expectedSequence}`);
    prev = entry.recordHash;
  }
}

export function readDecisionLedger(path: string): DecisionEntry[] {
  if (!existsSync(path)) return [];
  const entries = readFileSync(path, 'utf8')
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0)
    .map((line, index) => {
      try {
        return JSON.parse(line) as DecisionEntry;
      } catch (error) {
        throw new Error(`decision ledger JSON parse failure at ${index + 1}: ${String(error)}`);
      }
    });
  verifyDecisionEntries(entries);
  return entries;
}

/**
 * Append one immutable decision record. The on-disk format is intentionally
 * simple JSONL and hash chained. This is single-writer local storage today;
 * concurrent multi-process writers are not claimed to be serialized.
 */
export function appendDecision(path: string, body: DecisionBody): DecisionEntry {
  validateDecisionBody(body);
  const entries = readDecisionLedger(path);
  if (entries.some((entry) => entry.body.decisionId === body.decisionId)) {
    throw new Error(`decisionId already exists: ${body.decisionId}`);
  }
  const sequence = entries.length + 1;
  const prevHash = entries.at(-1)?.recordHash ?? null;
  const recordHash = decisionRecordHash(sequence, prevHash, body);
  const entry: DecisionEntry = { sequence, prevHash, body, recordHash };
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, `${JSON.stringify(entry)}\n`, { encoding: 'utf8', flag: 'a' });
  return entry;
}
