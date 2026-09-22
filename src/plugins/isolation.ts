/**
 * Declarative policy shared by the plugin contract and process host.
 *
 * This policy is not an OS sandbox. The process host enforces the stdio,
 * message, timeout, and environment rules it can enforce with Node's standard
 * library, while this module records the controls that still require a
 * platform-specific helper.
 */

import { DEFAULT_PLUGIN_MESSAGE_LIMITS } from './contract.ts';

export const PLUGIN_ISOLATION_POLICY_VERSION = 1 as const;

export const PLUGIN_TRANSPORTS = ['stdio', 'local_socket'] as const;
export type PluginTransport = (typeof PLUGIN_TRANSPORTS)[number];

export interface PluginStdioPolicy {
  readonly framing: 'newline_delimited_json';
  readonly stdin: 'host_to_plugin';
  readonly stdout: 'plugin_to_host';
  readonly stderr: 'diagnostic_only';
}

export interface PluginLocalSocketPolicy {
  readonly address: 'loopback_only';
  readonly loopbackOnly: true;
  readonly hostAllocated: true;
  readonly authentication: 'host_mediated';
}

export interface PluginEgressIsolationPolicy {
  readonly mode: 'host_policy_only';
  readonly directNetwork: 'forbidden';
  readonly credentialForwarding: 'forbidden';
}

export interface PluginTimeoutPolicy {
  readonly startupMs: number;
  readonly requestMs: number;
  readonly idleMs: number;
  readonly shutdownGraceMs: number;
}

export interface PluginResourcePolicy {
  readonly maxCpuTimeMs: number;
  readonly maxEvidenceRecords: number;
  readonly maxFileDescriptors: number;
  readonly maxInputBytes: number;
  readonly maxJsonDepth: number;
  readonly maxJsonNodes: number;
  readonly maxMemoryBytes: number;
  readonly maxMessageBytes: number;
  readonly maxOutputBytes: number;
  readonly maxStderrBytes: number;
}

export interface PluginIsolationPolicy {
  readonly schemaVersion: typeof PLUGIN_ISOLATION_POLICY_VERSION;
  readonly process: 'separate_process';
  readonly inProcessExecution: 'forbidden';
  /** Node's standard library does not provide a portable OS sandbox here. */
  readonly osBoundary: 'unsupported';
  readonly transports: readonly PluginTransport[];
  readonly defaultTransport: PluginTransport;
  readonly stdio: PluginStdioPolicy;
  readonly localSocket: PluginLocalSocketPolicy;
  readonly egress: PluginEgressIsolationPolicy;
  readonly timeouts: PluginTimeoutPolicy;
  readonly resources: PluginResourcePolicy;
  /** This is an execution boundary, not a claim of sandboxing. */
  readonly untrustedCode: 'process_boundary_only';
}

const DEFAULT_TIMEOUTS: PluginTimeoutPolicy = Object.freeze({
  startupMs: 5_000,
  requestMs: 30_000,
  idleMs: 60_000,
  shutdownGraceMs: 1_000,
});

const DEFAULT_RESOURCES: PluginResourcePolicy = Object.freeze({
  maxCpuTimeMs: 30_000,
  maxEvidenceRecords: DEFAULT_PLUGIN_MESSAGE_LIMITS.maxEvidenceRecords,
  maxFileDescriptors: 32,
  maxInputBytes: 512 * 1024,
  maxJsonDepth: DEFAULT_PLUGIN_MESSAGE_LIMITS.maxJsonDepth,
  maxJsonNodes: DEFAULT_PLUGIN_MESSAGE_LIMITS.maxJsonNodes,
  maxMemoryBytes: 128 * 1024 * 1024,
  maxMessageBytes: DEFAULT_PLUGIN_MESSAGE_LIMITS.maxMessageBytes,
  maxOutputBytes: 512 * 1024,
  maxStderrBytes: 64 * 1024,
});

/** Conservative process-host policy; exporting data does not enforce it. */
export const DEFAULT_PLUGIN_ISOLATION_POLICY: PluginIsolationPolicy = Object.freeze({
  schemaVersion: PLUGIN_ISOLATION_POLICY_VERSION,
  process: 'separate_process',
  inProcessExecution: 'forbidden',
  osBoundary: 'unsupported',
  transports: Object.freeze([...PLUGIN_TRANSPORTS]),
  defaultTransport: 'stdio',
  stdio: Object.freeze({
    framing: 'newline_delimited_json',
    stdin: 'host_to_plugin',
    stdout: 'plugin_to_host',
    stderr: 'diagnostic_only',
  }),
  localSocket: Object.freeze({
    address: 'loopback_only',
    loopbackOnly: true,
    hostAllocated: true,
    authentication: 'host_mediated',
  }),
  egress: Object.freeze({
    mode: 'host_policy_only',
    directNetwork: 'forbidden',
    credentialForwarding: 'forbidden',
  }),
  timeouts: DEFAULT_TIMEOUTS,
  resources: DEFAULT_RESOURCES,
  untrustedCode: 'process_boundary_only',
});

const TOP_LEVEL_KEYS = [
  'schemaVersion', 'process', 'inProcessExecution', 'osBoundary', 'transports', 'defaultTransport',
  'stdio', 'localSocket', 'egress', 'timeouts', 'resources', 'untrustedCode',
] as const;
const STDIO_KEYS = ['framing', 'stdin', 'stdout', 'stderr'] as const;
const SOCKET_KEYS = ['address', 'loopbackOnly', 'hostAllocated', 'authentication'] as const;
const EGRESS_KEYS = ['mode', 'directNetwork', 'credentialForwarding'] as const;
const TIMEOUT_KEYS = ['startupMs', 'requestMs', 'idleMs', 'shutdownGraceMs'] as const;
const RESOURCE_KEYS = [
  'maxCpuTimeMs', 'maxEvidenceRecords', 'maxFileDescriptors', 'maxInputBytes',
  'maxJsonDepth', 'maxJsonNodes', 'maxMemoryBytes', 'maxMessageBytes',
  'maxOutputBytes', 'maxStderrBytes',
] as const;

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  try {
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
  } catch {
    return false;
  }
}

function exactKeys(value: unknown, expected: readonly string[]): boolean {
  if (!isPlainRecord(value)) return false;
  try {
    const keys = Reflect.ownKeys(value);
    return keys.length === expected.length
      && keys.every((key) => typeof key === 'string' && expected.includes(key));
  } catch {
    return false;
  }
}

function positiveInteger(value: unknown, label: string, errors: string[]): value is number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    errors.push(`${label} must be a positive safe integer`);
    return false;
  }
  return true;
}

function validateNestedKeys(value: unknown, expected: readonly string[], label: string, errors: string[]): value is Record<string, unknown> {
  if (!exactKeys(value, expected)) {
    errors.push(`${label} fields must be exact`);
    return false;
  }
  return true;
}

/** Return policy violations without opening a process or transport. */
export function validatePluginIsolationPolicy(value: unknown): string[] {
  const errors: string[] = [];
  if (!validateNestedKeys(value, TOP_LEVEL_KEYS, 'isolation policy', errors)) return errors;
  const policy = value as Record<string, unknown>;
  if (policy.schemaVersion !== PLUGIN_ISOLATION_POLICY_VERSION) errors.push('schemaVersion must be 1');
  if (policy.process !== 'separate_process') errors.push('plugin isolation requires separate_process');
  if (policy.inProcessExecution !== 'forbidden') errors.push('in-process plugin execution is forbidden');
  if (policy.osBoundary !== 'unsupported') errors.push('OS-level plugin isolation is unsupported');
  if (!Array.isArray(policy.transports)
      || policy.transports.length !== PLUGIN_TRANSPORTS.length
      || policy.transports.some((item) => !PLUGIN_TRANSPORTS.includes(item as PluginTransport))
      || new Set(policy.transports).size !== PLUGIN_TRANSPORTS.length) {
    errors.push('transports must contain exactly stdio and local_socket');
  }
  if (!PLUGIN_TRANSPORTS.includes(policy.defaultTransport as PluginTransport)) errors.push('defaultTransport is unsupported');

  const stdio = policy.stdio;
  if (validateNestedKeys(stdio, STDIO_KEYS, 'stdio policy', errors)) {
    const item = stdio as Record<string, unknown>;
    if (item.framing !== 'newline_delimited_json') errors.push('stdio framing must be newline_delimited_json');
    if (item.stdin !== 'host_to_plugin' || item.stdout !== 'plugin_to_host') errors.push('stdio direction must be host-mediated');
    if (item.stderr !== 'diagnostic_only') errors.push('plugin stderr must be diagnostic_only');
  }

  const socket = policy.localSocket;
  if (validateNestedKeys(socket, SOCKET_KEYS, 'local socket policy', errors)) {
    const item = socket as Record<string, unknown>;
    if (item.address !== 'loopback_only' || item.loopbackOnly !== true) errors.push('local socket must be loopback-only');
    if (item.hostAllocated !== true) errors.push('local socket endpoint must be host-allocated');
    if (item.authentication !== 'host_mediated') errors.push('local socket authentication must be host_mediated');
  }

  const egress = policy.egress;
  if (validateNestedKeys(egress, EGRESS_KEYS, 'egress policy', errors)) {
    const item = egress as Record<string, unknown>;
    if (item.mode !== 'host_policy_only') errors.push('plugin egress must be host_policy_only');
    if (item.directNetwork !== 'forbidden') errors.push('plugin direct network access is forbidden');
    if (item.credentialForwarding !== 'forbidden') errors.push('credential forwarding to a plugin is forbidden');
  }

  const timeouts = policy.timeouts;
  if (validateNestedKeys(timeouts, TIMEOUT_KEYS, 'timeout policy', errors)) {
    const item = timeouts as Record<string, unknown>;
    for (const key of TIMEOUT_KEYS) positiveInteger(item[key], `timeouts.${key}`, errors);
    if (typeof item.requestMs === 'number' && typeof item.startupMs === 'number' && item.requestMs < item.startupMs) {
      errors.push('timeouts.requestMs cannot be shorter than startupMs');
    }
  }

  const resources = policy.resources;
  if (validateNestedKeys(resources, RESOURCE_KEYS, 'resource policy', errors)) {
    const item = resources as Record<string, unknown>;
    for (const key of RESOURCE_KEYS) positiveInteger(item[key], `resources.${key}`, errors);
    if (typeof item.maxOutputBytes === 'number' && typeof item.maxMessageBytes === 'number'
        && item.maxOutputBytes > item.maxMessageBytes) {
      errors.push('resources.maxOutputBytes cannot exceed maxMessageBytes');
    }
    if (typeof item.maxInputBytes === 'number' && typeof item.maxMessageBytes === 'number'
        && item.maxInputBytes > item.maxMessageBytes) {
      errors.push('resources.maxInputBytes cannot exceed maxMessageBytes');
    }
  }
  if (policy.untrustedCode !== 'process_boundary_only') errors.push('untrustedCode must remain process_boundary_only');
  return errors;
}

/** Construct a deeply immutable validated policy; it still performs no isolation action. */
export function createPluginIsolationPolicy(input: PluginIsolationPolicy): PluginIsolationPolicy {
  const errors = validatePluginIsolationPolicy(input);
  if (errors.length > 0) throw new Error(`invalid plugin isolation policy: ${errors.join('; ')}`);
  const value = input as PluginIsolationPolicy;
  return Object.freeze({
    ...value,
    transports: Object.freeze([...value.transports]),
    stdio: Object.freeze({ ...value.stdio }),
    localSocket: Object.freeze({ ...value.localSocket }),
    egress: Object.freeze({ ...value.egress }),
    timeouts: Object.freeze({ ...value.timeouts }),
    resources: Object.freeze({ ...value.resources }),
  });
}
