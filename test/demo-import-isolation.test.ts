/**
 * Demo mode holds synthetic data in demo.db and labels every surface as sample
 * data. An import run in that mode used to append REAL usage into the same store,
 * which then showed inside the DEMO-labelled totals and claimed to be isolated.
 * Both the CLI import and the dashboard import must refuse, and write nothing.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const home = mkdtempSync(join(tmpdir(), 'segreant-demo-iso-'));
const userHome = join(home, 'userhome');
const transcripts = join(userHome, '.claude', 'projects', 'proj-real');
mkdirSync(transcripts, { recursive: true });
const line = (i: number) => JSON.stringify({
  type: 'assistant',
  uuid: `iso-uuid-${i}`,
  requestId: `iso_req_${i}`,
  timestamp: `2026-10-11T1${i}:00:00.000Z`,
  sessionId: 'iso-session',
  cwd: 'C:\\Users\\fixture\\real-fixture-app',
  message: { model: 'claude-opus-4-8', usage: { input_tokens: 1000, output_tokens: 500 } },
});
writeFileSync(join(transcripts, 'session.jsonl'), [line(1), line(2), line(3)].join('\n') + '\n', 'utf8');

// Isolate every path the code can resolve before any module reads them.
process.env.SEGREANT_HOME = join(home, 'segreant');
process.env.USERPROFILE = userHome;
process.env.HOME = userHome;
process.env.SEGREANT_DEMO = '1';
process.env.SEGREANT_DB = join(home, 'demo.db');

const { Store } = await import('../src/store/db.ts');
const { cmdImport } = await import('../src/cli/importCmd.ts');
const { createDashboardServer } = await import('../src/dashboard/server.ts');
const { DEFAULT_CONFIG } = await import('../src/config.ts');

function realRowsIn(file: string): number {
  const store = new Store(file);
  try {
    return store.summary(0, Date.now() + 1000, 'real-fixture-app').requests;
  } finally {
    store.close();
  }
}

test('CLI import in demo mode writes nothing into the sample store', async () => {
  const before = process.exitCode;
  await cmdImport({ _: ['claude-code'], root: join(userHome, '.claude', 'projects') } as never);
  const exitCode = process.exitCode;
  process.exitCode = before;
  assert.equal(realRowsIn(process.env.SEGREANT_DB!), 0, 'real usage must not be appended to demo.db');
  assert.equal(exitCode, 1, 'the refused import reports a failure exit code');
});

test('dashboard import in demo mode is refused and writes nothing', async () => {
  const store = new Store(process.env.SEGREANT_DB!);
  const server = createDashboardServer({ store, config: structuredClone(DEFAULT_CONFIG), version: 'demo-iso' });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/import?tool=claude-code`, {
      method: 'POST',
      headers: { 'x-segreant-local': '1' },
    });
    assert.equal(response.status, 409, 'demo mode refuses the write with a conflict, not a success');
    const body = (await response.json()) as { error?: string };
    assert.match(body.error ?? '', /demo/i);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    store.close();
  }
  assert.equal(realRowsIn(process.env.SEGREANT_DB!), 0, 'real usage must not be appended to demo.db');
});
