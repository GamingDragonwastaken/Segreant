import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CLI = join(import.meta.dirname, '..', 'src', 'cli.ts');
const FIXTURE = join(import.meta.dirname, 'fixtures', 'billing', 'openai-operator-export.v1.json');

function runCli(args: string[], dbPath: string, home?: string): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [CLI, ...args],
      { env: { ...process.env, AEGIS_DB: dbPath, ...(home ? { AEGIS_HOME: home } : {}), NODE_OPTIONS: '' } },
      (err, stdout, stderr) => {
        const code = err && typeof (err as NodeJS.ErrnoException & { code?: unknown }).code === 'number'
          ? ((err as unknown as { code: number }).code)
          : err ? 1 : 0;
        resolve({ code, stdout: String(stdout), stderr: String(stderr) });
      },
    );
  });
}

test('billing CLI dry-runs by default, applies only with --apply, and exports a separate evidence ledger', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'fiscus-billing-cli-'));
  const db = join(dir, 'fiscus.db');
  try {
    const dry = await runCli(['billing', 'import', '--file', FIXTURE, '--json'], db);
    assert.equal(dry.code, 0, dry.stderr);
    const dryPayload = JSON.parse(dry.stdout) as { applied: boolean; preview: { reconciliationStatus: string; recordsSeen: number } };
    assert.equal(dryPayload.applied, false);
    assert.equal(dryPayload.preview.recordsSeen, 2);
    assert.equal(dryPayload.preview.reconciliationStatus, 'not_reconciled');

    const apply = await runCli(['billing', 'import', '--file', FIXTURE, '--apply', '--json'], db);
    assert.equal(apply.code, 0, apply.stderr);
    const appliedPayload = JSON.parse(apply.stdout) as { applied: boolean; duplicateFile: boolean; run: { recordsInserted: number } };
    assert.equal(appliedPayload.applied, true);
    assert.equal(appliedPayload.duplicateFile, false);
    assert.equal(appliedPayload.run.recordsInserted, 2);

    const replay = await runCli(['billing', 'import', '--file', FIXTURE, '--apply', '--json'], db);
    assert.equal(replay.code, 0, replay.stderr);
    assert.equal((JSON.parse(replay.stdout) as { duplicateFile: boolean }).duplicateFile, true);

    const status = await runCli(['billing', 'status', '--json'], db);
    assert.equal(status.code, 0, status.stderr);
    const statusPayload = JSON.parse(status.stdout) as { summary: { recordCount: number; reconciliationStatus: string } };
    assert.equal(statusPayload.summary.recordCount, 2);
    assert.equal(statusPayload.summary.reconciliationStatus, 'not_reconciled');

    const exported = await runCli(['billing', 'export', '--json'], db);
    assert.equal(exported.code, 0, exported.stderr);
    const exportPayload = JSON.parse(exported.stdout) as { summary: { recordCount: number }; records: unknown[] };
    assert.equal(exportPayload.summary.recordCount, 2);
    assert.equal(exportPayload.records.length, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('billing scope is an explicit local declaration and changes only on --apply', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'fiscus-billing-scope-cli-'));
  const db = join(dir, 'fiscus.db');
  try {
    const preview = await runCli(['billing', 'scope', 'set', '--account-ref', 'finops-test', '--json'], db, join(dir, 'home'));
    assert.equal(preview.code, 0, preview.stderr);
    const previewPayload = JSON.parse(preview.stdout) as { applied: boolean; preview: { trust: string; upstreamDisplay: string } };
    assert.equal(previewPayload.applied, false);
    assert.equal(previewPayload.preview.trust, 'operator_declared_unverified');
    assert.equal(previewPayload.preview.upstreamDisplay, 'https://api.openai.com');

    const before = await runCli(['billing', 'scope', 'status', '--json'], db);
    assert.equal((JSON.parse(before.stdout) as { active: unknown }).active, null);

    const apply = await runCli(['billing', 'scope', 'set', '--account-ref', 'finops-test', '--project-ref', 'proj_local', '--apply', '--json'], db, join(dir, 'home'));
    assert.equal(apply.code, 0, apply.stderr);
    const appliedPayload = JSON.parse(apply.stdout) as { applied: boolean; declaration: { trust: string; billingAccountRef: string } };
    assert.equal(appliedPayload.applied, true);
    assert.equal(appliedPayload.declaration.trust, 'operator_declared_unverified');
    assert.equal(appliedPayload.declaration.billingAccountRef, 'finops-test');

    const clear = await runCli(['billing', 'scope', 'clear', '--apply', '--json'], db);
    assert.equal(clear.code, 0, clear.stderr);
    assert.equal((JSON.parse(clear.stdout) as { cleared: boolean }).cleared, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
