/** Versioned, redacted local diagnostics for support and resumable handoff. */

import { createHash, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import {
  closeSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  renameSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { dirname, relative, resolve, sep } from 'node:path';
import { performance } from 'node:perf_hooks';
import {
  baselineManifestStatus,
  type BaselineManifestStatus,
} from './value/liftBaseline.ts';
import {
  configPath,
  dbPath,
  fiscusHome,
  loadConfig,
  type FiscusConfig,
} from './config.ts';
import { pricingStatus, type PricingStatus } from './cost/pricing.ts';
import { egressReceiptPath, verifyEgressReceipts, type ReceiptVerification } from './egress/receipts.ts';
import { Store, type BackupResult } from './store/db.ts';
import { packageVersion } from './version.ts';

export interface DiagnosticObservation {
  operationId: string;
  name: string;
  status: 'ok' | 'error';
  durationMs: number;
  errorClass?: string;
}

export interface RedactedDiagnosticBundle {
  version: 1;
  operationId: string;
  generatedAt: string;
  runtime: { fiscusVersion: string; node: string; platform: string; arch: string };
  boundaries: { externalNetworkAttempted: false; credentialRead: false; rawPromptSourceOrLedgerRowsExported: false };
  config: {
    valid: boolean;
    path: string;
    budget?: { dailyCapConfigured: boolean; softCapConfigured: boolean; sessionCapConfigured: boolean; includesImported: boolean };
    egress?: { mode: FiscusConfig['egress']['mode']; ruleCount: number; rules: Array<{ id: string; purpose: string; dataClass: string; method: string; enabled: boolean }> };
    metadataOnly?: boolean;
    errorClass?: string;
  };
  database: {
    path: string;
    status: 'ok' | 'error';
    bytes: number | null;
    sha256: string | null;
    schemaFingerprint: string | null;
    schemaVersion: number | null;
    tableCount: number | null;
    migrationState: 'read_only_schema_inspected' | 'unavailable';
    requiredTables: string[];
    manifestPresent: boolean;
    errorClass?: string;
  };
  egress: {
    path: string;
    status: 'ok' | 'error';
    receiptCount: number;
    validThroughHash: string | null;
    errors: string[];
  };
  pricing: { status: PricingStatus | null; baseline: BaselineManifestStatus | null };
  resources: { rssBytes: number; heapUsedBytes: number };
  observations: DiagnosticObservation[];
}

function errorClass(error: unknown): string {
  return error instanceof Error && error.constructor?.name ? error.constructor.name : 'Error';
}

function pathEntryExists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

/** Keep useful local layout while never exporting the user's absolute path. */
export function redactDiagnosticPath(path: string): string {
  const absolute = resolve(path);
  const home = resolve(fiscusHome());
  const prefix = home.endsWith(sep) ? home : home + sep;
  if (absolute.toLowerCase() === home.toLowerCase()) return '<FISCUS_HOME>';
  if (absolute.toLowerCase().startsWith(prefix.toLowerCase())) {
    const suffix = relative(home, absolute).replaceAll('\\', '/');
    return `<FISCUS_HOME>/${suffix}`;
  }
  const digest = createHash('sha256').update(absolute, 'utf8').digest('hex').slice(0, 16);
  return `<PATH:${digest}>`;
}

function observe<T>(observations: DiagnosticObservation[], name: string, fn: () => T): T | null {
  const operationId = randomUUID();
  const started = performance.now();
  try {
    const result = fn();
    observations.push({ operationId, name, status: 'ok', durationMs: Math.max(0, performance.now() - started) });
    return result;
  } catch (error) {
    observations.push({ operationId, name, status: 'error', durationMs: Math.max(0, performance.now() - started), errorClass: errorClass(error) });
    return null;
  }
}

interface ConfigObservation {
  view: RedactedDiagnosticBundle['config'];
  value: FiscusConfig | null;
}

function configObservation(observations: DiagnosticObservation[]): ConfigObservation {
  const path = configPath();
  const config = observe(observations, 'config.load', () => loadConfig());
  if (config === null) {
    const last = observations.at(-1);
    return {
      value: null,
      view: { valid: false, path: redactDiagnosticPath(path), errorClass: last?.errorClass ?? 'Error' },
    };
  }
  return {
    value: config,
    view: {
      valid: true,
      path: redactDiagnosticPath(path),
      budget: {
        dailyCapConfigured: config.budget.dailyUsd !== null,
        softCapConfigured: config.budget.dailySoftUsd !== null,
        sessionCapConfigured: config.budget.sessionUsd !== null,
        includesImported: config.budget.capIncludesImported,
      },
      egress: {
        mode: config.egress.mode,
        ruleCount: config.egress.rules.length,
        rules: config.egress.rules.map((rule) => ({
          id: rule.id,
          purpose: rule.purpose,
          dataClass: rule.dataClass,
          method: rule.method,
          enabled: rule.enabled,
        })),
      },
      metadataOnly: config.metadataOnly,
    },
  };
}

function databaseObservation(observations: DiagnosticObservation[]): RedactedDiagnosticBundle['database'] {
  const path = dbPath();
  const inspected = observe<BackupResult>(observations, 'database.inspect', () => Store.inspectBackup(path));
  if (inspected === null || !inspected.ok) {
    const last = observations.at(-1);
    return {
      path: redactDiagnosticPath(path),
      status: 'error',
      bytes: inspected?.bytes ?? null,
      sha256: inspected?.sha256 ?? null,
      schemaFingerprint: inspected?.schemaFingerprint ?? null,
      schemaVersion: null,
      tableCount: null,
      migrationState: 'unavailable',
      requiredTables: inspected?.requiredTables ?? [],
      manifestPresent: inspected?.manifestPresent ?? false,
      errorClass: last?.errorClass ?? 'DatabaseIntegrityError',
    };
  }
  const schema = observe(observations, 'database.schema', () => {
    const db = new DatabaseSync(path, { readOnly: true });
    try {
      const version = db.prepare('PRAGMA user_version').get() as { user_version?: unknown } | undefined;
      const count = db.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table'").get() as { count?: unknown } | undefined;
      return {
        schemaVersion: typeof version?.user_version === 'number' ? version.user_version : null,
        tableCount: typeof count?.count === 'number' ? count.count : null,
      };
    } finally {
      db.close();
    }
  });
  return {
    path: redactDiagnosticPath(path),
    status: 'ok',
    bytes: inspected.bytes,
    sha256: inspected.sha256,
    schemaFingerprint: inspected.schemaFingerprint,
    schemaVersion: schema?.schemaVersion ?? null,
    tableCount: schema?.tableCount ?? null,
    migrationState: schema ? 'read_only_schema_inspected' : 'unavailable',
    requiredTables: inspected.requiredTables,
    manifestPresent: inspected.manifestPresent,
  };
}

function egressObservation(observations: DiagnosticObservation[]): RedactedDiagnosticBundle['egress'] {
  const path = egressReceiptPath();
  const verified = observe<ReceiptVerification>(observations, 'egress.verify', () => verifyEgressReceipts(path));
  if (verified === null) {
    const last = observations.at(-1);
    return { path: redactDiagnosticPath(path), status: 'error', receiptCount: 0, validThroughHash: null, errors: [last?.errorClass ?? 'Error'] };
  }
  return { path: redactDiagnosticPath(path), status: verified.ok ? 'ok' : 'error', receiptCount: verified.receiptCount, validThroughHash: verified.validThroughHash, errors: verified.errors };
}

export function buildDiagnostics(): RedactedDiagnosticBundle {
  const observations: DiagnosticObservation[] = [];
  const configObservationResult = configObservation(observations);
  const config = configObservationResult.view;
  const db = databaseObservation(observations);
  const egress = egressObservation(observations);
  const pricing = configObservationResult.value
    ? observe(observations, 'pricing.status', () => pricingStatus(configObservationResult.value!.pricing.maxAgeDays))
    : null;
  const baseline = observe(observations, 'baseline.status', () => baselineManifestStatus());
  const memory = process.memoryUsage();
  return {
    version: 1,
    operationId: randomUUID(),
    generatedAt: new Date().toISOString(),
    runtime: { fiscusVersion: packageVersion(), node: process.version, platform: process.platform, arch: process.arch },
    boundaries: { externalNetworkAttempted: false, credentialRead: false, rawPromptSourceOrLedgerRowsExported: false },
    config,
    database: db,
    egress,
    pricing: { status: pricing, baseline },
    resources: { rssBytes: memory.rss, heapUsedBytes: memory.heapUsed },
    observations,
  };
}

export function writeDiagnosticsBundle(bundle: RedactedDiagnosticBundle, destinationPath: string): string {
  const destination = resolve(destinationPath);
  if (pathEntryExists(destination)) throw new Error('diagnostic destination already exists; refusing to overwrite it');
  mkdirSync(dirname(destination), { recursive: true });
  const temp = `${destination}.tmp-${randomUUID()}`;
  let fd: number | null = null;
  try {
    fd = openSync(temp, 'wx', 0o600);
    const bytes = Buffer.from(JSON.stringify(bundle, null, 2) + '\n', 'utf8');
    try {
      let offset = 0;
      while (offset < bytes.length) {
        const written = writeSync(fd, bytes, offset, bytes.length - offset, null);
        if (written <= 0) throw new Error('diagnostic bundle wrote no bytes');
        offset += written;
      }
      fsyncSync(fd);
    } finally {
      bytes.fill(0);
    }
    closeSync(fd);
    fd = null;
    renameSync(temp, destination);
    return destination;
  } catch (error) {
    if (fd !== null) {
      try { closeSync(fd); } catch { /* preserve the original export error */ }
    }
    try { unlinkSync(temp); } catch { /* no residue is best effort */ }
    throw error;
  }
}
