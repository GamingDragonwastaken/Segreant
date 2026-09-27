import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_CONFIG } from '../src/config.ts';
import { Store, type RequestRow } from '../src/store/db.ts';

const CLI = join(import.meta.dirname, '..', 'src', 'cli.ts');
const DAY_MS = 24 * 60 * 60 * 1000;

function runCli(
  args: string[],
  dbPath: string,
  home: string,
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [CLI, ...args],
      { env: { ...process.env, SEGREANT_DB: dbPath, SEGREANT_HOME: home, NODE_OPTIONS: '' } },
      (err, stdout, stderr) => {
        const code = err && typeof (err as NodeJS.ErrnoException & { code?: unknown }).code === 'number'
          ? (err as unknown as { code: number }).code
          : err
            ? 1
            : 0;
        resolve({ code, stdout: String(stdout), stderr: String(stderr) });
      },
    );
  });
}

function request(index: number, nowMs: number): RequestRow {
  return {
    requestId: `budget-recommend-${index}`,
    sessionId: null,
    tsEpochMs: nowMs - (index + 0.25) * DAY_MS,
    provider: 'openai',
    model: 'gpt-5',
    project: 'budget-gate-test',
    taskWeight: 1,
    inputTokens: 1,
    outputTokens: 1,
    cacheWriteTokens: 0,
    cacheReadTokens: 0,
    reasoningTokens: 0,
    costUsd: index + 3,
    estimated: false,
    streamed: false,
    statusCode: 200,
    durationMs: 1,
    via: 'proxy',
  };
}

test('budget recommendation apply fails closed without a DAL-3 certificate, while preview and manual caps remain usable', async () => {
  const root = mkdtempSync(join(tmpdir(), 'segreant-budget-recommend-gate-'));
  const home = join(root, 'home');
  const db = join(root, 'segreant.db');
  const configFile = join(home, 'config.json');
  mkdirSync(home, { recursive: true });

  const config = structuredClone(DEFAULT_CONFIG);
  config.budget.dailyUsd = 99;
  config.budget.dailySoftUsd = 88;
  const before = JSON.stringify(config, null, 2) + '\n';
  writeFileSync(configFile, before, 'utf8');

  const nowMs = Date.now();
  const store = new Store(db);
  try {
    for (let index = 0; index < 7; index++) store.insertRequest(request(index, nowMs));
  } finally {
    store.close();
  }

  try {
    const blocked = await runCli(['budget', '--recommend', '--apply'], db, home);
    assert.equal(blocked.code, 1, blocked.stdout + blocked.stderr);
    assert.match(blocked.stderr, /DecisionCertificate|DAL-3|changes spend/i);
    assert.doesNotMatch(blocked.stdout, /Applied:/i);
    assert.equal(readFileSync(configFile, 'utf8'), before, 'unsafe recommendation apply must not change caps');

    const unchangedStore = new Store(db);
    try {
      assert.equal(
        unchangedStore.requestsInRange(nowMs - 30 * DAY_MS, nowMs + 1000).length,
        7,
        'a refused cap application must not mutate spend rows',
      );
    } finally {
      unchangedStore.close();
    }

    const preview = await runCli(['budget', '--recommend', '--json'], db, home);
    assert.equal(preview.code, 0, preview.stderr);
    const previewPayload = JSON.parse(preview.stdout) as {
      recommendedDailyUsd: number | null;
      canApply: boolean;
    };
    assert.ok(previewPayload.recommendedDailyUsd !== null, 'seeded active days still produce a read-only recommendation');
    assert.equal(previewPayload.canApply, true, 'the pure recommendation remains eligible for explicit review');
    assert.equal(readFileSync(configFile, 'utf8'), before, 'read-only recommendation must not change caps');

    const manual = await runCli(['budget', '--daily', '12', '--soft', '9'], db, home);
    assert.equal(manual.code, 0, manual.stderr);
    const manuallyConfigured = JSON.parse(readFileSync(configFile, 'utf8')) as {
      budget: { dailyUsd: number; dailySoftUsd: number };
    };
    assert.equal(manuallyConfigured.budget.dailyUsd, 12);
    assert.equal(manuallyConfigured.budget.dailySoftUsd, 9);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
