/**
 * Segreant is the only identity this project has.
 *
 * The product was once called AegisFlow, and then Fiscus. Every trace of both
 * names is gone from anything describing what the product IS or how it
 * behaves — the home directory, the database file, the environment overrides,
 * the exported identifiers, the HTTP headers on the proxy and the dashboard's
 * CSRF gate.
 *
 * The legacy `AEGIS_*` and `FISCUS_*` environment variables are not
 * deprecated, not fallbacks, and not dual-supported. They are GONE. A test that only proves
 * `SEGREANT_HOME` works would pass just as happily with the old names still
 * silently honoured underneath, so each one is asserted to be inert: set it
 * alone, and the resolver must behave exactly as if nothing were set.
 *
 * The AegisFlow tests were written before that rename and run against the
 * pre-rename tree first, where they failed. The Fiscus tests below were added
 * with the Segreant rename, and each fails if its legacy name is read. A test suite authored after the
 * code it checks tends to describe the code rather than the requirement.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';

const REPO = dirname(dirname(fileURLToPath(import.meta.url)));

/** Every override name, old and new, so a test can guarantee a clean slate. */
const ALL_KEYS = [
  'SEGREANT_HOME', 'SEGREANT_DB', 'SEGREANT_DEMO', 'SEGREANT_JUDGE_API_KEY',
  'AEGIS_HOME', 'AEGIS_DB', 'AEGIS_DEMO', 'AEGIS_JUDGE_API_KEY',
  'FISCUS_HOME', 'FISCUS_DB', 'FISCUS_DEMO', 'FISCUS_JUDGE_API_KEY',
];

function withEnv<T>(env: Record<string, string>, fn: () => T): T {
  const saved = new Map(ALL_KEYS.map((k) => [k, process.env[k]]));
  try {
    for (const k of ALL_KEYS) delete process.env[k];
    for (const [k, v] of Object.entries(env)) process.env[k] = v;
    return fn();
  } finally {
    for (const [k, v] of saved) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

/** Imported dynamically so a missing export fails ONE test with a clear message. */
async function config(): Promise<Record<string, any>> {
  return (await import('../src/config.ts')) as unknown as Record<string, any>;
}

// ---- the home and the database -------------------------------------------

test('the home resolver is named for the product', async () => {
  const cfg = await config();
  assert.equal(typeof cfg.segreantHome, 'function', '`segreantHome` must be the exported resolver');
  assert.equal(cfg.aegisHome, undefined, '`aegisHome` must no longer be exported');
  assert.equal(cfg.fiscusHome, undefined, '`fiscusHome` must no longer be exported');
});

test('the default home is ~/.segreant', async () => {
  const { segreantHome } = await config();
  assert.equal(withEnv({}, segreantHome), join(homedir(), '.segreant'));
});

test('the default database is segreant.db, and the demo database sits beside it', async () => {
  const { dbPath, demoDbPath } = await config();
  assert.equal(withEnv({}, dbPath), join(homedir(), '.segreant', 'segreant.db'));
  assert.equal(withEnv({}, demoDbPath), join(homedir(), '.segreant', 'demo.db'));
});

test('the config file sits in the Segreant home', async () => {
  const { configPath } = await config();
  assert.equal(withEnv({}, configPath), join(homedir(), '.segreant', 'config.json'));
});

// ---- SEGREANT_* is honoured --------------------------------------------------

test('SEGREANT_HOME, SEGREANT_DB and SEGREANT_DEMO are honoured', async () => {
  const { segreantHome, dbPath, isDemo } = await config();
  assert.equal(withEnv({ SEGREANT_HOME: '/tmp/fh' }, segreantHome), '/tmp/fh');
  assert.equal(withEnv({ SEGREANT_HOME: '/tmp/fh' }, dbPath), join('/tmp/fh', 'segreant.db'));
  assert.equal(withEnv({ SEGREANT_DB: '/tmp/x.db' }, dbPath), '/tmp/x.db');
  assert.equal(withEnv({ SEGREANT_DEMO: '1' }, isDemo), true);
  assert.equal(withEnv({}, isDemo), false);
});

test('an empty or blank SEGREANT_HOME counts as unset, never as a relative path', async () => {
  const { segreantHome } = await config();
  for (const blank of ['', '   ']) {
    assert.equal(withEnv({ SEGREANT_HOME: blank }, segreantHome), join(homedir(), '.segreant'));
  }
});

// ---- AEGIS_* is INERT ------------------------------------------------------
//
// The point of these four. Each sets ONLY the legacy name and requires the
// resolver to behave as though nothing were set at all.

test('AEGIS_HOME is not read', async () => {
  const { segreantHome } = await config();
  assert.equal(
    withEnv({ AEGIS_HOME: '/tmp/should-be-ignored' }, segreantHome),
    join(homedir(), '.segreant'),
    'AEGIS_HOME must be inert — no fallback, no dual support',
  );
});

test('AEGIS_DB is not read', async () => {
  const { dbPath } = await config();
  assert.equal(
    withEnv({ AEGIS_DB: '/tmp/should-be-ignored.db' }, dbPath),
    join(homedir(), '.segreant', 'segreant.db'),
  );
});

test('AEGIS_DEMO is not read', async () => {
  const { isDemo } = await config();
  assert.equal(withEnv({ AEGIS_DEMO: '1' }, isDemo), false);
});

// ---- FISCUS_* is INERT -----------------------------------------------------
//
// The same guarantee for the second rename. A ledger under ~/.fiscus is left
// on disk and never read; a FISCUS_* variable changes nothing.

test('FISCUS_HOME is not read', async () => {
  const { segreantHome } = await config();
  assert.equal(
    withEnv({ FISCUS_HOME: '/tmp/should-be-ignored' }, segreantHome),
    join(homedir(), '.segreant'),
    'FISCUS_HOME must be inert — no fallback, no dual support',
  );
});

test('FISCUS_DB is not read', async () => {
  const { dbPath } = await config();
  assert.equal(
    withEnv({ FISCUS_DB: '/tmp/should-be-ignored.db' }, dbPath),
    join(homedir(), '.segreant', 'segreant.db'),
  );
});

test('FISCUS_DEMO is not read', async () => {
  const { isDemo } = await config();
  assert.equal(withEnv({ FISCUS_DEMO: '1' }, isDemo), false);
});

test('no FISCUS_* variable, FISCUS_JUDGE_API_KEY included, is read anywhere in the product source', () => {
  for (const rel of ['config.ts', join('judge', 'orchestrate.ts'), join('judge', 'tier.ts')]) {
    const src = readFileSync(join(REPO, 'src', rel), 'utf8');
    assert.equal(/FISCUS_/.test(src), false, `src/${rel} must not name a FISCUS_* variable`);
  }
});

test('SEGREANT_* wins trivially, because the legacy name has no effect at all', async () => {
  const { segreantHome } = await config();
  assert.equal(withEnv({ SEGREANT_HOME: '/tmp/win', AEGIS_HOME: '/tmp/lose' }, segreantHome), '/tmp/win');
  assert.equal(withEnv({ SEGREANT_HOME: '/tmp/win', FISCUS_HOME: '/tmp/lose' }, segreantHome), '/tmp/win');
});

// ---- the exported config type ---------------------------------------------

test('the config interface is named for the product', () => {
  const src = readFileSync(join(REPO, 'src', 'config.ts'), 'utf8');
  assert.ok(/export interface SegreantConfig\b/.test(src), '`SegreantConfig` must be the exported config type');
  assert.equal(/\bAegisConfig\b/.test(src), false, '`AegisConfig` must be gone');
  assert.equal(/\bFiscusConfig\b/.test(src), false, '`FiscusConfig` must be gone');
});
