import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function packageEntries(): string[] {
  const cache = mkdtempSync(join(tmpdir(), 'fiscus-package-surface-cache-'));
  try {
    const npmArgs = ['pack', '--dry-run', '--ignore-scripts', '--json', '--loglevel=error'];
    // Windows command shims are not directly spawnable in every Node host. Use
    // cmd.exe explicitly there; the command line is composed only of constants,
    // while the disposable cache is passed through the environment.
    const command = process.platform === 'win32' ? (process.env.ComSpec ?? 'cmd.exe') : 'npm';
    const args = process.platform === 'win32'
      ? ['/d', '/s', '/c', `npm.cmd ${npmArgs.join(' ')}`]
      : npmArgs;
    const output = execFileSync(
      command,
      args,
      { cwd: ROOT, encoding: 'utf8', env: { ...process.env, npm_config_cache: cache } },
    );
    const report = JSON.parse(output) as Array<{ files?: Array<{ path?: string }> }>;
    return (report.at(-1)?.files ?? [])
      .map((entry) => entry.path)
      .filter((path): path is string => typeof path === 'string')
      .map((path) => path.replaceAll('\\', '/'));
  } finally {
    rmSync(cache, { recursive: true, force: true });
  }
}

function packagePath(entries: string[], suffix: string): string | undefined {
  return entries.find((entry) => entry === suffix || entry.endsWith(`/${suffix}`));
}

test('npm package surface keeps public docs and the README seal while excluding internal plans', () => {
  const packageJson = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as { files?: string[] };
  const allowlist = packageJson.files ?? [];

  assert.ok(allowlist.includes('docs/*.md'), 'public top-level Markdown docs must remain packageable');
  assert.equal(allowlist.includes('docs'), false, 'the broad docs directory allowlist would ship internal plans');
  assert.ok(
    allowlist.includes('web/assets/seal-256.png'),
    'the README seal must be explicitly included without shipping the whole web asset tree',
  );

  const entries = packageEntries();
  assert.ok(packagePath(entries, 'bin/fiscus.mjs'), 'the packaged CLI launcher must remain present');
  assert.ok(packagePath(entries, 'dist/cli.js'), 'the compiled CLI runtime must remain present');
  assert.ok(packagePath(entries, 'dist/store/backup.js'), 'the packaged runtime must include verified backup support');
  assert.ok(packagePath(entries, 'dist/cli/backupCmd.js'), 'the packaged CLI must include backup and restore commands');
  assert.ok(packagePath(entries, 'dist/diagnostics.js'), 'the packaged runtime must include redacted diagnostics');
  assert.ok(packagePath(entries, 'dist/cli/diagnosticsCmd.js'), 'the packaged CLI must include the diagnostics command');
  assert.ok(packagePath(entries, 'pricing/models.json'), 'the bundled pricing data must remain present');
  assert.ok(packagePath(entries, 'baselines/lift-baselines.json'), 'the bundled baseline data must remain present');
  assert.ok(packagePath(entries, 'web/assets/seal-256.png'), 'the README seal must be present in the packed artifact');
  assert.ok(packagePath(entries, 'docs/GETTING-STARTED.md'), 'the public getting-started guide must remain packaged');
  assert.ok(packagePath(entries, 'docs/RELEASE-GATE.md'), 'the public release gate must remain packaged');
  assert.ok(packagePath(entries, 'docs/RELIABILITY-PERFORMANCE.md'), 'the performance evidence guide must remain packaged');
  assert.ok(
    packagePath(entries, 'docs/CAPABILITY-EVIDENCE-CONTRACT.md'),
    'the public capability contract must remain packaged',
  );
  assert.equal(
    entries.some((entry) => /(?:^|\/)docs\/superpowers(?:\/|$)/.test(entry)),
    false,
    'internal superpowers plans must not enter the npm artifact',
  );
  assert.equal(
    packagePath(entries, 'dist/value/causalExperiment.js'),
    undefined,
    'research-only causalExperiment must not enter the npm artifact',
  );
});
