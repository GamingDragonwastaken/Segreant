/**
 * Fiscus is the only identity this project has.
 *
 * The product was once called AegisFlow. Every trace of that name is gone from
 * anything describing what the product IS or how it behaves — the home
 * directory, the database file, the environment overrides, the exported
 * identifiers, the HTTP headers on the proxy and the dashboard's CSRF gate.
 *
 * The legacy `AEGIS_*` environment variables are not deprecated, not
 * fallbacks, and not dual-supported. They are GONE. A test that only proves
 * `FISCUS_HOME` works would pass just as happily with the old names still
 * silently honoured underneath, so each one is asserted to be inert: set it
 * alone, and the resolver must behave exactly as if nothing were set.
 *
 * These tests were written before the rename was implemented and run against
 * the pre-rename tree first, where they fail. A test suite authored after the
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
  'FISCUS_HOME', 'FISCUS_DB', 'FISCUS_DEMO', 'FISCUS_JUDGE_API_KEY',
  'AEGIS_HOME', 'AEGIS_DB', 'AEGIS_DEMO', 'AEGIS_JUDGE_API_KEY',
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
  assert.equal(typeof cfg.fiscusHome, 'function', '`fiscusHome` must be the exported resolver');
  assert.equal(cfg.aegisHome, undefined, '`aegisHome` must no longer be exported');
});

test('the default home is ~/.fiscus', async () => {
  const { fiscusHome } = await config();
  assert.equal(withEnv({}, fiscusHome), join(homedir(), '.fiscus'));
});

test('the default database is fiscus.db, and the demo database sits beside it', async () => {
  const { dbPath, demoDbPath } = await config();
  assert.equal(withEnv({}, dbPath), join(homedir(), '.fiscus', 'fiscus.db'));
  assert.equal(withEnv({}, demoDbPath), join(homedir(), '.fiscus', 'demo.db'));
});

test('the config file sits in the Fiscus home', async () => {
  const { configPath } = await config();
  assert.equal(withEnv({}, configPath), join(homedir(), '.fiscus', 'config.json'));
});

// ---- FISCUS_* is honoured --------------------------------------------------

test('FISCUS_HOME, FISCUS_DB and FISCUS_DEMO are honoured', async () => {
  const { fiscusHome, dbPath, isDemo } = await config();
  assert.equal(withEnv({ FISCUS_HOME: '/tmp/fh' }, fiscusHome), '/tmp/fh');
  assert.equal(withEnv({ FISCUS_HOME: '/tmp/fh' }, dbPath), join('/tmp/fh', 'fiscus.db'));
  assert.equal(withEnv({ FISCUS_DB: '/tmp/x.db' }, dbPath), '/tmp/x.db');
  assert.equal(withEnv({ FISCUS_DEMO: '1' }, isDemo), true);
  assert.equal(withEnv({}, isDemo), false);
});

test('an empty or blank FISCUS_HOME counts as unset, never as a relative path', async () => {
  const { fiscusHome } = await config();
  for (const blank of ['', '   ']) {
    assert.equal(withEnv({ FISCUS_HOME: blank }, fiscusHome), join(homedir(), '.fiscus'));
  }
});

// ---- AEGIS_* is INERT ------------------------------------------------------
//
// The point of these four. Each sets ONLY the legacy name and requires the
// resolver to behave as though nothing were set at all.

test('AEGIS_HOME is not read', async () => {
  const { fiscusHome } = await config();
  assert.equal(
    withEnv({ AEGIS_HOME: '/tmp/should-be-ignored' }, fiscusHome),
    join(homedir(), '.fiscus'),
    'AEGIS_HOME must be inert — no fallback, no dual support',
  );
});

test('AEGIS_DB is not read', async () => {
  const { dbPath } = await config();
  assert.equal(
    withEnv({ AEGIS_DB: '/tmp/should-be-ignored.db' }, dbPath),
    join(homedir(), '.fiscus', 'fiscus.db'),
  );
});

test('AEGIS_DEMO is not read', async () => {
  const { isDemo } = await config();
  assert.equal(withEnv({ AEGIS_DEMO: '1' }, isDemo), false);
});

test('FISCUS_* wins trivially, because the legacy name has no effect at all', async () => {
  const { fiscusHome } = await config();
  assert.equal(withEnv({ FISCUS_HOME: '/tmp/win', AEGIS_HOME: '/tmp/lose' }, fiscusHome), '/tmp/win');
});

// ---- the exported config type ---------------------------------------------

test('the config interface is named for the product', () => {
  const src = readFileSync(join(REPO, 'src', 'config.ts'), 'utf8');
  assert.ok(/export interface FiscusConfig\b/.test(src), '`FiscusConfig` must be the exported config type');
  assert.equal(/\bAegisConfig\b/.test(src), false, '`AegisConfig` must be gone');
});
