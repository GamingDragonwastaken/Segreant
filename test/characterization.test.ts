/**
 * The characterization vocabulary — one definition of a project key, shared by the
 * importers (cwd basename) and git correlation (repo top-level basename). The
 * load-bearing property is CROSS-PLATFORM AGREEMENT: a Windows path and a POSIX
 * path for the same logical directory must characterize to the same project, or a
 * dashboard would split one project into two.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { projectKey, DIMENSIONS, isDimension } from '../src/value/characterization.ts';

test('projectKey: trailing segment of either separator style', () => {
  assert.equal(projectKey('C:\\Users\\dev\\game'), 'game');
  assert.equal(projectKey('/home/dev/game'), 'game');
  assert.equal(projectKey('C:/Users/dev/game'), 'game');
  assert.equal(projectKey('game'), 'game');
});

test('projectKey: Windows and POSIX forms of the same dir AGREE (no phantom split)', () => {
  assert.equal(projectKey('C:\\a\\b\\fiscus'), projectKey('/a/b/fiscus'));
  assert.equal(projectKey('C:\\a\\b\\fiscus'), 'fiscus');
});

test('projectKey: trailing separators are ignored', () => {
  assert.equal(projectKey('/home/dev/game/'), 'game');
  assert.equal(projectKey('C:\\Users\\dev\\game\\'), 'game');
});

test('projectKey: blank/rootless path falls back to the caller label, never empty', () => {
  assert.equal(projectKey(''), 'default');
  assert.equal(projectKey(null), 'default');
  assert.equal(projectKey(undefined), 'default');
  assert.equal(projectKey('', 'claude-code'), 'claude-code');
  assert.equal(projectKey('/', 'codex'), 'codex');
});

test('projectKey: case is preserved (case-sensitive filesystems are two real projects)', () => {
  assert.equal(projectKey('/a/Api'), 'Api');
  assert.notEqual(projectKey('/a/Api'), projectKey('/a/api'));
});

test('DIMENSIONS: project leads, session is included, and isDimension guards', () => {
  assert.equal(DIMENSIONS[0], 'project'); // the reliable, RoI-relevant primary axis
  assert.ok(DIMENSIONS.includes('session'));
  assert.ok(isDimension('project') && isDimension('source') && isDimension('model'));
  assert.equal(isDimension('nope'), false);
});
