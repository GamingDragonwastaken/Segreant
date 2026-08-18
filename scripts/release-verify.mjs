import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = join(root, '.fiscus-release-evidence');
const packDir = join(outDir, 'pack');
const installDir = join(outDir, 'install');
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const steps = [];
let evidence = null;
let exitCode = 0;

mkdirSync(outDir, { recursive: true });
rmSync(packDir, { recursive: true, force: true });
rmSync(installDir, { recursive: true, force: true });
mkdirSync(packDir, { recursive: true });
mkdirSync(installDir, { recursive: true });

function tail(s, n = 4000) {
  const text = String(s ?? '');
  return text.length <= n ? text : text.slice(-n);
}

function exec(label, command, args, options = {}) {
  const startedAt = new Date().toISOString();
  const r = spawnSync(command, args, {
    cwd: options.cwd ?? root,
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
    env: { ...process.env, ...(options.env ?? {}) },
  });
  const record = {
    label,
    command: [command, ...args],
    startedAt,
    exitCode: r.status ?? 1,
    stdoutTail: tail(r.stdout),
    stderrTail: tail(r.stderr),
  };
  steps.push(record);
  if (r.status !== 0) {
    const err = new Error(`${label} failed with exit ${r.status ?? 1}`);
    err.record = record;
    throw err;
  }
  return r.stdout ?? '';
}

function git(args) {
  return exec(`git ${args.join(' ')}`, 'git', args).trim();
}

try {
  const beforeStatus = git(['status', '--porcelain', '--untracked-files=all']);
  if (beforeStatus !== '') throw new Error(`release verification requires a clean tree before it starts: ${beforeStatus}`);
  const sha = git(['rev-parse', 'HEAD']);
  const nodeVersion = process.version;
  const npmVersion = exec('npm --version', npm, ['--version']).trim();

  exec('source typecheck', npm, ['run', 'typecheck']);
  const testOutput = exec('source tests', npm, ['test']);
  exec('source build', npm, ['run', 'build']);

  const packOutput = exec('npm pack', npm, ['pack', '--ignore-scripts', '--json', '--pack-destination', packDir]);
  const pack = JSON.parse(packOutput);
  if (!Array.isArray(pack) || pack.length !== 1) throw new Error('npm pack did not return exactly one package record');
  const item = pack[0];
  const tarball = join(packDir, item.filename);
  const digest = createHash('sha256').update(readFileSync(tarball)).digest('hex');
  const files = new Set((item.files ?? []).map((f) => f.path));
  const required = [
    ['bin', (p) => p.startsWith('bin/')],
    ['compiled dist', (p) => p.startsWith('dist/')],
    ['pricing', (p) => p.startsWith('pricing/')],
    ['baselines', (p) => p.startsWith('baselines/')],
    ['dashboard html', (p) => p === 'dist/dashboard/web/index.html'],
  ];
  for (const [label, predicate] of required) {
    if (![...files].some(predicate)) throw new Error(`packed artifact missing required ${label}`);
  }

  writeFileSync(join(installDir, 'package.json'), '{"private":true}\n', 'utf8');
  exec('clean tarball install', npm, ['install', '--ignore-scripts', '--no-package-lock', tarball], { cwd: installDir });
  exec('installed fiscus --help', process.execPath, [join(installDir, 'node_modules', 'fiscus', 'bin', 'fiscus.mjs'), '--help'], { cwd: installDir });

  const afterStatus = git(['status', '--porcelain', '--untracked-files=all']);
  if (afterStatus !== '') throw new Error(`release verification dirtied the tracked tree: ${afterStatus}`);

  const match = /ℹ tests\s+(\d+)[\s\S]*?ℹ pass\s+(\d+)[\s\S]*?ℹ fail\s+(\d+)/m.exec(testOutput);
  evidence = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    candidate: { sha, cleanBefore: true, cleanAfter: true },
    environment: { node: nodeVersion, npm: npmVersion, platform: process.platform, arch: process.arch },
    source: {
      typecheck: 'pass',
      tests: match ? { total: Number(match[1]), pass: Number(match[2]), fail: Number(match[3]) } : { status: 'pass', totalsParsed: false },
      build: 'pass',
    },
    package: {
      status: 'pass',
      filename: item.filename,
      sha256: digest,
      fileCount: item.files?.length ?? null,
      requiredSurfaces: required.map(([label]) => label),
      cleanInstallCliSmoke: 'pass',
    },
    externalGates: {
      realProviderReconciliation: 'external_validation_required',
      internetTeamDeployment: 'external_validation_required',
      npmPublication: 'not_attempted',
      visualBrowserInspection: 'requires_separate_evidence',
    },
    notes: [
      'This artifact proves the local source/package/CLI candidate only.',
      'Permanent CI separately proves packaged dashboard/API truth boundaries and the real PostgreSQL adapter.',
      'Unknown external gates are not converted to passes by this verifier.',
    ],
    steps,
  };
} catch (err) {
  exitCode = 1;
  evidence = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    status: 'failed',
    error: err instanceof Error ? err.message : String(err),
    steps,
  };
}

const evidencePath = join(outDir, 'release-evidence.json');
writeFileSync(evidencePath, JSON.stringify(evidence, null, 2) + '\n', 'utf8');
console.log(JSON.stringify({ status: exitCode === 0 ? 'pass' : 'fail', evidencePath, candidate: evidence?.candidate?.sha ?? null }, null, 2));
process.exit(exitCode);
