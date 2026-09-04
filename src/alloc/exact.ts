/** Exact-Money allocation adapter for the immutable economic projection. */

import { applyExactRate, exactRate } from '../economics/rate.ts';
import { addMoney, compareMoney, ECONOMIC_BASES, money, moneyFromJson, moneyToJson, type EconomicBasis, type Money } from '../economics/money.ts';
import { createHash } from 'node:crypto';
import { canonicalJson } from '../epistemic/serialization.ts';
import {
  orderRules,
  matchesRow,
  ratioToParts,
  ruleAppliesAt,
  RATIO_SCALE,
  validateRule,
  type AllocatableRow,
  type AllocationRule,
  type CostCentre,
} from './rules.ts';

const EXACT_ROW_KEYS = new Set(['sourceEventIds', 'amount', 'project', 'provider', 'model', 'source', 'user', 'tsEpochMs']);

export interface ExactAllocatableRow {
  readonly sourceEventIds: readonly string[];
  readonly amount: Money;
  readonly project: string;
  readonly provider: string;
  readonly model: string;
  readonly source: string | null;
  readonly user: string | null;
  readonly tsEpochMs: number;
}

export interface ExactMoneyBucket {
  readonly currency: string;
  readonly basis: EconomicBasis;
  readonly amount: Money;
  readonly sourceEventIds: readonly string[];
}

export interface ExactAllocationLine {
  readonly costCentreId: string;
  readonly ruleId: string;
  readonly ruleVersion: number;
  readonly method: AllocationRule['method'];
  readonly ratioParts: number;
  readonly amount: Money;
  readonly sourceBasis: EconomicBasis;
  readonly sourceEventIds: readonly string[];
}

export type ExactUnallocatedReason = 'no_matching_rule' | 'no_driver_for_proportional_pool' | 'target_cost_centre_archived';

export interface ExactUnallocatedLine {
  readonly reason: ExactUnallocatedReason;
  readonly amount: Money;
  readonly sourceBasis: EconomicBasis;
  readonly sourceEventIds: readonly string[];
  readonly topProjects: readonly { project: string; amount: Money }[];
}

export interface ExactAllocationRunResult {
  readonly periodStartMs: number;
  readonly periodEndMs: number;
  readonly runAtMs: number;
  readonly totalByIdentity: readonly ExactMoneyBucket[];
  readonly allocatedByIdentity: readonly ExactMoneyBucket[];
  readonly unallocatedByIdentity: readonly ExactMoneyBucket[];
  readonly lines: readonly ExactAllocationLine[];
  readonly unallocated: readonly ExactUnallocatedLine[];
  readonly sourceBases: readonly EconomicBasis[];
  readonly unresolvedRequestIds: readonly string[];
  readonly complete: boolean;
  readonly conserves: boolean;
  readonly trust: 'derived_allocation_of_exact_effective_charges';
  readonly excludedFrom: readonly ['request_metered_spend', 'budget_enforcement', 'roi', 'model_recommendations'];
}

/** Immutable economic-period finalization that authorized one exact run. */
export interface ExactAllocationCloseBinding {
  readonly periodStartMs: number;
  readonly periodEndMs: number;
  readonly finalizationId: string;
  readonly projectionDigest: string;
  readonly eventCount: number;
}

/** Validate the shape of the immutable close authorization carried by a run. */
export function validateExactAllocationCloseBinding(
  value: ExactAllocationCloseBinding,
  periodStartMs: number,
  periodEndMs: number,
): void {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('exact allocation close binding must be an object');
  }
  if (value.periodStartMs !== periodStartMs || value.periodEndMs !== periodEndMs) {
    throw new Error('exact allocation close binding period does not match its result');
  }
  if (typeof value.finalizationId !== 'string' || value.finalizationId.trim().length === 0) {
    throw new Error('exact allocation close binding finalizationId must be non-empty');
  }
  if (typeof value.projectionDigest !== 'string' || !/^[a-f0-9]{64}$/.test(value.projectionDigest)) {
    throw new Error('exact allocation close binding projectionDigest must be a lowercase SHA-256 digest');
  }
  if (!Number.isSafeInteger(value.eventCount) || value.eventCount < 0) {
    throw new Error('exact allocation close binding eventCount must be a non-negative safe integer');
  }
}

const EXACT_EXCLUDED_FROM = ['request_metered_spend', 'budget_enforcement', 'roi', 'model_recommendations'] as const;

export interface SerializedExactAllocationRun {
  readonly kind: 'exact_allocation_run';
  readonly schemaVersion: 1;
  readonly body: string;
  readonly digest: string;
}

const RESULT_KEYS = ['allocatedByIdentity', 'complete', 'conserves', 'excludedFrom', 'lines', 'periodEndMs', 'periodStartMs', 'runAtMs', 'sourceBases', 'totalByIdentity', 'unallocated', 'unallocatedByIdentity', 'unresolvedRequestIds', 'trust'];
const BUCKET_KEYS = ['amount', 'basis', 'currency', 'sourceEventIds'];
const LINE_KEYS = ['amount', 'costCentreId', 'method', 'ratioParts', 'ruleId', 'ruleVersion', 'sourceBasis', 'sourceEventIds'];
const UNALLOCATED_KEYS = ['amount', 'reason', 'sourceBasis', 'sourceEventIds', 'topProjects'];
const TOP_PROJECT_KEYS = ['amount', 'project'];
const ALLOCATION_METHODS = new Set(['direct', 'fixed_split', 'proportional_to_direct']);
const UNALLOCATED_REASONS = new Set(['no_matching_rule', 'no_driver_for_proportional_pool', 'target_cost_centre_archived']);

function jsonMoney(value: Money): Record<string, unknown> {
  return { ...moneyToJson(value) };
}

function allocationBucketJson(value: ExactMoneyBucket): Record<string, unknown> {
  return { currency: value.currency, basis: value.basis, amount: jsonMoney(value.amount), sourceEventIds: [...value.sourceEventIds] };
}

/** JSON-safe canonical form; no BigInt or numeric accounting values cross this boundary. */
export function exactAllocationToJson(value: ExactAllocationRunResult): Record<string, unknown> {
  return {
    periodStartMs: value.periodStartMs,
    periodEndMs: value.periodEndMs,
    runAtMs: value.runAtMs,
    totalByIdentity: value.totalByIdentity.map(allocationBucketJson),
    allocatedByIdentity: value.allocatedByIdentity.map(allocationBucketJson),
    unallocatedByIdentity: value.unallocatedByIdentity.map(allocationBucketJson),
    lines: value.lines.map((line) => ({
      costCentreId: line.costCentreId,
      ruleId: line.ruleId,
      ruleVersion: line.ruleVersion,
      method: line.method,
      ratioParts: line.ratioParts,
      amount: jsonMoney(line.amount),
      sourceBasis: line.sourceBasis,
      sourceEventIds: [...line.sourceEventIds],
    })),
    unallocated: value.unallocated.map((line) => ({
      reason: line.reason,
      amount: jsonMoney(line.amount),
      sourceBasis: line.sourceBasis,
      sourceEventIds: [...line.sourceEventIds],
      topProjects: line.topProjects.map((project) => ({ project: project.project, amount: jsonMoney(project.amount) })),
    })),
    sourceBases: [...value.sourceBases],
    unresolvedRequestIds: [...value.unresolvedRequestIds],
    complete: value.complete,
    conserves: value.conserves,
    trust: value.trust,
    excludedFrom: [...value.excludedFrom],
  };
}

function digest(body: string): string {
  return `sha256:${createHash('sha256').update(body, 'utf8').digest('hex')}`;
}

export function serializeExactAllocationRun(value: ExactAllocationRunResult): SerializedExactAllocationRun {
  validateExactAllocationResult(value);
  const body = canonicalJson(exactAllocationToJson(value) as never);
  return Object.freeze({ kind: 'exact_allocation_run', schemaVersion: 1, body, digest: digest(body) });
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function exactFields(value: Record<string, unknown>, expected: readonly string[], label: string): void {
  const keys = Object.keys(value).sort();
  const sorted = [...expected].sort();
  if (keys.join('\u0000') !== sorted.join('\u0000')) throw new Error(`${label} contains unknown or missing fields`);
}

function safeInteger(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) throw new Error(`${label} must be a safe integer`);
  return value;
}

function textValue(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) throw new Error(`${label} must be a non-empty string`);
  return value;
}

function stringArray(value: unknown, label: string, allowEmpty = false): readonly string[] {
  if (!Array.isArray(value) || (!allowEmpty && value.length === 0)) throw new Error(`${label} must be a non-empty string array`);
  const seen = new Set<string>();
  return Object.freeze(value.map((item, index) => {
    const text = textValue(item, `${label}[${index}]`);
    if (seen.has(text)) throw new Error(`${label} contains duplicate source id: ${text}`);
    seen.add(text);
    return text;
  }));
}

function parsedMoney(value: unknown, label: string): Money {
  const record = object(value, label);
  exactFields(record, ['coefficient', 'scale', 'currency', 'basis'], label);
  try { return moneyFromJson(record as never); } catch (error) { throw new Error(`${label}: ${error instanceof Error ? error.message : String(error)}`); }
}

function parsedBucket(value: unknown, label: string): ExactMoneyBucket {
  const record = object(value, label);
  exactFields(record, BUCKET_KEYS, label);
  const amount = parsedMoney(record.amount, `${label}.amount`);
  const currency = textValue(record.currency, `${label}.currency`);
  const basis = textValue(record.basis, `${label}.basis`) as EconomicBasis;
  if (currency !== amount.currency || basis !== amount.basis) throw new Error(`${label} identity does not match its Money amount`);
  return Object.freeze({ currency, basis, amount, sourceEventIds: stringArray(record.sourceEventIds, `${label}.sourceEventIds`) });
}

function parsedLine(value: unknown, label: string): ExactAllocationLine {
  const record = object(value, label);
  exactFields(record, LINE_KEYS, label);
  const amount = parsedMoney(record.amount, `${label}.amount`);
  const method = textValue(record.method, `${label}.method`) as AllocationRule['method'];
  if (!ALLOCATION_METHODS.has(method)) throw new Error(`${label}.method is invalid`);
  const sourceBasis = textValue(record.sourceBasis, `${label}.sourceBasis`) as EconomicBasis;
  if (sourceBasis !== amount.basis) throw new Error(`${label}.sourceBasis does not match its Money amount`);
  const ratioParts = safeInteger(record.ratioParts, `${label}.ratioParts`);
  if (ratioParts < 0 || ratioParts > RATIO_SCALE) throw new Error(`${label}.ratioParts is outside the ratio range`);
  const ruleVersion = safeInteger(record.ruleVersion, `${label}.ruleVersion`);
  if (ruleVersion < 1) throw new Error(`${label}.ruleVersion must be positive`);
  return Object.freeze({
    costCentreId: textValue(record.costCentreId, `${label}.costCentreId`),
    ruleId: textValue(record.ruleId, `${label}.ruleId`),
    ruleVersion,
    method,
    ratioParts,
    amount,
    sourceBasis,
    sourceEventIds: stringArray(record.sourceEventIds, `${label}.sourceEventIds`),
  });
}

function parsedUnallocated(value: unknown, label: string): ExactUnallocatedLine {
  const record = object(value, label);
  exactFields(record, UNALLOCATED_KEYS, label);
  const amount = parsedMoney(record.amount, `${label}.amount`);
  const sourceBasis = textValue(record.sourceBasis, `${label}.sourceBasis`) as EconomicBasis;
  const reason = textValue(record.reason, `${label}.reason`) as ExactUnallocatedReason;
  if (!UNALLOCATED_REASONS.has(reason)) throw new Error(`${label}.reason is invalid`);
  if (sourceBasis !== amount.basis) throw new Error(`${label}.sourceBasis does not match its Money amount`);
  if (!Array.isArray(record.topProjects)) throw new Error(`${label}.topProjects must be an array`);
  const topProjects = Object.freeze(record.topProjects.map((project, index) => {
    const item = object(project, `${label}.topProjects[${index}]`);
    exactFields(item, TOP_PROJECT_KEYS, `${label}.topProjects[${index}]`);
    return Object.freeze({ project: textValue(item.project, `${label}.topProjects[${index}].project`), amount: parsedMoney(item.amount, `${label}.topProjects[${index}].amount`) });
  }));
  for (const project of topProjects) if (project.amount.currency !== amount.currency || project.amount.basis !== amount.basis) throw new Error(`${label}.topProjects currency/basis mismatch`);
  return Object.freeze({ reason, amount, sourceBasis, sourceEventIds: stringArray(record.sourceEventIds, `${label}.sourceEventIds`), topProjects });
}

function amountMap(values: readonly ExactMoneyBucket[], label: string): { amounts: Map<string, Money>; sources: Map<string, Set<string>> } {
  const amounts = new Map<string, Money>();
  const sources = new Map<string, Set<string>>();
  for (const [index, bucket] of values.entries()) {
    exactFields(bucket as unknown as Record<string, unknown>, BUCKET_KEYS, `${label}[${index}]`);
    const amount = exactMoney(bucket.amount, `${label}[${index}].amount`);
    const key = identityKey(amount);
    if (amounts.has(key)) throw new Error(`${label} contains duplicate currency/basis identity: ${key}`);
    if (bucket.currency !== amount.currency || bucket.basis !== amount.basis) throw new Error(`${label}[${index}] identity does not match its Money amount`);
    const ids = stringArray(bucket.sourceEventIds, `${label}[${index}].sourceEventIds`);
    amounts.set(key, amount);
    sources.set(key, new Set(ids));
  }
  return { amounts, sources };
}

function addAggregate(map: Map<string, Money>, amount: Money): void {
  const key = identityKey(amount);
  const prior = map.get(key);
  map.set(key, prior === undefined ? amount : addMoney(prior, amount));
}

function aggregateSources(map: Map<string, Set<string>>, amount: Money, ids: readonly string[]): void {
  const key = identityKey(amount);
  const target = map.get(key) ?? new Set<string>();
  for (const id of ids) target.add(id);
  map.set(key, target);
}

function sameSourceSet(left: Set<string> | undefined, right: Set<string> | undefined): boolean {
  const a = [...(left ?? new Set<string>())].sort();
  const b = [...(right ?? new Set<string>())].sort();
  return a.length === b.length && a.every((id, index) => id === b[index]);
}

/** Recompute the conservation and identity invariants before a result is serialized or trusted. */
export function validateExactAllocationResult(value: ExactAllocationRunResult): void {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('exact allocation result must be an object');
  exactFields(value as unknown as Record<string, unknown>, RESULT_KEYS, 'exact allocation result');
  if (!Number.isSafeInteger(value.periodStartMs) || !Number.isSafeInteger(value.periodEndMs) || value.periodStartMs >= value.periodEndMs) throw new Error('exact allocation result period is not ordered');
  if (!Number.isSafeInteger(value.runAtMs)) throw new Error('exact allocation result runAt must be a safe timestamp');
  if (!Array.isArray(value.totalByIdentity) || !Array.isArray(value.allocatedByIdentity) || !Array.isArray(value.unallocatedByIdentity) || !Array.isArray(value.lines) || !Array.isArray(value.unallocated) || !Array.isArray(value.sourceBases) || !Array.isArray(value.unresolvedRequestIds) || !Array.isArray(value.excludedFrom)) throw new Error('exact allocation result arrays are malformed');
  if (value.trust !== 'derived_allocation_of_exact_effective_charges') throw new Error('exact allocation result trust is invalid');
  if (value.excludedFrom.length !== EXACT_EXCLUDED_FROM.length || value.excludedFrom.some((item, index) => item !== EXACT_EXCLUDED_FROM[index])) throw new Error('exact allocation result excludedFrom is invalid');
  if (typeof value.complete !== 'boolean' || typeof value.conserves !== 'boolean') throw new Error('exact allocation result status is invalid');
  if (!value.conserves) throw new Error('exact allocation result is not conserving');
  const unresolved = stringArray(value.unresolvedRequestIds, 'unresolvedRequestIds', true);
  if (value.complete !== (unresolved.length === 0)) throw new Error('exact allocation result completeness disagrees with unresolved requests');
  const total = amountMap(value.totalByIdentity, 'totalByIdentity');
  const allocated = amountMap(value.allocatedByIdentity, 'allocatedByIdentity');
  const unallocated = amountMap(value.unallocatedByIdentity, 'unallocatedByIdentity');
  const lineAmounts = new Map<string, Money>();
  const lineSources = new Map<string, Set<string>>();
  for (const [index, line] of value.lines.entries()) {
    exactFields(line as unknown as Record<string, unknown>, LINE_KEYS, `lines[${index}]`);
    const amount = exactMoney(line.amount, `lines[${index}].amount`);
    if (line.sourceBasis !== amount.basis) throw new Error(`lines[${index}] source basis does not match its Money amount`);
    if (!ALLOCATION_METHODS.has(line.method) || !Number.isSafeInteger(line.ruleVersion) || line.ruleVersion < 1 || !Number.isSafeInteger(line.ratioParts) || line.ratioParts < 0 || line.ratioParts > RATIO_SCALE) throw new Error(`lines[${index}] has invalid rule metadata`);
    const ids = stringArray(line.sourceEventIds, `lines[${index}].sourceEventIds`);
    addAggregate(lineAmounts, amount);
    aggregateSources(lineSources, amount, ids);
  }
  const unallocatedAmounts = new Map<string, Money>();
  const unallocatedSources = new Map<string, Set<string>>();
  for (const [index, line] of value.unallocated.entries()) {
    exactFields(line as unknown as Record<string, unknown>, UNALLOCATED_KEYS, `unallocated[${index}]`);
    const amount = exactMoney(line.amount, `unallocated[${index}].amount`);
    if (line.sourceBasis !== amount.basis || !UNALLOCATED_REASONS.has(line.reason)) throw new Error(`unallocated[${index}] has invalid identity/reason`);
    const ids = stringArray(line.sourceEventIds, `unallocated[${index}].sourceEventIds`);
    if (!Array.isArray(line.topProjects)) throw new Error(`unallocated[${index}].topProjects must be an array`);
    for (const [projectIndex, project] of line.topProjects.entries()) {
      if (project === null || typeof project !== 'object' || typeof project.project !== 'string' || project.project.trim().length === 0) throw new Error(`unallocated[${index}].topProjects[${projectIndex}] is malformed`);
      exactFields(project as unknown as Record<string, unknown>, TOP_PROJECT_KEYS, `unallocated[${index}].topProjects[${projectIndex}]`);
      const projectAmount = exactMoney(project.amount, `unallocated[${index}].topProjects[${projectIndex}].amount`);
      if (projectAmount.currency !== amount.currency || projectAmount.basis !== amount.basis) throw new Error(`unallocated[${index}].topProjects[${projectIndex}] identity mismatch`);
    }
    addAggregate(unallocatedAmounts, amount);
    aggregateSources(unallocatedSources, amount, ids);
  }
  const keys = new Set([...total.amounts.keys(), ...allocated.amounts.keys(), ...unallocated.amounts.keys(), ...lineAmounts.keys(), ...unallocatedAmounts.keys()]);
  for (const key of keys) {
    const identity = splitIdentity(key);
    const zero = money('0', identity.currency, identity.basis);
    const expected = total.amounts.get(key) ?? zero;
    const expectedAllocated = allocated.amounts.get(key) ?? zero;
    const expectedUnallocated = unallocated.amounts.get(key) ?? zero;
    const actualAllocated = lineAmounts.get(key) ?? zero;
    const actualUnallocated = unallocatedAmounts.get(key) ?? zero;
    if (compareMoney(expectedAllocated, actualAllocated) !== 0 || compareMoney(expectedUnallocated, actualUnallocated) !== 0) throw new Error(`exact allocation result identity ${key} does not match its line totals`);
    if (compareMoney(expected, addMoney(actualAllocated, actualUnallocated)) !== 0) throw new Error(`exact allocation result identity ${key} does not conserve`);
    const expectedSources = total.sources.get(key);
    const actualSources = new Set<string>([...(lineSources.get(key) ?? new Set<string>()), ...(unallocatedSources.get(key) ?? new Set<string>())]);
    if (!sameSourceSet(expectedSources, actualSources)) throw new Error(`exact allocation result identity ${key} source lineage does not cover its total`);
    if (!sameSourceSet(allocated.sources.get(key), lineSources.get(key))) throw new Error(`exact allocation result identity ${key} allocated lineage diverges`);
    if (!sameSourceSet(unallocated.sources.get(key), unallocatedSources.get(key))) throw new Error(`exact allocation result identity ${key} unallocated lineage diverges`);
  }
  const expectedBases = [...new Set([...total.amounts.values()].map((amount) => amount.basis))].sort();
  const actualBases = [...new Set(value.sourceBases)].sort();
  if (actualBases.length !== value.sourceBases.length || !actualBases.every((basis) => (ECONOMIC_BASES as readonly string[]).includes(basis)) || actualBases.length !== expectedBases.length || actualBases.some((basis, index) => basis !== expectedBases[index])) throw new Error('exact allocation result sourceBases diverge from total identities');
}

export function deserializeExactAllocationRun(record: SerializedExactAllocationRun): ExactAllocationRunResult {
  if (record === null || typeof record !== 'object' || Array.isArray(record)) throw new Error('serialized exact allocation run must be an object');
  const envelopeKeys = Object.keys(record).sort();
  if (envelopeKeys.join('\u0000') !== ['body', 'digest', 'kind', 'schemaVersion'].join('\u0000')) throw new Error('serialized exact allocation run contains unknown or missing envelope fields');
  if (record.kind !== 'exact_allocation_run' || record.schemaVersion !== 1) throw new Error('serialized exact allocation run kind/schemaVersion is invalid');
  if (typeof record.body !== 'string' || record.body.length === 0 || record.digest !== digest(record.body)) throw new Error('serialized exact allocation run digest verification failed');
  let parsed: unknown;
  try { parsed = JSON.parse(record.body); } catch { throw new Error('serialized exact allocation run body is invalid JSON'); }
  if (canonicalJson(parsed as never) !== record.body) throw new Error('serialized exact allocation run body is not canonical JSON');
  const value = object(parsed, 'exact allocation run body');
  exactFields(value, RESULT_KEYS, 'exact allocation run body');
  const arrayValue = (item: unknown, label: string): unknown[] => {
    if (!Array.isArray(item)) throw new Error(`${label} must be an array`);
    return item;
  };
  const totalByIdentity = Object.freeze(arrayValue(value.totalByIdentity, 'totalByIdentity').map((item, index) => parsedBucket(item, `totalByIdentity[${index}]`)));
  const allocatedByIdentity = Object.freeze(arrayValue(value.allocatedByIdentity, 'allocatedByIdentity').map((item, index) => parsedBucket(item, `allocatedByIdentity[${index}]`)));
  const unallocatedByIdentity = Object.freeze(arrayValue(value.unallocatedByIdentity, 'unallocatedByIdentity').map((item, index) => parsedBucket(item, `unallocatedByIdentity[${index}]`)));
  const lines = Object.freeze(arrayValue(value.lines, 'lines').map((item, index) => parsedLine(item, `lines[${index}]`)));
  const unallocated = Object.freeze(arrayValue(value.unallocated, 'unallocated').map((item, index) => parsedUnallocated(item, `unallocated[${index}]`)));
  if (!Array.isArray(value.sourceBases) || !Array.isArray(value.unresolvedRequestIds) || !Array.isArray(value.excludedFrom)) throw new Error('exact allocation run arrays are malformed');
  const sourceBases = Object.freeze(stringArray(value.sourceBases, 'sourceBases', true).map((basis) => {
    if (!(ECONOMIC_BASES as readonly string[]).includes(basis)) throw new Error(`sourceBases contains an unsupported basis: ${basis}`);
    return basis as EconomicBasis;
  }));
  const unresolvedRequestIds = Object.freeze(stringArray(value.unresolvedRequestIds, 'unresolvedRequestIds', true));
  const excludedFrom = Object.freeze(stringArray(value.excludedFrom, 'excludedFrom', true));
  if (excludedFrom.length !== 4 || excludedFrom.join('\u0000') !== ['request_metered_spend', 'budget_enforcement', 'roi', 'model_recommendations'].join('\u0000')) throw new Error('exact allocation run excludedFrom is invalid');
  if (typeof value.complete !== 'boolean' || typeof value.conserves !== 'boolean' || value.trust !== 'derived_allocation_of_exact_effective_charges') throw new Error('exact allocation run status/trust is invalid');
  if (value.complete !== (unresolvedRequestIds.length === 0)) throw new Error('exact allocation run completeness disagrees with unresolved requests');
  if (!value.conserves) throw new Error('exact allocation run is not conserving');
  const periodStartMs = safeInteger(value.periodStartMs, 'periodStartMs');
  const periodEndMs = safeInteger(value.periodEndMs, 'periodEndMs');
  if (periodStartMs >= periodEndMs) throw new Error('exact allocation run period is not ordered');
  const result = Object.freeze({
    periodStartMs,
    periodEndMs,
    runAtMs: safeInteger(value.runAtMs, 'runAtMs'),
    totalByIdentity,
    allocatedByIdentity,
    unallocatedByIdentity,
    lines,
    unallocated,
    sourceBases,
    unresolvedRequestIds,
    complete: value.complete,
    conserves: value.conserves,
    trust: 'derived_allocation_of_exact_effective_charges',
    excludedFrom: EXACT_EXCLUDED_FROM,
  });
  validateExactAllocationResult(result);
  return result;
}

interface Bucket {
  amount: Money;
  sourceEventIds: string[];
  rows: ExactAllocatableRow[];
  byProject: Map<string, Money>;
}

function identityKey(value: Money): string {
  return `${value.currency}\u0000${value.basis}`;
}

function splitIdentity(key: string): { currency: string; basis: EconomicBasis } {
  const [currency, basis] = key.split('\u0000');
  if (currency === undefined || basis === undefined) throw new Error('exact allocation identity is malformed');
  return { currency, basis: basis as EconomicBasis };
}

function emptyBucket(amount: Money): Bucket {
  return { amount: money('0', amount.currency, amount.basis), sourceEventIds: [], rows: [], byProject: new Map() };
}

function addToBucket(bucket: Bucket, row: ExactAllocatableRow): void {
  bucket.amount = addMoney(bucket.amount, row.amount);
  bucket.sourceEventIds.push(...row.sourceEventIds);
  bucket.rows.push(row);
  const existing = bucket.byProject.get(row.project);
  bucket.byProject.set(row.project, existing === undefined ? row.amount : addMoney(existing, row.amount));
}

function exactMoney(value: unknown, label: string): Money {
  if (value === null || typeof value !== 'object' || Array.isArray(value) || typeof (value as { coefficient?: unknown }).coefficient !== 'bigint') {
    throw new Error(`${label} must be an exact Money value`);
  }
  const keys = Object.keys(value).sort();
  if (keys.join('\u0000') !== ['basis', 'coefficient', 'currency', 'scale'].join('\u0000')) throw new Error(`${label} contains unknown or missing Money fields`);
  try {
    return moneyFromJson(moneyToJson(value as Money));
  } catch (error) {
    throw new Error(`${label}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function canonicalRows(rows: readonly ExactAllocatableRow[], periodStartMs: number, periodEndMs: number): ExactAllocatableRow[] {
  if (!Array.isArray(rows)) throw new Error('exact allocation rows must be an array');
  if (!Number.isSafeInteger(periodStartMs) || !Number.isSafeInteger(periodEndMs) || periodStartMs >= periodEndMs) throw new Error('exact allocation period must be ordered safe timestamps');
  const seenSources = new Set<string>();
  return rows.map((raw, index) => {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) throw new Error(`exact allocation row ${index} must be an object`);
    for (const key of Object.keys(raw)) if (!EXACT_ROW_KEYS.has(key)) throw new Error(`exact allocation row ${index} contains unknown field: ${key}`);
    const row = raw as ExactAllocatableRow;
    if (!Array.isArray(row.sourceEventIds) || row.sourceEventIds.length === 0) throw new Error(`exact allocation row ${index} requires source event ids`);
    const sourceEventIds = [...row.sourceEventIds].map((sourceId, sourceIndex) => {
      if (typeof sourceId !== 'string' || sourceId.trim().length === 0) throw new Error(`exact allocation row ${index} sourceEventIds[${sourceIndex}] must be non-empty`);
      if (seenSources.has(sourceId)) throw new Error(`exact allocation source event is assigned more than once: ${sourceId}`);
      seenSources.add(sourceId);
      return sourceId;
    });
    if (!Number.isSafeInteger(row.tsEpochMs) || row.tsEpochMs < periodStartMs || row.tsEpochMs >= periodEndMs) throw new Error(`exact allocation row ${index} is outside the requested period`);
    for (const [value, label] of [[row.project, 'project'], [row.provider, 'provider'], [row.model, 'model']] as const) {
      if (typeof value !== 'string' || value.trim().length === 0) throw new Error(`exact allocation row ${index} ${label} must be non-empty`);
    }
    if (row.source !== null && row.source !== undefined && typeof row.source !== 'string') throw new Error(`exact allocation row ${index} source must be a string or null`);
    if (row.user !== null && row.user !== undefined && typeof row.user !== 'string') throw new Error(`exact allocation row ${index} user must be a string or null`);
    const amount = exactMoney(row.amount, `exact allocation row ${index} amount`);
    return Object.freeze({
      sourceEventIds: Object.freeze(sourceEventIds),
      amount,
      project: row.project.trim(),
      provider: row.provider.trim(),
      model: row.model.trim(),
      source: row.source ?? null,
      user: row.user ?? null,
      tsEpochMs: row.tsEpochMs,
    });
  });
}

function addGrouped(map: Map<string, Bucket>, row: ExactAllocatableRow): void {
  const key = identityKey(row.amount);
  const bucket = map.get(key);
  if (bucket === undefined) {
    const created = emptyBucket(row.amount);
    addToBucket(created, row);
    map.set(key, created);
  } else addToBucket(bucket, row);
}

function sourceIds(bucket: Bucket): readonly string[] {
  return Object.freeze([...new Set(bucket.sourceEventIds)].sort());
}

function splitByWeights(total: Money, weights: readonly { costCentreId: string; weight: bigint }[]): Map<string, Money> {
  const positive = weights.filter((item) => item.weight > 0n);
  const denominator = positive.reduce((sum, item) => sum + item.weight, 0n);
  if (denominator <= 0n) return new Map();
  const result = new Map<string, Money>();
  for (const item of positive) {
    try {
      const rate = exactRate({ numerator: item.weight, denominator, sourceUnit: total.currency, targetUnit: total.currency });
      result.set(item.costCentreId, applyExactRate(total, rate, total.basis));
    } catch (error) {
      throw new Error(`exact allocation requires an explicit quantization policy for a non-terminating share: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return result;
}

function asBucketMap(map: Map<string, Money>, sourceIdsByKey: Map<string, Set<string>>): ExactMoneyBucket[] {
  return [...map.entries()]
    .map(([key, amount]) => {
      const identity = splitIdentity(key);
      return Object.freeze({
        currency: identity.currency,
        basis: identity.basis,
        amount,
        sourceEventIds: Object.freeze([...(sourceIdsByKey.get(key) ?? new Set<string>())].sort()),
      });
    })
    .sort((a, b) => a.currency.localeCompare(b.currency) || a.basis.localeCompare(b.basis));
}

function addAmount(map: Map<string, Money>, sourceIdsByKey: Map<string, Set<string>>, amount: Money, sourceIds: readonly string[]): void {
  const key = identityKey(amount);
  const prior = map.get(key);
  map.set(key, prior === undefined ? amount : addMoney(prior, amount));
  const ids = sourceIdsByKey.get(key) ?? new Set<string>();
  for (const sourceId of sourceIds) ids.add(sourceId);
  sourceIdsByKey.set(key, ids);
}

function topProjects(bucket: Bucket): readonly { project: string; amount: Money }[] {
  return Object.freeze([...bucket.byProject.entries()]
    .map(([project, amount]) => ({ project, amount }))
    .sort((a, b) => compareMoney(b.amount, a.amount) || a.project.localeCompare(b.project))
    .slice(0, 5)
    .map((item) => Object.freeze(item)));
}

/** Apply allocation rules without converting exact Money to a numeric microdollar projection. */
export function applyExactAllocation(input: {
  rows: readonly ExactAllocatableRow[];
  rules: readonly AllocationRule[];
  costCentres: readonly CostCentre[];
  periodStartMs: number;
  periodEndMs: number;
  runAtMs: number;
}): ExactAllocationRunResult {
  const rows = canonicalRows(input.rows, input.periodStartMs, input.periodEndMs);
  if (!Array.isArray(input.rules) || !Array.isArray(input.costCentres)) throw new Error('exact allocation rules and cost centres must be arrays');
  for (const rule of input.rules) validateRule(rule);
  if (!Number.isSafeInteger(input.runAtMs)) throw new Error('exact allocation runAt must be a safe timestamp');
  const rules = orderRules(input.rules);
  const archived = new Set(input.costCentres.filter((centre) => centre.archivedAtMs !== null).map((centre) => centre.costCentreId));
  const knownCentres = new Set(input.costCentres.map((centre) => centre.costCentreId));
  for (const rule of rules) {
    for (const target of rule.targets) {
      if (!knownCentres.has(target.costCentreId)) throw new Error(`exact allocation rule ${rule.ruleId} names an unknown cost centre: ${target.costCentreId}`);
    }
  }
  const total = new Map<string, Money>();
  const totalSources = new Map<string, Set<string>>();
  const claimed = new Map<string, { rule: AllocationRule; bucket: Bucket }>();
  const pools = new Map<string, { rule: AllocationRule; bucket: Bucket }>();
  const unmatched = new Map<string, Bucket>();
  const archivedRows = new Map<string, Bucket>();

  for (const row of rows) {
    addAmount(total, totalSources, row.amount, row.sourceEventIds);
    const matchingRow: AllocatableRow = {
      project: row.project, provider: row.provider, model: row.model,
      source: row.source, user: row.user, tsEpochMs: row.tsEpochMs,
      costUsd: 0, costBasis: row.amount.basis,
    };
    const rule = rules.find((candidate) => ruleAppliesAt(candidate, row.tsEpochMs) && matchesRow(candidate, matchingRow));
    if (rule === undefined) addGrouped(unmatched, row);
    else if (rule.method !== 'proportional_to_direct' && rule.targets.some((target) => archived.has(target.costCentreId))) addGrouped(archivedRows, row);
    else {
      const target = rule.method === 'proportional_to_direct' ? pools : claimed;
      const key = `${rule.ruleId}\u0000${rule.version}\u0000${identityKey(row.amount)}`;
      const entry = target.get(key) ?? { rule, bucket: emptyBucket(row.amount) };
      addToBucket(entry.bucket, row);
      target.set(key, entry);
    }
  }

  const lines: ExactAllocationLine[] = [];
  const allocated = new Map<string, Money>();
  const allocatedSources = new Map<string, Set<string>>();
  const unallocated = new Map<string, Money>();
  const unallocatedSources = new Map<string, Set<string>>();
  const directDrivers = new Map<string, Map<string, Money>>();

  for (const { rule, bucket } of claimed.values()) {
    const weights = rule.targets.map((target) => ({ costCentreId: target.costCentreId, weight: BigInt(ratioToParts(target.ratio)) }));
    const split = splitByWeights(bucket.amount, weights);
    const identity = identityKey(bucket.amount);
    for (const target of rule.targets) {
      const amount = split.get(target.costCentreId) ?? money('0', bucket.amount.currency, bucket.amount.basis);
      lines.push(Object.freeze({
        costCentreId: target.costCentreId,
        ruleId: rule.ruleId,
        ruleVersion: rule.version,
        method: rule.method,
        ratioParts: ratioToParts(target.ratio),
        amount,
        sourceBasis: bucket.amount.basis,
        sourceEventIds: sourceIds(bucket),
      }));
      addAmount(allocated, allocatedSources, amount, bucket.sourceEventIds);
      if (amount.coefficient > 0n) {
        const drivers = directDrivers.get(identity) ?? new Map<string, Money>();
        const prior = drivers.get(target.costCentreId);
        drivers.set(target.costCentreId, prior === undefined ? amount : addMoney(prior, amount));
        directDrivers.set(identity, drivers);
      }
    }
  }

  for (const { rule, bucket } of pools.values()) {
    const identity = identityKey(bucket.amount);
    const drivers = [...(directDrivers.get(identity) ?? new Map<string, Money>()).entries()]
      .filter(([, amount]) => amount.coefficient > 0n);
    if (drivers.length === 0) {
      addAmount(unallocated, unallocatedSources, bucket.amount, bucket.sourceEventIds);
      continue;
    }
    const commonScale = Math.max(...drivers.map(([, amount]) => amount.scale));
    const weights = drivers.map(([costCentreId, amount]) => ({
      costCentreId,
      weight: amount.coefficient * (10n ** BigInt(commonScale - amount.scale)),
    }));
    const split = splitByWeights(bucket.amount, weights);
    const denominator = weights.reduce((sum, item) => sum + item.weight, 0n);
    for (const [costCentreId, amount] of split) {
      lines.push(Object.freeze({
        costCentreId,
        ruleId: rule.ruleId,
        ruleVersion: rule.version,
        method: rule.method,
        ratioParts: Number((weights.find((item) => item.costCentreId === costCentreId)?.weight ?? 0n) * BigInt(RATIO_SCALE) / denominator),
        amount,
        sourceBasis: bucket.amount.basis,
        sourceEventIds: sourceIds(bucket),
      }));
      addAmount(allocated, allocatedSources, amount, bucket.sourceEventIds);
    }
  }

  const unallocatedLines: ExactUnallocatedLine[] = [];
  const appendUnallocated = (reason: ExactUnallocatedReason, groups: Map<string, Bucket>): void => {
    for (const bucket of groups.values()) {
      unallocatedLines.push(Object.freeze({ reason, amount: bucket.amount, sourceBasis: bucket.amount.basis, sourceEventIds: sourceIds(bucket), topProjects: topProjects(bucket) }));
      addAmount(unallocated, unallocatedSources, bucket.amount, bucket.sourceEventIds);
    }
  };
  appendUnallocated('no_matching_rule', unmatched);
  appendUnallocated('target_cost_centre_archived', archivedRows);
  for (const { rule, bucket } of pools.values()) {
    const identity = identityKey(bucket.amount);
    if (!(directDrivers.get(identity)?.size ?? 0)) {
      unallocatedLines.push(Object.freeze({ reason: 'no_driver_for_proportional_pool', amount: bucket.amount, sourceBasis: bucket.amount.basis, sourceEventIds: sourceIds(bucket), topProjects: topProjects(bucket) }));
      // The pool was added above only when it had no driver; avoid adding it a second time.
      const already = [...unallocatedSources.get(identity) ?? new Set<string>()];
      if (!already.some((sourceId) => bucket.sourceEventIds.includes(sourceId))) addAmount(unallocated, unallocatedSources, bucket.amount, bucket.sourceEventIds);
    }
  }

  lines.sort((a, b) => a.amount.currency.localeCompare(b.amount.currency) || a.amount.basis.localeCompare(b.amount.basis) || a.ruleId.localeCompare(b.ruleId) || a.ruleVersion - b.ruleVersion || a.costCentreId.localeCompare(b.costCentreId));
  unallocatedLines.sort((a, b) => a.amount.currency.localeCompare(b.amount.currency) || a.amount.basis.localeCompare(b.amount.basis) || a.reason.localeCompare(b.reason) || a.sourceEventIds.join('\u0000').localeCompare(b.sourceEventIds.join('\u0000')));

  const allKeys = new Set([...total.keys(), ...allocated.keys(), ...unallocated.keys()]);
  let conserves = true;
  for (const key of allKeys) {
    const identity = splitIdentity(key);
    const expected = total.get(key) ?? money('0', identity.currency, identity.basis);
    const placed = addMoney(
      allocated.get(key) ?? money('0', identity.currency, identity.basis),
      unallocated.get(key) ?? money('0', identity.currency, identity.basis),
    );
    if (compareMoney(expected, placed) !== 0) conserves = false;
  }

  return Object.freeze({
    periodStartMs: input.periodStartMs,
    periodEndMs: input.periodEndMs,
    runAtMs: input.runAtMs,
    totalByIdentity: Object.freeze(asBucketMap(total, totalSources)),
    allocatedByIdentity: Object.freeze(asBucketMap(allocated, allocatedSources)),
    unallocatedByIdentity: Object.freeze(asBucketMap(unallocated, unallocatedSources)),
    lines: Object.freeze(lines),
    unallocated: Object.freeze(unallocatedLines),
    sourceBases: Object.freeze([...new Set(rows.map((row) => row.amount.basis))].sort()),
    unresolvedRequestIds: Object.freeze([]),
    complete: true,
    conserves,
    trust: 'derived_allocation_of_exact_effective_charges',
    excludedFrom: ['request_metered_spend', 'budget_enforcement', 'roi', 'model_recommendations'] as const,
  });
}
