/**
 * Where Fiscus keeps its data, and which environment variable decides.
 *
 * The product is called Fiscus; the variables were named `AEGIS_*` before it was
 * renamed and never grew a `FISCUS_*` spelling. So `FISCUS_HOME=/somewhere
 * fiscus start` silently ignored the operator and used the default home — which
 * is how a demo run in this repository regenerated a real `~/.aegisflow/demo.db`
 * while a scratch directory sat unused.
 *
 * Both spellings are honoured now. The tests that matter here are the two
 * places that can go wrong quietly: an EMPTY value being treated as a real
 * path, and the demo switch being outranked by an operator's own variable.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { aegisHome, dbPath, demoDbPath, isDemo, envOverrideKey } from '../src/config.ts';

const KEYS = ['FISCUS_HOME', 'AEGIS_HOME', 'FISCUS_DB', 'AEGIS_DB', 'FISCUS_DEMO', 'AEGIS_DEMO'];

/** Run `fn` with exactly the given overrides set and every other one cleared. */
function withEnv<T>(env: Record<string, string | undefined>, fn: () => T): T {
  const saved = new Map(KEYS.map((k) => [k, process.env[k]]));
  try {
    for (const k of KEYS) delete process.env[k];
    for (const [k, v] of Object.entries(env)) if (v !== undefined) process.env[k] = v;
    return fn();
  } finally {
    for (const [k, v] of saved) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

test('FISCUS_HOME is honoured — the defect that sent a demo run at the real home', () => {
  assert.equal(withEnv({ FISCUS_HOME: '/tmp/fiscus-a' }, aegisHome), '/tmp/fiscus-a');
});

test('the legacy AEGIS_HOME still works, because installs and CI scripts use it', () => {
  assert.equal(withEnv({ AEGIS_HOME: '/tmp/fiscus-b' }, aegisHome), '/tmp/fiscus-b');
});

test('FISCUS_HOME wins over AEGIS_HOME when both are set', () => {
  assert.equal(withEnv({ FISCUS_HOME: '/tmp/win', AEGIS_HOME: '/tmp/lose' }, aegisHome), '/tmp/win');
});

test('with neither set, the home is the default under the user directory', () => {
  assert.equal(withEnv({}, aegisHome), join(homedir(), '.aegisflow'));
});

test('an empty or blank value counts as unset, never as a relative path', () => {
  // `FISCUS_HOME=` in a shell sets the variable to the empty string. Accepting
  // it would resolve the ledger relative to the current directory — writing an
  // operator's data into whatever folder they happened to be standing in.
  for (const blank of ['', '   ']) {
    assert.equal(withEnv({ FISCUS_HOME: blank }, aegisHome), join(homedir(), '.aegisflow'));
    assert.equal(withEnv({ FISCUS_HOME: blank, AEGIS_HOME: '/tmp/real' }, aegisHome), '/tmp/real',
      'a blank FISCUS_HOME must fall through to the legacy name, not shadow it');
  }
});

test('the database path follows the home, and FISCUS_DB overrides it outright', () => {
  assert.equal(withEnv({ FISCUS_HOME: '/tmp/h' }, dbPath), join('/tmp/h', 'aegis.db'));
  assert.equal(withEnv({ FISCUS_HOME: '/tmp/h', FISCUS_DB: '/tmp/explicit.db' }, dbPath), '/tmp/explicit.db');
  assert.equal(withEnv({ FISCUS_HOME: '/tmp/h', AEGIS_DB: '/tmp/legacy.db' }, dbPath), '/tmp/legacy.db');
});

test('demo mode cannot be outranked by an operator FISCUS_DB — demo data never lands in a real ledger', () => {
  // `src/cli.ts` sets the demo overrides on the process before anything opens a
  // store. It writes the PREFERRED spelling for exactly this reason: if it wrote
  // the legacy `AEGIS_DB` while an operator had exported `FISCUS_DB`, their
  // variable would outrank the switch and synthetic traffic would be metered
  // straight into their real database.
  withEnv({ FISCUS_HOME: '/tmp/h', FISCUS_DB: '/tmp/my-real-ledger.db' }, () => {
    assert.equal(dbPath(), '/tmp/my-real-ledger.db', 'precondition: the operator variable is in effect');

    // Exactly what cli.ts does when it sees `demo` or `--demo`.
    process.env[envOverrideKey('DB')] = demoDbPath();
    process.env[envOverrideKey('DEMO')] = '1';

    assert.equal(dbPath(), join('/tmp/h', 'demo.db'), 'the demo switch must win');
    assert.notEqual(dbPath(), '/tmp/my-real-ledger.db');
    assert.equal(isDemo(), true);
  });
});

test('isDemo reads either spelling, and is false when neither is set', () => {
  assert.equal(withEnv({}, isDemo), false);
  assert.equal(withEnv({ AEGIS_DEMO: '1' }, isDemo), true);
  assert.equal(withEnv({ FISCUS_DEMO: '1' }, isDemo), true);
  assert.equal(withEnv({ FISCUS_DEMO: '0' }, isDemo), false);
});
