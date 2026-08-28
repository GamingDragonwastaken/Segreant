import { test } from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store, type RequestRow } from '../src/store/db.ts';

function request(): RequestRow {
  return {
    requestId: 'backup-request-1',
    sessionId: null,
    tsEpochMs: 1_700_000_000_000,
    provider: 'openai',
    model: 'gpt-4o',
    project: 'backup-fixture',
    taskWeight: 1,
    inputTokens: 10,
    outputTokens: 5,
    cacheWriteTokens: 0,
    cacheReadTokens: 0,
    reasoningTokens: 0,
    costUsd: 0.00125,
    estimated: false,
    streamed: false,
    statusCode: 200,
    durationMs: 12,
  };
}

test('Store backup creates a verified snapshot and redacted manifest without changing the active ledger', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fiscus-backup-'));
  const source = join(dir, 'fiscus.db');
  const backup = join(dir, 'backups', 'snapshot.sqlite');
  const store = new Store(source);
  store.insertRequest(request());
  const before = store.summary(0, 2_000_000_000_000);
  const result = store.backupTo(backup);
  assert.equal(result.ok, true);
  assert.equal(result.integrity, 'ok');
  assert.match(result.sha256, /^[a-f0-9]{64}$/);
  assert.match(result.schemaFingerprint, /^sha256:[a-f0-9]{64}$/);
  assert.equal(result.bytes > 0, true);
  assert.equal(existsSync(backup), true);
  assert.equal(existsSync(`${backup}.manifest.json`), true);
  const manifest = JSON.parse(readFileSync(`${backup}.manifest.json`, 'utf8')) as Record<string, unknown>;
  assert.deepEqual(manifest.requiredTables, ['requests', 'sessions']);
  assert.equal('requestId' in manifest, false, 'manifest must not copy ledger rows');
  assert.equal('backup-fixture' in manifest, false, 'manifest must not copy project labels');
  assert.deepEqual(store.summary(0, 2_000_000_000_000), before);
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

test('Store restore preview is read-only and apply restores into a new verified path', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fiscus-restore-'));
  const source = join(dir, 'source.sqlite');
  const backup = join(dir, 'backup.sqlite');
  const restored = join(dir, 'restored.sqlite');
  const store = new Store(source);
  store.insertRequest(request());
  store.backupTo(backup);
  const sourceSummary = store.summary(0, 2_000_000_000_000);
  store.close();
  try {
    const preview = Store.inspectBackup(backup);
    assert.equal(preview.ok, true);
    assert.equal(existsSync(restored), false, 'preview must not create a destination');
    const result = Store.restoreBackup(backup, restored);
    assert.equal(result.ok, true);
    assert.equal(result.integrity, 'ok');
    const restoredStore = new Store(restored);
    assert.deepEqual(restoredStore.summary(0, 2_000_000_000_000), sourceSummary);
    restoredStore.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('backup inspection fails closed for a corrupt source', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fiscus-backup-corrupt-'));
  const source = join(dir, 'source.sqlite');
  const backup = join(dir, 'backup.sqlite');
  const store = new Store(source);
  store.insertRequest(request());
  store.backupTo(backup);
  store.close();
  try {
    writeFileSync(backup, Buffer.from('not a sqlite database'));
    const invalid = Store.inspectBackup(backup);
    assert.equal(invalid.ok, false);
    assert.match(invalid.reason ?? '', /integrity|sqlite|corrupt/i);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('restore refuses an existing destination without changing it', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fiscus-backup-existing-'));
  const source = join(dir, 'source.sqlite');
  const backup = join(dir, 'backup.sqlite');
  const existing = join(dir, 'existing.sqlite');
  const store = new Store(source);
  store.insertRequest(request());
  store.backupTo(backup);
  store.close();
  try {
    writeFileSync(existing, Buffer.from('sentinel'));
    const restore = Store.restoreBackup(backup, existing);
    assert.equal(restore.ok, false);
    assert.match(restore.reason ?? '', /exist|overwrite/i);
    assert.equal(String(readFileSync(existing)), 'sentinel');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('restore refuses a valid but manifestless SQLite file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fiscus-backup-manifestless-'));
  const source = join(dir, 'source.sqlite');
  const manual = join(dir, 'manual.sqlite');
  const destination = join(dir, 'restored.sqlite');
  const store = new Store(source);
  store.insertRequest(request());
  store.close();
  try {
    copyFileSync(source, manual);
    const inspection = Store.inspectBackup(manual);
    assert.equal(inspection.ok, true, 'read-only inspection may describe a compatible local database');
    assert.equal(inspection.manifestPresent, false);
    const restore = Store.restoreBackup(manual, destination);
    assert.equal(restore.ok, false);
    assert.match(restore.reason ?? '', /manifest|backup artifact/i);
    assert.equal(existsSync(destination), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('backup inspection fails closed when its manifest is tampered with', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fiscus-backup-manifest-'));
  const source = join(dir, 'source.sqlite');
  const backup = join(dir, 'backup.sqlite');
  const store = new Store(source);
  store.insertRequest(request());
  store.backupTo(backup);
  store.close();
  try {
    const manifestPath = `${backup}.manifest.json`;
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Record<string, unknown>;
    manifest.sha256 = '0'.repeat(64);
    writeFileSync(manifestPath, JSON.stringify(manifest));
    const invalid = Store.inspectBackup(backup);
    assert.equal(invalid.ok, false);
    assert.match(invalid.reason ?? '', /manifest|match/i);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('backup artifacts receive restrictive owner-only mode bits where supported', (t) => {
  if (process.platform === 'win32') {
    t.skip('Windows ACL inheritance does not expose POSIX mode bits; choose a private destination and review ACLs');
    return;
  }
  const dir = mkdtempSync(join(tmpdir(), 'fiscus-backup-mode-'));
  const source = join(dir, 'source.sqlite');
  const backup = join(dir, 'backup.sqlite');
  const store = new Store(source);
  store.backupTo(backup);
  store.close();
  try {
    assert.equal(statSync(backup).mode & 0o777, 0o600);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('backup and restore reject symlinked source and destination paths when supported', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'fiscus-backup-links-'));
  const source = join(dir, 'source.sqlite');
  const backup = join(dir, 'backup.sqlite');
  const sourceLink = join(dir, 'source-link.sqlite');
  const target = join(dir, 'target.sqlite');
  const destinationLink = join(dir, 'destination-link.sqlite');
  const store = new Store(source);
  store.insertRequest(request());
  store.backupTo(backup);
  store.close();
  try {
    try {
      symlinkSync(backup, sourceLink, 'file');
      writeFileSync(target, Buffer.from('sentinel'));
      symlinkSync(target, destinationLink, 'file');
    } catch (error) {
      t.skip(`symlink creation unavailable: ${error instanceof Error ? error.message : String(error)}`);
      return;
    }
    const sourceResult = Store.inspectBackup(sourceLink);
    assert.equal(sourceResult.ok, false);
    assert.match(sourceResult.reason ?? '', /regular|missing|symbolic/i);
    const destinationResult = Store.restoreBackup(backup, destinationLink);
    assert.equal(destinationResult.ok, false);
    assert.match(destinationResult.reason ?? '', /exist|overwrite/i);
    assert.equal(String(readFileSync(target)), 'sentinel');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
