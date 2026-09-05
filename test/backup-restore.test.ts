import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { money } from '../src/economics/money.ts';
import { backupDatabase } from '../src/store/backup.ts';
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

function rewriteManifestForArtifact(path: string, updates: Record<string, unknown> = {}): void {
  const manifestPath = `${path}.manifest.json`;
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Record<string, unknown>;
  const bytes = readFileSync(path);
  try {
    writeFileSync(manifestPath, JSON.stringify({
      ...manifest,
      bytes: statSync(path).size,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      ...updates,
    }) + '\n');
  } finally {
    bytes.fill(0);
  }
}

test('restore refuses a manifest-consistent backup with a corrupted economic payload before publishing', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fiscus-backup-economic-corrupt-'));
  const source = join(dir, 'source.sqlite');
  const backup = join(dir, 'backup.sqlite');
  const restored = join(dir, 'restored.sqlite');
  const store = new Store(source);
  store.insertRequest({ ...request(), economicAmount: money('0.00125', 'USD', 'list') });
  assert.equal(store.backupTo(backup).ok, true);
  store.close();
  try {
    const corrupted = new DatabaseSync(backup);
    try {
      const row = corrupted.prepare('SELECT event_id, event_json FROM economic_events LIMIT 1').get() as { event_id: string; event_json: string } | undefined;
      assert.ok(row);
      const eventJson = row.event_json.replace('backup-fixture', 'corrupted-project');
      assert.notEqual(eventJson, row.event_json);
      corrupted.prepare('DROP TRIGGER economic_events_append_only_update').run();
      corrupted.prepare('UPDATE economic_events SET event_json = ? WHERE event_id = ?').run(eventJson, row.event_id);
      corrupted.prepare(
        "CREATE TRIGGER economic_events_append_only_update BEFORE UPDATE ON economic_events BEGIN SELECT RAISE(ABORT, 'economic event ledger is append-only'); END",
      ).run();
    } finally {
      corrupted.close();
    }
    // Model a writer that emitted an internally matching artifact hash while
    // leaving the append-only payload digest stale. The backup must still refuse.
    rewriteManifestForArtifact(backup);
    const result = Store.restoreBackup(backup, restored);
    assert.equal(result.ok, false);
    assert.match(result.reason ?? '', /digest|payload|integrity|corrupt/i);
    assert.equal(existsSync(restored), false, 'corrupt history must not publish a destination');
    assert.equal(existsSync(backup), true, 'the source evidence must remain available for recovery');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('restore rejects an incompatible newer schema version without writing a destination', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fiscus-backup-newer-schema-'));
  const source = join(dir, 'source.sqlite');
  const backup = join(dir, 'backup.sqlite');
  const restored = join(dir, 'restored.sqlite');
  const store = new Store(source);
  store.insertRequest(request());
  assert.equal(store.backupTo(backup).ok, true);
  store.close();
  try {
    const future = new DatabaseSync(backup);
    try {
      future.prepare('PRAGMA user_version = 999').run();
    } finally {
      future.close();
    }
    rewriteManifestForArtifact(backup, { schemaVersion: 999 });
    const result = Store.restoreBackup(backup, restored);
    assert.equal(result.ok, false);
    assert.match(result.reason ?? '', /newer|schema|unsupported/i);
    assert.equal(existsSync(restored), false);
    assert.equal(existsSync(backup), true, 'an incompatible source must remain untouched');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a verified old-schema backup restores and migrates append-only data without losing the legacy row', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fiscus-backup-old-schema-'));
  const legacyPath = join(dir, 'legacy.sqlite');
  const backup = join(dir, 'backup.sqlite');
  const restored = join(dir, 'restored.sqlite');
  const legacy = new DatabaseSync(legacyPath);
  legacy.prepare(`CREATE TABLE sessions (
    session_id TEXT PRIMARY KEY NOT NULL, project TEXT NOT NULL DEFAULT 'default', tool TEXT NOT NULL DEFAULT 'unknown',
    start_ms INTEGER NOT NULL, end_ms INTEGER, status TEXT NOT NULL DEFAULT 'active'
  )`).run();
  legacy.prepare(`CREATE TABLE requests (
    request_id TEXT PRIMARY KEY NOT NULL, session_id TEXT, ts_iso TEXT NOT NULL, ts_epoch_ms INTEGER NOT NULL,
    provider TEXT NOT NULL, model TEXT NOT NULL, project TEXT NOT NULL DEFAULT 'default', task_weight REAL NOT NULL DEFAULT 1.0,
    input_tokens INTEGER NOT NULL DEFAULT 0, output_tokens INTEGER NOT NULL DEFAULT 0, cache_write_tokens INTEGER NOT NULL DEFAULT 0,
    cache_read_tokens INTEGER NOT NULL DEFAULT 0, reasoning_tokens INTEGER NOT NULL DEFAULT 0, cost_usd REAL NOT NULL DEFAULT 0,
    estimated INTEGER NOT NULL DEFAULT 0, streamed INTEGER NOT NULL DEFAULT 0, status_code INTEGER, duration_ms INTEGER
  )`).run();
  legacy.prepare('INSERT INTO sessions (session_id, start_ms) VALUES (?, ?)').run('legacy-session', 1_700_000_000_000);
  legacy.prepare(`INSERT INTO requests (
    request_id, session_id, ts_iso, ts_epoch_ms, provider, model, project, task_weight, input_tokens, output_tokens,
    cache_write_tokens, cache_read_tokens, reasoning_tokens, cost_usd, estimated, streamed, status_code, duration_ms
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    'legacy-request', 'legacy-session', '2023-11-14T22:13:20.000Z', 1_700_000_000_000,
    'openai', 'gpt-4o', 'legacy-project', 1, 10, 5, 0, 0, 0, 0.00125, 0, 0, 200, 12,
  );
  legacy.close();
  try {
    const sourceHandle = new DatabaseSync(legacyPath);
    try {
      const result = backupDatabase(sourceHandle, legacyPath, backup);
      assert.equal(result.ok, true);
      if (result.ok) assert.equal((result as unknown as { schemaVersion?: number }).schemaVersion, 0);
    } finally {
      sourceHandle.close();
    }
    assert.equal(Store.restoreBackup(backup, restored).ok, true);
    const migrated = new Store(restored);
    try {
      const retained = migrated.raw().prepare(
        'SELECT request_id, project, via, attribution_basis, capture_coverage FROM requests WHERE request_id = ?',
      ).get('legacy-request') as { request_id: string; project: string; via: string; attribution_basis: string; capture_coverage: string } | undefined;
      assert.deepEqual({ ...retained }, {
        request_id: 'legacy-request',
        project: 'legacy-project',
        via: 'proxy',
        attribution_basis: 'legacy_unknown',
        capture_coverage: 'legacy_unknown',
      });
      const version = migrated.raw().prepare('PRAGMA user_version').get() as { user_version: number };
      assert.equal(version.user_version, 1);
    } finally {
      migrated.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a legacy manifest without schemaVersion remains inspectable using the database version', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fiscus-backup-legacy-manifest-'));
  const source = join(dir, 'source.sqlite');
  const backup = join(dir, 'backup.sqlite');
  const store = new Store(source);
  store.insertRequest(request());
  assert.equal(store.backupTo(backup).ok, true);
  store.close();
  try {
    const manifestPath = `${backup}.manifest.json`;
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Record<string, unknown>;
    delete manifest.schemaVersion;
    writeFileSync(manifestPath, JSON.stringify(manifest) + '\n');
    const inspected = Store.inspectBackup(backup);
    assert.equal(inspected.ok, true);
    if (inspected.ok) assert.equal(inspected.schemaVersion, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
