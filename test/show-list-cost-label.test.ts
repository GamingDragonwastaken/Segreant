/**
 * The four-truth rule on the first screen: `today`, `week` and `month` price
 * everything from the rate card, so the headline is LIST COST, never "spend",
 * and usage read from tool logs (subscription work) is said to be list-price
 * value, not the user's invoice.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store/db.ts';

const CLI = join(import.meta.dirname, '..', 'src', 'cli.ts');

function runCli(args: string[], home: string): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [CLI, ...args],
      { env: { ...process.env, SEGREANT_HOME: home, SEGREANT_DB: join(home, 'segreant.db'), NODE_OPTIONS: '' } },
      (err, stdout, stderr) => {
        const code = err && typeof (err as NodeJS.ErrnoException & { code?: unknown }).code === 'number'
          ? ((err as unknown as { code: number }).code)
          : err ? 1 : 0;
        resolve({ code, stdout: String(stdout), stderr: String(stderr) });
      },
    );
  });
}

test('the window views head with list cost, and say imported usage is not the invoice', async () => {
  const home = mkdtempSync(join(tmpdir(), 'segreant-list-cost-'));
  try {
    const store = new Store(join(home, 'segreant.db'));
    const base = {
      sessionId: null, provider: 'anthropic', model: 'claude-opus-4-8', project: 'p', taskWeight: 1,
      inputTokens: 10, outputTokens: 10, cacheWriteTokens: 0, cacheReadTokens: 0, reasoningTokens: 0,
      estimated: false, streamed: false, statusCode: 200, durationMs: 1,
    };
    store.insertRequestIfNew({ ...base, requestId: 'imported-1', tsEpochMs: Date.now() - 60_000, costUsd: 12.5, via: 'import', source: 'claude-code' });
    store.insertRequest({ ...base, requestId: 'proxied-1', tsEpochMs: Date.now() - 30_000, costUsd: 2.25 });
    store.close();

    for (const window of ['today', 'week', 'month']) {
      const { code, stdout, stderr } = await runCli([window], home);
      assert.equal(code, 0, stderr);
      assert.match(stdout, /List cost\s+\$14\.75/, `${window}: the headline is list cost`);
      assert.doesNotMatch(stdout, /^\s*Spend\b/m, `${window}: no line opens with a bare "Spend"`);
      assert.match(stdout, /\$12\.50 read from tool logs: .*not your invoice/, `${window}: imported usage is not the invoice`);
      assert.match(stdout, /\$2\.25 metered through the proxy: list price/, `${window}: proxied usage is list price`);
    }
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
