from __future__ import annotations

import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def read(path: str) -> str:
    return (ROOT / path).read_text(encoding='utf-8')


def write(path: str, content: str) -> None:
    p = ROOT / path
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(content, encoding='utf-8')


def replace_once(path: str, old: str, new: str) -> None:
    text = read(path)
    count = text.count(old)
    if count != 1:
        raise SystemExit(f'{path}: expected exactly one replacement target, found {count}')
    write(path, text.replace(old, new, 1))


# ---------------------------------------------------------------------------
# Workstream 2: enforceability is a typed claim, not prose.
# ---------------------------------------------------------------------------
write('src/budget/enforceability.ts', r'''/**
 * Enforcement truth for budget controls.
 *
 * A configured threshold, a blockable threshold, an observed-only amount, and a
 * provider-native control are different claims. This module names the distinction
 * without changing BudgetGuard behavior.
 */

import type { BudgetConfig } from '../config.ts';

export const ENFORCEABILITY_STATES = [
  'enforced_in_path',
  'provider_native',
  'observed_only',
  'proposed',
  'unknown',
] as const;

export type EnforceabilityState = (typeof ENFORCEABILITY_STATES)[number];

export interface BudgetEnforcementDescriptor {
  localProxy: {
    state: 'enforced_in_path';
    mechanism: 'local_proxy';
    /** At least one hard blocker (daily/session/runaway) is configured now. */
    hardControlActive: boolean;
    /** The warning-only daily threshold is configured now. */
    warningActive: boolean;
    /** Dashboard/CLI config changes are read by the running guard. */
    liveConfig: boolean;
    /** Which observed dollars are used to decide whether a future proxy request is blocked. */
    spendScope: 'live_proxy' | 'all_observed';
  };
  importedSpend: {
    state: 'observed_only';
    blockable: false;
    /** Imported spend may influence a later proxy decision, but cannot itself be stopped. */
    countsTowardInPathCap: boolean;
  };
  providerNative: {
    /** Fiscus does not currently inspect or attest provider-side limits. */
    state: 'unknown';
    inspected: false;
  };
  recommendation: {
    /** Budget advice is a proposal until the operator applies it. */
    state: 'proposed';
    automaticallyApplied: false;
  };
}

export function describeBudgetEnforcement(cfg: BudgetConfig): BudgetEnforcementDescriptor {
  return {
    localProxy: {
      state: 'enforced_in_path',
      mechanism: 'local_proxy',
      hardControlActive: cfg.dailyUsd !== null || cfg.sessionUsd !== null || cfg.runawayMaxUsd !== null,
      warningActive: cfg.dailySoftUsd !== null,
      liveConfig: true,
      spendScope: cfg.capIncludesImported ? 'all_observed' : 'live_proxy',
    },
    importedSpend: {
      state: 'observed_only',
      blockable: false,
      countsTowardInPathCap: cfg.capIncludesImported,
    },
    providerNative: {
      state: 'unknown',
      inspected: false,
    },
    recommendation: {
      state: 'proposed',
      automaticallyApplied: false,
    },
  };
}
''')

replace_once(
    'src/dashboard/settings.ts',
    "import { aegisHome, configPath, dbPath } from '../config.ts';\n",
    "import { aegisHome, configPath, dbPath } from '../config.ts';\nimport { describeBudgetEnforcement, type BudgetEnforcementDescriptor } from '../budget/enforceability.ts';\n",
)
replace_once(
    'src/dashboard/settings.ts',
    '  budget: BudgetConfig;\n  connections: ProviderConnection[];\n',
    '  budget: BudgetConfig;\n  enforcement: BudgetEnforcementDescriptor;\n  connections: ProviderConnection[];\n',
)
replace_once(
    'src/dashboard/settings.ts',
    '    budget: config.budget,\n    connections: store.recentProviderConnections(sinceMs),\n',
    '    budget: config.budget,\n    enforcement: describeBudgetEnforcement(config.budget),\n    connections: store.recentProviderConnections(sinceMs),\n',
)

contracts = read('src/dashboard/web/app/core/contracts.ts')
marker = 'export interface SettingsSnapshot {\n'
if contracts.count(marker) != 1:
    raise SystemExit('contracts.ts: SettingsSnapshot marker missing/ambiguous')
enforcement_contract = r'''export type EnforceabilityState =
  | 'enforced_in_path'
  | 'provider_native'
  | 'observed_only'
  | 'proposed'
  | 'unknown';

export interface BudgetEnforcementDescriptor {
  localProxy: {
    state: 'enforced_in_path';
    mechanism: 'local_proxy';
    hardControlActive: boolean;
    warningActive: boolean;
    liveConfig: boolean;
    spendScope: 'live_proxy' | 'all_observed';
  };
  importedSpend: {
    state: 'observed_only';
    blockable: false;
    countsTowardInPathCap: boolean;
  };
  providerNative: { state: 'unknown'; inspected: false };
  recommendation: { state: 'proposed'; automaticallyApplied: false };
}

'''
contracts = contracts.replace(marker, enforcement_contract + marker, 1)
contracts = contracts.replace('  budget: BudgetConfig;\n  connections: Array<Record<string, unknown>>;\n', '  budget: BudgetConfig;\n  enforcement: BudgetEnforcementDescriptor;\n  connections: Array<Record<string, unknown>>;\n', 1)
write('src/dashboard/web/app/core/contracts.ts', contracts)

control = read('src/dashboard/web/app/views/control.ts')
old_header = ''' *   2. Saving a cap writes the config file, but the RUNNING proxy holds its own
 *      config object and does not pick the change up until it restarts. The
 *      server source says so in a comment; before this view, no surface said it
 *      to the person relying on it. A control that silently does not take effect
 *      is worse than no control.
'''
new_header = ''' *   2. A limit configured in Fiscus, off-path/imported spend, and provider-native
 *      limits are different enforcement claims. The screen states which boundary
 *      can actually block a future request instead of collapsing them into “cap”.
'''
if control.count(old_header) != 1:
    raise SystemExit('control.ts: stale restart header not found exactly once')
control = control.replace(old_header, new_header, 1)
control = control.replace('      const includesImported = budget?.capIncludesImported === true;\n', '      const includesImported = budget?.capIncludesImported === true;\n      const enforcement = s.enforcement;\n', 1)
control = control.replace("              text: cap === null ? 'unlimited' : 'enforced',\n", "              text: cap === null ? 'unlimited' : 'enforced in path',\n", 1)
start = control.find('          // The enforcement gap.')
end = control.find('\n\n        // The other three enforcement controls', start)
if start < 0 or end < 0:
    raise SystemExit('control.ts: enforcement-gap block markers missing')
new_block = r'''          // Enforcement is a location/scope claim, not just an on/off flag.
          h('div', { class: 'facts enforcement-facts' },
            h('div', { class: 'fact' },
              h('span', { class: 'fact-key', text: () => (isPrecise() ? 'Local proxy' : 'What Fiscus can stop') }),
              h('span', { class: 'fact-val', text: () => (isPrecise()
                ? `${enforcement.localProxy.state.replaceAll('_', ' ')}${enforcement.localProxy.hardControlActive ? ' · hard control active' : ' · no hard blocker configured'}`
                : (enforcement.localProxy.hardControlActive ? 'future requests are guarded' : 'ready, but no hard limit is set')) })),
            h('div', { class: 'fact' },
              h('span', { class: 'fact-key', text: () => (isPrecise() ? 'Config updates' : 'Changes you save') }),
              h('span', { class: 'fact-val', text: enforcement.localProxy.liveConfig ? 'live · running proxy' : 'not live' })),
            h('div', { class: 'fact' },
              h('span', { class: 'fact-key', text: () => (isPrecise() ? 'Imported / off-path' : 'Usage Fiscus saw later') }),
              h('span', { class: 'fact-val', text: () => (isPrecise()
                ? `${enforcement.importedSpend.state.replaceAll('_', ' ')} · not blockable${enforcement.importedSpend.countsTowardInPathCap ? ' · counts toward later proxy decisions' : ''}`
                : 'visible, but already spent') })),
            h('div', { class: 'fact' },
              h('span', { class: 'fact-key', text: () => (isPrecise() ? 'Provider-native limits' : 'Limits at the AI provider') }),
              h('span', { class: 'fact-val', text: () => (isPrecise()
                ? `${enforcement.providerNative.state} · not inspected`
                : 'not checked by Fiscus') }))),
'''
control = control[:start] + new_block + control[end:]
old_other = '''          h('span', { class: 'basis', text: () => (isPrecise()
            ? 'All four limits are enforced at the proxy and share the same restart caveat as the daily cap.'
            : 'These are set the same way as the daily limit, and need the same restart before they take effect.') })),
'''
new_other = '''          h('span', { class: 'basis', text: () => (isPrecise()
            ? 'All four controls share the same local in-path boundary. Saved changes are visible to the running proxy; off-path spend remains observed-only.'
            : 'All four work at the same Fiscus boundary: they can stop future requests that pass through Fiscus, not usage that already happened elsewhere.') })),
'''
if control.count(old_other) != 1:
    raise SystemExit('control.ts: old other-limits restart copy missing')
control = control.replace(old_other, new_other, 1)
write('src/dashboard/web/app/views/control.ts', control)

server = read('src/dashboard/server.ts')
old_decode = "  const relative = decodeURIComponent(pathname).replace(/^\\/+/, '');\n"
new_decode = "  let relative: string;\n  try {\n    relative = decodeURIComponent(pathname).replace(/^\\/+/, '');\n  } catch {\n    return false; // malformed percent-encoding is an invalid asset path, never a server exception\n  }\n"
if server.count(old_decode) != 1:
    raise SystemExit('server.ts: static decode target missing')
server = server.replace(old_decode, new_decode, 1)
old_comment = '''          // Keep this process's in-memory config in sync so a later plain GET
          // /api/settings doesn't read back stale values until a restart. Note this
          // does NOT reach the separately-constructed proxy server's own config
          // object — live budget enforcement still needs a restart to pick up edits,
          // same as any existing CLI config mutation today.
'''
new_comment = '''          // Keep the shared in-memory config in sync. The running BudgetGuard
          // reads its configuration through a live supplier, so dashboard budget
          // edits affect subsequent in-path decisions without inventing a second
          // control state or waiting for a process restart.
'''
if server.count(old_comment) != 1:
    raise SystemExit('server.ts: stale live-config comment missing')
server = server.replace(old_comment, new_comment, 1)
write('src/dashboard/server.ts', server)

# Capability truth manifest: add the control claim, never rewrite the existing history.
cap_path = ROOT / 'docs' / 'CAPABILITIES.json'
cap = json.loads(cap_path.read_text(encoding='utf-8'))
if not any(x.get('id') == 'control-enforceability' for x in cap.get('truthClaims', [])):
    cap['truthClaims'].append({
        'id': 'control-enforceability',
        'status': 'implemented',
        'basis': 'local proxy controls are enforced in path; imported/off-path spend is observed-only; provider-native controls are not attested',
    })
cap_path.write_text(json.dumps(cap, indent=2) + '\n', encoding='utf-8')

# ---------------------------------------------------------------------------
# Workstream 5: executable exact-SHA release evidence.
# ---------------------------------------------------------------------------
write('scripts/release-verify.mjs', r'''import { createHash } from 'node:crypto';
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
''')

pkg_path = ROOT / 'package.json'
pkg = json.loads(pkg_path.read_text(encoding='utf-8'))
pkg['scripts']['release:verify'] = 'node scripts/release-verify.mjs'
pkg_path.write_text(json.dumps(pkg, indent=2) + '\n', encoding='utf-8')

gitignore = read('.gitignore')
if '.fiscus-release-evidence/' not in gitignore:
    gitignore = gitignore.rstrip() + '\n.fiscus-release-evidence/\n'
write('.gitignore', gitignore)

# ---------------------------------------------------------------------------
# Workstream 6: adversarial local-dashboard boundary tests.
# ---------------------------------------------------------------------------
write('test/dashboard-security-matrix.test.ts', r'''import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { Store } from '../src/store/db.ts';
import { DEFAULT_CONFIG } from '../src/config.ts';
import { createDashboardServer } from '../src/dashboard/server.ts';

async function boot() {
  const store = new Store(':memory:');
  const server = createDashboardServer({ store, config: structuredClone(DEFAULT_CONFIG), version: 'security-test' });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    port,
    base: `http://127.0.0.1:${port}`,
    close: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      store.close();
    },
  };
}

function raw(port: number, path: string, opts: { method?: string; headers?: Record<string, string>; body?: string } = {}) {
  return new Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }>((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path, method: opts.method ?? 'GET', headers: opts.headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.setTimeout(2000, () => req.destroy(new Error('request timeout')));
    req.on('error', reject);
    if (opts.body) req.write(opts.body);
    req.end();
  });
}

test('dashboard security matrix: Host, methods, CSRF, CORS, traversal, malformed paths, and response headers fail closed', async () => {
  const srv = await boot();
  try {
    const rebound = await raw(srv.port, '/api/health', { headers: { Host: 'attacker.example' } });
    assert.equal(rebound.status, 403, 'DNS-rebinding Host must never read local data');

    const wrongMethod = await raw(srv.port, '/api/import');
    assert.equal(wrongMethod.status, 405);
    assert.equal(wrongMethod.headers.allow, 'POST');

    const csrf = await raw(srv.port, '/api/settings/update', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    assert.equal(csrf.status, 403, 'mutation without same-origin custom header must fail');

    const preflight = await raw(srv.port, '/api/settings/update', {
      method: 'OPTIONS',
      headers: { Origin: 'https://attacker.example', 'Access-Control-Request-Method': 'POST' },
    });
    assert.equal(preflight.status, 405);
    assert.equal(preflight.headers['access-control-allow-origin'], undefined, 'server must not opt a hostile origin into CORS');

    const traversal = await raw(srv.port, '/app/%2e%2e%2f%2e%2e%2fpackage.json.js');
    assert.equal(traversal.status, 404, 'encoded traversal must not escape WEB_ROOT');

    const malformed = await raw(srv.port, '/%E0%A4%A.js');
    assert.equal(malformed.status, 404, 'malformed percent-encoding is an invalid asset, not an exception');

    const page = await raw(srv.port, '/');
    assert.equal(page.status, 200);
    const csp = String(page.headers['content-security-policy'] ?? '');
    assert.match(csp, /connect-src 'self'/);
    assert.match(csp, /frame-ancestors 'none'/);
    assert.equal(page.headers['x-content-type-options'], 'nosniff');

    const healthAfter = await raw(srv.port, '/api/health');
    assert.equal(healthAfter.status, 200, 'adversarial requests must not destabilize the local server');
  } finally {
    await srv.close();
  }
});
''')

# ---------------------------------------------------------------------------
# Workstream 7: generated mathematical invariants.
# ---------------------------------------------------------------------------
write('test/property-invariants.test.ts', r'''import { test } from 'node:test';
import assert from 'node:assert/strict';
import { recommendAllocation } from '../src/budget/allocate.ts';
import { anytimeRateInterval } from '../src/value/anytime.ts';
import { computeReturnOnIntelligence, weightedPowerMean, type RealizationLike } from '../src/value/lenses.ts';

function approx(a: number, b: number, eps = 1e-8) {
  assert.ok(Math.abs(a - b) <= eps, `${a} ≈ ${b}`);
}

let rngState = 0x5f3759df;
function rnd(): number {
  rngState = (Math.imul(rngState, 1664525) + 1013904223) >>> 0;
  return rngState / 0x1_0000_0000;
}

function report(realizationRate = 0.7, acceptance = 0.8): RealizationLike {
  const realized = Math.round(realizationRate * 10);
  const units = Array.from({ length: 10 }, (_, i) => ({
    maturing: false,
    acceptance,
    funnel: { realized: i < realized, results: [{ gate: 'shipped' as const, verdict: i < realized ? ('pass' as const) : ('fail' as const) }] },
  }));
  return {
    firstPassAcceptance: acceptance,
    units,
    matured: { realizationRate: realized / 10, totalCostUsd: 10, realizedValueUsd: realized },
  };
}

test('property: allocation conserves the same budget across generated portfolios and tilts', () => {
  for (let caseNo = 0; caseNo < 120; caseNo++) {
    const n = 2 + Math.floor(rnd() * 7);
    const cells = Array.from({ length: n }, (_, i) => ({
      key: `c${i}`,
      costUsd: 0.01 + rnd() * 500,
      roiIndex: rnd() < 0.15 ? null : rnd() * 100,
      realizedValueUsd: rnd() * 500,
    }));
    const tilt = rnd();
    const plan = recommendAllocation(cells, { tilt });
    approx(plan.items.reduce((s, x) => s + x.recommendedUsd, 0), plan.totalUsd, 1e-7);
    assert.ok(plan.items.every((x) => x.recommendedUsd >= -1e-9));
  }
});

test('property: anytime-valid rate intervals always contain the observed Bernoulli rate', () => {
  for (let n = 1; n <= 80; n++) {
    const ks = new Set([0, Math.floor(n / 4), Math.floor(n / 2), Math.floor((3 * n) / 4), n]);
    for (const k of ks) {
      const cs = anytimeRateInterval(k, n);
      const p = k / n;
      assert.ok(cs.low <= p + 1e-12 && p <= cs.high + 1e-12, `${k}/${n}: ${cs.low} ≤ ${p} ≤ ${cs.high}`);
      assert.ok(cs.low >= 0 && cs.high <= 1 && cs.low <= cs.high);
    }
  }
});

test('property: weighted geometric aggregation stays within extrema and is monotone in every lens', () => {
  for (let i = 0; i < 200; i++) {
    const pairs = Array.from({ length: 4 }, () => ({ value: 0.01 + 0.98 * rnd(), weight: 0.1 + 3 * rnd() }));
    const base = weightedPowerMean(pairs, 0);
    const values = pairs.map((p) => p.value);
    assert.ok(base >= Math.min(...values) - 1e-12 && base <= Math.max(...values) + 1e-12);
    const j = i % pairs.length;
    const raised = pairs.map((p, k) => k === j ? { ...p, value: Math.min(1, p.value + 0.05) } : p);
    assert.ok(weightedPowerMean(raised, 0) + 1e-12 >= base, 'raising one lens cannot lower a positive-weight geometric mean');
  }
});

test('property: RoI identification/statistical intervals keep their ordering across generated evidence', () => {
  for (let i = 0; i < 80; i++) {
    const r = computeReturnOnIntelligence(report(0.1 + 0.8 * rnd(), 0.1 + 0.8 * rnd()), {
      lift: 0.2 + 0.6 * rnd(),
      liftRange: { low: 0.1, high: 0.9 },
    });
    const ii = r.instrumentationInterval;
    if (ii.low !== null && ii.observed !== null && ii.high !== null) {
      assert.ok(ii.low <= ii.observed + 1e-12 && ii.observed <= ii.high + 1e-12, `${ii.low} ≤ ${ii.observed} ≤ ${ii.high}`);
    }
    const ri = r.roiInterval;
    if (ri.low !== null && ri.point !== null && ri.high !== null) {
      assert.ok(ri.low <= ri.point + 1e-12 && ri.point <= ri.high + 1e-12);
    }
    const ci = r.compositeInterval;
    if (ci?.low !== null && ci?.point !== null && ci?.high !== null) {
      assert.ok(ci.low <= ci.point + 1e-12 && ci.point <= ci.high + 1e-12);
    }
  }
});

test('property: causal return never exceeds gross return when counterfactual credit is in [0,1]', () => {
  for (let i = 0; i <= 20; i++) {
    const credit = i / 20;
    const r = computeReturnOnIntelligence(report(), {
      lift: credit,
      liftRange: { low: Math.max(0, credit - 0.1), high: Math.min(1, credit + 0.1) },
      grossRealizedValueUsd: 50,
      laborRatePerHour: 60,
      supervisionMinutes: 10,
    });
    const gross = r.returnRatio.grossRatio;
    const causal = r.returnRatio.causalRatio;
    assert.ok(gross !== null && causal !== null);
    assert.ok(causal! <= gross! + 1e-12);
    assert.ok((r.returnRatio.causalRange.low ?? 0) <= (r.returnRatio.causalRange.high ?? Infinity));
  }
});
''')

write('test/enforceability.test.ts', r'''import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DEFAULT_CONFIG } from '../src/config.ts';
import { ENFORCEABILITY_STATES, describeBudgetEnforcement } from '../src/budget/enforceability.ts';

const cfg = () => structuredClone(DEFAULT_CONFIG).budget;

test('enforceability vocabulary is closed and includes in-path, provider, observed, proposed, and unknown states', () => {
  assert.deepEqual(ENFORCEABILITY_STATES, ['enforced_in_path', 'provider_native', 'observed_only', 'proposed', 'unknown']);
});

test('budget enforcement descriptor distinguishes capability, active controls, off-path spend, and uninspected provider controls', () => {
  const empty = describeBudgetEnforcement(cfg());
  assert.equal(empty.localProxy.state, 'enforced_in_path');
  assert.equal(empty.localProxy.hardControlActive, false, 'capability exists even when no hard threshold is configured');
  assert.equal(empty.localProxy.liveConfig, true);
  assert.equal(empty.localProxy.spendScope, 'live_proxy');
  assert.deepEqual(empty.importedSpend, { state: 'observed_only', blockable: false, countsTowardInPathCap: false });
  assert.deepEqual(empty.providerNative, { state: 'unknown', inspected: false });
  assert.deepEqual(empty.recommendation, { state: 'proposed', automaticallyApplied: false });

  const governed = cfg();
  governed.dailyUsd = 25;
  governed.dailySoftUsd = 20;
  governed.capIncludesImported = true;
  const d = describeBudgetEnforcement(governed);
  assert.equal(d.localProxy.hardControlActive, true);
  assert.equal(d.localProxy.warningActive, true);
  assert.equal(d.localProxy.spendScope, 'all_observed');
  assert.equal(d.importedSpend.blockable, false, 'including sunk spend in the decision does not make sunk spend blockable');
  assert.equal(d.importedSpend.countsTowardInPathCap, true);
});

test('Control UI no longer tells operators a live budget change requires a restart', () => {
  const source = readFileSync(new URL('../src/dashboard/web/app/views/control.ts', import.meta.url), 'utf8');
  assert.ok(!source.includes('Applies at proxy restart'));
  assert.ok(!source.includes('Changes need a restart'));
  assert.ok(!source.includes('share the same restart caveat'));
  assert.ok(source.includes('enforced in path'));
  assert.ok(source.includes('Provider-native limits'));
});
''')

# Extend existing settings tests to pin the transport descriptor.
settings_test = read('test/dashboard-settings.test.ts')
old_assert = "  assert.equal(snap.retentionDays, 180);\n  assert.equal(snap.connections.length, 1);\n"
new_assert = "  assert.equal(snap.retentionDays, 180);\n  assert.equal(snap.enforcement.localProxy.state, 'enforced_in_path');\n  assert.equal(snap.enforcement.localProxy.liveConfig, true);\n  assert.equal(snap.enforcement.importedSpend.state, 'observed_only');\n  assert.equal(snap.connections.length, 1);\n"
if settings_test.count(old_assert) != 1:
    raise SystemExit('dashboard-settings.test.ts: snapshot assertion marker missing')
settings_test = settings_test.replace(old_assert, new_assert, 1)
write('test/dashboard-settings.test.ts', settings_test)

print('phase3 trust machinery applied')
