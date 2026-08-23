import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { evaluateEgressPolicy } from '../src/egress/policy.ts';
import { egressReceiptPath } from '../src/egress/receipts.ts';
import {
  EgressError,
  egressFetchWithConfig,
  setEgressDialHookForTests,
  setEgressDnsLookupForTests,
} from '../src/egress/transport.ts';
import { loadConfig } from '../src/config.ts';
import type { EgressConfig } from '../src/config.ts';

const CLOUD: EgressConfig = {
  mode: 'controlled_cloud',
  rules: [{
    id: 'ipv6-test',
    enabled: true,
    purpose: 'provider_inference',
    dataClass: 'provider_request',
    method: 'GET',
    origin: 'https://ipv6.example.test',
    pathPrefix: '/v1/',
  }],
};

function withHome(label: string): { home: string; restore: () => void } {
  const home = mkdtempSync(join(tmpdir(), 'fiscus-ipv6-' + label + '-'));
  const previous = process.env.FISCUS_HOME;
  process.env.FISCUS_HOME = home;
  return {
    home,
    restore: () => {
      if (previous === undefined) delete process.env.FISCUS_HOME;
      else process.env.FISCUS_HOME = previous;
      rmSync(home, { recursive: true, force: true });
    },
  };
}

function dnsResult(address: string): { address: string; family: 4 | 6 }[] {
  return [{ address, family: 6 }];
}

test('controlled-cloud DNS rejects every required IPv6 special-use class without a dial', async () => {
  const rejected = [
    '::',
    '::1',
    'ff02::1',
    'Ff02:0:0:0:0:0:0:1',
    'fec0::1',
    'fe80::1',
    'fc00::1',
    'fd12:3456::1',
    '2001:db8::1',
    '::ffff:192.168.1.10',
    '::ffff:10.0.0.1',
  ];
  for (const address of rejected) {
    const state = withHome(address.replace(/[^a-z0-9]/gi, '-'));
    let dnsCalls = 0;
    let dialCalls = 0;
    const restoreDns = setEgressDnsLookupForTests(async () => {
      dnsCalls++;
      return dnsResult(address);
    });
    const restoreDial = setEgressDialHookForTests(async () => {
      dialCalls++;
      return new Response('unexpected dial');
    });
    try {
      await assert.rejects(
        egressFetchWithConfig(CLOUD, 'https://ipv6.example.test/v1/test', {
          purpose: 'provider_inference',
          dataClass: 'provider_request',
        }),
        (error: unknown) => error instanceof EgressError && error.code === 'dns_denied',
        address,
      );
      assert.equal(dnsCalls, 1, address);
      assert.equal(dialCalls, 0, address);
    } finally {
      restoreDial();
      restoreDns();
      state.restore();
    }
  }
});

test('a legitimate global-unicast IPv6 address is selected and reaches the injected dial seam', async () => {
  const state = withHome('global');
  const selected = '2001:4860:4860::8888';
  let observed: { address: string; family: 4 | 6 } | undefined;
  const restoreDns = setEgressDnsLookupForTests(async () => dnsResult(selected));
  const restoreDial = setEgressDialHookForTests(async ({ resolved }) => {
    observed = resolved;
    return new Response('intercepted', { status: 200 });
  });
  try {
    const response = await egressFetchWithConfig(CLOUD, 'https://ipv6.example.test/v1/test', {
      purpose: 'provider_inference',
      dataClass: 'provider_request',
    });
    assert.equal(response.status, 200);
    assert.deepEqual(observed, { address: selected, family: 6, targetClass: 'controlled_cloud' });
  } finally {
    restoreDial();
    restoreDns();
    state.restore();
  }
});

test('corrupt receipt history refuses before even invoking the DNS resolver', async () => {
  const state = withHome('corrupt-no-dns');
  writeFileSync(egressReceiptPath(), '', 'utf8');
  let dnsCalls = 0;
  let dialCalls = 0;
  const restoreDns = setEgressDnsLookupForTests(async () => {
    dnsCalls++;
    return dnsResult('2001:4860:4860::8888');
  });
  const restoreDial = setEgressDialHookForTests(async () => {
    dialCalls++;
    return new Response('unexpected dial');
  });
  try {
    await assert.rejects(
      egressFetchWithConfig({ mode: 'local_locked', rules: [] }, 'http://127.0.0.1:9/health', {
        purpose: 'local_healthcheck',
        dataClass: 'healthcheck',
      }),
      (error: unknown) => error instanceof EgressError && error.code === 'receipt_integrity_failed',
    );
    assert.equal(dnsCalls, 0);
    assert.equal(dialCalls, 0);
  } finally {
    restoreDial();
    restoreDns();
    state.restore();
  }
});

test('runtime config rejects ambiguous egress mode and rule coercions fail closed', () => {
  const cases: unknown[] = [
    { egress: { mode: 'remote', rules: [] } },
    { egress: { mode: 'controlled_cloud', rules: [{ id: 'bad', enabled: 'false' }] } },
    { egress: { mode: 'controlled_cloud', rules: {} } },
    { egress: { rules: [{ id: 'bad', enabled: true }] } },
  ];
  for (const raw of cases) {
    const state = withHome('config-invalid');
    try {
      writeFileSync(join(state.home, 'config.json'), JSON.stringify(raw), 'utf8');
      const loaded = loadConfig();
      assert.equal(loaded.egress.mode, 'local_locked', JSON.stringify(raw));
      assert.deepEqual(loaded.egress.rules, [], JSON.stringify(raw));
      const decision = evaluateEgressPolicy(loaded.egress, {
        url: 'https://ipv6.example.test/v1/test',
        purpose: 'provider_inference',
        dataClass: 'provider_request',
        method: 'GET',
      });
      assert.equal(decision.allowed, false, JSON.stringify(raw));
    } finally {
      state.restore();
    }
  }
});

test('an exact controlled-cloud config remains usable after runtime validation', () => {
  const state = withHome('config-valid');
  try {
    writeFileSync(join(state.home, 'config.json'), JSON.stringify({ egress: CLOUD }), 'utf8');
    const loaded = loadConfig();
    assert.equal(loaded.egress.mode, 'controlled_cloud');
    assert.deepEqual(loaded.egress.rules, CLOUD.rules);
    assert.equal(evaluateEgressPolicy(loaded.egress, {
      url: 'https://ipv6.example.test/v1/test',
      purpose: 'provider_inference',
      dataClass: 'provider_request',
      method: 'GET',
    }).allowed, true);
  } finally {
    state.restore();
  }
});

test('policy itself does not treat non-boolean enabled or unknown mode as authorization', () => {
  const ambiguous = {
    mode: 'remote',
    rules: [{ ...CLOUD.rules[0]!, enabled: 'false' as unknown as boolean }],
  } as unknown as EgressConfig;
  const decision = evaluateEgressPolicy(ambiguous, {
    url: 'https://ipv6.example.test/v1/test',
    purpose: 'provider_inference',
    dataClass: 'provider_request',
    method: 'GET',
  });
  assert.equal(decision.allowed, false);
});
