/**
 * Executable plugin host with a deliberately narrow promise.
 *
 * This host creates a real child process and mediates one bounded newline-
 * delimited JSON request/response over stdio. Node's standard library does not
 * provide portable filesystem, network, memory, CPU, or descriptor isolation,
 * so those controls are refused rather than described as a sandbox.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { isAbsolute } from 'node:path';
import {
  DEFAULT_PLUGIN_MESSAGE_LIMITS,
  createPluginManifest,
  parsePluginMessage,
  serializePluginMessage,
  type PluginCapability,
  type PluginEvidenceOutput,
  type PluginManifest,
} from './contract.ts';
import {
  DEFAULT_PLUGIN_ISOLATION_POLICY,
  createPluginIsolationPolicy,
  type PluginIsolationPolicy,
} from './isolation.ts';
import { authorizePluginInvocation } from './invocation.ts';

export const PLUGIN_PROCESS_BOUNDARY = 'separate_process' as const;
export const PLUGIN_OS_BOUNDARY = 'unsupported' as const;

/** The only capability this host can mediate without granting OS authority. */
export const PROCESS_HOST_SAFE_CAPABILITIES = Object.freeze([
  'write_local_evidence',
] as const satisfies readonly PluginCapability[]);

export const PROCESS_HOST_ENFORCED_CONTROLS = Object.freeze([
  'separate_process',
  'stdio_transport',
  'bounded_messages',
  'request_timeout',
  'credential_environment_scrub',
] as const);

/** These controls need a platform-specific supervisor and are not claimed here. */
export const PROCESS_HOST_NOT_ENFORCED_CONTROLS = Object.freeze([
  'filesystem_restriction',
  'direct_network_block',
  'credential_access_block',
  'cpu_time_hard_limit',
  'memory_hard_limit',
  'file_descriptor_limit',
] as const);

type ProcessHostStatus = 'completed' | 'refused' | 'failed' | 'timed_out';

export interface PluginProcessHostInput {
  readonly manifest: unknown;
  readonly invocation: unknown;
  /** Absolute executable path. It is passed directly with shell=false. */
  readonly executable: string;
  readonly args?: readonly string[];
  /** The working directory is a launch setting, not a filesystem restriction. */
  readonly cwd: string;
  readonly policy?: unknown;
  /** Refuse unless a real OS-level boundary is available. */
  readonly requireOsBoundary?: boolean;
}

export interface PluginProcessHostResult {
  readonly status: ProcessHostStatus;
  readonly boundary: typeof PLUGIN_PROCESS_BOUNDARY;
  readonly osBoundary: typeof PLUGIN_OS_BOUNDARY;
  readonly pid: number | null;
  readonly output: PluginEvidenceOutput | null;
  readonly errors: readonly string[];
  readonly stdoutBytes: number;
  readonly stderrBytes: number;
  readonly enforcedControls: typeof PROCESS_HOST_ENFORCED_CONTROLS;
  readonly notEnforcedControls: typeof PROCESS_HOST_NOT_ENFORCED_CONTROLS;
}

function result(
  status: ProcessHostStatus,
  errors: readonly string[],
  pid: number | null = null,
  output: PluginEvidenceOutput | null = null,
  stdoutBytes = 0,
  stderrBytes = 0,
): PluginProcessHostResult {
  return Object.freeze({
    status,
    boundary: PLUGIN_PROCESS_BOUNDARY,
    osBoundary: PLUGIN_OS_BOUNDARY,
    pid,
    output,
    errors: Object.freeze([...errors]),
    stdoutBytes,
    stderrBytes,
    enforcedControls: PROCESS_HOST_ENFORCED_CONTROLS,
    notEnforcedControls: PROCESS_HOST_NOT_ENFORCED_CONTROLS,
  });
}

function safeError(error: unknown, fallback: string): string {
  if (!(error instanceof Error)) return fallback;
  const message = error.message.trim();
  if (message.length === 0 || message.length > 256) return fallback;
  return message.replace(/\[REDACTED\]/g, '[redacted]');
}

function denseStrings(value: unknown, label: string): readonly string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) {
    throw new Error(`${label} must be an array`);
  }
  const keys = Reflect.ownKeys(value);
  if (keys.length !== value.length + 1 || !keys.includes('length')
      || keys.some((key) => typeof key !== 'string'
        || (key !== 'length' && !/^(?:0|[1-9][0-9]*)$/.test(key)))) {
    throw new Error(`${label} must be dense without extra fields`);
  }
  const strings: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string' || item.includes('\u0000')) {
      throw new Error(`${label} must contain only NUL-free strings`);
    }
    strings.push(item);
  }
  return strings;
}

function validateLaunch(input: PluginProcessHostInput): readonly string[] {
  const errors: string[] = [];
  if (typeof input.executable !== 'string' || input.executable.length === 0
      || input.executable.includes('\u0000') || !isAbsolute(input.executable)) {
    errors.push('plugin executable must be an absolute NUL-free path');
  }
  if (typeof input.cwd !== 'string' || input.cwd.length === 0
      || input.cwd.includes('\u0000') || !isAbsolute(input.cwd)) {
    errors.push('plugin cwd must be an absolute NUL-free path');
  }
  try {
    const args = denseStrings(input.args, 'plugin executable args');
    if (args.length > 128) errors.push('plugin executable args exceed the host limit');
    if (Buffer.byteLength(args.join('\u0000'), 'utf8') > 64 * 1024) {
      errors.push('plugin executable args exceed the host byte limit');
    }
  } catch (error) {
    errors.push(safeError(error, 'plugin executable args are invalid'));
  }
  return errors;
}

function safeCapabilities(manifest: PluginManifest): readonly string[] {
  return manifest.capabilities.filter(
    (capability) => !PROCESS_HOST_SAFE_CAPABILITIES.includes(capability as typeof PROCESS_HOST_SAFE_CAPABILITIES[number]),
  );
}

/** Do not inherit ambient provider keys, token variables, loaders, or user paths. */
function scrubbedEnvironment(): NodeJS.ProcessEnv {
  return Object.freeze({ NODE_NO_WARNINGS: '1' });
}

function byteCount(chunk: string | Uint8Array): number {
  return typeof chunk === 'string' ? Buffer.byteLength(chunk, 'utf8') : chunk.byteLength;
}

function chunkText(chunk: string | Uint8Array): string {
  return typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
}

function parsedOutput(
  stdout: string,
  manifest: PluginManifest,
  expectedRequestId: string,
  maxMessageBytes: number,
  maxEvidenceRecords: number,
): PluginEvidenceOutput {
  const messages = stdout.split(/\r?\n/).map((line) => line.trim()).filter((line) => line.length > 0);
  if (messages.length !== 1) {
    throw new Error('plugin process must emit exactly one non-empty response message');
  }
  if (Buffer.byteLength(messages[0]!, 'utf8') > maxMessageBytes) {
    throw new Error('plugin response exceeds the maximum message size');
  }
  const message = parsePluginMessage(messages[0]!, manifest);
  if (message.kind !== 'evidence') {
    throw new Error('plugin process response must be evidence-only');
  }
  if (message.requestId !== expectedRequestId) {
    throw new Error('plugin response requestId does not match the active request');
  }
  if (message.evidence.length > maxEvidenceRecords) {
    throw new Error('plugin response exceeds the maximum evidence record count');
  }
  return message;
}

function terminate(child: ChildProcess): void {
  try {
    child.kill();
  } catch {
    // The close event remains the only completion signal; no error details are
    // exposed because a child may have written sensitive diagnostic text.
  }
}

/**
 * Run one plugin request in a separate executable process.
 *
 * The function refuses direct egress, credentials, and capabilities that would
 * require unconfined OS access. It also refuses callers that require an OS
 * sandbox, because this standard-library path does not provide one.
 */
export async function runPluginProcess(input: PluginProcessHostInput): Promise<PluginProcessHostResult> {
  if (input.requireOsBoundary === true) {
    return result('refused', ['OS-level plugin isolation is unsupported; execution is refused']);
  }
  if (input.requireOsBoundary !== undefined && input.requireOsBoundary !== false) {
    return result('refused', ['requireOsBoundary must be a boolean']);
  }

  const launchErrors = validateLaunch(input);
  if (launchErrors.length > 0) return result('refused', launchErrors);

  let isolationPolicy: PluginIsolationPolicy;
  try {
    isolationPolicy = input.policy === undefined
      ? DEFAULT_PLUGIN_ISOLATION_POLICY
      : createPluginIsolationPolicy(input.policy as PluginIsolationPolicy);
  } catch (error) {
    return result('refused', [safeError(error, 'plugin isolation policy is invalid')]);
  }
  if (isolationPolicy.defaultTransport !== 'stdio') {
    return result('refused', ['process host supports only the host-mediated stdio transport']);
  }
  if (isolationPolicy.osBoundary !== 'unsupported') {
    return result('refused', ['OS-level plugin isolation policy is unsupported by this host']);
  }

  let manifest: PluginManifest;
  try {
    manifest = createPluginManifest(input.manifest as PluginManifest);
  } catch (error) {
    return result('refused', [safeError(error, 'plugin manifest is invalid')]);
  }

  const unsupported = safeCapabilities(manifest);
  const refusalErrors: string[] = [];
  if (unsupported.length > 0) {
    refusalErrors.push(`process host refuses unmediated plugin capabilities: ${unsupported.join(', ')}`);
  }
  if (manifest.egress !== 'none') {
    refusalErrors.push('process host refuses plugin egress because direct network blocking is unavailable');
  }
  if (manifest.credentials !== 'none') {
    refusalErrors.push('process host refuses plugin credentials because OS credential access blocking is unavailable');
  }
  if (!manifest.capabilities.includes('write_local_evidence')) {
    refusalErrors.push('process host requires the host-mediated write_local_evidence capability');
  }
  if (refusalErrors.length > 0) return result('refused', refusalErrors);

  const authorization = authorizePluginInvocation(input.manifest, input.invocation);
  if (!authorization.allowed || authorization.request === null) {
    return result('refused', authorization.errors.length > 0
      ? authorization.errors
      : ['plugin invocation authorization was refused']);
  }

  let wire: string;
  try {
    wire = serializePluginMessage(authorization.request, manifest);
  } catch (error) {
    return result('refused', [safeError(error, 'plugin request could not be serialized')]);
  }
  const inputBytes = Buffer.byteLength(wire, 'utf8') + 1;
  if (inputBytes > isolationPolicy.resources.maxInputBytes) {
    return result('refused', ['plugin request exceeds the host input byte limit']);
  }
  const expectedRequestId = authorization.request.requestId;

  const maxOutputBytes = Math.min(
    isolationPolicy.resources.maxOutputBytes,
    isolationPolicy.resources.maxMessageBytes,
    DEFAULT_PLUGIN_MESSAGE_LIMITS.maxMessageBytes,
  );
  const maxMessageBytes = Math.min(
    isolationPolicy.resources.maxMessageBytes,
    DEFAULT_PLUGIN_MESSAGE_LIMITS.maxMessageBytes,
  );

  return new Promise<PluginProcessHostResult>((resolve) => {
    let child: ChildProcess;
    try {
      child = spawn(input.executable, denseStrings(input.args, 'plugin executable args'), {
        cwd: input.cwd,
        env: scrubbedEnvironment(),
        shell: false,
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (error) {
      resolve(result('failed', [safeError(error, 'plugin process could not be started')]));
      return;
    }

    const stdin = child.stdin;
    const stdout = child.stdout;
    const stderr = child.stderr;
    const pid = child.pid ?? null;
    if (stdin === null || stdout === null || stderr === null) {
      terminate(child);
      resolve(result('failed', ['plugin process did not expose stdio pipes'], pid));
      return;
    }

    let stdoutText = '';
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let settled = false;
    let forcedStatus: Exclude<ProcessHostStatus, 'completed'> | null = null;
    let forcedError = '';
    let startupTimer: ReturnType<typeof setTimeout> | undefined;
    let requestTimer: ReturnType<typeof setTimeout> | undefined;

    const clearTimers = (): void => {
      if (startupTimer !== undefined) clearTimeout(startupTimer);
      if (requestTimer !== undefined) clearTimeout(requestTimer);
    };

    const forceStop = (status: Exclude<ProcessHostStatus, 'completed'>, message: string): void => {
      if (settled || forcedStatus !== null) return;
      forcedStatus = status;
      forcedError = message;
      terminate(child);
    };

    child.once('spawn', () => {
      if (startupTimer !== undefined) clearTimeout(startupTimer);
      requestTimer = setTimeout(() => {
        forceStop('timed_out', 'plugin process request timeout');
      }, isolationPolicy.timeouts.requestMs);
      try {
        stdin.end(`${wire}\n`);
      } catch {
        forceStop('failed', 'plugin request could not be written to the child process');
      }
    });

    stdout.on('data', (chunk: string | Uint8Array) => {
      if (settled || forcedStatus !== null) return;
      stdoutBytes += byteCount(chunk);
      if (stdoutBytes > maxOutputBytes) {
        forceStop('refused', 'plugin output exceeded the host output bound');
        return;
      }
      stdoutText += chunkText(chunk);
    });

    stderr.on('data', (chunk: string | Uint8Array) => {
      if (settled || forcedStatus !== null) return;
      stderrBytes += byteCount(chunk);
      if (stderrBytes > isolationPolicy.resources.maxStderrBytes) {
        forceStop('refused', 'plugin diagnostic output exceeded the host stderr bound');
      }
    });

    child.once('error', () => {
      forceStop('failed', 'plugin process failed to start or communicate');
    });

    child.once('close', (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimers();

      if (forcedStatus !== null) {
        resolve(result(forcedStatus, [forcedError], pid, null, stdoutBytes, stderrBytes));
        return;
      }
      if (code !== 0 || signal !== null) {
        resolve(result('failed', ['plugin process exited without a successful response'], pid, null, stdoutBytes, stderrBytes));
        return;
      }
      try {
        const output = parsedOutput(
          stdoutText,
          manifest,
          expectedRequestId,
          maxMessageBytes,
          isolationPolicy.resources.maxEvidenceRecords,
        );
        resolve(result('completed', [], pid, output, stdoutBytes, stderrBytes));
      } catch (error) {
        resolve(result('failed', [safeError(error, 'plugin response was invalid')], pid, null, stdoutBytes, stderrBytes));
      }
    });

    startupTimer = setTimeout(() => {
      forceStop('timed_out', 'plugin process startup timeout');
    }, isolationPolicy.timeouts.startupMs);
  });
}
