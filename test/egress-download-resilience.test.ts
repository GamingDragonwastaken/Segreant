/**
 * A download through the egress transport must not be held hostage by one bad
 * route: every checked DNS address is offered to the dial (Happy Eyeballs),
 * and an opt-in stall timeout aborts a body that stops arriving. Inference
 * streams never get the stall timeout, because a reasoning model can be silent
 * for minutes.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  egressFetchWithConfig, setEgressDialHookForTests, setEgressDnsLookupForTests, type ResolvedTarget,
} from '../src/egress/transport.ts';
import type { EgressConfig } from '../src/config.ts';

function withHome(): () => void {
  const home = mkdtempSync(join(tmpdir(), 'segreant-download-'));
  const previous = process.env.SEGREANT_HOME;
  process.env.SEGREANT_HOME = home;
  return () => {
    if (previous === undefined) delete process.env.SEGREANT_HOME;
    else process.env.SEGREANT_HOME = previous;
    rmSync(home, { recursive: true, force: true });
  };
}

const CLOUD: EgressConfig = {
  mode: 'controlled_cloud',
  rules: [{ id: 'dl-test', enabled: true, purpose: 'market_refresh', dataClass: 'market_manifest', method: 'GET', origin: 'https://files.example.test', pathPrefix: '/data.json' }],
};

test('the dial is offered every checked address, not only the first', async () => {
  const restoreHome = withHome();
  const dns = [{ address: '2001:4860:4860::8888', family: 6 as const }, { address: '8.8.8.8', family: 4 as const }, { address: '1.1.1.1', family: 4 as const }];
  let seen: ResolvedTarget | null = null;
  const restoreDns = setEgressDnsLookupForTests(async () => dns);
  const restoreDial = setEgressDialHookForTests(async ({ resolved }) => { seen = resolved; return new Response('ok'); });
  try {
    const res = await egressFetchWithConfig(CLOUD, 'https://files.example.test/data.json', { purpose: 'market_refresh', dataClass: 'market_manifest' });
    assert.equal(await res.text(), 'ok');
    assert.deepEqual(seen!.addresses, dns);
    assert.equal(seen!.address, dns[0]!.address);
  } finally {
    restoreDial(); restoreDns(); restoreHome();
  }
});

async function stallingServer(): Promise<{ url: string; close: () => Promise<void> }> {
  const server = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.write('{"partial":');
    // ...and then nothing, with the connection held open.
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}/health`,
    close: () => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }),
  };
}

test('an opted-in download that stops arriving is aborted by the stall timeout', async () => {
  const restoreHome = withHome();
  const srv = await stallingServer();
  try {
    const started = Date.now();
    const res = await egressFetchWithConfig({ mode: 'local_locked', rules: [] }, srv.url, {
      purpose: 'local_healthcheck', dataClass: 'healthcheck', stallTimeoutMs: 300,
    });
    await assert.rejects(res.text());
    assert.ok(Date.now() - started < 5_000, 'the stall fails fast instead of waiting for an overall timeout');
  } finally {
    await srv.close(); restoreHome();
  }
});

test('without the opt-in, a silent body is left alone (inference streams may pause for minutes)', async () => {
  const restoreHome = withHome();
  const srv = await stallingServer();
  try {
    const res = await egressFetchWithConfig({ mode: 'local_locked', rules: [] }, srv.url, { purpose: 'local_healthcheck', dataClass: 'healthcheck' });
    const reader = res.body!.getReader();
    const first = await reader.read();
    assert.equal(first.done, false);
    const next = await Promise.race([reader.read().then(() => 'data-or-end'), new Promise((r) => setTimeout(() => r('still-open'), 800))]);
    assert.equal(next, 'still-open');
    await reader.cancel();
  } finally {
    await srv.close(); restoreHome();
  }
});
