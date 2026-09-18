/**
 * THE PLUGIN HOST HAS A FIRST-PARTY CONSUMER: PLUGIN EVIDENCE BECOMES KERNEL
 * EVIDENCE, UNDER THE PLUGIN'S OWN IDENTITY, WITH ONLY THE AXES A HOST CAN
 * HONESTLY WRITE.
 *
 * WP-G02/G03 built the contract and the process host and left them reachable
 * from no product path (directive §21: wire a first-party consumer). D-234
 * adds `src/plugins/intake.ts` and `fiscus plugin run`: one bounded exchange,
 * a preview of the Evidence envelopes it would append, and `--apply` to
 * append them.
 *
 * Checked: a real child's output lands in the epistemic ledger under
 * `plugin:<id>@<version>`; `integrity` is `verified` only for a record whose
 * `payloadHash` matches its payload and `unknown` for a record with none or
 * with a mismatch (the record is kept; the axis is not raised); `authenticity`
 * is `self_asserted` and `completeness.status` is `unknown` regardless of
 * category; a second apply of the same output is `duplicate`; an output whose
 * pluginId or category differs from the manifest refuses the whole batch and
 * writes nothing.
 *
 * Shown able to fail: with the digest comparison inverted the verified /
 * unknown split failed; with the refusal gate removed the batch test's
 * "nothing written" assertion failed.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { EpistemicLedger } from '../src/epistemic/ledger.ts';
import { canonicalJson } from '../src/epistemic/serialization.ts';
import { createPluginManifest, type PluginEvidenceOutput } from '../src/plugins/contract.ts';
import { runPluginProcess } from '../src/plugins/host.ts';
import { createPluginIsolationPolicy, DEFAULT_PLUGIN_ISOLATION_POLICY } from '../src/plugins/isolation.ts';
import { applyPluginIntake, planPluginIntake, pluginEvidenceId } from '../src/plugins/intake.ts';

const MANIFEST = createPluginManifest({
  schemaVersion: 1, pluginId: 'usage.local', pluginVersion: '1.0.0', category: 'usage_source',
  capabilities: ['write_local_evidence'], egress: 'none', credentials: 'none', reversibility: 'append_only',
});
const INVOCATION = {
  request: { protocolVersion: 1, kind: 'request', requestId: 'request-001', pluginId: 'usage.local', operation: 'observe', input: { source: 'host' } },
  requiredCapabilities: [], egress: 'none', credentials: 'none', directNetwork: false, credentialForwarding: false,
};
const INTAKE = { manifest: MANIFEST, scope: { account: 'acct-1' }, grain: ['day', 'project'] };

const digest = (value: unknown): string => createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex');

function output(records: PluginEvidenceOutput['evidence'], overrides: Partial<PluginEvidenceOutput> = {}): PluginEvidenceOutput {
  return { protocolVersion: 1, kind: 'evidence', requestId: 'request-001', pluginId: 'usage.local', category: 'usage_source', evidence: records, ...overrides };
}

function childScript(): string {
  const hashed = { tokens: 12 };
  return `
    let wire = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => { wire += chunk; });
    process.stdin.on('end', () => {
      const request = JSON.parse(wire.trim());
      process.stdout.write(JSON.stringify({
        protocolVersion: 1, kind: 'evidence', requestId: request.requestId, pluginId: request.pluginId, category: 'usage_source',
        evidence: [
          { evidenceId: 'hashed', evidenceType: 'usage.observation', source: 'child', observedAtMs: 1700000000000, payload: ${JSON.stringify(hashed)}, payloadHash: '${digest(hashed)}' },
          { evidenceId: 'bare', evidenceType: 'usage.observation', source: 'child', observedAtMs: 1700000000000, payload: { tokens: 3 } },
        ]
      }) + String.fromCharCode(10));
    });
  `;
}

test('a real child plugin\'s output lands in the kernel under the plugin\'s identity, with honest axes', async () => {
  const policy = createPluginIsolationPolicy({ ...DEFAULT_PLUGIN_ISOLATION_POLICY, timeouts: { ...DEFAULT_PLUGIN_ISOLATION_POLICY.timeouts, startupMs: 15_000, requestMs: 15_000 } });
  const hosted = await runPluginProcess({ manifest: MANIFEST, invocation: INVOCATION, executable: process.execPath, args: ['-e', childScript()], cwd: process.cwd(), policy });
  assert.equal(hosted.status, 'completed', hosted.errors.join('; '));
  assert.ok(hosted.output);

  const ledger = new EpistemicLedger(new DatabaseSync(':memory:'));
  const plan = planPluginIntake({ ...INTAKE, output: hosted.output });
  assert.deepEqual(plan.refusals, []);
  assert.equal(plan.evidence.length, 2);
  const result = applyPluginIntake(ledger, plan);
  assert.equal(result.inserted.length, 2);

  const hashed = ledger.readEvidence(pluginEvidenceId('usage.local', 'request-001', 'hashed'));
  const bare = ledger.readEvidence(pluginEvidenceId('usage.local', 'request-001', 'bare'));
  assert.ok(hashed && bare);
  assert.equal(hashed.sourceIdentity, 'plugin:usage.local@1.0.0');
  assert.equal(hashed.evidenceType, 'plugin.usage_source.usage.observation');
  assert.equal(hashed.integrity, 'verified', 'a matching payloadHash is the one thing the host can verify');
  assert.equal(bare.integrity, 'unknown', 'no hash, no claim');
  for (const item of [hashed, bare]) {
    assert.equal(item.authenticity, 'self_asserted');
    assert.equal(item.completeness.status, 'unknown');
    assert.equal(item.sensitivity, 'internal');
  }

  const again = applyPluginIntake(ledger, planPluginIntake({ ...INTAKE, output: hosted.output }));
  assert.deepEqual(again.inserted, []);
  assert.equal(again.duplicate.length, 2, 'the same output twice is a duplicate, not a second row');
});

test('a payloadHash that does not match its payload keeps the record and does not raise integrity', () => {
  const plan = planPluginIntake({ ...INTAKE, output: output([
    { evidenceId: 'lying', evidenceType: 'usage.observation', source: 'child', observedAtMs: 1700000000000, payload: { tokens: 1 }, payloadHash: 'a'.repeat(64) },
  ]) });
  assert.deepEqual(plan.refusals, []);
  assert.equal(plan.evidence[0]!.integrity, 'unknown');
  assert.match(plan.integrity[0]!.because, /does not match/);
});

test('an output whose identity or category is not the manifest\'s refuses the whole batch and writes nothing', () => {
  const ledger = new EpistemicLedger(new DatabaseSync(':memory:'));
  for (const overrides of [{ pluginId: 'someone.else' }, { category: 'billing_source' as const }]) {
    const plan = planPluginIntake({ ...INTAKE, output: output([
      { evidenceId: 'ok', evidenceType: 'usage.observation', source: 'child', observedAtMs: 1700000000000, payload: { tokens: 1 } },
    ], overrides) });
    assert.ok(plan.refusals.length > 0);
    const result = applyPluginIntake(ledger, plan);
    assert.deepEqual(result.inserted, []);
  }
  assert.equal(ledger.graph().nodes.length, 0, 'a refused batch must write nothing');
});

test('a record that changed under the same id is a conflict the plan names, and nothing half-lands', () => {
  // Found by running the CLI twice: the first draft stamped recordedAt from
  // the wall clock, so the second run's envelope differed and the ledger threw
  // "different evidence already exists" mid-batch. The envelope is now a pure
  // function of the output, and a genuinely changed record is refused up front.
  const ledger = new EpistemicLedger(new DatabaseSync(':memory:'));
  const first = applyPluginIntake(ledger, planPluginIntake({ ...INTAKE, output: output([
    { evidenceId: 'e1', evidenceType: 'usage.observation', source: 'child', observedAtMs: 1700000000000, payload: { tokens: 1 } },
  ]) }));
  assert.equal(first.inserted.length, 1);
  const changed = applyPluginIntake(ledger, planPluginIntake({ ...INTAKE, output: output([
    { evidenceId: 'e1', evidenceType: 'usage.observation', source: 'child', observedAtMs: 1700000000000, payload: { tokens: 2 } },
    { evidenceId: 'e2', evidenceType: 'usage.observation', source: 'child', observedAtMs: 1700000000000, payload: { tokens: 3 } },
  ]) }));
  assert.deepEqual(changed.inserted, []);
  assert.match(changed.refusals.join(' '), /conflict/);
  assert.equal(ledger.graph().nodes.length, 1, 'e2 must not land beside a conflicting e1');
});
