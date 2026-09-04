/**
 * Durable identity and rehydration boundary for OutcomeAdapters.
 *
 * An OutcomeAdapter contains executable callbacks, so its durable form stores
 * only the adapter identity and the contract those callbacks are expected to
 * evaluate. Deserialization never imports, evaluates, or discovers code: it can
 * return an implementation only when that exact identity was explicitly
 * allowlisted and registered by the host.
 */

import { createHash } from 'node:crypto';
import { canonicalJson } from '../epistemic/serialization.ts';
import {
  evaluateOutcomeContract,
  type OutcomeContract,
} from './contract.ts';
import type { OutcomeAdapter } from './work-unit.ts';

export const OUTCOME_ADAPTER_REGISTRY_SCHEMA_VERSION = 1 as const;
export const OUTCOME_ADAPTER_SERIALIZED_KIND = 'outcome_adapter' as const;

export interface OutcomeAdapterDescriptor {
  readonly id: string;
  readonly contract: {
    readonly id: string;
    readonly requiredPredicates: readonly string[];
  };
}

export interface SerializedOutcomeAdapter {
  readonly kind: typeof OUTCOME_ADAPTER_SERIALIZED_KIND;
  readonly schemaVersion: typeof OUTCOME_ADAPTER_REGISTRY_SCHEMA_VERSION;
  readonly id: string;
  readonly body: string;
  readonly digest: string;
}

export interface OutcomeAdapterRegistry {
  readonly schemaVersion: typeof OUTCOME_ADAPTER_REGISTRY_SCHEMA_VERSION;
  /** IDs the host has explicitly authorized for registration. */
  readonly allowlistedAdapterIds: readonly string[];
  register(adapter: OutcomeAdapter): void;
  get(adapterId: string): OutcomeAdapter | undefined;
  require(adapterId: string): OutcomeAdapter;
  registeredAdapterIds(): readonly string[];
  serialize(adapterId: string): SerializedOutcomeAdapter;
  deserialize(record: unknown): OutcomeAdapter;
}

const ADAPTER_KEYS = ['id', 'contract', 'resolve', 'measure', 'observedAtMs'] as const;
const DESCRIPTOR_KEYS = ['id', 'contract'] as const;
const CONTRACT_KEYS = ['id', 'requiredPredicates'] as const;
const ENVELOPE_KEYS = ['kind', 'schemaVersion', 'id', 'body', 'digest'] as const;

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  try {
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
  } catch {
    return false;
  }
}

function ownStringKeys(value: object, label: string): readonly string[] {
  let keys: readonly (string | symbol)[];
  try {
    keys = Reflect.ownKeys(value);
  } catch {
    throw new Error(`${label} fields could not be inspected safely`);
  }
  if (keys.some((key) => typeof key !== 'string')) throw new Error(`${label} contains a symbol field`);
  return keys as string[];
}

function exactKeys(value: unknown, expected: readonly string[], label: string): value is Record<string, unknown> {
  if (!isPlainRecord(value)) throw new Error(`${label} must be a plain object`);
  const keys = ownStringKeys(value, label);
  if (keys.length !== expected.length || keys.some((key) => !expected.includes(key))) {
    throw new Error(`${label} fields must be exact`);
  }
  return true;
}

function allowedKeys(
  value: unknown,
  allowed: readonly string[],
  required: readonly string[],
  label: string,
): value is Record<string, unknown> {
  if (!isPlainRecord(value)) throw new Error(`${label} must be a plain object`);
  const keys = ownStringKeys(value, label);
  const unknown = keys.find((key) => !allowed.includes(key));
  if (unknown !== undefined) throw new Error(`${label} contains unknown field: ${unknown}`);
  const missing = required.find((key) => !keys.includes(key));
  if (missing !== undefined) throw new Error(`${label} is missing required field: ${missing}`);
  return true;
}

function nonEmptyText(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0 || value !== value.trim()) {
    throw new Error(`${label} must be a non-empty trimmed string`);
  }
  return value;
}

function requiredPredicates(value: unknown, label: string): readonly string[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) {
    throw new Error(`${label} must be an array`);
  }
  const keys = ownStringKeys(value, label);
  if (keys.length !== value.length + 1 || !keys.includes('length')
      || keys.some((key) => key !== 'length' && !/^(?:0|[1-9][0-9]*)$/.test(key))) {
    throw new Error(`${label} must be a dense array without extra fields`);
  }
  if (value.length === 0) throw new Error(`${label} must contain at least one required predicate`);
  const seen = new Set<string>();
  const result: string[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const predicate = nonEmptyText(value[index], `${label}[${index}]`);
    if (seen.has(predicate)) throw new Error(`duplicate required predicate: ${predicate}`);
    seen.add(predicate);
    result.push(predicate);
  }
  return Object.freeze(result);
}

function canonicalContract(value: unknown, label: string): OutcomeAdapterDescriptor['contract'] {
  exactKeys(value, CONTRACT_KEYS, label);
  const record = value as Record<string, unknown>;
  const id = nonEmptyText(record.id, `${label}.id`);
  const predicates = requiredPredicates(record.requiredPredicates, `${label}.requiredPredicates`);
  const contract: OutcomeContract = Object.freeze({ id, requiredPredicates: predicates });
  // Keep the generic contract validator authoritative for the shared semantics.
  evaluateOutcomeContract(contract, () => 'unknown');
  return contract;
}

function descriptorFromUnknown(value: unknown, label: string): OutcomeAdapterDescriptor {
  exactKeys(value, DESCRIPTOR_KEYS, label);
  const record = value as Record<string, unknown>;
  const id = nonEmptyText(record.id, `${label}.id`);
  const contract = canonicalContract(record.contract, `${label}.contract`);
  return Object.freeze({ id, contract });
}

function descriptorFromAdapter(value: unknown): OutcomeAdapterDescriptor {
  allowedKeys(value, ADAPTER_KEYS, ['id', 'contract', 'resolve'], 'outcome adapter');
  const record = value as Record<string, unknown>;
  if (typeof record.resolve !== 'function') throw new Error('outcome adapter resolve must be a function');
  if (record.measure !== undefined && typeof record.measure !== 'function') {
    throw new Error('outcome adapter measure must be a function when provided');
  }
  if (record.observedAtMs !== undefined && typeof record.observedAtMs !== 'function') {
    throw new Error('outcome adapter observedAtMs must be a function when provided');
  }
  return descriptorFromUnknown({ id: record.id, contract: record.contract }, 'outcome adapter');
}

function digest(body: string): string {
  return `sha256:${createHash('sha256').update(body, 'utf8').digest('hex')}`;
}

/** Serialize only durable adapter identity; callbacks are intentionally omitted. */
export function serializeOutcomeAdapter(adapter: OutcomeAdapter): SerializedOutcomeAdapter {
  const descriptor = descriptorFromAdapter(adapter);
  const body = canonicalJson(descriptor);
  return Object.freeze({
    kind: OUTCOME_ADAPTER_SERIALIZED_KIND,
    schemaVersion: OUTCOME_ADAPTER_REGISTRY_SCHEMA_VERSION,
    id: descriptor.id,
    body,
    digest: digest(body),
  });
}

function decodeSerializedOutcomeAdapter(value: unknown): OutcomeAdapterDescriptor {
  exactKeys(value, ENVELOPE_KEYS, 'serialized outcome adapter');
  const record = value as Record<string, unknown>;
  if (record.kind !== OUTCOME_ADAPTER_SERIALIZED_KIND) {
    throw new Error('serialized outcome adapter kind is invalid');
  }
  if (record.schemaVersion !== OUTCOME_ADAPTER_REGISTRY_SCHEMA_VERSION) {
    throw new Error('serialized outcome adapter schemaVersion must be 1');
  }
  const id = nonEmptyText(record.id, 'serialized outcome adapter id');
  const body = nonEmptyText(record.body, 'serialized outcome adapter body');
  if (record.digest !== digest(body)) throw new Error('serialized outcome adapter digest verification failed');

  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new Error('serialized outcome adapter body is invalid JSON');
  }
  if (canonicalJson(parsed) !== body) throw new Error('serialized outcome adapter body is not canonical JSON');
  const descriptor = descriptorFromUnknown(parsed, 'serialized outcome adapter body');
  if (descriptor.id !== id) throw new Error('serialized outcome adapter identity mismatch');
  return descriptor;
}

function allowlistedIds(value: readonly string[]): readonly string[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) {
    throw new Error('outcome adapter allowlist must be an array');
  }
  const keys = ownStringKeys(value, 'outcome adapter allowlist');
  if (keys.length !== value.length + 1 || !keys.includes('length')
      || keys.some((key) => key !== 'length' && !/^(?:0|[1-9][0-9]*)$/.test(key))) {
    throw new Error('outcome adapter allowlist must be a dense array without extra fields');
  }
  const seen = new Set<string>();
  const result: string[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const id = nonEmptyText(value[index], `outcome adapter allowlist[${index}]`);
    if (seen.has(id)) throw new Error(`duplicate allowlisted outcome adapter id: ${id}`);
    seen.add(id);
    result.push(id);
  }
  return Object.freeze(result);
}

interface Registration {
  readonly adapter: OutcomeAdapter;
  readonly descriptor: OutcomeAdapterDescriptor;
  readonly body: string;
  readonly resolve: OutcomeAdapter['resolve'];
  readonly measure: OutcomeAdapter['measure'];
  readonly observedAtMs: OutcomeAdapter['observedAtMs'];
}

function ensureRegistrationIntact(registration: Registration): void {
  const current = descriptorFromAdapter(registration.adapter);
  if (current.id !== registration.descriptor.id || canonicalJson(current) !== registration.body
      || registration.adapter.resolve !== registration.resolve
      || registration.adapter.measure !== registration.measure
      || registration.adapter.observedAtMs !== registration.observedAtMs) {
    throw new Error(`registered outcome adapter changed after registration: ${registration.descriptor.id}`);
  }
}

/**
 * Create an empty registry. Registration is deliberately a two-step operation:
 * the host supplies an explicit allowlist, then registers concrete callbacks.
 * Serialized bytes alone can never cause code discovery or execution.
 */
export function createOutcomeAdapterRegistry(
  allowlistedAdapterIds: readonly string[],
): OutcomeAdapterRegistry {
  const allowlisted = allowlistedIds(allowlistedAdapterIds);
  const allowed = new Set(allowlisted);
  const registrations = new Map<string, Registration>();

  const registry: OutcomeAdapterRegistry = {
    schemaVersion: OUTCOME_ADAPTER_REGISTRY_SCHEMA_VERSION,
    allowlistedAdapterIds: allowlisted,
    register(adapter: OutcomeAdapter): void {
      const descriptor = descriptorFromAdapter(adapter);
      if (!allowed.has(descriptor.id)) {
        throw new Error(`outcome adapter is not allowlisted: ${descriptor.id}`);
      }
      if (registrations.has(descriptor.id)) {
        throw new Error(`outcome adapter is already registered: ${descriptor.id}`);
      }
      const body = canonicalJson(descriptor);
      registrations.set(descriptor.id, {
        adapter,
        descriptor,
        body,
        resolve: adapter.resolve,
        measure: adapter.measure,
        observedAtMs: adapter.observedAtMs,
      });
    },
    get(adapterId: string): OutcomeAdapter | undefined {
      const registration = registrations.get(adapterId);
      if (registration === undefined) return undefined;
      ensureRegistrationIntact(registration);
      return registration.adapter;
    },
    require(adapterId: string): OutcomeAdapter {
      const adapter = registry.get(adapterId);
      if (adapter !== undefined) return adapter;
      if (!allowed.has(adapterId)) throw new Error(`outcome adapter is not allowlisted: ${adapterId}`);
      throw new Error(`outcome adapter is not registered: ${adapterId}`);
    },
    registeredAdapterIds(): readonly string[] {
      return Object.freeze([...registrations.keys()].sort((a, b) => a.localeCompare(b)));
    },
    serialize(adapterId: string): SerializedOutcomeAdapter {
      return serializeOutcomeAdapter(registry.require(adapterId));
    },
    deserialize(record: unknown): OutcomeAdapter {
      const descriptor = decodeSerializedOutcomeAdapter(record);
      const registration = registrations.get(descriptor.id);
      if (registration === undefined) {
        if (!allowed.has(descriptor.id)) throw new Error(`outcome adapter is not allowlisted: ${descriptor.id}`);
        throw new Error(`outcome adapter is not registered: ${descriptor.id}`);
      }
      ensureRegistrationIntact(registration);
      if (registration.body !== canonicalJson(descriptor)) {
        throw new Error(`serialized outcome adapter descriptor does not match registered adapter: ${descriptor.id}`);
      }
      return registration.adapter;
    },
  };
  return Object.freeze(registry);
}
