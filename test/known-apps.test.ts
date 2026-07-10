/**
 * Known-app inventory: read-only existence checks for AI coding tools beyond the
 * 3 natively-supported importers. Detection is dependency-injected, so these
 * tests fabricate a fake home/PATH/exists rather than depending on what happens
 * to be installed on the machine running the suite.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { detectKnownApps } from '../src/scan/knownApps.ts';

test('detectKnownApps: everything absent when nothing exists', () => {
  const apps = detectKnownApps({ home: '/nowhere', platform: 'linux', pathDirs: ['/usr/bin'], exists: () => false });
  assert.ok(apps.length >= 5, 'the table has a modest but real set of known tools');
  for (const a of apps) {
    assert.equal(a.present, false);
    assert.equal(a.evidence, null);
    assert.ok(a.label.length > 0);
    assert.ok(a.blurb.length > 0);
  }
  // Stable ids, no duplicates.
  const ids = apps.map((a) => a.id);
  assert.equal(new Set(ids).size, ids.length, 'ids are unique');
});

test('detectKnownApps: a config directory is detected as evidence', () => {
  const home = '/home/dev';
  const cursorDir = join(home, '.cursor');
  const apps = detectKnownApps({ home, platform: 'linux', pathDirs: [], exists: (p) => p === cursorDir });
  const cursor = apps.find((a) => a.id === 'cursor')!;
  assert.equal(cursor.present, true);
  assert.equal(cursor.evidence, cursorDir);
  // Nothing else was faked into existing.
  for (const a of apps) if (a.id !== 'cursor') assert.equal(a.present, false);
});

test('detectKnownApps: a PATH binary is detected for aider, platform suffix included', () => {
  const binDir = '/usr/local/bin';
  const aiderPath = join(binDir, 'aider');
  const apps = detectKnownApps({ home: '/home/dev', platform: 'linux', pathDirs: [binDir], exists: (p) => p === aiderPath });
  const aider = apps.find((a) => a.id === 'aider')!;
  assert.equal(aider.present, true);
  assert.equal(aider.evidence, aiderPath);
});

test('detectKnownApps: aider on Windows PATH resolves with an .exe/.cmd suffix', () => {
  const binDir = 'C:\\tools';
  const shim = join(binDir, 'aider.cmd');
  const apps = detectKnownApps({ home: 'C:\\Users\\dev', platform: 'win32', pathDirs: [binDir], exists: (p) => p === shim });
  const aider = apps.find((a) => a.id === 'aider')!;
  assert.equal(aider.present, true);
  assert.equal(aider.evidence, shim);
});

test('detectKnownApps: zed config dir is OS-specific', () => {
  const home = '/Users/dev';
  const macZed = join(home, 'Library', 'Application Support', 'Zed');
  const apps = detectKnownApps({ home, platform: 'darwin', pathDirs: [], exists: (p) => p === macZed });
  assert.equal(apps.find((a) => a.id === 'zed')!.present, true);

  const linuxHome = '/home/dev';
  const linuxZed = join(linuxHome, '.config', 'zed');
  const linuxApps = detectKnownApps({ home: linuxHome, platform: 'linux', pathDirs: [], exists: (p) => p === linuxZed });
  assert.equal(linuxApps.find((a) => a.id === 'zed')!.present, true);
});

test('detectKnownApps: real environment defaults do not throw', () => {
  // No injected env at all — exercises the real homedir()/process.env.PATH/existsSync path.
  const apps = detectKnownApps();
  assert.ok(Array.isArray(apps));
});
