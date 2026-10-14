// The on-disk repository walk must name the same working tree git does, for
// every layout a tool's session directory can sit in. Each case asks git itself
// and compares strings exactly; the walk exists only to avoid the spawn.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { repoToplevelOnDisk } from '../src/connect/repoRoot.ts';
import { repoToplevel } from '../src/git/correlate.ts';
import { createRepoResolver } from '../src/connect/importShared.ts';

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', args, { cwd, stdio: 'ignore', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.invalid', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.invalid' } });
}

test('the disk walk names the same working tree as git rev-parse --show-toplevel', async () => {
  const base = mkdtempSync(join(tmpdir(), 'segreant-repo-root-'));
  try {
    const repo = join(base, 'Repo-One');
    mkdirSync(join(repo, 'packages', 'web'), { recursive: true });
    git(repo, 'init', '-q');
    git(repo, 'commit', '-q', '--allow-empty', '-m', 'init');
    // A linked worktree: its .git is a file pointing into the main repository.
    const linked = join(base, 'linked-tree');
    git(repo, 'worktree', 'add', '-q', linked);
    mkdirSync(join(linked, 'src'));
    // A nested repository inside the first one.
    const inner = join(repo, 'vendor', 'inner');
    mkdirSync(inner, { recursive: true });
    git(inner, 'init', '-q');
    // A folder named .git that is not a repository: git keeps walking up.
    const fake = join(repo, 'fake');
    mkdirSync(join(fake, '.git'), { recursive: true });
    // A .git file whose target is missing: fatal to git, no walking further.
    const broken = join(repo, 'broken');
    mkdirSync(broken);
    writeFileSync(join(broken, '.git'), 'gitdir: ../nowhere\n');
    // A bare repository has no work tree.
    const bare = join(base, 'bare.git');
    mkdirSync(bare);
    git(bare, 'init', '-q', '--bare');
    const plain = join(base, 'not-a-repo', 'deep');
    mkdirSync(plain, { recursive: true });

    const cases: Array<[string, string]> = [
      ['repository root', repo],
      ['subdirectory', join(repo, 'packages', 'web')],
      ['linked worktree', join(linked, 'src')],
      ['nested repository', inner],
      ['folder named .git without a repository', fake],
      ['broken .git file', broken],
      ['inside the .git folder', join(repo, '.git', 'objects')],
      ['bare repository', bare],
      ['outside any repository', plain],
      ['a path that does not exist', join(base, 'gone', 'away')],
    ];
    // Tool logs record whatever case the shell used; the label must keep the disk's.
    if (process.platform === 'win32') cases.push(['recorded in another letter case', join(repo, 'packages', 'web').toLowerCase()]);
    try {
      const link = join(base, 'link-to-web');
      symlinkSync(join(repo, 'packages', 'web'), link, 'junction');
      cases.push(['through a symlink or junction', link]);
    } catch { /* no symlink permission on this machine: the other cases still run */ }

    for (const [label, dir] of cases) {
      assert.equal(repoToplevelOnDisk(dir), await repoToplevel(dir), label);
    }
    // Sanity: the cases are not all null.
    assert.ok(repoToplevelOnDisk(join(repo, 'packages', 'web'))?.endsWith('Repo-One'));
    assert.ok(repoToplevelOnDisk(join(linked, 'src'))?.endsWith('linked-tree'));
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('import attribution resolves a subdirectory to its repository without starting git', async () => {
  const base = mkdtempSync(join(tmpdir(), 'segreant-repo-root-'));
  try {
    const repo = join(base, 'shop');
    mkdirSync(join(repo, 'packages', 'web'), { recursive: true });
    git(repo, 'init', '-q');
    const saved = process.env.PATH;
    // With git unreachable, only the disk walk can produce a repository label.
    process.env.PATH = '';
    try {
      const resolve = createRepoResolver();
      const hit = await resolve(join(repo, 'packages', 'web'), 'claude-code');
      assert.deepEqual(hit, { project: 'shop', basis: 'tool_log_repo_resolved', supersedes: 'web' });
      const miss = await resolve(join(base), 'claude-code');
      assert.equal(miss.basis, 'tool_log_inferred');
    } finally {
      process.env.PATH = saved;
    }
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
