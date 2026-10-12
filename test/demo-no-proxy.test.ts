import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { connect } from 'node:net';
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

test('demo mode serves the dashboard and starts no proxy', async () => {
  const home = mkdtempSync(join(tmpdir(), 'segreant-demo-noproxy-'));
  const proxyPort = 8291;
  const dashboardPort = 8292;
  const child = spawn(process.execPath, ['bin/segreant.mjs', 'demo', '--serve', '--port', String(proxyPort), '--dashboard-port', String(dashboardPort)], {
    cwd: process.cwd(),
    env: { ...process.env, SEGREANT_HOME: home, NO_COLOR: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  child.stdout.on('data', (d: Buffer) => { out += d.toString(); });
  try {
    for (let i = 0; i < 300 && !(await listening(dashboardPort)); i++) await new Promise((r) => setTimeout(r, 200));
    assert.equal(await listening(dashboardPort), true, 'the dashboard answers');
    assert.equal(await listening(proxyPort), false, 'no proxy listens in demo mode');
    for (let i = 0; i < 50 && !/Real metering is untouched/.test(out); i++) await new Promise((r) => setTimeout(r, 100));
    assert.match(out, /No proxy runs in demo mode/);
    assert.doesNotMatch(out, /Start your tools through Segreant/);
  } finally {
    child.kill();
    await new Promise((r) => child.once('exit', r));
    rmSync(home, { recursive: true, force: true });
  }
});
