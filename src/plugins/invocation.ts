import {
  createPluginManifest,
  createPluginRequestMessage,
  PLUGIN_CAPABILITIES,
  PLUGIN_CREDENTIAL_CLASSES,
  PLUGIN_EGRESS_CLASSES,
  type PluginCapability,
  type PluginCredential,
  type PluginManifest,
  type PluginRequestMessage,
  type PluginRequestMessageInput,
  type PluginEgress,
} from './contract.ts';

export interface PluginInvocationInput {
  readonly request: PluginRequestMessageInput;
  readonly requiredCapabilities: readonly PluginCapability[];
  readonly egress: PluginEgress;
  readonly credentials: PluginCredential;
  readonly directNetwork: false;
  readonly credentialForwarding: false;
}

export interface PluginInvocationAuthorization {
  readonly allowed: boolean;
  readonly errors: readonly string[];
  readonly request: PluginRequestMessage | null;
}

const INVOCATION_KEYS = [
  'request',
  'requiredCapabilities',
  'egress',
  'credentials',
  'directNetwork',
  'credentialForwarding',
] as const;
const LOCAL_FILESYSTEM_CAPABILITIES: readonly PluginCapability[] = [
  'read_local_files',
  'write_local_evidence',
  'mutate_local_config',
  'delete_local_data',
];

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  try {
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
  } catch {
    return false;
  }
}

function hasExactKeys(value: unknown, expected: readonly string[]): value is Record<string, unknown> {
  if (!isPlainRecord(value)) return false;
  try {
    const keys = Reflect.ownKeys(value);
    return keys.length === expected.length
      && keys.every((key) => typeof key === 'string' && expected.includes(key));
  } catch {
    return false;
  }
}

function invocationCapabilities(value: unknown): readonly PluginCapability[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) {
    throw new Error('plugin invocation requiredCapabilities must be an array');
  }
  const keys = Reflect.ownKeys(value);
  if (keys.length !== value.length + 1 || !keys.includes('length')
      || keys.some((key) => typeof key !== 'string' || (key !== 'length' && !/^(?:0|[1-9][0-9]*)$/.test(key)))) {
    throw new Error('plugin invocation requiredCapabilities must be dense without extra fields');
  }
  const seen = new Set<PluginCapability>();
  const result: PluginCapability[] = [];
  for (const item of value) {
    if (!PLUGIN_CAPABILITIES.includes(item as PluginCapability)) {
      throw new Error('plugin invocation requiredCapabilities contains an unsupported capability');
    }
    const capability = item as PluginCapability;
    if (seen.has(capability)) throw new Error('plugin invocation requiredCapabilities contains a duplicate capability');
    seen.add(capability);
    result.push(capability);
  }
  return Object.freeze(result);
}

function refusal(errors: readonly string[]): PluginInvocationAuthorization {
  return Object.freeze({
    allowed: false,
    errors: Object.freeze([...errors]),
    request: null,
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'plugin invocation could not be safely inspected';
}

/**
 * Preflight one plugin request against its manifest. This is an authorization
 * gate for host code, not a plugin runner: it opens no transport, starts no
 * process, forwards no credential, and does not provide OS-level isolation.
 * The caller must supply the operation's required capabilities and declared
 * host-mediated egress/credential classes; this function cannot observe code
 * that runs outside the gate.
 */
export function authorizePluginInvocation(
  manifestValue: unknown,
  invocationValue: unknown,
): PluginInvocationAuthorization {
  try {
    const manifest = createPluginManifest(manifestValue as PluginManifest);
    if (!hasExactKeys(invocationValue, INVOCATION_KEYS)) {
      return refusal(['plugin invocation fields must be exact; unexpected or missing fields are refused']);
    }
    const invocation = invocationValue;
    const requiredCapabilities = invocationCapabilities(invocation.requiredCapabilities);
    const errors: string[] = [];

    if (!PLUGIN_EGRESS_CLASSES.includes(invocation.egress as PluginEgress)) {
      errors.push('plugin invocation egress class is unsupported');
    } else if (invocation.egress !== 'none' && invocation.egress !== manifest.egress) {
      errors.push('plugin invocation egress is not declared by the manifest');
    }

    if (!PLUGIN_CREDENTIAL_CLASSES.includes(invocation.credentials as PluginCredential)) {
      errors.push('plugin invocation credential class is unsupported');
    } else if (invocation.credentials !== 'none' && invocation.credentials !== manifest.credentials) {
      errors.push('plugin invocation credential class is not declared by the manifest');
    }

    for (const capability of requiredCapabilities) {
      if (!manifest.capabilities.includes(capability)) {
        errors.push(`plugin invocation requires undeclared plugin capability: ${capability}`);
      }
    }

    const requiresNetwork = invocation.egress === 'loopback'
      || invocation.egress === 'declared_cloud'
      || invocation.egress === 'team_server';
    if (requiresNetwork && !requiredCapabilities.includes('network_egress')) {
      errors.push('plugin invocation egress requires the network_egress capability');
    }
    if (invocation.egress === 'local_filesystem'
        && !requiredCapabilities.some((capability) => LOCAL_FILESYSTEM_CAPABILITIES.includes(capability))) {
      errors.push('plugin invocation local_filesystem egress requires a local filesystem capability');
    }
    if (invocation.egress === 'team_server' && !requiredCapabilities.includes('write_external')) {
      errors.push('plugin invocation team_server egress requires the write_external capability');
    }
    if (requiredCapabilities.includes('network_egress') && !requiresNetwork) {
      errors.push('plugin invocation network_egress capability requires a network egress class');
    }
    if (invocation.credentials !== 'none' && !requiredCapabilities.includes('use_credentials')) {
      errors.push('plugin invocation credentials require the use_credentials capability');
    }
    if (invocation.credentials === 'local_tool_logs'
        && !requiredCapabilities.includes('read_tool_logs')
        && !requiredCapabilities.includes('read_local_files')) {
      errors.push('plugin invocation local_tool_logs credentials require a local read capability');
    }

    if (invocation.directNetwork !== false) {
      errors.push('direct network access is forbidden for plugin invocations');
    }
    if (invocation.credentialForwarding !== false) {
      errors.push('credential forwarding to plugins is forbidden');
    }

    let request: PluginRequestMessage;
    try {
      request = createPluginRequestMessage(invocation.request as PluginRequestMessageInput);
    } catch (error) {
      errors.push(errorMessage(error));
      return refusal(errors);
    }
    if (request.pluginId !== manifest.pluginId) {
      errors.push('plugin invocation request pluginId does not match manifest');
    }
    if (errors.length > 0) return refusal(errors);

    return Object.freeze({
      allowed: true,
      errors: Object.freeze([]),
      request,
    });
  } catch (error) {
    return refusal([errorMessage(error)]);
  }
}
