/** The GUI capability registry is a product contract, not a decorative list. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { CAPABILITIES, CAPABILITY_SPECS } from '../src/dashboard/web/app/core/registry.ts';
import { DASHBOARD_API_CONTRACTS } from '../src/dashboard/contracts.ts';

const ROOT = join(import.meta.dirname, '..');
const API_PATHS = new Set<string>(DASHBOARD_API_CONTRACTS.map((contract) => contract.path));

test('every GUI capability has a complete, conservative CapabilitySpec', () => {
  assert.equal(CAPABILITY_SPECS.length, CAPABILITIES.length, 'the spec cannot silently drop a registry capability');
  assert.deepEqual(
    CAPABILITY_SPECS.map((spec) => spec.id),
    CAPABILITIES.map((capability) => capability.id),
    'CapabilitySpec ordering and identity must remain stable for the rendered parity table',
  );

  for (const spec of CAPABILITY_SPECS) {
    assert.equal(spec.schemaVersion, 1, `${spec.id} schema version`);
    assert.ok(spec.inputSchema.required.every((field) => field.length > 0), `${spec.id} input required fields`);
    assert.ok(spec.inputSchema.optional.every((field) => field.length > 0), `${spec.id} input optional fields`);
    assert.ok(spec.previewSchema.required.includes('applicable'), `${spec.id} preview must disclose applicability`);
    assert.ok(spec.previewSchema.required.includes('summary'), `${spec.id} preview must disclose a summary`);
    assert.equal(spec.bindings.cli, spec.command, `${spec.id} CLI binding drifted from its displayed command`);
    assert.ok(spec.bindings.docs.length > 0, `${spec.id} must name at least one documentation binding`);
    for (const doc of spec.bindings.docs) assert.equal(existsSync(join(ROOT, doc)), true, `${spec.id} docs binding is missing: ${doc}`);
    for (const path of spec.bindings.api) assert.equal(API_PATHS.has(path), true, `${spec.id} names an unknown API route: ${path}`);

    if (spec.coverage === 'planned') {
      assert.equal(spec.outputSchema.kind, 'none', `${spec.id} planned capability cannot claim an output contract`);
      assert.deepEqual(spec.bindings.gui, [], `${spec.id} planned capability cannot claim a GUI binding`);
    }
    if (spec.consequence === 'read') {
      assert.equal(spec.reversibility, 'read_only', `${spec.id} read capability must remain non-mutating`);
      assert.equal(spec.assurance, 'display', `${spec.id} read capability must not claim action assurance`);
    }
    if (spec.consequence === 'destructive') {
      assert.equal(spec.reversibility, 'destructive', `${spec.id} destructive capability needs an irreversible boundary`);
      assert.equal(spec.assurance, 'destructive_confirmation', `${spec.id} destructive capability needs explicit confirmation`);
    }
    if (spec.consequence === 'egress' || spec.id === 'billing-pull') {
      assert.notEqual(spec.egress, 'none', `${spec.id} outbound capability must name its egress boundary`);
    }
  }
});

test('CapabilitySpec is immutable at the product boundary', () => {
  const spec = CAPABILITY_SPECS.find((candidate) => candidate.id === 'billing-pull');
  assert.ok(spec);
  assert.equal(Object.isFrozen(spec), true);
  assert.equal(Object.isFrozen(spec.inputSchema), true);
  assert.equal(Object.isFrozen(spec.bindings), true);
  assert.equal(Object.isFrozen(spec.bindings.docs), true);
});
