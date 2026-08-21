/**
 * The home override is honoured by the real binary, not just by the resolver.
 *
 * `fiscus-identity.test.ts` proves `config.ts` ignores the pre-rename variable.
 * That is a unit-level claim about one module, and the defect it guards against
 * was an end-to-end one: a `demo` run regenerating the operator's real ledger
 * home while the scratch directory it had been pointed at sat empty. So this
 * spawns the actual CLI, through `bin/fiscus.mjs` and therefore through the
 * compiled `dist/`, and looks at the filesystem afterwards.
 *
 * The first draft of this file set BOTH variables and asserted the legacy one
 * stayed empty. It passed against a deliberately reintroduced fallback, because
 * a fallback only fires when the live name is absent — so the assertion could
 * never have failed and proved nothing. The shape below is what actually
 * discriminates: the legacy name is the ONLY override present, and the run must
 * ignore it in favour of the default home.
 *
 * That default is made a temp directory by overriding the spawned process's
 * home, which is what keeps this safe. A test that writes to the developer's
 * real ledger when it fails is not a test worth having.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync, readdirSync, existsSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = dirname(dirname(fileURLToPath(import.meta.url)));
const CLI = join(REPO, 'bin', 'fiscus.mjs');

/** Every override, so a case can guarantee exactly which names are present. */
const OVERRIDES = [
  'FISCUS_HOME', 'FISCUS_DB', 'FISCUS_DEMO',
  'AEGIS_HOME', 'AEGIS_DB', 'AEGIS_DEMO',
];

function run(args: string[], fakeHome: string, set: Record<string, string>): Promise<number> {
  const env: Record<string, string> = { ...process.env as Record<string, string> };
  for (const k of OVERRIDES) delete env[k];
  Object.assign(env, set, {
    HOME: fakeHome,
    USERPROFILE: fakeHome,
    NODE_OPTIONS: '',
  });
  return new Promise((resolve) => {
    execFile(process.execPath, [CLI, ...args], { env, timeout: 180_000 }, (err) => resolve(err ? 1 : 0));
  });
}

function listing(dir: string): string[] {
  return existsSync(dir) ? readdirSync(dir).sort() : [];
}

test('the CLI ignores the pre-rename home variable when it is the only one set', async (t) => {
  const fakeHome = mkdtempSync(join(tmpdir(), 'fiscus-fakehome-'));
  const legacy = mkdtempSync(join(tmpdir(), 'fiscus-legacy-'));
  t.after(() => {
    for (const d of [fakeHome, legacy]) rmSync(d, { recursive: true, force: true });
  });

  const realHomeBefore = listing(join(homedir(), '.fiscus'));

  // AEGIS_HOME is the ONLY override. A resolver that still reads it would seed
  // `legacy`; one that does not falls through to the default home, which this
  // spawn has pointed at a temp directory.
  const code = await run(['demo'], fakeHome, { AEGIS_HOME: legacy });
  assert.equal(code, 0, 'fiscus demo should succeed');

  assert.deepEqual(
    listing(legacy),
    [],
    'AEGIS_HOME must be inert — a run must never write to it',
  );
  assert.ok(
    listing(join(fakeHome, '.fiscus')).some((f) => f.startsWith('demo.db')),
    `expected the default home to be seeded; found ${JSON.stringify(listing(join(fakeHome, '.fiscus')))}`,
  );
  assert.deepEqual(
    listing(join(homedir(), '.fiscus')),
    realHomeBefore,
    'a redirected run must not touch the operator\u2019s real ledger home',
  );
});

test('the CLI honours FISCUS_HOME over the default home', async (t) => {
  const fakeHome = mkdtempSync(join(tmpdir(), 'fiscus-fakehome-'));
  const live = mkdtempSync(join(tmpdir(), 'fiscus-live-'));
  t.after(() => {
    for (const d of [fakeHome, live] ) rmSync(d, { recursive: true, force: true });
  });

  const code = await run(['demo'], fakeHome, { FISCUS_HOME: live });
  assert.equal(code, 0, 'fiscus demo should succeed');

  assert.ok(
    listing(live).some((f) => f.startsWith('demo.db')),
    `expected FISCUS_HOME to be seeded; found ${JSON.stringify(listing(live))}`,
  );
  assert.deepEqual(
    listing(join(fakeHome, '.fiscus')),
    [],
    'the default home must be untouched when FISCUS_HOME is set',
  );
});
