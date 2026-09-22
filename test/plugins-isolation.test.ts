import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_PLUGIN_ISOLATION_POLICY,
  createPluginIsolationPolicy,
  validatePluginIsolationPolicy,
} from '../src/plugins/isolation.ts';

test('default plugin isolation policy is separate-process and host-mediated', () => {
  const policy = DEFAULT_PLUGIN_ISOLATION_POLICY;
  assert.equal(policy.process, 'separate_process');
  assert.equal(policy.inProcessExecution, 'forbidden');
  assert.equal(policy.osBoundary, 'unsupported');
  assert.deepEqual(policy.transports, ['stdio', 'local_socket']);
  assert.equal(policy.defaultTransport, 'stdio');
  assert.equal(policy.localSocket.loopbackOnly, true);
  assert.equal(policy.localSocket.hostAllocated, true);
  assert.equal(policy.egress.directNetwork, 'forbidden');
  assert.equal(policy.egress.mode, 'host_policy_only');
  assert.ok(policy.timeouts.startupMs > 0);
  assert.ok(policy.timeouts.requestMs > 0);
  assert.ok(policy.resources.maxMessageBytes > 0);
  assert.ok(policy.resources.maxOutputBytes <= policy.resources.maxMessageBytes);
  assert.equal(Object.isFrozen(policy), true);
  assert.equal(Object.isFrozen(policy.timeouts), true);
  assert.equal(Object.isFrozen(policy.resources), true);
});

test('isolation policy validator rejects in-process execution and unsafe local sockets', () => {
  assert.deepEqual(validatePluginIsolationPolicy(DEFAULT_PLUGIN_ISOLATION_POLICY), []);

  assert.throws(
    () => createPluginIsolationPolicy({
      ...DEFAULT_PLUGIN_ISOLATION_POLICY,
      process: 'in_process',
    } as never),
    /separate_process|in-process/i,
  );
  assert.throws(
    () => createPluginIsolationPolicy({
      ...DEFAULT_PLUGIN_ISOLATION_POLICY,
      localSocket: { ...DEFAULT_PLUGIN_ISOLATION_POLICY.localSocket, loopbackOnly: false },
    } as never),
    /loopback/i,
  );
  assert.throws(
    () => createPluginIsolationPolicy({
      ...DEFAULT_PLUGIN_ISOLATION_POLICY,
      resources: { ...DEFAULT_PLUGIN_ISOLATION_POLICY.resources, maxOutputBytes: 999_999_999 },
    } as never),
    /output.*message|message.*output/i,
  );
});

test('isolation policy describes bounded time and resource controls without executing anything', () => {
  const policy = DEFAULT_PLUGIN_ISOLATION_POLICY;
  assert.deepEqual(Object.keys(policy.timeouts).sort(), ['idleMs', 'requestMs', 'shutdownGraceMs', 'startupMs']);
  assert.deepEqual(Object.keys(policy.resources).sort(), [
    'maxCpuTimeMs',
    'maxEvidenceRecords',
    'maxFileDescriptors',
    'maxInputBytes',
    'maxJsonDepth',
    'maxJsonNodes',
    'maxMemoryBytes',
    'maxMessageBytes',
    'maxOutputBytes',
    'maxStderrBytes',
  ]);
  assert.equal(policy.untrustedCode, 'process_boundary_only');
});
