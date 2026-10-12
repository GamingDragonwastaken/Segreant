import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { connect, createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// `start --demo` opens demo.db for the whole process. A proxy started there
// recorded real provider traffic into the sample store while the banner said
// "Real metering is untouched", so demo mode serves the dashboard only.

const listening = (port: number): Promise<boolean> => new Promise((resolve) => {
  const socket = connect({ port, host: '127.0.0.1' });
  socket.once('connect', () => { socket.destroy(); resolve(true); });
  socket.once('error', () => resolve(false));
});

/** A port nothing is listening on right now, chosen by the OS. */
const freePort = (): Promise<number> => new Promise((resolve, reject) => {
  const server = createServer();
  server.once('error', reject);
  server.listen(0, '127.0.0.1', () => {
    const address = server.address();
    const port = typeof address === 'object' && address !== null ? address.port : 0;
    server.close(() => resolve(port));
  });
});

const until = async (check: () => boolean | Promise<boolean>, ms: number): Promise<void> => {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline && !(await check())) await new Promise((r) => setTimeout(r, 200));
};

test('demo mode serves the dashboard and starts no proxy', async () => {
  const home = mkdtempSync(join(tmpdir(), 'segreant-demo-noproxy-'));
  const proxyPort = await freePort();
  const dashboardPort = await freePort();
  const child = spawn(process.execPath, ['bin/segreant.mjs', 'demo', '--serve', '--port', String(proxyPort), '--dashboard-port', String(dashboardPort)], {
    cwd: process.cwd(),
    env: { ...process.env, SEGREANT_HOME: home, NO_COLOR: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  child.stdout.on('data', (d: Buffer) => { out += d.toString(); });
  child.stderr.on('data', (d: Buffer) => { out += d.toString(); });
  try {
    // Seeding the demo store comes first and is slow under a loaded runner.
    await until(() => /Real metering is untouched/.test(out) && /sample-data dashboard/.test(out), 120_000);
    await until(() => listening(dashboardPort), 30_000);
    assert.equal(await listening(dashboardPort), true, `the dashboard answers\n${out}`);
    assert.equal(await listening(proxyPort), false, `no proxy listens in demo mode\n${out}`);
    assert.match(out, /No proxy runs in demo mode/);
    assert.doesNotMatch(out, /Start your tools through Segreant/);
  } finally {
    // Stop the whole tree: the launcher runs the runtime as its own child.
    // POSIX: the launcher forwards SIGTERM. Windows has no signal to forward,
    // so taskkill /T ends the tree.
    const exited = child.exitCode !== null || child.signalCode !== null
      ? Promise.resolve()
      : new Promise((r) => child.once('exit', r));
    if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    else child.kill('SIGTERM');
    await exited;
    await until(async () => !(await listening(dashboardPort)), 10_000);
    assert.equal(await listening(dashboardPort), false, 'stopping segreant stops its dashboard too');
    rmSync(home, { recursive: true, force: true });
  }
});
