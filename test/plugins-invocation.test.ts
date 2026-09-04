import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as pluginApi from '../src/plugins/index.ts';
import {
  createPluginManifest,
  parsePluginMessage,
  type PluginManifest,
} from '../src/plugins/contract.ts';

interface AuthorizationResult {
  readonly allowed: boolean;
  readonly errors: readonly string[];
  readonly request: { readonly pluginId: string; readonly requestId: string } | null;
}

type PluginApi = {
  readonly authorizePluginInvocation?: (
    manifest: unknown,
    invocation: unknown,
  ) => AuthorizationResult;
};

function authorize(manifest: unknown, invocation: unknown): AuthorizationResult {
  const authorizePluginInvocation = (pluginApi as unknown as PluginApi).authorizePluginInvocation;
  assert.equal(typeof authorizePluginInvocation, 'function', 'plugin invocation authorization must be executable');
  return authorizePluginInvocation!(manifest, invocation);
}

function manifest(overrides: Partial<PluginManifest> = {}): PluginManifest {
  return createPluginManifest({
    schemaVersion: 1,
    pluginId: 'usage.local',
    pluginVersion: '1.0.0',
    category: 'usage_source',
    capabilities: ['read_local_ledger'],
    egress: 'none',
    credentials: 'none',
    reversibility: 'read_only',
    ...overrides,
  });
}

function invocation(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    request: {
      protocolVersion: 1,
      kind: 'request',
      requestId: 'request-001',
      pluginId: 'usage.local',
      operation: 'observe',
    },
    requiredCapabilities: ['read_local_ledger'],
    egress: 'none',
    credentials: 'none',
    directNetwork: false,
    credentialForwarding: false,
    ...overrides,
  };
}

test('plugin invocation authorization accepts a bounded host-mediated request', () => {
  const result = authorize(manifest(), invocation());

  assert.equal(result.allowed, true);
  assert.deepEqual(result.errors, []);
  assert.equal(result.request?.pluginId, 'usage.local');
  assert.equal(result.request?.requestId, 'request-001');
  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.isFrozen(result.errors), true);
});

test('plugin invocation authorization refuses capabilities and egress not declared by the manifest', () => {
  const result = authorize(manifest(), invocation({
    requiredCapabilities: ['read_local_files'],
    egress: 'declared_cloud',
    credentials: 'provider_credential',
  }));

  assert.equal(result.allowed, false);
  assert.match(result.errors.join('\n'), /undeclared.*read_local_files/i);
  assert.match(result.errors.join('\n'), /egress.*manifest|manifest.*egress/i);
  assert.match(result.errors.join('\n'), /credential.*manifest|manifest.*credential/i);
  assert.equal(result.request, null);
});

test('plugin invocation authorization refuses direct network and credential forwarding even when declared', () => {
  const plugin = manifest({
    capabilities: ['read_local_ledger', 'network_egress', 'use_credentials'],
    egress: 'declared_cloud',
    credentials: 'provider_credential',
  });
  const result = authorize(plugin, invocation({
    requiredCapabilities: ['network_egress'],
    egress: 'declared_cloud',
    credentials: 'provider_credential',
    directNetwork: true,
    credentialForwarding: true,
  }));

  assert.equal(result.allowed, false);
  assert.match(result.errors.join('\n'), /direct network.*forbidden/i);
  assert.match(result.errors.join('\n'), /credential forwarding.*forbidden/i);
});

test('plugin invocation authorization requires operation capabilities to cover requested egress and credentials', () => {
  const plugin = manifest({
    capabilities: ['read_local_ledger', 'network_egress', 'use_credentials'],
    egress: 'declared_cloud',
    credentials: 'provider_credential',
  });
  const result = authorize(plugin, invocation({
    requiredCapabilities: ['read_local_ledger'],
    egress: 'declared_cloud',
    credentials: 'provider_credential',
  }));

  assert.equal(result.allowed, false);
  assert.match(result.errors.join('\n'), /network_egress.*required|egress.*network_egress/i);
  assert.match(result.errors.join('\n'), /use_credentials.*required|credential.*use_credentials/i);
});

test('plugin invocation authorization refuses filesystem egress without a local filesystem capability', () => {
  const plugin = manifest({
    capabilities: ['read_local_ledger', 'read_local_files'],
    egress: 'local_filesystem',
  });
  const result = authorize(plugin, invocation({
    requiredCapabilities: [],
    egress: 'local_filesystem',
  }));

  assert.equal(result.allowed, false);
  assert.match(result.errors.join('\n'), /local_filesystem.*capability|capability.*local_filesystem/i);
});

test('plugin invocation authorization rejects extra fields and malformed manifests instead of retaining them', () => {
  const extraField = authorize(manifest(), invocation({
    unexpected: '[REDACTED]',
  }));
  assert.equal(extraField.allowed, false);
  assert.match(extraField.errors.join('\n'), /exact|unsupported|unexpected/i);
  assert.doesNotMatch(extraField.errors.join('\n'), /\[REDACTED\]/);

  const duplicateCapabilityManifest = {
    ...manifest(),
    capabilities: ['read_local_ledger', 'read_local_ledger'],
  };
  const malformedManifest = authorize(duplicateCapabilityManifest, invocation());
  assert.equal(malformedManifest.allowed, false);
  assert.match(malformedManifest.errors.join('\n'), /duplicate.*capability/i);
});

test('manifest-bound plugin message parsing refuses a request for another plugin', () => {
  const request = invocation().request as Record<string, unknown>;
  const wire = JSON.stringify({ ...request, pluginId: 'other.plugin' });

  assert.throws(
    () => parsePluginMessage(wire, manifest()),
    /pluginId.*match|match.*pluginId/i,
  );
});
