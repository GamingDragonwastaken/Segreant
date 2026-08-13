import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CLI = join(import.meta.dirname, '..', 'src', 'cli.ts');
const FIXTURE = join(import.meta.dirname, 'fixtures', 'billing', 'openai-operator-export.v1.json');

function runCli(args: string[], dbPath: string): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [CLI, ...args],
      { env: { ...process.env, AEGIS_DB: dbPath, NODE_OPTIONS: '' } },
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
