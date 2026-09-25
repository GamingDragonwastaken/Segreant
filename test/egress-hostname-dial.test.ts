/**
 * A PERMITTED REQUEST TO A HOSTNAME REACHES THE SERVER THROUGH A REAL SOCKET.
 *
 * The transport resolves a target once, checks every address against the
 * policy class, then pins the connection to the address it checked by handing
 * `http.request` a custom `lookup`. Since Node 20, sockets call that `lookup`
 * with `{ all: true }` (autoSelectFamily) and expect an ARRAY of addresses
 * back. The pinned lookup answered in the single-address form, so Node read
 * `undefined` as the address and every request to a hostname failed with
 * ERR_INVALID_IP_ADDRESS, surfaced as `transport_failed`. That included proxy
 * forwarding to api.openai.com and api.anthropic.com on the Node 24 runtime
 * this package requires.
 *
 * No test caught it because every real-socket test dialled an IP literal,
 * which skips `lookup` entirely, and every hostname test used the dial hook.
 * This one uses a hostname and no hook. Found 2026-09-25 by an end-to-end
 * `segreant team push --url http://localhost:8092` against a live team server.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as http from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { EgressConfig } from '../src/config.ts';
import { egressFetchWithConfig } from '../src/egress/transport.ts';

const LOCKED: EgressConfig = { mode: 'local_locked', rules: [] };

test('a permitted request to a hostname (not an IP literal) is dialled over a real socket', async () => {
  const home = mkdtempSync(join(tmpdir(), 'segreant-egress-hostname-'));
  const previous = process.env.SEGREANT_HOME;
  process.env.SEGREANT_HOME = home;
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('reached');
  });
  // Bind by name so the server listens on the same first address the
  // transport's own resolution of `localhost` will pick on this machine.
  await new Promise<void>((resolve) => server.listen(0, 'localhost', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  try {
    const response = await egressFetchWithConfig(LOCKED, 'http://localhost:' + address.port + '/health', {
      purpose: 'local_healthcheck',
      dataClass: 'healthcheck',
    });
    assert.equal(response.status, 200);
    assert.equal(await response.text(), 'reached');
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    if (previous === undefined) delete process.env.SEGREANT_HOME;
    else process.env.SEGREANT_HOME = previous;
    rmSync(home, { recursive: true, force: true });
  }
});
