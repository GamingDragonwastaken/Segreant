import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Store } from '../src/store/db.ts';
import { cliJsonResponse, CLI_JSON_SCHEMA_VERSION } from '../src/cli/ui.ts';

const root = resolve(import.meta.dirname, '..');
const source = readFileSync(join(root, 'src/cli.ts'), 'utf8');
const dispatch = source.slice(source.indexOf('  switch (cmd) {'), source.indexOf('  // Long-running commands'));
const groups = [...dispatch.matchAll(/((?:\s*case '[^']+':\s*)+)([\s\S]*?)(?=\n\s*case |\n\s*default:)/g)]
  .map((match) => [...match[1]!.matchAll(/case '([^']+)'/g)].map((item) => item[1]!));

function seedLargeLedger(dbPath: string): void {
  const currentWindowTs = Date.now();
  const db = new DatabaseSync(dbPath);
  db.exec(`WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x<10000)
    INSERT INTO requests (request_id,ts_iso,ts_epoch_ms,provider,model,input_tokens,output_tokens,cache_read_tokens,cache_write_tokens,cost_usd,estimated,duration_ms,status_code,project,source)
    SELECT 'fixture-'||x,'${new Date(currentWindowTs).toISOString()}',${currentWindowTs},'openai','fixture-model',1,1,0,0,0.000001,1,1,200,'fixture-project','proxy' FROM n`);
  db.close();
}

test('10,000-row synthetic ledger is visible to month and all-time export', () => {
  const scratch = mkdtempSync(join(tmpdir(), 'segreant-json-huge-proof-'));
  const home = join(scratch, 'home');
  const repo = join(scratch, 'repo');
  mkdirSync(home);
  mkdirSync(repo);
  const dbPath = join(home, 'segreant.db');
  new Store(dbPath).close();
  seedLargeLedger(dbPath);
  const env = { ...process.env, SEGREANT_HOME: home, SEGREANT_DB: dbPath, SEGREANT_DEMO: '', HOME: scratch, USERPROFILE: scratch, APPDATA: scratch, LOCALAPPDATA: scratch, XDG_CONFIG_HOME: scratch, NODE_OPTIONS: '', NO_COLOR: '1' };
  const run = (args: string[]) => spawnSync(process.execPath, [join(root, 'dist/cli.js'), ...args], { cwd: repo, env, encoding: 'utf8', timeout: 30000, maxBuffer: 32 * 1024 * 1024 });
  try {
    const month = run(['month', '--json']);
    assert.equal(month.status, 0, month.stderr);
    assert.equal(JSON.parse(month.stdout).summary.requests, 10000, 'current-month JSON read includes every synthetic request');
    const exported = run(['export', '--all', '--json']);
    assert.equal(exported.status, 0, exported.stderr);
    assert.equal(JSON.parse(exported.stdout).data.length, 10000, 'all-time JSON export includes every synthetic request');
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

// Dispatch owns the command list. This table supplies safe read/preview modes;
// a new dispatch group must be classified before the suite can pass.
const modes: Record<string, string[][]> = {
  today: [[]], week: [[]], month: [[]], plan: [[]], quota: [[]], economic: [[], ['--close-status', '--from', '2026-01-01T00:00:00.000Z', '--to', '2026-02-01T00:00:00.000Z']],
  sources: [[]], egress: [[], ['verify'], ['plan', '--mode', 'local_locked']],
  causal: [['status'], ['inspect', 'missing-study'], ['verify', 'missing-study'], ['ope', '--options', '$options'], ['design', '--options', '$options'], ['transport', '--options', '$options'], ['family', '--options', '$options'], ['plan', '--study', 'missing-study', '--options', '$options']],
  capital: [['evaluate', '--options', '$options']], config: [[]], features: [[]], market: [[]],
  budget: [[], ['--recommend'], ['--control', '--policy', '$options']], alerts: [[]],
  export: [[], ['--economic', '--all']], home: [[]], guide: [[]], doctor: [[]], audit: [['--repo', '$repo']],
  yield: [['--repo', '$repo']], realize: [['--repo', '$repo']], roi: [['--repo', '$repo']], saved: [['--repo', '$repo']], frontier: [['--repo', '$repo']],
  usage: [[]], outcome: [['report']], judge: [['--session', 'missing-session']], team: [[]],
  evidence: [['ux', '--options', '$options']], import: [['codex', '--root', '$folder']],
  billing: [['status'], ['export'], ['scope', 'status'], ['mapping', 'status'], ['openai-costs', 'status'], ['openai-costs', 'coverage'], ['openai-costs', 'preview', '--from', '2026-01-01', '--to', '2026-02-01'], ['reconcile']],
  alloc: [['centres'], ['rules'], ['runs'], ['run', '--from', '2026-01-01T00:00:00.000Z', '--to', '2026-02-01T00:00:00.000Z']],
  discover: [[]], scan: [['$folder']], receipt: [['--verify', '$absent', '--key-id', 'fixture-signer']], project: [[], ['--coverage']],
  restore: [['--from', '$absent', '--out', '$restore']], pack: [['inspect', '$absent'], ['verify', '$absent']],
  plugin: [['run', '--manifest', '$absent', '--request', '$absent', '--exec', '$absent', '--scope', 'fixture=yes']],
  diagnostics: [[]], pricing: [[], ['--coverage']], reprice: [[]], baseline: [[]],
};
const excluded: Record<string, string> = {
  demo: 'seed/server operation without JSON', start: 'persistent server without JSON',
  statusline: 'stdin status-line protocol, not JSON read output', connect: 'setup recipes without JSON',
  init: 'configuration writer without JSON', report: 'outcome writer without JSON',
  exec: 'wrapped process stdout', launch: 'wrapped process stdout', prune: 'maintenance preview without JSON',
  backup: 'creates a ledger artifact; restore preview covers its read contract',
  help: 'help prose', version: 'version text',
};

test('the CLI envelope never overwrites a version that belongs to another schema', () => {
  // A period-close record or signed artifact may own a schemaVersion with its own
  // meaning. Rewriting it to the CLI's number would misdescribe that document.
  const owned = cliJsonResponse({ kind: 'period_close', schemaVersion: CLI_JSON_SCHEMA_VERSION + 6, result: null });
  assert.equal(owned.schemaVersion, CLI_JSON_SCHEMA_VERSION + 6);
  assert.equal(cliJsonResponse({ ok: true }).schemaVersion, CLI_JSON_SCHEMA_VERSION);
  assert.deepEqual(cliJsonResponse([1, 2]), { schemaVersion: CLI_JSON_SCHEMA_VERSION, data: [1, 2] });
});

test('every dispatch command and alias is classified for JSON read coverage', () => {
  assert.ok(groups.length > 40, 'dispatch extraction must see the actual switch');
  assert.deepEqual(groups.map((group) => group[0]).filter((name) => !(name! in modes) && !(name! in excluded)), []);
  assert.deepEqual(Object.keys(modes).filter((name) => !groups.some((group) => group[0] === name)), []);
});

test('JSON cap output has an explicit schema version', () => {
  const home = mkdtempSync(join(tmpdir(), 'segreant-json-version-'));
  try {
    const result = spawnSync(process.execPath, [join(root, 'dist/cli.js'), 'budget', '--json'], {
      encoding: 'utf8', env: { ...process.env, SEGREANT_HOME: home, SEGREANT_DB: join(home, 'segreant.db'), SEGREANT_DEMO: '' },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).schemaVersion, 1);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('dispatch-derived JSON reads preserve one versioned document across generated adversarial fixtures', async (t) => {
  const scratch = mkdtempSync(join(tmpdir(), 'segreant-json-matrix-'));
  try {
    for (const kind of ['missing', 'empty', 'corrupt', 'huge', 'no-git']) {
      const folder = join(scratch, kind);
      const home = join(folder, 'home');
      const repo = join(folder, 'repo');
      mkdirSync(repo, { recursive: true });
      if (kind !== 'missing') mkdirSync(home);
      if (kind !== 'no-git') {
        const git = spawnSync('git', ['init', '--quiet', repo], { encoding: 'utf8' });
        assert.equal(git.status, 0, git.stderr);
      }
      if (kind === 'corrupt') writeFileSync(join(home, 'segreant.db'), 'not a SQLite database');
      if (kind === 'empty' || kind === 'no-git' || kind === 'huge') new Store(join(home, 'segreant.db')).close();
      if (kind === 'huge') {
        // Large synthetic ledger plus long labels and many files. No owner data,
        // tool logs, credentials, or downloaded corpus is involved.
        seedLargeLedger(join(home, 'segreant.db'));
        for (let n = 0; n < 200; n++) writeFileSync(join(repo, `fixture-${n}.txt`), 'synthetic\n'.repeat(1000));
      }
      const options = join(folder, 'options.json');
      writeFileSync(options, '{}');
      const replacements: Record<string, string> = { '$repo': repo, '$folder': repo, '$options': options, '$absent': join(folder, 'absent.json'), '$restore': join(folder, 'restore.db') };
      const env = { ...process.env, SEGREANT_HOME: home, SEGREANT_DB: join(home, 'segreant.db'), SEGREANT_DEMO: '', HOME: folder, USERPROFILE: folder, APPDATA: folder, LOCALAPPDATA: folder, XDG_CONFIG_HOME: folder, NODE_OPTIONS: '', NO_COLOR: '1' };
      for (const aliases of groups) {
        const variants = modes[aliases[0]!];
        if (!variants) continue;
        for (const command of aliases) {
          for (const variant of variants) {
            const args = [command, ...variant.map((arg) => replacements[arg] ?? arg), '--json'];
            await t.test(`${kind}: ${command} ${variant.join(' ')}`, () => {
              // Exercise the emitted dispatch in a fresh process. Launcher
              // publication/snapshot behavior has its own dedicated tests.
              const result = spawnSync(process.execPath, [join(root, 'dist/cli.js'), ...args], { cwd: repo, env, encoding: 'utf8', timeout: 30000, maxBuffer: 32 * 1024 * 1024 });
              assert.equal(result.error, undefined, result.error?.message ?? 'CLI process failed');
              assert.doesNotMatch(result.stderr, /\n\s+at |(?:Type|Syntax|Range)Error:.*\n/, 'stderr has no stack trace');
              const stdout = result.stdout.trim();
              if (stdout.length === 0) {
                assert.notEqual(result.status, 0, 'empty success is not a machine-output contract');
                assert.ok(result.stderr.trim().length > 0, 'refusal explains the missing input');
                assert.ok(result.stderr.length < 4096, 'refusal is concise');
              } else {
                const payload = JSON.parse(stdout) as { schemaVersion?: unknown };
                assert.equal(payload.schemaVersion, 1, 'successful/read-error JSON carries its schema version');
              }
            });
          }
        }
      }
      if (kind === 'huge') {
        const month = spawnSync(process.execPath, [join(root, 'dist/cli.js'), 'month', '--json'], { cwd: repo, env, encoding: 'utf8', timeout: 30000, maxBuffer: 32 * 1024 * 1024 });
        assert.equal(month.status, 0, month.stderr);
        assert.equal(JSON.parse(month.stdout).summary.requests, 10000, 'current-month JSON read includes every synthetic request');
        const exported = spawnSync(process.execPath, [join(root, 'dist/cli.js'), 'export', '--economic', '--all', '--json'], { cwd: repo, env, encoding: 'utf8', timeout: 30000, maxBuffer: 32 * 1024 * 1024 });
        assert.equal(exported.status, 0, exported.stderr);
        assert.equal(JSON.parse(exported.stdout).data.length, 10000, 'all-time economic JSON export includes every synthetic request');
      }
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});
