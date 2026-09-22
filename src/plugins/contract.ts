/**
 * Bounded host/plugin wire contracts.
 *
 * This module describes what a future host may accept from an adapter; it does
 * not discover, load, spawn, or call one. A plugin can submit observations only
 * through the evidence envelope. Claims, decisions, actions, and credentials
 * are deliberately outside this protocol.
 */

export const PLUGIN_CONTRACT_VERSION = 1 as const;

export const PLUGIN_CATEGORIES = [
  'usage_source',
  'billing_source',
  'pricing_source',
  'identity_source',
  'outcome_source',
  'measurement_adapter',
  'causal_producer',
  'decision_policy',
  'control_target',
  'attestation_publisher',
] as const;
export type PluginCategory = (typeof PLUGIN_CATEGORIES)[number];

/** Capabilities are declarations, not grants. A future host must still enforce them. */
export const PLUGIN_CAPABILITIES = [
  'read_local_ledger',
  'read_local_files',
  'read_tool_logs',
  'write_local_evidence',
  'mutate_local_config',
  'delete_local_data',
  'network_egress',
  'use_credentials',
  'write_external',
] as const;
export type PluginCapability = (typeof PLUGIN_CAPABILITIES)[number];

export const PLUGIN_EGRESS_CLASSES = [
  'none',
  'local_filesystem',
  'loopback',
  'declared_cloud',
  'team_server',
] as const;
export type PluginEgress = (typeof PLUGIN_EGRESS_CLASSES)[number];

export const PLUGIN_CREDENTIAL_CLASSES = [
  'none',
  'local_tool_logs',
  'operator_environment',
  'provider_credential',
] as const;
export type PluginCredential = (typeof PLUGIN_CREDENTIAL_CLASSES)[number];
/** More explicit alias for callers that want to name the metadata as a class. */
export type PluginCredentialClass = PluginCredential;

export const PLUGIN_REVERSIBILITY_CLASSES = [
  'read_only',
  'append_only',
  'config_reversible',
  'destructive',
  'external_irreversible',
] as const;
export type PluginReversibility = (typeof PLUGIN_REVERSIBILITY_CLASSES)[number];

export interface PluginManifestInput {
  readonly schemaVersion: typeof PLUGIN_CONTRACT_VERSION;
  readonly pluginId: string;
  readonly pluginVersion: string;
  readonly category: PluginCategory;
  readonly capabilities: readonly PluginCapability[];
  readonly egress: PluginEgress;
  readonly credentials: PluginCredential;
  readonly reversibility: PluginReversibility;
}

export interface PluginManifest extends PluginManifestInput {
  readonly schemaVersion: typeof PLUGIN_CONTRACT_VERSION;
  readonly capabilities: readonly PluginCapability[];
}

export type PluginJsonPrimitive = string | number | boolean | null;
export interface PluginJsonObject {
  readonly [key: string]: PluginJsonValue;
}
export type PluginJsonValue = PluginJsonPrimitive | readonly PluginJsonValue[] | PluginJsonObject;

export interface PluginEvidenceRecordInput {
  readonly evidenceId: string;
  readonly evidenceType: string;
  readonly source: string;
  readonly observedAtMs: number;
  /** Raw payload is optional when a digest or bounded reference is supplied. */
  readonly payload?: PluginJsonValue;
  readonly payloadHash?: string;
  readonly reference?: string;
}

export interface PluginEvidenceRecord {
  readonly evidenceId: string;
  readonly evidenceType: string;
  readonly source: string;
  readonly observedAtMs: number;
  readonly payload?: PluginJsonValue;
  readonly payloadHash?: string;
  readonly reference?: string;
}

/** The only successful plugin response kind: an observation submission. */
export interface PluginEvidenceOutputInput {
  readonly protocolVersion: typeof PLUGIN_CONTRACT_VERSION;
  readonly kind: 'evidence';
  readonly requestId: string;
  readonly pluginId: string;
  readonly category: PluginCategory;
  readonly evidence: readonly PluginEvidenceRecordInput[];
}

export interface PluginEvidenceOutput {
  readonly protocolVersion: typeof PLUGIN_CONTRACT_VERSION;
  readonly kind: 'evidence';
  readonly requestId: string;
  readonly pluginId: string;
  readonly category: PluginCategory;
  readonly evidence: readonly PluginEvidenceRecord[];
}

export interface PluginRequestMessageInput {
  readonly protocolVersion: typeof PLUGIN_CONTRACT_VERSION;
  readonly kind: 'request';
  readonly requestId: string;
  readonly pluginId: string;
  readonly operation: string;
  readonly input?: PluginJsonValue;
}

export interface PluginRequestMessage {
  readonly protocolVersion: typeof PLUGIN_CONTRACT_VERSION;
  readonly kind: 'request';
  readonly requestId: string;
  readonly pluginId: string;
  readonly operation: string;
  readonly input?: PluginJsonValue;
}

export type PluginMessage = PluginRequestMessage | PluginEvidenceOutput;

export const DEFAULT_PLUGIN_MESSAGE_LIMITS = Object.freeze({
  /** One newline-delimited message, including its UTF-8 JSON bytes. */
  maxMessageBytes: 1_048_576,
  maxStringBytes: 4_096,
  maxJsonDepth: 32,
  maxJsonNodes: 10_000,
  maxEvidenceRecords: 1_000,
});
export type PluginMessageLimits = Readonly<typeof DEFAULT_PLUGIN_MESSAGE_LIMITS>;

const MANIFEST_KEYS = [
  'schemaVersion', 'pluginId', 'pluginVersion', 'category', 'capabilities',
  'egress', 'credentials', 'reversibility',
] as const;
const EVIDENCE_OUTPUT_KEYS = [
  'protocolVersion', 'kind', 'requestId', 'pluginId', 'category', 'evidence',
] as const;
const REQUEST_KEYS = [
  'protocolVersion', 'kind', 'requestId', 'pluginId', 'operation', 'input',
] as const;
const EVIDENCE_RECORD_KEYS = [
  'evidenceId', 'evidenceType', 'source', 'observedAtMs', 'payload', 'payloadHash', 'reference',
] as const;

const FORBIDDEN_MESSAGE_KEYS = new Set([
  'claim', 'claims', 'decision', 'decisions', 'recommendation', 'recommendations',
  'action', 'actions', 'credential', 'credentials', 'apikey', 'api_key', 'token', 'secret',
  'prompt', 'rawprompt', 'sourcetext', 'rawoutput', 'output',
]);

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  try {
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
  } catch {
    return false;
  }
}

function ownKeys(value: object): readonly string[] | null {
  try {
    const keys = Reflect.ownKeys(value);
    if (keys.some((key) => typeof key !== 'string')) return null;
    return keys as string[];
  } catch {
    return null;
  }
}

function hasExactKeys(value: unknown, expected: readonly string[]): boolean {
  if (!isPlainRecord(value)) return false;
  const keys = ownKeys(value);
  if (keys === null || keys.length !== expected.length) return false;
  const allowed = new Set(expected);
  return keys.every((key) => allowed.has(key));
}

function hasAllowedKeys(value: unknown, allowed: readonly string[]): boolean {
  if (!isPlainRecord(value)) return false;
  const keys = ownKeys(value);
  if (keys === null) return false;
  const accepted = new Set(allowed);
  return keys.every((key) => accepted.has(key));
}

function member<const T extends readonly string[]>(value: unknown, values: T): value is T[number] {
  return typeof value === 'string' && values.includes(value as T[number]);
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function safeText(value: unknown, label: string, limits: PluginMessageLimits = DEFAULT_PLUGIN_MESSAGE_LIMITS): string {
  if (typeof value !== 'string' || value.length === 0 || value !== value.trim()) {
    throw new Error(`${label} must be a non-empty trimmed string`);
  }
  if (/[^\x20-\x7e]/.test(value)) throw new Error(`${label} must contain printable ASCII only`);
  if (byteLength(value) > limits.maxStringBytes) throw new Error(`${label} exceeds maximum string size`);
  return value;
}

function safeIdentifier(value: unknown, label: string, limits = DEFAULT_PLUGIN_MESSAGE_LIMITS): string {
  const result = safeText(value, label, limits);
  if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(result)) {
    throw new Error(`${label} must be a bounded identifier`);
  }
  return result;
}

function safePluginId(value: unknown, label = 'pluginId'): string {
  const result = safeText(value, label);
  if (!/^[a-z][a-z0-9_.-]{2,63}$/.test(result)) {
    throw new Error(`${label} must be 3-64 lowercase identifier characters`);
  }
  return result;
}

function safeEpoch(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative safe integer epoch`);
  }
  return value;
}

function capabilityList(value: unknown): readonly PluginCapability[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) {
    throw new Error('capabilities must be an array');
  }
  const keys = Reflect.ownKeys(value);
  if (keys.length !== value.length + 1 || !keys.includes('length')
      || keys.some((key) => typeof key !== 'string' || (key !== 'length' && !/^(?:0|[1-9][0-9]*)$/.test(key)))) {
    throw new Error('capabilities must be a dense array without extra fields');
  }
  const seen = new Set<PluginCapability>();
  const result: PluginCapability[] = [];
  for (const item of value) {
    if (!member(item, PLUGIN_CAPABILITIES)) throw new Error(`unsupported plugin capability: ${String(item)}`);
    if (seen.has(item)) throw new Error(`duplicate plugin capability: ${item}`);
    seen.add(item);
    result.push(item);
  }
  return Object.freeze(result);
}

function manifestConsistency(
  capabilities: readonly PluginCapability[],
  egress: PluginEgress,
  credentials: PluginCredential,
  reversibility: PluginReversibility,
): string[] {
  const errors: string[] = [];
  const has = (capability: PluginCapability): boolean => capabilities.includes(capability);
  if (egress !== 'none' && egress !== 'local_filesystem' && !has('network_egress')) {
    errors.push('egress requires the network_egress capability');
  }
  if (credentials !== 'none' && !has('use_credentials')) {
    errors.push('credentials require the use_credentials capability');
  }
  if (credentials === 'local_tool_logs' && !has('read_tool_logs') && !has('read_local_files')) {
    errors.push('local_tool_logs credentials require a local-log or local-file read capability');
  }
  if (egress === 'team_server' && !has('write_external')) {
    errors.push('team_server egress requires the write_external capability');
  }
  if (reversibility === 'read_only' && (
    has('write_local_evidence') || has('mutate_local_config') || has('delete_local_data') || has('write_external')
  )) {
    errors.push('read_only reversibility cannot declare a write capability');
  }
  if (reversibility === 'append_only' && !has('write_local_evidence')) {
    errors.push('append_only reversibility requires the write_local_evidence capability');
  }
  if (reversibility === 'config_reversible' && !has('mutate_local_config')) {
    errors.push('config_reversible reversibility requires the mutate_local_config capability');
  }
  if (reversibility === 'destructive' && !has('delete_local_data')) {
    errors.push('destructive reversibility requires the delete_local_data capability');
  }
  if (reversibility === 'external_irreversible' && !has('write_external')) {
    errors.push('external_irreversible reversibility requires the write_external capability');
  }
  return errors;
}

/** Return all manifest violations without executing any plugin behavior. */
export function validatePluginManifest(value: unknown): string[] {
  try {
    if (!hasExactKeys(value, MANIFEST_KEYS)) {
      return ['plugin manifest fields must be exact; unexpected or missing fields are refused'];
    }
    const record = value as Record<string, unknown>;
    const errors: string[] = [];
    if (record.schemaVersion !== PLUGIN_CONTRACT_VERSION) errors.push('schemaVersion must be 1');
    try { safePluginId(record.pluginId); } catch (error) { errors.push(error instanceof Error ? error.message : String(error)); }
    try { safeText(record.pluginVersion, 'pluginVersion'); } catch (error) { errors.push(error instanceof Error ? error.message : String(error)); }
    if (!member(record.category, PLUGIN_CATEGORIES)) errors.push('category is not a supported plugin category');

    let capabilities: readonly PluginCapability[] = [];
    try { capabilities = capabilityList(record.capabilities); } catch (error) { errors.push(error instanceof Error ? error.message : String(error)); }
    if (!member(record.egress, PLUGIN_EGRESS_CLASSES)) errors.push('egress is not a supported plugin egress class');
    if (!member(record.credentials, PLUGIN_CREDENTIAL_CLASSES)) errors.push('credentials is not a supported plugin credential class');
    if (!member(record.reversibility, PLUGIN_REVERSIBILITY_CLASSES)) errors.push('reversibility is not a supported plugin class');
    if (member(record.egress, PLUGIN_EGRESS_CLASSES)
        && member(record.credentials, PLUGIN_CREDENTIAL_CLASSES)
        && member(record.reversibility, PLUGIN_REVERSIBILITY_CLASSES)) {
      errors.push(...manifestConsistency(capabilities, record.egress, record.credentials, record.reversibility));
    }
    return errors;
  } catch {
    return ['plugin manifest could not be safely inspected'];
  }
}

/** Construct an immutable, validated manifest. */
export function createPluginManifest(input: PluginManifestInput): PluginManifest {
  const errors = validatePluginManifest(input);
  if (errors.length > 0) throw new Error(`invalid plugin manifest: ${errors.join('; ')}`);
  const value = input as PluginManifestInput;
  return Object.freeze({
    schemaVersion: PLUGIN_CONTRACT_VERSION,
    pluginId: safePluginId(value.pluginId),
    pluginVersion: safeText(value.pluginVersion, 'pluginVersion'),
    category: value.category,
    capabilities: capabilityList(value.capabilities),
    egress: value.egress,
    credentials: value.credentials,
    reversibility: value.reversibility,
  });
}

interface JsonCloneState {
  nodes: number;
  seen: WeakSet<object>;
}

function cloneBoundedJson(
  value: unknown,
  label: string,
  limits: PluginMessageLimits,
  state: JsonCloneState,
  depth: number,
  forbidAuthorityKeys: boolean,
): PluginJsonValue {
  if (depth > limits.maxJsonDepth) throw new Error(`${label} exceeds maximum JSON depth`);
  state.nodes += 1;
  if (state.nodes > limits.maxJsonNodes) throw new Error(`${label} exceeds maximum JSON node count`);
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    if (byteLength(value) > limits.maxStringBytes) throw new Error(`${label} exceeds maximum string size`);
    return value;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error(`${label} must contain only finite JSON numbers`);
    return value;
  }
  if (typeof value !== 'object') throw new Error(`${label} must be JSON-compatible`);
  if (state.seen.has(value)) throw new Error(`${label} must not contain cycles`);
  state.seen.add(value);
  if (Array.isArray(value)) {
    const keys = ownKeys(value);
    if (keys === null || keys.length !== value.length + 1 || !keys.includes('length')
        || keys.some((key) => key !== 'length' && !/^(?:0|[1-9][0-9]*)$/.test(key))) {
      state.seen.delete(value);
      throw new Error(`${label} must be a dense JSON array without extra fields`);
    }
    const result = value.map((item, index) => cloneBoundedJson(item, `${label}[${index}]`, limits, state, depth + 1, forbidAuthorityKeys));
    state.seen.delete(value);
    return Object.freeze(result);
  }
  if (!isPlainRecord(value)) {
    state.seen.delete(value);
    throw new Error(`${label} must contain only plain JSON objects`);
  }
  const keys = ownKeys(value);
  if (keys === null) {
    state.seen.delete(value);
    throw new Error(`${label} contains an unsafe property key`);
  }
  const result: Record<string, PluginJsonValue> = {};
  for (const key of [...keys].sort((a, b) => a.localeCompare(b))) {
    if (key === '__proto__' || key === 'constructor' || key === 'prototype') {
      state.seen.delete(value);
      throw new Error(`${label}.${key} is not an allowed JSON field`);
    }
    if (forbidAuthorityKeys && FORBIDDEN_MESSAGE_KEYS.has(key.toLowerCase())) {
      state.seen.delete(value);
      throw new Error(`${label} contains forbidden authority or secret field: ${key}`);
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !('value' in descriptor) || descriptor.enumerable !== true) {
      state.seen.delete(value);
      throw new Error(`${label}.${key} must be an enumerable data property`);
    }
    result[key] = cloneBoundedJson(descriptor.value, `${label}.${key}`, limits, state, depth + 1, forbidAuthorityKeys);
  }
  state.seen.delete(value);
  return Object.freeze(result);
}

function boundedJson(
  value: unknown,
  label: string,
  limits: PluginMessageLimits = DEFAULT_PLUGIN_MESSAGE_LIMITS,
  forbidAuthorityKeys = true,
): PluginJsonValue {
  return cloneBoundedJson(value, label, limits, { nodes: 0, seen: new WeakSet<object>() }, 0, forbidAuthorityKeys);
}

function optionalSafeText(value: unknown, label: string): string | undefined {
  if (value === undefined) return undefined;
  return safeText(value, label);
}

function evidenceRecord(value: unknown, index: number, limits: PluginMessageLimits): PluginEvidenceRecord {
  if (!hasAllowedKeys(value, EVIDENCE_RECORD_KEYS)) {
    throw new Error(`evidence[${index}] fields must be exact; unexpected field is refused`);
  }
  const record = value as Record<string, unknown>;
  const evidenceId = safeIdentifier(record.evidenceId, `evidence[${index}].evidenceId`, limits);
  const evidenceType = safeIdentifier(record.evidenceType, `evidence[${index}].evidenceType`, limits);
  if (/^(claim|decision|action|recommendation)(?:[.:_-]|$)/i.test(evidenceType)) {
    throw new Error(`evidence[${index}] cannot directly mint a claim, decision, action, or recommendation`);
  }
  const source = safeText(record.source, `evidence[${index}].source`, limits);
  const observedAtMs = safeEpoch(record.observedAtMs, `evidence[${index}].observedAtMs`);
  const hasPayload = Object.hasOwn(record, 'payload');
  const payloadHash = optionalSafeText(record.payloadHash, `evidence[${index}].payloadHash`);
  const reference = optionalSafeText(record.reference, `evidence[${index}].reference`);
  if (!hasPayload && payloadHash === undefined && reference === undefined) {
    throw new Error(`evidence[${index}] requires payload, payloadHash, or reference`);
  }
  const output: PluginEvidenceRecord = {
    evidenceId,
    evidenceType,
    source,
    observedAtMs,
    ...(hasPayload ? { payload: boundedJson(record.payload, `evidence[${index}].payload`, limits) } : {}),
    ...(payloadHash === undefined ? {} : { payloadHash }),
    ...(reference === undefined ? {} : { reference }),
  };
  return Object.freeze(output);
}

function evidenceOutput(value: unknown, plugin: PluginManifest | undefined, limits: PluginMessageLimits): PluginEvidenceOutput {
  if (!hasExactKeys(value, EVIDENCE_OUTPUT_KEYS)) {
    throw new Error('plugin output must be an exact evidence-only envelope; claims and actions are refused');
  }
  const record = value as Record<string, unknown>;
  if (record.protocolVersion !== PLUGIN_CONTRACT_VERSION) throw new Error('plugin output protocolVersion must be 1');
  if (record.kind !== 'evidence') throw new Error('plugin output kind must be evidence');
  const requestId = safeIdentifier(record.requestId, 'plugin output requestId', limits);
  const pluginId = safePluginId(record.pluginId, 'plugin output pluginId');
  if (!member(record.category, PLUGIN_CATEGORIES)) throw new Error('plugin output category is unsupported');
  if (plugin !== undefined) {
    if (plugin.pluginId !== pluginId) throw new Error('plugin output pluginId does not match manifest');
    if (plugin.category !== record.category) throw new Error('plugin output category does not match manifest');
    if (!plugin.capabilities.includes('write_local_evidence')) {
      throw new Error('plugin manifest does not declare write_local_evidence');
    }
  }
  if (!Array.isArray(record.evidence) || record.evidence.length === 0) {
    throw new Error('plugin output evidence must be a non-empty array');
  }
  if (record.evidence.length > limits.maxEvidenceRecords) {
    throw new Error('plugin output evidence exceeds maximum record count');
  }
  const evidence = record.evidence.map((item, index) => evidenceRecord(item, index, limits));
  const evidenceIds = new Set<string>();
  for (const item of evidence) {
    if (evidenceIds.has(item.evidenceId)) throw new Error(`plugin output contains duplicate evidenceId: ${item.evidenceId}`);
    evidenceIds.add(item.evidenceId);
  }
  return Object.freeze({
    protocolVersion: PLUGIN_CONTRACT_VERSION,
    kind: 'evidence',
    requestId,
    pluginId,
    category: record.category,
    evidence: Object.freeze(evidence),
  });
}

function requestMessage(
  value: unknown,
  limits: PluginMessageLimits,
  plugin?: PluginManifest,
): PluginRequestMessage {
  if (!hasAllowedKeys(value, REQUEST_KEYS)) throw new Error('plugin request fields must be exact');
  const record = value as Record<string, unknown>;
  if (record.protocolVersion !== PLUGIN_CONTRACT_VERSION) throw new Error('plugin request protocolVersion must be 1');
  if (record.kind !== 'request') throw new Error('plugin message kind must be request or evidence');
  const requestId = safeIdentifier(record.requestId, 'plugin request requestId', limits);
  const pluginId = safePluginId(record.pluginId, 'plugin request pluginId');
  if (plugin !== undefined && plugin.pluginId !== pluginId) {
    throw new Error('plugin request pluginId does not match manifest');
  }
  const operation = safeIdentifier(record.operation, 'plugin request operation', limits);
  return Object.freeze({
    protocolVersion: PLUGIN_CONTRACT_VERSION,
    kind: 'request',
    requestId,
    pluginId,
    operation,
    ...(Object.hasOwn(record, 'input') ? { input: boundedJson(record.input, 'plugin request input', limits) } : {}),
  });
}

function normalizedMessage(value: unknown, plugin: PluginManifest | undefined, limits: PluginMessageLimits): PluginMessage {
  if (!isPlainRecord(value)) throw new Error('plugin message must be a plain JSON object');
  if (value.kind === 'request') return requestMessage(value, limits, plugin);
  if (value.kind === 'evidence') return evidenceOutput(value, plugin, limits);
  throw new Error('plugin message kind must be request or evidence');
}

/** Construct a bounded request without granting it execution authority. */
export function createPluginRequestMessage(input: PluginRequestMessageInput): PluginRequestMessage {
  return requestMessage(input, DEFAULT_PLUGIN_MESSAGE_LIMITS);
}

/** Construct an immutable evidence-only response bound to a declared manifest. */
export function createPluginEvidenceOutput(
  input: PluginEvidenceOutputInput,
  plugin: PluginManifest,
): PluginEvidenceOutput {
  const manifest = createPluginManifest(plugin);
  return evidenceOutput(input, manifest, DEFAULT_PLUGIN_MESSAGE_LIMITS);
}

/** Validate a parsed message; an optional manifest adds identity/capability binding. */
export function validatePluginMessage(value: unknown, plugin?: PluginManifest): string[] {
  try {
    normalizedMessage(value, plugin, DEFAULT_PLUGIN_MESSAGE_LIMITS);
    return [];
  } catch (error) {
    return [error instanceof Error ? error.message : String(error)];
  }
}

/** Parse one bounded JSON message. Oversized input is rejected before JSON parsing. */
export function parsePluginMessage(wire: string, plugin?: PluginManifest): PluginMessage {
  if (typeof wire !== 'string') throw new Error('plugin message must be a UTF-8 JSON string');
  if (byteLength(wire) > DEFAULT_PLUGIN_MESSAGE_LIMITS.maxMessageBytes) {
    throw new Error('plugin message exceeds maximum message size');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(wire) as unknown;
  } catch {
    throw new Error('plugin message is not valid JSON');
  }
  const manifest = plugin === undefined ? undefined : createPluginManifest(plugin);
  return normalizedMessage(parsed, manifest, DEFAULT_PLUGIN_MESSAGE_LIMITS);
}

/** Serialize only a validated request/evidence message; no transport is opened. */
export function serializePluginMessage(message: PluginMessage, plugin?: PluginManifest): string {
  const manifest = plugin === undefined ? undefined : createPluginManifest(plugin);
  const normalized = normalizedMessage(message, manifest, DEFAULT_PLUGIN_MESSAGE_LIMITS);
  const wire = JSON.stringify(normalized);
  if (typeof wire !== 'string') throw new Error('plugin message could not be serialized');
  if (byteLength(wire) > DEFAULT_PLUGIN_MESSAGE_LIMITS.maxMessageBytes) {
    throw new Error('plugin message exceeds maximum message size');
  }
  return wire;
}
