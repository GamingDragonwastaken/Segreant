import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildDiagnostics, writeDiagnosticsBundle } from '../src/diagnostics.ts';
import { Store } from '../src/store/db.ts';

function sha256(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

test('diagnostics are redacted, versioned, and do not mutate the active ledger', () => {
  const previousHome = process.env.FISCUS_HOME;
  const previousDb = process.env.FISCUS_DB;
  const home = mkdtempSync(join(tmpdir(), 'fiscus-diagnostics-'));
  const db = join(home, 'fiscus.db');
  process.env.FISCUS_HOME = home;
  delete process.env.FISCUS_DB;
  const store = new Store(db);
  store.close();
  const before = sha256(db);
  try {
    const bundle = buildDiagnostics();
    const after = sha256(db);
    assert.equal(after, before, 'diagnostic inspection must be read-only');
    assert.equal(bundle.version, 1);
    assert.match(bundle.operationId, /^[0-9a-f-]{36}$/);
    assert.equal(bundle.boundaries.externalNetworkAttempted, false);
    assert.equal(bundle.boundaries.credentialRead, false);
    assert.equal(bundle.boundaries.rawPromptSourceOrLedgerRowsExported, false);
    assert.match(bundle.config.path, /^<FISCUS_HOME>/);
    assert.match(bundle.database.path, /^<FISCUS_HOME>/);
    assert.equal(bundle.database.migrationState, 'read_only_schema_inspected');
    assert.equal(typeof bundle.database.schemaVersion, 'number');
    assert.equal(typeof bundle.database.tableCount, 'number');
    assert.match(bundle.egress.path, /^<FISCUS_HOME>/);
    const serialized = JSON.stringify(bundle);
    assert.equal(serialized.includes(home), false, 'absolute Fiscus home must not enter the bundle');
    assert.equal(serialized.includes('backup-request-1'), false, 'ledger request identities must not enter the bundle');
    assert.equal(serialized.includes('benchmark-fixture'), false, 'ledger project labels must not enter the bundle');
    assert.equal(serialized.includes('"sourceUrl":'), false, 'pricing endpoint identity must not enter the bundle');
    assert.equal(bundle.observations.length >= 4, true);
    for (const observation of bundle.observations) {
      assert.match(observation.operationId, /^[0-9a-f-]{36}$/);
      assert.equal(Number.isFinite(observation.durationMs), true);
      assert.equal(observation.durationMs >= 0, true);
      assert.ok(observation.name);
    }
  } finally {
    if (previousHome === undefined) delete process.env.FISCUS_HOME;
    else process.env.FISCUS_HOME = previousHome;
    if (previousDb === undefined) delete process.env.FISCUS_DB;
    else process.env.FISCUS_DB = previousDb;
    rmSync(home, { recursive: true, force: true });
  }
});

test('diagnostic export is atomic and refuses an existing destination', () => {
  const previousHome = process.env.FISCUS_HOME;
  const previousDb = process.env.FISCUS_DB;
  const home = mkdtempSync(join(tmpdir(), 'fiscus-diagnostics-export-'));
  const output = join(home, 'out', 'diagnostics.json');
  process.env.FISCUS_HOME = home;
  delete process.env.FISCUS_DB;
  try {
    const bundle = buildDiagnostics();
    const written = writeDiagnosticsBundle(bundle, output);
    assert.equal(existsSync(written), true);
    assert.deepEqual(JSON.parse(readFileSync(written, 'utf8')), bundle);
    const sentinel = Buffer.from('sentinel');
    writeFileSync(written, sentinel);
    assert.throws(() => writeDiagnosticsBundle(bundle, written), /already exists|overwrite/i);
    assert.deepEqual(readFileSync(written), sentinel);
  } finally {
    if (previousHome === undefined) delete process.env.FISCUS_HOME;
    else process.env.FISCUS_HOME = previousHome;
    if (previousDb === undefined) delete process.env.FISCUS_DB;
    else process.env.FISCUS_DB = previousDb;
    rmSync(home, { recursive: true, force: true });
  }
});

test('diagnostics omit private pricing URL host and path details', () => {
  const previousHome = process.env.FISCUS_HOME;
  const previousDb = process.env.FISCUS_DB;
  const home = mkdtempSync(join(tmpdir(), 'fiscus-diagnostics-pricing-'));
  const pricingDir = join(home, 'pricing');
  process.env.FISCUS_HOME = home;
  delete process.env.FISCUS_DB;
  try {
    mkdirSync(pricingDir, { recursive: true });
    const cardText = readFileSync(new URL('../pricing/models.json', import.meta.url), 'utf8');
    const card = JSON.parse(cardText) as { providers: Record<string, { models: Record<string, unknown> }> };
    const cardSha256 = createHash('sha256').update(JSON.stringify(card), 'utf8').digest('hex');
    const modelCount = Object.values(card.providers).reduce((sum, provider) => sum + Object.keys(provider.models).length, 0);
    writeFileSync(join(pricingDir, 'models.json'), cardText, 'utf8');
    writeFileSync(join(pricingDir, 'provenance.json'), JSON.stringify({
      schemaVersion: 1,
      sourceUrl: 'https://private.example/teams/SECRET_PATH_TOKEN',
      sourceUrlSha256: '0'.repeat(64),
      sourceKind: 'manual',
      fetchedAt: '2026-08-28T00:00:00.000Z',
      lastCheckedAt: '2026-08-28T00:00:00.000Z',
      upstreamDeclaredUpdated: null,
      cardSha256,
      modelCount,
      etag: null,
      lastModified: null,
    }), 'utf8');
    const bundle = buildDiagnostics();
    const serialized = JSON.stringify(bundle);
    assert.equal(serialized.includes('private.example'), false);
    assert.equal(serialized.includes('SECRET_PATH_TOKEN'), false);
  } finally {
    if (previousHome === undefined) delete process.env.FISCUS_HOME;
    else process.env.FISCUS_HOME = previousHome;
    if (previousDb === undefined) delete process.env.FISCUS_DB;
    else process.env.FISCUS_DB = previousDb;
    rmSync(home, { recursive: true, force: true });
  }
});
