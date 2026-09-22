/**
 * THE REPOSITORY-SIDE LAUNCH DOCUMENTS EXIST, AND WHAT THEY POINT AT EXISTS.
 *
 * WP-J07 asked for the documents a newcomer to a public repository expects —
 * contribution, governance, security, threat model, release process,
 * compatibility, support, name-collision review, neutrality. A document of
 * that kind rots in one specific way: it keeps naming a file, a command or a
 * record that has since moved. D-166 and D-198 built the two checks that catch
 * that rot for operator docs and module contracts; this applies the same two
 * forms to the launch set, plus one rule specific to it.
 *
 * Checked: every file exists; every backticked or linked repository path
 * resolves against `git ls-files` by suffix (the D-198 rule — a false positive
 * in a gate over documentation is worse than a miss); every `fiscus <verb>`
 * names a verb `src/cli.ts` dispatches (the D-166 rule); SECURITY.md carries
 * no e-mail address, because the reporting path is owner-reserved and a
 * placeholder must not be silently filled with a person's address.
 *
 * Shown able to fail: with `docs/THREAT-MODEL.md` referencing
 * `src/store/DOES-NOT-EXIST.md` in place of `src/store/CONTEXT.md` the path check reported exactly that line;
 * with `SECURITY.md` carrying `security@example.com` the address check failed.
 * Both reverted. Not checked: any prose claim about behaviour.
 *
 * Recorded at D-225.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dirname, '..');

const LAUNCH_DOCS = [
  'CONTRIBUTING.md',
  'GOVERNANCE.md',
  'SECURITY.md',
  'docs/THREAT-MODEL.md',
  'docs/RELEASE-PROCESS.md',
  'docs/COMPATIBILITY.md',
  'docs/SUPPORT.md',
  'docs/NAME-COLLISION-REVIEW.md',
  'docs/NEUTRALITY.md',
] as const;

const read = (relative: string): string => readFileSync(join(ROOT, relative), 'utf8');

function trackedFiles(): string[] {
  return execFileSync('git', ['ls-files'], { cwd: ROOT, encoding: 'utf8' }).split('\n').filter((line) => line.length > 0);
}

function resolves(files: readonly string[], reference: string): boolean {
  return files.some((file) => file === reference || file.endsWith(`/${reference}`));
}

/** Backticked repository paths and markdown link targets, both relative-only. */
const PATH_REFERENCE = /`([A-Za-z0-9_./-]+\.(?:ts|mjs|md|json|yml|yaml))`|\]\(((?!https?:|#)[A-Za-z0-9_./-]+\.(?:md|ts|mjs|json|yml|yaml))(?:#[^)]*)?\)/g;
const VERB_REFERENCE = /`fiscus ([a-z][a-z0-9-]*)/g;

function dispatchActions(): Set<string> {
  const cli = read('src/cli.ts');
  const switchAt = cli.indexOf('  switch (cmd) {');
  assert.notEqual(switchAt, -1, 'src/cli.ts must dispatch through a switch, or this test is reading the wrong thing');
  return new Set([...cli.slice(switchAt).matchAll(/^ {4}case '([^']+)':/gm)].map((m) => m[1]!));
}

test('every launch-readiness document exists and is non-trivial', () => {
  for (const doc of LAUNCH_DOCS) {
    assert.ok(existsSync(join(ROOT, doc)), `${doc} is missing`);
    assert.ok(read(doc).split('\n').length >= 20, `${doc} is a stub`);
  }
});

test('every repository path a launch document names is a tracked file', () => {
  const files = trackedFiles();
  const missing: string[] = [];
  let checked = 0;
  for (const doc of LAUNCH_DOCS) {
    for (const match of read(doc).matchAll(PATH_REFERENCE)) {
      const reference = (match[1] ?? match[2]!).replace(/^(\.\.?\/)+/, '');
      checked += 1;
      if (!resolves(files, reference)) missing.push(`${doc}: names \`${reference}\``);
    }
  }
  assert.ok(checked >= 40, `only ${checked} path references matched; the pattern has stopped reading the documents`);
  assert.deepEqual(missing, [], 'a launch document names a file that is not tracked');
});

test('every `fiscus <verb>` a launch document names is dispatched by the CLI', () => {
  const verbs = dispatchActions();
  const unknown: string[] = [];
  let checked = 0;
  for (const doc of LAUNCH_DOCS) {
    for (const match of read(doc).matchAll(VERB_REFERENCE)) {
      checked += 1;
      if (!verbs.has(match[1]!)) unknown.push(`${doc}: \`fiscus ${match[1]}\``);
    }
  }
  assert.ok(checked >= 5, `only ${checked} command mentions matched; the pattern has stopped reading the documents`);
  assert.deepEqual(unknown, [], 'a launch document documents a verb the CLI does not dispatch');
});

test('SECURITY.md leaves the reporting path to the owner and carries no e-mail address', () => {
  const text = read('SECURITY.md');
  assert.doesNotMatch(text, /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/, 'SECURITY.md must not carry an e-mail address');
  assert.match(text, /maintainer|owner|placeholder|to be filled|TBD/i, 'SECURITY.md must route private contact through the maintainer rather than name an address');
});

test('README links the launch set', () => {
  const readme = read('README.md');
  for (const doc of ['CONTRIBUTING.md', 'GOVERNANCE.md', 'SECURITY.md', 'docs/THREAT-MODEL.md', 'docs/NEUTRALITY.md']) {
    assert.ok(readme.includes(`(${doc})`), `README.md does not link ${doc}`);
  }
});
