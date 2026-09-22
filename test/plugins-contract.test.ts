import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_PLUGIN_MESSAGE_LIMITS,
  PLUGIN_CATEGORIES,
  createPluginEvidenceOutput,
  createPluginManifest,
  createPluginRequestMessage,
  parsePluginMessage,
  serializePluginMessage,
  type PluginEvidenceOutput,
  type PluginManifest,
} from '../src/plugins/contract.ts';

function manifest(overrides: Partial<PluginManifest> = {}): PluginManifest {
  return createPluginManifest({
    schemaVersion: 1,
    pluginId: 'usage.local',
    pluginVersion: '1.0.0',
    category: 'usage_source',
    capabilities: ['read_local_ledger', 'write_local_evidence'],
    egress: 'none',
    credentials: 'none',
    reversibility: 'append_only',
    ...overrides,
  });
}

function evidenceOutput(plugin = manifest()): PluginEvidenceOutput {
  return createPluginEvidenceOutput({
    protocolVersion: 1,
    kind: 'evidence',
    requestId: 'request-001',
    pluginId: plugin.pluginId,
    category: plugin.category,
    evidence: [{
      evidenceId: 'evidence-001',
      evidenceType: 'usage.observation',
      source: 'local-fixture',
      observedAtMs: 1_700_000_000_000,
      payload: { count: 2, source: 'fixture' },
    }],
  }, plugin);
}

test('plugin manifests expose typed categories and risk metadata as immutable data', () => {
  assert.deepEqual(PLUGIN_CATEGORIES, [
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
  ]);

  const item = manifest();
  assert.equal(item.category, 'usage_source');
  assert.deepEqual(item.capabilities, ['read_local_ledger', 'write_local_evidence']);
  assert.equal(item.egress, 'none');
  assert.equal(item.credentials, 'none');
  assert.equal(item.reversibility, 'append_only');
  assert.equal(Object.isFrozen(item), true);
  assert.equal(Object.isFrozen(item.capabilities), true);
});

test('manifest metadata cannot claim egress or credentials without the matching capability', () => {
  assert.throws(
    () => manifest({ egress: 'declared_cloud' }),
    /network_egress/,
  );
  assert.throws(
    () => manifest({ credentials: 'operator_environment' }),
    /use_credentials/,
  );
  assert.throws(
    () => manifest({
      capabilities: ['read_local_ledger'],
      egress: 'declared_cloud',
    }),
    /network_egress/,
  );
});

test('plugin output is evidence-only and binds to the manifest identity', () => {
  const plugin = manifest();
  const output = evidenceOutput(plugin);
  assert.equal(output.kind, 'evidence');
  assert.equal(output.pluginId, plugin.pluginId);
  assert.equal(output.category, plugin.category);
  assert.equal(Object.isFrozen(output), true);
  assert.equal(Object.isFrozen(output.evidence), true);
  assert.equal(Object.isFrozen(output.evidence[0]), true);

  assert.throws(
    () => createPluginEvidenceOutput({
      ...output,
      claims: [{ id: 'claim:forbidden' }],
    } as never, plugin),
    /unknown field|evidence-only|claim/i,
  );
  assert.throws(
    () => createPluginEvidenceOutput({ ...output, category: 'billing_source' } as never, plugin),
    /category|plugin/i,
  );
  assert.throws(
    () => createPluginEvidenceOutput({
      ...output,
      evidence: [{ ...output.evidence[0]!, evidenceType: 'claim.issued' }],
    } as never, plugin),
    /claim|decision|action/i,
  );
  assert.throws(
    () => createPluginEvidenceOutput({
      ...output,
      evidence: [output.evidence[0]!, output.evidence[0]!],
    } as never, plugin),
    /duplicate.*evidenceId/i,
  );
});

test('plugin messages round-trip through a bounded JSON wire representation', () => {
  const wire = serializePluginMessage(evidenceOutput());
  const parsed = parsePluginMessage(wire);
  assert.deepEqual(parsed, evidenceOutput());
  assert.ok(Buffer.byteLength(wire, 'utf8') <= DEFAULT_PLUGIN_MESSAGE_LIMITS.maxMessageBytes);
});

test('plugin message validation refuses oversized and deeply nested input', () => {
  const tooLarge = {
    protocolVersion: 1,
    kind: 'request',
    requestId: 'request-001',
    pluginId: 'usage.local',
    operation: 'observe',
    input: { value: 'x'.repeat(DEFAULT_PLUGIN_MESSAGE_LIMITS.maxStringBytes + 1) },
  };
  assert.throws(() => parsePluginMessage(JSON.stringify(tooLarge)), /size|limit/i);

  let nested: unknown = 'leaf';
  for (let index = 0; index <= DEFAULT_PLUGIN_MESSAGE_LIMITS.maxJsonDepth; index += 1) {
    nested = { next: nested };
  }
  const tooDeep = {
    protocolVersion: 1,
    kind: 'request',
    requestId: 'request-001',
    pluginId: 'usage.local',
    operation: 'observe',
    input: nested,
  };
  assert.throws(() => parsePluginMessage(JSON.stringify(tooDeep)), /depth|limit/i);

  const cyclic = {} as { next?: unknown };
  cyclic.next = cyclic;
  assert.throws(() => createPluginRequestMessage({
    protocolVersion: 1,
    kind: 'request',
    requestId: 'request-001',
    pluginId: 'usage.local',
    operation: 'observe',
    input: cyclic as never,
  }), /cycle/i);
});
