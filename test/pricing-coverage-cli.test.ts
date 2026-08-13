/** The headless provenance report must be inspectable without a refresh/reprice. */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Store, type RequestRow } from '../src/store/db.ts';

const CLI = join(import.meta.dirname, '..', 'src', 'cli.ts');

function runCli(args: string[], dbPath: string, home: string): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(process.execPath, [CLI, ...args], {
      env: { ...process.env, AEGIS_DB: dbPath, AEGIS_HOME: home, NODE_OPTIONS: '' },
    }, (err, stdout, stderr) => {
      const code = err && typeof (err as NodeJS.ErrnoException & { code?: unknown }).code === 'number'
        ? (err as unknown as { code: number }).code : err ? 1 : 0;
      resolve({ code, stdout: String(stdout), stderr: String(stderr) });
    });
  });
}

function row(): RequestRow {
  return {
    requestId: 'pricing-coverage-fixture', sessionId: null, tsEpochMs: Date.now(),
    provider: 'openai', model: 'gpt-5', project: 'fixture', taskWeight: 1,
    inputTokens: 100, outputTokens: 20, cacheWriteTokens: 0, cacheReadTokens: 0, reasoningTokens: 0,
    costUsd: 1.25, estimated: false, streamed: false, statusCode: 200, durationMs: 1,
    pricing: {
      costBasis: 'local_list_price', rateCardSha256: 'c'.repeat(64), rateCardSourceKind: 'bundled',
      rateMatchKind: 'exact_provider', rateMatchProvider: 'openai', rateMatchModel: 'gpt-5',
    },
  };
}

test('pricing --coverage is read-only and returns immutable local pricing provenance', async () => {
  const root = mkdtempSync(join(tmpdir(), 'fiscus-pricing-coverage-'));
  const dbPath = join(root, 'ledger.db');
  const home = join(root, 'home');
  const store = new Store(dbPath);
  store.insertRequest(row());
  store.close();
  try {
    const result = await runCli(['pricing', '--coverage', '--all', '--json'], dbPath, home);
    assert.equal(result.code, 0, result.stderr);
    const body = JSON.parse(result.stdout) as {
      window: { label: string };
      total: { costUsd: number; requests: number };
      provenance: Array<{ provider: string; model: string; rateCardSha256: string; rateMatchKind: string; costUsd: number }>;
      boundary: string;
    };
    assert.equal(body.window.label, 'all recorded time');
    assert.deepEqual(body.total, { costUsd: 1.25, requests: 1 });
    assert.deepEqual(body.provenance, [{
      provider: 'openai', model: 'gpt-5', costBasis: 'local_list_price', rateCardSha256: 'c'.repeat(64),
      rateCardSourceKind: 'bundled', rateMatchKind: 'exact_provider', rateMatchProvider: 'openai',
      rateMatchModel: 'gpt-5', requests: 1, costUsd: 1.25, estimatedCostUsd: 0, inputTokens: 100, outputTokens: 20,
    }]);
    assert.match(body.boundary, /does not fetch pricing, reprice history/i);
    assert.equal(result.stdout.includes('provider-billed'), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('pricing --coverage rejects a nonpositive --days window', async () => {
  const root = mkdtempSync(join(tmpdir(), 'fiscus-pricing-coverage-invalid-'));
  try {
    const result = await runCli(['pricing', '--coverage', '--days', '0', '--json'], join(root, 'ledger.db'), join(root, 'home'));
    assert.equal(result.code, 1);
    assert.match(result.stderr, /--days must be a positive number/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
