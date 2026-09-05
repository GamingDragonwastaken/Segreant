import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_PLUGIN_ISOLATION_POLICY,
  createPluginIsolationPolicy,
  type PluginIsolationPolicy,
} from '../src/plugins/isolation.ts';
import {
  createPluginManifest,
  type PluginManifest,
} from '../src/plugins/contract.ts';
import {
  runPluginProcess,
  type PluginProcessHostInput,
} from '../src/plugins/host.ts';

function manifest(overrides: Partial<PluginManifest> = {}): PluginManifest {
  return createPluginManifest({
    schemaVersion: 1,
    pluginId: 'usage.local',
    pluginVersion: '1.0.0',
    category: 'usage_source',
    capabilities: ['write_local_evidence'],
    egress: 'none',
    credentials: 'none',
    reversibility: 'append_only',
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
      input: { source: 'host' },
    },
    requiredCapabilities: [],
    egress: 'none',
    credentials: 'none',
    directNetwork: false,
    credentialForwarding: false,
    ...overrides,
  };
}

function policy(overrides: Partial<PluginIsolationPolicy> = {}): PluginIsolationPolicy {
  return createPluginIsolationPolicy({
    ...DEFAULT_PLUGIN_ISOLATION_POLICY,
    timeouts: {
      ...DEFAULT_PLUGIN_ISOLATION_POLICY.timeouts,
      startupMs: 250,
      requestMs: 500,
    },
    ...overrides,
  });
}

function input(script: string, overrides: Partial<PluginProcessHostInput> = {}): PluginProcessHostInput {
  return {
    manifest: manifest(),
    invocation: invocation(),
    executable: process.execPath,
    args: ['-e', script],
    cwd: process.cwd(),
    policy: policy(),
    ...overrides,
  };
}

function successScript(): string {
  return `
    let wire = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => { wire += chunk; });
    process.stdin.on('end', () => {
      const request = JSON.parse(wire.trim());
      process.stdout.write(JSON.stringify({
        protocolVersion: 1,
        kind: 'evidence',
        requestId: request.requestId,
        pluginId: request.pluginId,
        category: 'usage_source',
        evidence: [{
          evidenceId: 'child-evidence-001',
          evidenceType: 'usage.observation',
          source: 'child-process',
          observedAtMs: 1700000000000,
          payload: { pid: process.pid, ambientProbe: process.env.FISCUS_TEST_SECRET ?? 'absent' }
        }]
      }) + String.fromCharCode(10));
    });
  `;
}

test('process host executes the plugin as a real child and returns bounded evidence', async () => {
  const result = await runPluginProcess(input(successScript()));

  assert.equal(result.status, 'completed');
  assert.equal(result.boundary, 'separate_process');
  assert.equal(result.osBoundary, 'unsupported');
  assert.notEqual(result.pid, null);
  assert.notEqual(result.pid, process.pid);
  assert.equal(result.output?.kind, 'evidence');
  assert.equal(result.output?.pluginId, 'usage.local');
  assert.equal(result.output?.evidence[0]?.source, 'child-process');
  const payload = result.output?.evidence[0]?.payload as { pid: number; ambientProbe: string };
  assert.notEqual(payload.pid, process.pid);
  assert.equal(payload.ambientProbe, 'absent');
  assert.deepEqual(result.enforcedControls, [
    'separate_process',
    'stdio_transport',
    'bounded_messages',
    'request_timeout',
    'credential_environment_scrub',
  ]);
  assert.ok(result.notEnforcedControls.includes('filesystem_restriction'));
  assert.ok(result.notEnforcedControls.includes('direct_network_block'));
});

test('process host refuses when OS-level isolation is required instead of overstating the process boundary', async () => {
  const result = await runPluginProcess(input('process.exit(42);', { requireOsBoundary: true }));

  assert.equal(result.status, 'refused');
  assert.equal(result.pid, null);
  assert.equal(result.output, null);
  assert.match(result.errors.join('\n'), /OS-level.*unavailable|unsupported/i);
});

test('process host refuses a valid-looking response bound to a different request id', async () => {
  const result = await runPluginProcess(input(
    successScript().replace('requestId: request.requestId', 'requestId: "stale-request"'),
  ));

  assert.equal(result.status, 'failed');
  assert.equal(result.output, null);
  assert.match(result.errors.join('\\n'), /requestId|request id/i);
});

test('process host refuses declared direct egress and credentials before spawning a child', async () => {
  const directEgress = await runPluginProcess(input('process.exit(42);', {
    manifest: manifest({
      capabilities: ['write_local_evidence', 'network_egress'],
      egress: 'declared_cloud',
    }),
    invocation: invocation({ egress: 'declared_cloud', requiredCapabilities: ['network_egress'] }),
  }));
  assert.equal(directEgress.status, 'refused');
  assert.equal(directEgress.pid, null);
  assert.match(directEgress.errors.join('\n'), /egress|OS-level|network/i);

  const credentials = await runPluginProcess(input('process.exit(42);', {
    manifest: manifest({
      capabilities: ['write_local_evidence', 'use_credentials'],
      credentials: 'provider_credential',
    }),
    invocation: invocation({ credentials: 'provider_credential', requiredCapabilities: ['use_credentials'] }),
  }));
  assert.equal(credentials.status, 'refused');
  assert.equal(credentials.pid, null);
  assert.match(credentials.errors.join('\n'), /credential|OS-level/i);
});

test('process host refuses capabilities that would require unconfined operating-system access', async () => {
  const result = await runPluginProcess(input('process.exit(42);', {
    manifest: manifest({
      capabilities: ['write_local_evidence', 'read_local_files'],
    }),
  }));

  assert.equal(result.status, 'refused');
  assert.equal(result.pid, null);
  assert.match(result.errors.join('\n'), /capabilit|filesystem|OS-level/i);
});

test('process host refuses direct network and credential forwarding flags even for a safe manifest', async () => {
  const directNetwork = await runPluginProcess(input('process.exit(42);', {
    invocation: invocation({ directNetwork: true }),
  }));
  assert.equal(directNetwork.status, 'refused');
  assert.equal(directNetwork.pid, null);
  assert.match(directNetwork.errors.join('\n'), /direct network.*forbidden/i);

  const forwardedCredential = await runPluginProcess(input('process.exit(42);', {
    invocation: invocation({ credentialForwarding: true }),
  }));
  assert.equal(forwardedCredential.status, 'refused');
  assert.equal(forwardedCredential.pid, null);
  assert.match(forwardedCredential.errors.join('\n'), /credential forwarding.*forbidden/i);
});

test('process host kills a child that exceeds the bounded output policy', async () => {
  const result = await runPluginProcess(input("process.stdout.write('x'.repeat(4096));", {
    policy: policy({
      resources: {
        ...DEFAULT_PLUGIN_ISOLATION_POLICY.resources,
        maxOutputBytes: 256,
      },
    }),
  }));

  assert.equal(result.status, 'refused');
  assert.equal(result.output, null);
  assert.match(result.errors.join('\n'), /output.*limit|maximum.*output|bound/i);
  assert.ok(result.stdoutBytes > 256);
});

test('process host times out a child that does not answer the request', async () => {
  const result = await runPluginProcess(input('setTimeout(() => {}, 5000);', {
    policy: policy({
      timeouts: {
        ...DEFAULT_PLUGIN_ISOLATION_POLICY.timeouts,
        startupMs: 100,
        requestMs: 100,
      },
    }),
  }));

  assert.equal(result.status, 'timed_out');
  assert.equal(result.output, null);
  assert.match(result.errors.join('\n'), /timeout/i);
});

test('process host does not inherit ambient credentials from the parent environment', async () => {
  const previous = process.env.FISCUS_TEST_SECRET;
  process.env.FISCUS_TEST_SECRET = '[REDACTED]';
  try {
    const result = await runPluginProcess(input(successScript()));
    assert.equal(result.status, 'completed');
    const payload = result.output?.evidence[0]?.payload as { ambientProbe: string };
    assert.equal(payload.ambientProbe, 'absent');
    assert.doesNotMatch(JSON.stringify(result), /\[REDACTED\]/);
  } finally {
    if (previous === undefined) delete process.env.FISCUS_TEST_SECRET;
    else process.env.FISCUS_TEST_SECRET = previous;
  }
});
