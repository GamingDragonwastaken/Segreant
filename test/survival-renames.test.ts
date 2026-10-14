/**
 * A commit that renames a file and edits it must be blamed on the file's new
 * path. Git's plain numstat prints such a file as `src/{old.ts => new.ts}`,
 * which is not a path; blame refused it and the commit's lines read as not
 * retained.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseNumstatZ, survivingLines, clearBlameCache } from '../src/git/quality.ts';

const NUL = String.fromCharCode(0);

test('numstat -z: renames yield the new path, odd names stay exact, binary adds nothing', () => {
  const out = [
    `1\t0\t`, 'src/old.ts', 'src/new.ts',
    `2\t1\tsrc/sp ace => arrow.ts`,
    `-\t-\tassets/logo.png`,
    `\n3\t0\tsrc/after-newline.ts`,
    '',
  ].join(NUL);
  assert.deepEqual(parseNumstatZ(out), [
    { path: 'src/new.ts', added: 1 },
    { path: 'src/sp ace => arrow.ts', added: 2 },
    { path: 'assets/logo.png', added: 0 },
    { path: 'src/after-newline.ts', added: 3 },
  ]);
  assert.deepEqual(parseNumstatZ(''), []);
});

test('a commit that renames and edits a file keeps credit for the lines it added', async () => {
  const repo = mkdtempSync(join(tmpdir(), 'segreant-survival-renames-'));
  const git = (...args: string[]) => execFileSync('git', args, {
    cwd: repo, encoding: 'utf8',
    env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.invalid', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.invalid' },
  }).trim();
  try {
    git('init', '-q');
    git('config', 'core.autocrlf', 'false');
    mkdirSync(join(repo, 'src'));
    // Long enough that one added line keeps the file above git's 50% rename similarity.
    writeFileSync(join(repo, 'src', 'old.ts'), Array.from({ length: 40 }, (_, i) => `export const line${i} = ${i};`).join('\n') + '\n');
    git('add', '.');
    git('commit', '-qm', 'one');
    git('mv', 'src/old.ts', 'src/new.ts');
    appendFileSync(join(repo, 'src', 'new.ts'), 'export const added = true;\n');
    git('commit', '-qam', 'rename and edit');
    const hash = git('rev-parse', 'HEAD');
    clearBlameCache();
    const result = await survivingLines(repo, hash);
    assert.deepEqual(result, { added: 1, surviving: 1, measured: true });
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});
