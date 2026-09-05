/**
 * Local SQLite backup/restore helpers. A backup is a new sensitive artifact,
 * never an in-place replacement of the active ledger. The JSON sidecar carries
 * integrity metadata only; the SQLite file remains the evidence-bearing object.
 */

import { createHash, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import {
  closeSync,
  chmodSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { dirname, resolve } from 'node:path';
import { deserializeEconomicEvent, deserializeHistoricalRateObservation } from '../economics/serialization.ts';
import { CURRENT_SCHEMA_VERSION, readSchemaVersion } from './schema.ts';

const MANIFEST_VERSION = 1;
// These tables are created by the original on-disk schema and remain the
// minimum contract for a usable Fiscus ledger. Do not invent a metadata table
// here: compatibility is checked against the schema Fiscus actually owns.
const REQUIRED_TABLES = ['requests', 'sessions'] as const;

export interface BackupManifest {
  version: 1;
  kind: 'fiscus-ledger-backup';
  createdAt: string;
  bytes: number;
  sha256: string;
  schemaVersion: number;
  schemaFingerprint: string;
  requiredTables: readonly string[];
  restoredFromSha256?: string;
}

interface BackupInspectionFields {
  path: string;
  bytes: number;
  sha256: string | null;
  schemaVersion: number | null;
  schemaFingerprint: string | null;
  requiredTables: string[];
  manifestPath: string;
  manifestPresent: boolean;
}

export interface BackupSuccess extends BackupInspectionFields {
  ok: true;
  sha256: string;
  schemaFingerprint: string;
  integrity: 'ok';
}

export interface BackupFailure extends BackupInspectionFields {
  ok: false;
  reason: string;
}

export type BackupInspection = BackupSuccess | BackupFailure;
export type BackupResult = BackupSuccess | BackupFailure;

type OpenInspection = { bytes: number; sha256: string; schemaVersion: number; schemaFingerprint: string; tables: string[] };

function isFailure(value: OpenInspection | BackupFailure): value is BackupFailure {
  return 'ok' in value && value.ok === false;
}

function manifestPath(databasePath: string): string {
  return `${databasePath}.manifest.json`;
}

/** lstat-based existence check: unlike existsSync, it also sees broken links. */
function pathEntryExists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

function failure(path: string, reason: string, extra: Partial<BackupInspection> = {}): BackupFailure {
  return {
    ok: false,
    path,
    bytes: extra.bytes ?? 0,
    sha256: extra.sha256 ?? null,
    schemaVersion: extra.schemaVersion ?? null,
    schemaFingerprint: extra.schemaFingerprint ?? null,
    requiredTables: extra.requiredTables ?? [],
    manifestPath: manifestPath(path),
    manifestPresent: extra.manifestPresent ?? pathEntryExists(manifestPath(path)),
    reason,
  };
}

function regularFile(path: string): boolean {
  try {
    const stat = lstatSync(path);
    return stat.isFile() && !stat.isSymbolicLink();
  } catch {
    return false;
  }
}

function sha256File(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function schemaFingerprint(db: DatabaseSync): { fingerprint: string; tables: string[] } {
  const rows = db.prepare(
    `SELECT type, name, tbl_name, sql
       FROM sqlite_master
      WHERE type IN ('table', 'index', 'trigger', 'view')
      ORDER BY type, name, tbl_name, sql`,
  ).all() as Array<{ type: string; name: string; tbl_name: string; sql: string | null }>;
  const tables = rows.filter((row) => row.type === 'table').map((row) => row.name).sort();
  const canonical = JSON.stringify(rows);
  return { fingerprint: `sha256:${createHash('sha256').update(canonical, 'utf8').digest('hex')}`, tables };
}

function tableExists(db: DatabaseSync, table: string): boolean {
  const row = db.prepare("SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = ?").get(table) as { present?: unknown } | undefined;
  return row?.present === 1;
}

/** Verify canonical payload digests that a whole-file hash cannot validate. */
function storedPayloadIntegrity(db: DatabaseSync): string | null {
  if (tableExists(db, 'economic_events')) {
    const rows = db.prepare(
      'SELECT event_id, event_kind, subject, occurred_at, recorded_at, event_json, event_digest FROM economic_events ORDER BY event_id ASC',
    ).all() as Array<{ event_id: string; event_kind: string; subject: string; occurred_at: string; recorded_at: string; event_json: string; event_digest: string }>;
    for (const row of rows) {
      try {
        const parsed = JSON.parse(row.event_json) as { schemaVersion?: unknown; id?: unknown };
        const item = deserializeEconomicEvent({
          kind: 'economic_event',
          schemaVersion: parsed.schemaVersion as number,
          id: parsed.id as string,
          body: row.event_json,
          digest: row.event_digest,
        });
        if (item.id !== row.event_id || item.kind !== row.event_kind || item.subject !== row.subject
            || item.occurredAt !== row.occurred_at || item.recordedAt !== row.recorded_at) {
          return `stored economic event ${row.event_id} failed physical identity verification`;
        }
      } catch (error) {
        return `stored economic event ${row.event_id} failed integrity verification: ${error instanceof Error ? error.message : String(error)}`;
      }
    }
  }
  if (tableExists(db, 'economic_fx_rate_observations')) {
    const rows = db.prepare(
      'SELECT observation_id, recorded_at, supersedes_id, observation_json, observation_digest FROM economic_fx_rate_observations ORDER BY recorded_at ASC, observation_id ASC',
    ).all() as Array<{ observation_id: string; recorded_at: string; supersedes_id: string | null; observation_json: string; observation_digest: string }>;
    for (const row of rows) {
      try {
        const item = deserializeHistoricalRateObservation({
          kind: 'historical_fx_rate_observation',
          schemaVersion: 1,
          id: row.observation_id,
          body: row.observation_json,
          digest: row.observation_digest,
        });
        if (item.id !== row.observation_id || item.recordedAt !== row.recorded_at || item.supersedes !== row.supersedes_id) {
          return `stored historical FX observation ${row.observation_id} failed physical identity verification`;
        }
      } catch (error) {
        return `stored historical FX observation ${row.observation_id} failed integrity verification: ${error instanceof Error ? error.message : String(error)}`;
      }
    }
  }
  return null;
}

function inspectOpenDatabase(path: string): OpenInspection | BackupFailure {
  if (!regularFile(path)) return failure(path, 'backup path is missing or is not a regular file');
  let db: DatabaseSync | null = null;
  try {
    const stat = statSync(path);
    db = new DatabaseSync(path, { readOnly: true });
    const schemaVersion = readSchemaVersion(db);
    if (schemaVersion > CURRENT_SCHEMA_VERSION) {
      return failure(path, `backup schema version ${schemaVersion} is newer than supported version ${CURRENT_SCHEMA_VERSION}`, {
        bytes: stat.size,
        schemaVersion,
      });
    }
    const quick = db.prepare('PRAGMA quick_check').get() as { quick_check?: unknown } | undefined;
    if (quick?.quick_check !== 'ok') return failure(path, 'SQLite quick_check did not return ok', { bytes: stat.size });
    const foreign = db.prepare('PRAGMA foreign_key_check').all();
    if (foreign.length > 0) return failure(path, 'SQLite foreign_key_check reported violations', { bytes: stat.size });
    const payloadError = storedPayloadIntegrity(db);
    if (payloadError) return failure(path, payloadError, { bytes: stat.size, schemaVersion });
    const fingerprint = schemaFingerprint(db);
    const missing = REQUIRED_TABLES.filter((table) => !fingerprint.tables.includes(table));
    if (missing.length > 0) return failure(path, `backup is missing required table(s): ${missing.join(', ')}`, {
      bytes: stat.size,
      sha256: sha256File(path),
      schemaFingerprint: fingerprint.fingerprint,
      requiredTables: [...REQUIRED_TABLES],
    });
    return { bytes: stat.size, sha256: sha256File(path), schemaVersion, schemaFingerprint: fingerprint.fingerprint, tables: fingerprint.tables };
  } catch (error) {
    return failure(path, `backup integrity check failed: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    try { db?.close(); } catch { /* preserve the inspection result */ }
  }
}

function writeManifest(path: string, inspected: { bytes: number; sha256: string; schemaVersion: number; schemaFingerprint: string; tables: string[] }, restoredFromSha256?: string): string {
  const target = manifestPath(path);
  const manifest: BackupManifest = {
    version: MANIFEST_VERSION,
    kind: 'fiscus-ledger-backup',
    createdAt: new Date().toISOString(),
    bytes: inspected.bytes,
    sha256: inspected.sha256,
    schemaVersion: inspected.schemaVersion,
    schemaFingerprint: inspected.schemaFingerprint,
    requiredTables: [...REQUIRED_TABLES],
    ...(restoredFromSha256 ? { restoredFromSha256 } : {}),
  };
  const temp = `${target}.tmp-${randomUUID()}`;
  let fd: number | null = null;
  try {
    fd = openSync(temp, 'wx', 0o600);
    const bytes = Buffer.from(JSON.stringify(manifest, null, 2) + '\n', 'utf8');
    try {
      let offset = 0;
      while (offset < bytes.length) {
        const written = writeSync(fd, bytes, offset, bytes.length - offset, null);
        if (written <= 0) throw new Error('manifest wrote no bytes');
        offset += written;
      }
      fsyncSync(fd);
    } finally {
      bytes.fill(0);
    }
    closeSync(fd);
    fd = null;
    renameSync(temp, target);
    return target;
  } catch (error) {
    if (fd !== null) {
      try { closeSync(fd); } catch { /* preserve original error */ }
    }
    try { unlinkSync(temp); } catch { /* no residue is best effort */ }
    throw error;
  }
}

function verifyManifest(path: string, inspected: { bytes: number; sha256: string; schemaVersion: number; schemaFingerprint: string }): string | null {
  const target = manifestPath(path);
  if (!pathEntryExists(target)) return null;
  try {
    if (!regularFile(target)) return 'backup manifest is not a regular file';
    const raw = JSON.parse(readFileSync(target, 'utf8')) as Partial<BackupManifest>;
    if (raw.version !== 1 || raw.kind !== 'fiscus-ledger-backup') return 'backup manifest has an unsupported version or kind';
    if (raw.bytes !== inspected.bytes || raw.sha256 !== inspected.sha256
        || (raw.schemaVersion !== undefined && raw.schemaVersion !== inspected.schemaVersion)
        || raw.schemaFingerprint !== inspected.schemaFingerprint) {
      return 'backup manifest does not match the SQLite artifact';
    }
    if (!Array.isArray(raw.requiredTables) || raw.requiredTables.length !== REQUIRED_TABLES.length || !REQUIRED_TABLES.every((table) => raw.requiredTables?.includes(table))) {
      return 'backup manifest required-table contract is incomplete';
    }
    return null;
  } catch (error) {
    return `backup manifest could not be read: ${error instanceof Error ? error.message : String(error)}`;
  }
}

export function inspectBackup(databasePath: string): BackupResult {
  const path = resolve(databasePath);
  const inspected = inspectOpenDatabase(path);
  if (isFailure(inspected)) return inspected;
  const manifestError = verifyManifest(path, inspected);
  if (manifestError) return failure(path, manifestError, {
    bytes: inspected.bytes,
    sha256: inspected.sha256,
    schemaVersion: inspected.schemaVersion,
    schemaFingerprint: inspected.schemaFingerprint,
    requiredTables: [...REQUIRED_TABLES],
  });
  return {
    ok: true,
    path,
    bytes: inspected.bytes,
    sha256: inspected.sha256,
    schemaVersion: inspected.schemaVersion,
    schemaFingerprint: inspected.schemaFingerprint,
    requiredTables: [...REQUIRED_TABLES],
    manifestPath: manifestPath(path),
    manifestPresent: pathEntryExists(manifestPath(path)),
    integrity: 'ok',
  };
}

export function backupDatabase(db: DatabaseSync, sourcePath: string, destinationPath: string): BackupResult {
  if (sourcePath === ':memory:') return failure(destinationPath, 'an in-memory Store cannot be backed up');
  const source = resolve(sourcePath);
  const destination = resolve(destinationPath);
  if (!regularFile(source)) return failure(destination, 'active database is missing or is not a regular file');
  if (pathEntryExists(destination)) return failure(destination, 'backup destination already exists; refusing to overwrite it');
  if (pathEntryExists(manifestPath(destination))) return failure(destination, 'backup manifest destination already exists; refusing to overwrite it');
  try {
    mkdirSync(dirname(destination), { recursive: true });
    db.prepare('PRAGMA quick_check').get();
    db.prepare('VACUUM INTO ?').run(destination);
    chmodSync(destination, 0o600);
    const inspected = inspectOpenDatabase(destination);
    if (isFailure(inspected)) {
      try { rmSync(destination, { force: true }); } catch { /* retain the error boundary */ }
      return inspected;
    }
    writeManifest(destination, inspected);
    return { ok: true, path: destination, bytes: inspected.bytes, sha256: inspected.sha256, schemaVersion: inspected.schemaVersion, schemaFingerprint: inspected.schemaFingerprint, requiredTables: [...REQUIRED_TABLES], manifestPath: manifestPath(destination), manifestPresent: true, integrity: 'ok' };
  } catch (error) {
    try { rmSync(destination, { force: true }); } catch { /* no residue is best effort */ }
    return failure(destination, `backup failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export function restoreDatabase(sourcePath: string, destinationPath: string): BackupResult {
  const source = resolve(sourcePath);
  const destination = resolve(destinationPath);
  const inspectedSource = inspectBackup(source);
  if (!inspectedSource.ok) return failure(destination, `source backup is invalid: ${inspectedSource.reason}`);
  if (!inspectedSource.manifestPresent) return failure(destination, 'source backup is missing its integrity manifest; use a Fiscus-created backup artifact');
  if (pathEntryExists(destination)) return failure(destination, 'restore destination already exists; refusing to overwrite it');
  if (pathEntryExists(manifestPath(destination))) return failure(destination, 'restore manifest destination already exists; refusing to overwrite it');
  let db: DatabaseSync | null = null;
  try {
    mkdirSync(dirname(destination), { recursive: true });
    db = new DatabaseSync(source, { readOnly: true });
    db.prepare('VACUUM INTO ?').run(destination);
    chmodSync(destination, 0o600);
    const inspected = inspectOpenDatabase(destination);
    if (isFailure(inspected)) {
      try { rmSync(destination, { force: true }); } catch { /* retain the error boundary */ }
      return inspected;
    }
    writeManifest(destination, inspected, inspectedSource.sha256);
    return { ok: true, path: destination, bytes: inspected.bytes, sha256: inspected.sha256, schemaVersion: inspected.schemaVersion, schemaFingerprint: inspected.schemaFingerprint, requiredTables: [...REQUIRED_TABLES], manifestPath: manifestPath(destination), manifestPresent: true, integrity: 'ok' };
  } catch (error) {
    try { rmSync(destination, { force: true }); } catch { /* no residue is best effort */ }
    return failure(destination, `restore failed: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    try { db?.close(); } catch { /* preserve the result */ }
  }
}
