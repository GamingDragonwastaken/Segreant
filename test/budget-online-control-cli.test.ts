import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_CONFIG } from '../src/config.ts';
import { Store, type RequestRow } from '../src/store/db.ts';

const CLI = join(import.meta.dirname, '..', 'src', 'cli.ts');
const DAY_MS = 24 * 60 * 60 * 1000;

function runCli(args: string[], dbPath: string, home: string, cwd: string): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [CLI, ...args],
      { cwd, env: { ...process.env, FISCUS_DB: dbPath, FISCUS_HOME: home, NODE_OPTIONS: '' } },
      (err, stdout, stderr) => {
        const code = err && typeof (err as NodeJS.ErrnoException & { code?: unknown }).code === 'number'
          ? (err as unknown as { code: number }).code
          : err ? 1 : 0;
        resolve({ code, stdout: String(stdout), stderr: String(stderr) });
      },
    );
  });
}

function request(index: number, nowMs: number): RequestRow {
  return {
    requestId: `control-${index}`,
    sessionId: null,
    tsEpochMs: nowMs - (index + 1) * DAY_MS,
    provider: 'openai',
    model: 'gpt-5',
    project: 'control-test',
    taskWeight: 1,
    inputTokens: 1,
    outputTokens: 1,
    cacheWriteTokens: 0,
    cacheReadTokens: 0,
    reasoningTokens: 0,
    costUsd: 5 + index,
    estimated: false,
    streamed: false,
    statusCode: 200,
    durationMs: 1,
    via: 'proxy',
  };
}

test('budget --control is a real fail-closed product route with durable policy state and audit', async () => {
  const root = mkdtempSync(join(tmpdir(), 'fiscus-budget-control-cli-'));
  const home = join(root, 'home');
  const db = join(root, 'fiscus.db');
  const policyPath = join(root, 'policy.json');
  mkdirSync(home, { recursive: true });

  const config = structuredClone(DEFAULT_CONFIG);
  config.budget.dailyUsd = 100;
  config.budget.dailySoftUsd = 80;
  config.budget.runawayMaxUsd = 5;
  writeFileSync(join(home, 'config.json'), JSON.stringify(config, null, 2) + '\n');

  writeFileSync(policyPath, JSON.stringify({
    id: 'budget-control:daily',
    version: 1,
    issuedAt: '2020-01-01T00:00:00.000Z',
    expiresAt: '2099-01-01T00:00:00.000Z',
    enabled: true,
    safeBaselineDailyUsd: 100,
    minDailyUsd: 5,
    maxDailyUsd: 100,
    maxRelativeStep: 0.95,
    explorationRateCap: 0,
    maxRunawayUsd: 10,
  }, null, 2) + '\n');

  const store = new Store(db);
  const nowMs = Date.now();
  try {
    for (let index = 0; index < 8; index += 1) store.insertRequest(request(index, nowMs));
  } finally {
    store.close();
  }

  try {
    const preview = await runCli(['budget', '--control', '--policy', policyPath, '--json'], db, home, root);
    assert.equal(preview.code, 0, preview.stdout + preview.stderr);
    const previewPayload = JSON.parse(preview.stdout) as { applied: boolean; target: string; plan: { action: string } };
    assert.equal(previewPayload.applied, false);
    assert.equal(previewPayload.target, 'budget.dailyUsd');
    assert.equal(previewPayload.plan.action, 'no_action', 'ordinary observational inputs must not cross the spend-change gate');
    assert.equal(readFileSync(join(home, 'config.json'), 'utf8'), JSON.stringify(config, null, 2) + '\n');

    const applied = await runCli(['budget', '--control', '--policy', policyPath, '--apply', '--json'], db, home, root);
    assert.equal(applied.code, 0, applied.stdout + applied.stderr);
    const payload = JSON.parse(applied.stdout) as {
      applied: boolean;
      plan: { action: string; reasons: string[] };
      state: { phase: string; policyId: string };
      auditHead: string | null;
    };
    assert.equal(payload.applied, false, 'review-only evidence must still produce no spend mutation');
    assert.equal(payload.plan.action, 'no_action');
    assert.ok(payload.plan.reasons.some((reason) => /DecisionCertificate|assurance/i.test(reason)));
    assert.equal(payload.state.phase, 'armed');
    assert.equal(payload.state.policyId, 'budget-control:daily');
    assert.match(payload.auditHead ?? '', /^[0-9a-f]{64}$/);

    const persisted = JSON.parse(readFileSync(join(home, 'config.json'), 'utf8') as string) as typeof config;
    assert.equal(persisted.budget.dailyUsd, 100, 'fail-closed controller must leave the live cap at its baseline');
    const state = JSON.parse(readFileSync(join(home, 'budget-control-state.json'), 'utf8') as string) as { phase: string };
    assert.equal(state.phase, 'armed');
    const auditLines = readFileSync(join(home, 'budget-control-audit.jsonl'), 'utf8').trim().split(/\r?\n/);
    assert.equal(auditLines.length, 1);
    assert.equal(JSON.parse(auditLines[0]!).action, 'no_action');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});


test('budget --control rejects an oversized policy before parsing or mutation', async () => {
  const root = mkdtempSync(join(tmpdir(), 'fiscus-budget-control-policy-limit-'));
  const home = join(root, 'home');
  const db = join(root, 'fiscus.db');
  const policyPath = join(root, 'oversized-policy.json');
  mkdirSync(home, { recursive: true });
  const config = structuredClone(DEFAULT_CONFIG);
  config.budget.dailyUsd = 100;
  writeFileSync(join(home, 'config.json'), JSON.stringify(config, null, 2) + '\n');
  // Valid JSON whitespace after a tiny object: the resource limit, not parsing,
  // must be the first boundary reached.
  writeFileSync(policyPath, '{}' + ' '.repeat(70 * 1024));
  try {
    const result = await runCli(['budget', '--control', '--policy', policyPath, '--apply', '--json'], db, home, root);
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /resource limit|budget_control_policy_bytes/i);
    const persisted = JSON.parse(readFileSync(join(home, 'config.json'), 'utf8') as string) as typeof config;
    assert.equal(persisted.budget.dailyUsd, 100);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
