/**
 * AegisFlow command-line interface.
 *
 *   aegisflow start            start the proxy + local dashboard
 *   aegisflow today|week|month show spend for a window  (--json for raw)
 *   aegisflow init             write a default config and print setup steps
 *   aegisflow budget ...       set soft/hard caps
 *   aegisflow audit --repo .   correlate spend with git commits
 *   aegisflow config           show config + paths
 *   aegisflow prune            prune old rows and compact the database
 */

import './util/quiet.ts';
import { Store } from './store/db.ts';
import { createProxyServer } from './proxy/server.ts';
import { createDashboardServer } from './dashboard/server.ts';
import {
  loadConfig,
  saveConfig,
  dbPath,
  demoDbPath,
  isDemo,
  unlinkDemoDb,
  configPath,
  aegisHome,
  DEFAULT_CONFIG,
  type AegisConfig,
} from './config.ts';
import { seedDemo, demoLiftOptions } from './demo/seed.ts';
import { startOfLocalDay } from './budget/guard.ts';
import { attributeCommits, isGitRepo, projectName, resolveCommit } from './git/correlate.ts';
import { computeQuality } from './git/quality.ts';
import {
  computeRealization,
  loadRealization,
  liftOptionsFromStore,
  moneyInputsFromStore,
  realizeDiscoveredProjects,
  projectValueBreakdown,
  projectTaskStrata,
  type ProjectValue,
  type ProjectTaskStratum,
} from './value/realization.ts';
import { scanWithDiff, saveScan, type ScanDiff } from './scan/scan.ts';
import { computeReturnOnIntelligence } from './value/lenses.ts';
import { describeSourceDepth } from './value/sourceDepth.ts';
import { boundedLift } from './value/lift.ts';
import { resolveBaselineMinutesForRepo, refreshBaselineManifest, baselineManifestStatus } from './value/liftBaseline.ts';
import { refreshPricing, pricingStatus, DEFAULT_MANIFEST_URL } from './cost/pricing.ts';
import { computeFrontier } from './value/frontier.ts';
import { computeUsageRoI } from './value/usage.ts';
import { computeCohort, userValueRows, selfView } from './value/cohort.ts';
import { recommendBudget } from './budget/recommend.ts';
import { recommendAllocation } from './budget/allocate.ts';
import { shadowPriceOfIntelligence, estimateBetaFromPairs } from './value/marginal.ts';
import { goodhartStreams } from './value/drift.ts';
import { instrumentationPriority } from './value/voi.ts';
import { estimateBetaPrior, shrinkRate } from './value/reliability.ts';
import { buildGuide, type GuideFacts } from './guide.ts';
import { computeAlerts } from './alerts/detect.ts';
import { notifyWebhook } from './alerts/notify.ts';
import { requestsToCsv } from './export/csv.ts';
import { GATE_LADDER, GATE_META, type Gate, type Verdict } from './value/gates.ts';
import {
  loadOrCreateKeyPair,
  buildReceiptBody,
  signReceipt,
  verifyReceipt,
  type SignedReceipt,
  type VerifyOptions,
  type KeyPair,
} from './value/receipt.ts';
import { buildRollupBody, signRollup, type SignedRollup } from './team/rollup.ts';
import { judgeSessionFromStore } from './judge/orchestrate.ts';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync, copyFileSync, mkdirSync } from 'node:fs';
import { SOURCE_HEADER, CONNECTORS, GEMINI_OPENAI_COMPAT_BASE, opencodeProviderBlock, mergeOpencodeConfig, resolveOpencodeConfigPath, listOpencodeProviders, wrapOpencodeProvider } from './connect/connectors.ts';
import { importClaudeCode, defaultClaudeCodeRoot } from './connect/claudeCode.ts';
import { importOpencode, defaultOpencodeDbPath } from './connect/opencode.ts';
import { importCodex, defaultCodexRoot } from './connect/codex.ts';
import { type ImportSummary } from './connect/importShared.ts';

import { C, color, usd, num, pct, glyph, noteSource, printNotAGitRepo } from './cli/ui.ts';
import { parseFlags, rangeFor, type Flags } from './cli/flags.ts';
import { cmdImport, cmdDiscover, cmdScan } from './cli/importCmd.ts';
import { cmdYield, cmdRealize, cmdReport, cmdUsage, cmdRoi, cmdBudgetAdvisor, cmdFrontier } from './cli/valueCmd.ts';
import { cmdTeam, cmdReceipt, cmdJudge, cmdTeamPush } from './cli/teamCmd.ts';
import { cmdConnect } from './cli/connectCmd.ts';
import { cmdAlerts, cmdDoctor, cmdInit, cmdGuide, cmdAudit } from './cli/opsCmd.ts';

function cmdShow(window: 'today' | 'week' | 'month', flags: Flags): void {
  const cfg = loadConfig();
  const store = new Store(dbPath());
  const { startMs, endMs, label } = rangeFor(window);
  const summary = store.summary(startMs, endMs);
  const byModel = store.byModel(startMs, endMs);
  const byProject = store.byProject(startMs, endMs);
  const byUser = store.byUser(startMs, endMs);
  const bySource = store.bySource(startMs, endMs);

  if (flags.json) {
    process.stdout.write(JSON.stringify({ window, label, demo: isDemo(), summary, byModel, byProject, byUser, bySource }, null, 2) + '\n');
    store.close();
    return;
  }

  const tty = process.stdout.isTTY ?? false;
  const todaySpend = store.spendBetween(startOfLocalDay(), Date.now() + 1000);
  console.log('');
  console.log(color(tty, C.bold, `  AegisFlow — ${label}`));
  console.log(color(tty, C.gray, '  ' + '─'.repeat(46)));
  if (isDemo()) console.log(color(tty, C.yellow, '  ● DEMO DATA — synthetic, isolated in demo.db'));
  console.log(`  Spend       ${color(tty, C.green, usd(summary.costUsd))}   ${color(tty, C.gray, `(${num(summary.requests)} requests)`)}`);
  console.log(`  Input       ${num(summary.inputTokens)} tokens`);
  console.log(`  Output      ${num(summary.outputTokens)} tokens`);

  if (window === 'today') {
    const alerts = computeAlerts(store, cfg);
    if (alerts.length) {
      const crit = alerts.filter((a) => a.severity === 'critical').length;
      const top = alerts[0]!;
      const sevColor = top.severity === 'critical' ? C.red : top.severity === 'warn' ? C.yellow : C.gray;
      console.log('');
      console.log(
        `  ${color(tty, sevColor, `● ${alerts.length} ${alerts.length === 1 ? 'alert' : 'alerts'}`)}${crit ? color(tty, C.red, ` (${crit} critical)`) : ''}  ${color(tty, C.gray, `— ${top.title}. Run: aegisflow alerts`)}`,
      );
    }
  }

  if (cfg.budget.dailyUsd !== null) {
    const remaining = Math.max(0, cfg.budget.dailyUsd - todaySpend);
    const pct = Math.min(100, (todaySpend / cfg.budget.dailyUsd) * 100);
    console.log('');
    console.log(`  Daily cap   ${usd(cfg.budget.dailyUsd)}   ${color(tty, pct > 90 ? C.red : pct > 70 ? C.yellow : C.green, `${pct.toFixed(0)}% used`)}   ${color(tty, C.gray, `${usd(remaining)} left`)}`);
  }

  if (byModel.length) {
    console.log('');
    console.log(color(tty, C.bold, '  By model'));
    for (const m of byModel.slice(0, 8)) {
      const name = `${m.provider}/${m.label}`.padEnd(34);
      console.log(`  ${name} ${usd(m.costUsd).padStart(11)}  ${color(tty, C.gray, `${num(m.requests)} req`)}`);
    }
  }

  if (byProject.length > 1) {
    console.log('');
    console.log(color(tty, C.bold, '  By project'));
    for (const p of byProject.slice(0, 8)) {
      console.log(`  ${p.label.padEnd(34)} ${usd(p.costUsd).padStart(11)}`);
    }
  }

  if (byUser.some((u) => u.label !== 'unassigned')) {
    console.log('');
    console.log(color(tty, C.bold, '  By user'));
    for (const u of byUser.slice(0, 8)) {
      console.log(`  ${u.label.padEnd(34)} ${usd(u.costUsd).padStart(11)}  ${color(tty, C.gray, `${num(u.requests)} req`)}`);
    }
  }

  if (bySource.some((s) => s.label !== 'direct')) {
    console.log('');
    console.log(color(tty, C.bold, '  By source'));
    for (const s of bySource.slice(0, 8)) {
      console.log(`  ${s.label.padEnd(34)} ${usd(s.costUsd).padStart(11)}  ${color(tty, C.gray, `${num(s.requests)} req`)}`);
    }
    console.log(color(tty, C.gray, '  → per-source depth + model mix:  aegisflow sources'));
  }
  console.log('');
  console.log(color(tty, C.gray, `  Dashboard: run "aegisflow start" then open http://localhost:${cfg.dashboardPort}`));
  console.log('');
  store.close();
}

/**
 * Spend by connected source — each AI tool deliberately routed through AegisFlow.
 * This is the "connect, don't intercept" view: a source is a feed, and its depth
 * is honest about how much of the loop it exposes (a proxy-connected tool gives
 * spend + attribution; untagged traffic is 'direct' and spend-only).
 */
function cmdSources(flags: Flags): void {
  const store = new Store(dbPath());
  const all = Boolean(flags.all);
  const now = Date.now();
  const startMs = all ? 0 : now - 30 * 24 * 60 * 60 * 1000;
  // Each source carries its measured depth (spend / + acceptance / + RoI),
  // read off real signals via the shared helper — same wording as the dashboard.
  const bySource = store.bySourceWithDepth(startMs, now + 1000).map((s) => ({ ...s, ...describeSourceDepth(s) }));
  // Model mix WITHIN each source (Source→Model), grouped for display.
  const modelsBySource = new Map<string, Array<{ provider: string; model: string; costUsd: number; requests: number }>>();
  for (const m of store.sourceModelBreakdown(startMs, now + 1000)) {
    const list = modelsBySource.get(m.source) ?? [];
    list.push({ provider: m.provider, model: m.model, costUsd: m.costUsd, requests: m.requests });
    modelsBySource.set(m.source, list);
  }

  if (flags.json) {
    const enriched = bySource.map((s) => ({ ...s, models: modelsBySource.get(s.label) ?? [] }));
    process.stdout.write(JSON.stringify({ window: all ? 'all' : '30d', demo: isDemo(), bySource: enriched }, null, 2) + '\n');
    store.close();
    return;
  }

  const tty = process.stdout.isTTY ?? false;
  console.log('');
  console.log(color(tty, C.bold, '  AegisFlow — sources (connected AI feeds)'));
  console.log(color(tty, C.gray, '  ' + '─'.repeat(46)));
  if (isDemo()) console.log(color(tty, C.yellow, '  ● DEMO DATA — synthetic, isolated in demo.db'));
  console.log(color(tty, C.gray, `  ${all ? 'all time' : 'last 30 days'} · spend grouped by the tool each request was routed from`));
  console.log('');

  if (!bySource.length) {
    console.log(color(tty, C.gray, '  No metered traffic yet. Connect a tool as a source, then run it:'));
    console.log(color(tty, C.green, '    aegisflow connect opencode'));
    console.log('');
    store.close();
    return;
  }

  for (const s of bySource.slice(0, 12)) {
    const tag = s.full ? color(tty, C.green, ' ✓ full RoI') : '';
    console.log(`  ${s.label.padEnd(20)} ${usd(s.costUsd).padStart(11)}  ${color(tty, C.gray, `${num(s.requests)} req · ${s.depth}`)}${tag}`);
    // Source→Model: the top models this source spent on.
    for (const m of (modelsBySource.get(s.label) ?? []).slice(0, 3)) {
      console.log(color(tty, C.gray, `      ${`${m.provider}/${m.model}`.padEnd(30)} ${usd(m.costUsd).padStart(11)}  ${num(m.requests)} req`));
    }
  }
  console.log('');
  console.log(color(tty, C.gray, '  Depth is read from real signals: spend always · + acceptance once a source sends'));
  console.log(color(tty, C.gray, '  proposed edits · + RoI once its work reaches projects with realized value.'));
  console.log(color(tty, C.gray, "  A source is one AI tool deliberately routed through AegisFlow (connect, don't intercept)."));
  console.log(color(tty, C.gray, '  Tag one with:  aegisflow connect <tool>   — the tag is stripped before traffic leaves your machine.'));
  console.log('');
  store.close();
}

function cmdExport(flags: Flags): void {
  const store = new Store(dbPath());
  const now = Date.now();
  const dayMs = 24 * 60 * 60 * 1000;
  const days = flags.days ? Number(flags.days) : 30;
  const startMs = flags.all ? 0 : now - days * dayMs;
  const rows = store.requestsInRange(startMs, now + 1000);
  const asJson = flags.json === true || flags.format === 'json';
  const out = asJson ? JSON.stringify(rows, null, 2) + '\n' : requestsToCsv(rows);

  if (typeof flags.out === 'string') {
    writeFileSync(flags.out, out);
    const tty = process.stdout.isTTY ?? false;
    console.error(color(tty, C.green, `  Exported ${num(rows.length)} requests (${asJson ? 'json' : 'csv'}) → ${flags.out}`));
  } else {
    process.stdout.write(out);
  }
  store.close();
}

function cmdConfig(flags: Flags): void {
  const cfg = loadConfig();
  if (flags.json) {
    process.stdout.write(JSON.stringify({ home: aegisHome(), configPath: configPath(), dbPath: dbPath(), config: cfg }, null, 2) + '\n');
    return;
  }
  console.log('');
  console.log(`  Home:   ${aegisHome()}`);
  console.log(`  Config: ${configPath()}`);
  console.log(`  DB:     ${dbPath()}`);
  console.log('');
  console.log(JSON.stringify(cfg, null, 2));
  console.log('');
}

function cmdBudget(flags: Flags): void {
  const cfg = loadConfig();
  const next: AegisConfig = { ...cfg, budget: { ...cfg.budget } };
  const setNum = (key: 'dailyUsd' | 'dailySoftUsd' | 'sessionUsd' | 'runawayMaxUsd', flag: string) => {
    if (flags[flag] !== undefined) {
      const v = String(flags[flag]);
      next.budget[key] = v === 'off' || v === 'none' ? null : Number(v);
    }
  };
  setNum('dailyUsd', 'daily');
  setNum('dailySoftUsd', 'soft');
  setNum('sessionUsd', 'session');
  setNum('runawayMaxUsd', 'runaway');
  if (flags.window !== undefined) next.budget.runawayWindowSec = Number(flags.window);
  saveConfig(next);

  console.log('');
  console.log('  Budget updated:');
  console.log(`    Daily hard cap:   ${next.budget.dailyUsd === null ? 'off' : usd(next.budget.dailyUsd)}`);
  console.log(`    Daily soft warn:  ${next.budget.dailySoftUsd === null ? 'off' : usd(next.budget.dailySoftUsd)}`);
  console.log(`    Per-session cap:  ${next.budget.sessionUsd === null ? 'off' : usd(next.budget.sessionUsd)}`);
  console.log(`    Runaway guard:    ${next.budget.runawayMaxUsd === null ? 'off' : `${usd(next.budget.runawayMaxUsd)} / ${next.budget.runawayWindowSec}s`}`);
  console.log('');
}

/**
 * Ambient outcome capture — `aegisflow exec [--kind K] [--commit R|--session S] -- <cmd…>`.
 *
 * The adoption cliff of outcome reporting is the human in the loop: every manual
 * `report` decays to zero compliance. But machines already KNOW outcomes — as
 * exit codes. Wrap the test/deploy command once (a package.json script, a shell
 * alias, a Makefile target) and every run reports itself: exit 0 → the gate
 * passes, non-zero → it honestly fails. The wrapper is transparent — the wrapped
 * command's stdio and exit code pass straight through, so pipelines and CI steps
 * behave identically. Our own chatter goes to stderr only.
 */

async function cmdExec(flags: Flags, command: string[]): Promise<void> {
  const codeKinds = ['tested', 'merged', 'shipped'];
  const usageKinds = ['used', 'resolved', 'published'];
  const kind = String(flags.kind ?? 'tested');
  if (![...codeKinds, ...usageKinds].includes(kind)) {
    console.error(`  Usage: aegisflow exec [--kind <${[...codeKinds, ...usageKinds].join('|')}>] [--commit <ref> | --session <id>] -- <command…>`);
    process.exitCode = 1;
    return;
  }
  if (command.length === 0) {
    console.error('  Nothing to run. Put the wrapped command after a bare "--":  aegisflow exec -- npm test');
    process.exitCode = 1;
    return;
  }
  if (usageKinds.includes(kind) && !flags.session) {
    console.error(`  Non-code outcome "${kind}" needs --session <id>.`);
    process.exitCode = 1;
    return;
  }

  // Resolve the ref BEFORE running: the outcome belongs to the work that was
  // current when the command started (HEAD may move underneath a long run).
  let ref: string | null = null;
  let project = 'default';
  if (flags.session) {
    ref = String(flags.session);
  } else {
    const repo = (flags.repo as string) ?? process.cwd();
    if (flags.commit) {
      if (!(await isGitRepo(repo))) {
        printNotAGitRepo(repo);
        process.exitCode = 1;
        return;
      }
      ref = await resolveCommit(repo, String(flags.commit));
      if (!ref) {
        console.error(`  Could not resolve commit: ${String(flags.commit)}`);
        process.exitCode = 1;
        return;
      }
      project = await projectName(repo);
    } else if (await isGitRepo(repo)) {
      ref = await resolveCommit(repo, 'HEAD');
      project = await projectName(repo);
    }
  }

  const started = Date.now();
  const exitCode: number = await new Promise((resolve) => {
    // Windows tool entrypoints (npm, npx, …) are .cmd shims that need a shell;
    // elsewhere spawn directly — no word-splitting surprises.
    const child =
      process.platform === 'win32'
        ? spawn(command.join(' '), { stdio: 'inherit', shell: true })
        : spawn(command[0]!, command.slice(1), { stdio: 'inherit' });
    child.on('error', (e) => {
      console.error(`  aegisflow exec: could not start "${command[0]}": ${String(e)}`);
      resolve(127);
    });
    child.on('close', (code) => resolve(code ?? 1));
  });
  const secs = ((Date.now() - started) / 1000).toFixed(1);
  const verdict = exitCode === 0 ? 'pass' : 'fail';

  const store = new Store(dbPath());
  store.insertSignal({
    signalId: randomUUID(),
    kind,
    commitHash: ref,
    project,
    tsEpochMs: Date.now(),
    verdict,
    detail: `ambient: "${command.join(' ')}" exit ${exitCode} in ${secs}s`,
  });
  store.close();

  const tty = process.stderr.isTTY ?? false;
  console.error(color(tty, C.gray, `  [aegisflow] ${kind} = ${verdict} (exit ${exitCode}, ${secs}s)${ref ? ` → ${ref.slice(0, 12)}` : ' (project-wide)'}`));
  process.exitCode = exitCode; // transparent: the wrapper never changes what the pipeline sees
}

function cmdPrune(): void {
  const cfg = loadConfig();
  const store = new Store(dbPath());
  const before = Date.now() - cfg.retentionDays * 24 * 60 * 60 * 1000;
  const removed = store.prune(before);
  console.log(`  Pruned ${removed} request rows older than ${cfg.retentionDays} days and compacted the database.`);
  store.close();
}

async function cmdStart(flags: Flags): Promise<void> {
  const cfg = loadConfig();
  if (flags.port) cfg.port = Number(flags.port);
  if (flags['dashboard-port']) cfg.dashboardPort = Number(flags['dashboard-port']);

  const store = new Store(dbPath());
  const tty = process.stdout.isTTY ?? false;

  // Honor pricing.autoRefresh: if the rate card is stale and a manifest is set,
  // pull a fresh one on launch so metering prices at current rates. OFF by default
  // (keeps "zero external requests" true out of the box); a failure never blocks
  // the daemon — we keep the current table and say so.
  if (cfg.pricing.autoRefresh && pricingStatus(cfg.pricing.maxAgeDays).stale) {
    const res = await refreshPricing(cfg.pricing.manifestUrl);
    console.log(
      res.ok
        ? color(tty, C.gray, `  ↻ pricing refreshed — ${res.modelCount} models (${cfg.pricing.manifestUrl ?? DEFAULT_MANIFEST_URL})`)
        : color(tty, C.yellow, `  ↻ pricing auto-refresh skipped: ${res.error ?? 'unreachable'} — keeping current table`),
    );
  }

  const proxy = createProxyServer({
    store,
    config: cfg,
    onLog: (row) => {
      if (row.statusCode === 429) {
        console.log(color(tty, C.red, `  ⛔ blocked  ${row.provider}/${row.model}  (budget)`));
        return;
      }
      const today = store.spendBetween(startOfLocalDay(), Date.now() + 1000);
      const time = new Date(row.tsEpochMs).toLocaleTimeString('en-US', { hour12: false });
      const est = row.estimated ? color(tty, C.yellow, ' ~est') : '';
      console.log(
        `  ${color(tty, C.gray, time)}  ${row.provider}/${row.model}  ` +
          `in ${num(row.inputTokens)} out ${num(row.outputTokens)}  ` +
          `${color(tty, C.green, usd(row.costUsd))}${est}  ${color(tty, C.gray, `today ${usd(today)}`)}`,
      );
    },
  });
  const dashboard = createDashboardServer({ store, config: cfg });

  await new Promise<void>((resolve) => proxy.listen(cfg.port, '127.0.0.1', resolve));
  await new Promise<void>((resolve) => dashboard.listen(cfg.dashboardPort, '127.0.0.1', resolve));

  printBanner(cfg, tty);

  const shutdown = () => {
    console.log('\n  Shutting down…');
    proxy.close();
    dashboard.close();
    store.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

function printBanner(cfg: AegisConfig, tty: boolean): void {
  const line = (s: string) => console.log('  ' + s);
  console.log('');
  line(color(tty, C.bold, '╔════════════════════════════════════════════════════════╗'));
  line(color(tty, C.bold, '║   AegisFlow  ·  local AI-spend proxy is running         ║'));
  line(color(tty, C.bold, '╚════════════════════════════════════════════════════════╝'));
  console.log('');
  line(`Proxy      ${color(tty, C.cyan, `http://localhost:${cfg.port}`)}`);
  line(`Dashboard  ${color(tty, C.cyan, `http://localhost:${cfg.dashboardPort}`)}`);
  console.log('');
  if (isDemo()) {
    line(color(tty, C.yellow, '● DEMO DATA — synthetic, isolated in demo.db. Real metering is untouched.'));
    console.log('');
  }
  line(color(tty, C.bold, 'Point your tools here (PowerShell):'));
  line(color(tty, C.gray, `  $env:ANTHROPIC_BASE_URL="http://localhost:${cfg.port}"`));
  line(color(tty, C.gray, `  $env:OPENAI_BASE_URL="http://localhost:${cfg.port}/v1"`));
  console.log('');
  if (cfg.budget.dailyUsd !== null) {
    line(`Daily cap  ${usd(cfg.budget.dailyUsd)}  ${color(tty, C.gray, '(set with: aegisflow budget --daily N)')}`);
  } else {
    line(color(tty, C.gray, 'No budget cap set. Add one: aegisflow budget --daily 25 --soft 18'));
  }
  console.log('');
  line(color(tty, C.gray, 'Press Ctrl+C to stop. Traffic falls straight through if AegisFlow is off.'));
  console.log('');
}

async function cmdDemo(flags: Flags): Promise<void> {
  const tty = process.stdout.isTTY ?? false;

  if (flags.clear) {
    unlinkDemoDb();
    console.log(color(tty, C.gray, `  Demo data cleared.  (${demoDbPath()})`));
    return;
  }

  // Fresh DB each run keeps the deterministic seed ids collision-free.
  unlinkDemoDb();
  const store = new Store(dbPath()); // resolves to demo.db (env set in main)
  const res = seedDemo(store);
  store.close();

  console.log('');
  console.log(color(tty, C.bold, '  AegisFlow — demo data generated'));
  console.log(color(tty, C.gray, '  ' + '─'.repeat(52)));
  console.log(
    `  ${num(res.requests)} requests · ${num(res.blocked)} blocked · ` +
      `${num(res.sessions)} sessions · ${num(res.signals)} reported outcomes`,
  );
  console.log(`  ${color(tty, C.green, usd(res.totalCostUsd))} of synthetic spend across ${res.days} days`);
  console.log('');
  console.log(color(tty, C.yellow, '  ● DEMO DATA — synthetic, priced by the real engine, isolated in demo.db.'));
  console.log(color(tty, C.gray, '    It never mixes with real metering. Clear it: aegisflow demo --clear'));
  console.log('');
  console.log(color(tty, C.bold, '  Explore it:'));
  console.log(`    aegisflow today --demo        ${color(tty, C.gray, '# spend, by-model, by-user')}`);
  console.log(`    aegisflow alerts --demo       ${color(tty, C.gray, '# budget, spike, throttling')}`);
  console.log(`    aegisflow usage --demo        ${color(tty, C.gray, '# non-coding RoI from outcomes')}`);
  console.log(`    aegisflow budget --recommend --demo`);
  console.log(`    aegisflow start --demo        ${color(tty, C.gray, '# dashboard, pointed at the demo data')}`);
  console.log('');

  if (flags.serve || flags.start) {
    console.log(color(tty, C.gray, '  Launching the dashboard against the demo data…'));
    await cmdStart(flags);
  }
}

async function cmdPricing(flags: Flags): Promise<void> {
  const cfg = loadConfig();
  const on = process.stdout.isTTY ?? false;

  // One-command self-maintenance: `pricing --auto` opts into refreshing the
  // rate card on every `start` when it's stale (a plain GET of a public price
  // file — nothing about the user). `--auto off` turns it back off.
  if (flags['auto'] !== undefined) {
    const enable = flags['auto'] !== 'off' && flags['auto'] !== 'false';
    saveConfig({ ...cfg, pricing: { ...cfg.pricing, autoRefresh: enable } });
    console.log('');
    if (enable) {
      console.log(`  ${color(on, C.green, '✓')} Auto-refresh ON — "aegisflow start" updates the rate card when it is older than ${cfg.pricing.maxAgeDays}d.`);
      console.log(`  ${color(on, C.dim, `Source: ${cfg.pricing.manifestUrl ?? DEFAULT_MANIFEST_URL}`)}`);
      console.log(`  ${color(on, C.dim, 'The fetch is a GET of a public pricing file — it sends nothing about you. Turn off: aegisflow pricing --auto off')}`);
    } else {
      console.log(`  ${color(on, C.green, '✓')} Auto-refresh OFF — the rate card only changes when you run "aegisflow pricing --refresh".`);
    }
    console.log('');
    return;
  }

  if (flags['refresh']) {
    const url = (typeof flags['url'] === 'string' ? flags['url'] : null) ?? cfg.pricing.manifestUrl;
    if (!flags.json) console.error(`  Refreshing pricing from ${url ?? DEFAULT_MANIFEST_URL} …`);
    const result = await refreshPricing(url);
    if (flags.json) {
      console.log(JSON.stringify(result, null, 2));
      process.exitCode = result.ok ? 0 : 1;
      return;
    }
    if (result.ok) {
      console.log(`  ${color(on, C.green, '✓')} Pricing updated — ${result.modelCount} models, table dated ${result.updated}.`);
      console.log(`  ${color(on, C.dim, `Saved to ${join(aegisHome(), 'pricing', 'models.json')} (overrides the bundled table).`)}`);
    } else {
      console.error(`  ${color(on, C.yellow, '✗')} Refresh failed: ${result.error}`);
      console.error(`  ${color(on, C.dim, 'Keeping the current table — pricing still works; only the update was skipped.')}`);
      process.exitCode = 1;
    }
    return;
  }

  const st = pricingStatus(cfg.pricing.maxAgeDays);
  if (flags.json) {
    console.log(JSON.stringify(st, null, 2));
    return;
  }
  console.log(`\n  ${color(on, C.bold, 'AegisFlow pricing')}`);
  console.log(`  Source     ${st.source === 'cache' ? 'refreshed cache (~/.aegisflow/pricing)' : 'bundled with the package'}`);
  const age = st.ageDays === null ? '' : `  (${num(st.ageDays)}d ago)`;
  const stale = st.stale ? color(on, C.yellow, '  — STALE') : '';
  console.log(`  Updated    ${st.updated}${age}${stale}`);
  console.log(`  Models     ${num(st.modelCount)} across ${st.providers.join(', ')}`);
  if (st.stale || st.source === 'bundled') {
    console.log(`\n  ${color(on, C.dim, 'Refresh now:   aegisflow pricing --refresh')}`);
    console.log(`  ${color(on, C.dim, 'Keep current:  aegisflow pricing --auto     (refreshes on start when stale)')}`);
  }
  console.log('');
}

/**
 * `aegisflow baseline [--refresh --url <url>] [--json]` — status and refresh for
 * the Lift population-prior manifest (`baselines/lift-baselines.json`), the CLI
 * surface `docs/RETURN-ON-INTELLIGENCE.md` §7.1 promises but that, until now, had
 * no command to reach it. Deliberately NOT a mirror of `pricing --auto`: there is
 * no established machine-readable feed for this (METR publishes research, not a
 * versioned endpoint), so there is no default URL and no auto-refresh-on-stale —
 * `--url` is required on every refresh, never silently reused from a prior run.
 */
async function cmdBaseline(flags: Flags): Promise<void> {
  const on = process.stdout.isTTY ?? false;

  if (flags['refresh']) {
    const url = typeof flags['url'] === 'string' ? flags['url'] : null;
    if (!url) {
      const msg = 'no URL given — Lift baselines have no default source (unlike pricing). Pass one you trust: aegisflow baseline --refresh --url <url>';
      if (flags.json) {
        console.log(JSON.stringify({ ok: false, error: msg }, null, 2));
        process.exitCode = 1;
        return;
      }
      console.error(`  ${color(on, C.yellow, '✗')} ${msg}`);
      console.error(`  ${color(on, C.dim, 'Or edit the cache file by hand: ~/.aegisflow/baselines/lift-baselines.json')}`);
      process.exitCode = 1;
      return;
    }
    if (!flags.json) console.error(`  Refreshing Lift baselines from ${url} …`);
    const result = await refreshBaselineManifest(url);
    if (flags.json) {
      console.log(JSON.stringify(result, null, 2));
      process.exitCode = result.ok ? 0 : 1;
      return;
    }
    if (result.ok) {
      console.log(`  ${color(on, C.green, '✓')} Baselines updated — ${result.taskTypeCount} task-type(s), table dated ${result.curated}.`);
      console.log(`  ${color(on, C.dim, `Saved to ${join(aegisHome(), 'baselines', 'lift-baselines.json')} (overrides the bundled table).`)}`);
    } else {
      console.error(`  ${color(on, C.yellow, '✗')} Refresh failed: ${result.error}`);
      console.error(`  ${color(on, C.dim, 'Keeping the current table — baselines still work; only the update was skipped.')}`);
      process.exitCode = 1;
    }
    return;
  }

  const st = baselineManifestStatus();
  if (flags.json) {
    console.log(JSON.stringify(st, null, 2));
    return;
  }
  console.log(`\n  ${color(on, C.bold, 'AegisFlow Lift baselines')}`);
  console.log(`  Source     ${st.source === 'cache' ? 'refreshed cache (~/.aegisflow/baselines)' : 'bundled with the package'}`);
  const age = st.ageDays === null ? '' : `  (${num(st.ageDays)}d ago)`;
  const stale = st.stale ? color(on, C.yellow, '  — STALE') : '';
  console.log(`  Curated    ${st.curated}${age}${stale}`);
  console.log(`  Task-types ${num(st.taskTypeCount)}`);
  console.log(`  ${color(on, C.dim, 'Real per-project numbers (blended with your own git history): aegisflow roi')}`);
  console.log(`\n  ${color(on, C.dim, 'Refresh from a source you trust:  aegisflow baseline --refresh --url <url>')}`);
  console.log(`  ${color(on, C.dim, 'No default source exists for this — unlike pricing, METR publishes research, not a feed.')}`);
  console.log('');
}

/** This package's version, read from package.json — the single source of truth. */
function packageVersion(): string {
  try {
    const pkgPath = join(dirname(fileURLToPath(import.meta.url)), '..', 'package.json');
    return (JSON.parse(readFileSync(pkgPath, 'utf8')) as { version?: string }).version ?? 'unknown';
  } catch {
    // Version is informational only; a missing/garbled package.json must never
    // break the CLI. Return an explicit sentinel rather than crash.
    return 'unknown';
  }
}

function cmdHelp(): void {
  console.log(`
  AegisFlow — meter and cap what your AI coding agents spend, locally.

  Usage: aegisflow <command> [options]

  Commands
    guide                 Where you are + the single next step, read from your
                          actual state — also what bare "aegisflow" shows (--json)
    start                 Start the proxy + local dashboard
    today | week | month  Show spend for a window      (--json)
    sources               Spend by connected source — each AI tool routed here
                          (--all for all-time, --json)
    connect <tool>        Connect an AI tool as a source so its spend is metered:
                          opencode (--write to apply), claude-code (native import),
                          antigravity (custom-provider recipe; --write points the
                          upstream at Gemini free tier), api (generic SDK/curl
                          recipe). No tool lists the connectors.
    import <tool|all>     NATIVE metering, no routing: read the usage a tool
                          already logs locally — works on subscriptions the proxy
                          can never see. Tools: claude-code, opencode, codex (or
                          all). Idempotent. --watch keeps it live (poll every N
                          sec: --every N). (--root <dir>, --days N, --json)
    scan [path]           One-command onboarding: find the AI tools + git repos on
                          this machine and preview a setup plan (read-only). --setup
                          imports every detected tool and correlates every repo into
                          per-project RoI. --deep widens the walk. (path defaults to
                          your home; --json)
    discover               Correlate ALREADY-imported projects into per-project RoI,
                          without re-importing — the correlation half of "scan --setup"
                          on its own      (--window D, --json)
    audit --repo <path>   Correlate spend with git commits (--limit N, --json)
    roi --repo <path>     Return on Intelligence: four value lenses (Realization,
                          Acceptance, Lift, Impact) → one composite index
                          (--labor-rate $/hr, --tsf <multiplier> for Lift, --json)
    frontier --repo <p>   What's best for you: RoI by model × task-type, with
                          routing recommendations (--window D, --json)
    usage                 RoI for non-coding usage (chat, research, drafting) —
                          sessions scored from reported outcomes (--days N, --json)
    judge                 Score a recent window's AI-assisted efficiency —
                          algorithmic by default; opt into a local/hosted LLM
                          judge via config.judge.* (--window D, --project <name>, --json)
    team                  Per-user value: how much of the spend reaches outcomes.
                          Opt-in, distribution-only, k-anonymous. --me <user> for
                          your own view (--days N, --json)
    team push --url <u>   Cross-machine: sign + push this window's per-project
                          value/RoI to a team server YOU run (AegisFlow hosts
                          nothing). --dry-run to preview, --pubkey to publish
                          this machine's rollup identity, --watch to keep
                          pushing on an interval (--window D, --project
                          <name>, --every N, --json)
    report --kind K       Wire an outcome: code --commit <hash>, non-code --session <id>
                          kinds: tested|merged|shipped|incident|used|resolved|published|…
    exec -- <command>     AMBIENT outcome capture: run any command and report its
                          exit code as the outcome — wrap "npm test" once, every
                          run reports itself ([--kind tested|shipped|…] [--commit R|--session S])
    realize --repo <path> The Realization Standard: % of AI spend that became
                          verified, durable outcomes (--window DAYS, --limit N, --json)
    receipt --repo <path> Emit signed, verifiable value receipts (--unit <hash>, --json)
                          Publish identity:  receipt --pubkey
                          Verify + pin signer: receipt --verify <file> --key-id <id>
    yield --repo <path>   AI Yield (survival lens): durable lines per $ — survival, churn
                          (--window DAYS, --limit N, --json)
    budget                Set caps: --daily N --soft N --session N --runaway N --window S
    budget --recommend    Suggest a value-aware budget from usage + realized value
                          (--repo <path> for value-based, --apply to write, --json)
    alerts                Active governance alerts: spend spikes, throttling, runaway,
                          value craters (--repo <path> for value, --json; exits 1 if critical)
                          Deliver to your own webhook: --set-webhook <url>, then --notify
                          (cron it; sends ONLY alert metadata — never prompts/code/keys)
    export                Export the request ledger for BI/finance (--csv default | --json,
                          --days N | --all, --out <file>; otherwise stdout)
    init                  Write default config + print setup steps
    doctor                First-run health check: config, DB, proxy, caps, data quality
    config                Show config and file paths    (--json)
    pricing               Show the rate card: source, age, model count (--json).
                          Update it:  pricing --refresh  (pulls the latest rates
                          from the community price feed; --url <manifest> to
                          override the source)
                          Self-maintaining: pricing --auto  (refresh on start
                          when stale; --auto off to disable)
    baseline               Show the Lift manual-minutes population prior: source,
                          age, task-type count (--json). Update it: baseline
                          --refresh --url <manifest>  (no default source exists —
                          unlike pricing, METR publishes research, not a feed)
    prune                 Prune old rows and compact the database
    demo                  Generate isolated, clearly-labeled synthetic data so every
                          surface populates without an API key (--serve to launch the
                          dashboard on it; --clear to remove). Add --demo to any read
                          command (today, alerts, usage, start) to view the demo data.
    help                  This message
    --version             Print the AegisFlow version

  Setup
    1) aegisflow start
    2) $env:ANTHROPIC_BASE_URL="http://localhost:8090"   (PowerShell)
       $env:OPENAI_BASE_URL="http://localhost:8090/v1"
    3) Run your AI tools as usual. Watch the dashboard.

  Any OpenAI-compatible provider works through the OpenAI path — point your tool
  at http://localhost:8090/v1. Gemini, for example, via Google's free tier:
       $env:OPENAI_BASE_URL="http://localhost:8090/v1"   then use a gemini-* model
`);
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  // Bare `aegisflow` opens the guide, not the reference: the tool's first job
  // is to tell you where you are and the single next step. `help` is one word away.
  const cmd = argv[0] ?? 'guide';
  // `exec` wraps another command: everything after the bare `--` belongs to the
  // wrapped command verbatim and must never be flag-parsed.
  const sep = argv.indexOf('--');
  const flags = parseFlags(cmd === 'exec' && sep !== -1 ? argv.slice(1, sep) : argv.slice(1));
  const wrapped = cmd === 'exec' && sep !== -1 ? argv.slice(sep + 1) : [];

  // Demo mode: point every store-open at an isolated demo.db and flag surfaces
  // to render the DEMO label. One switch covers the CLI and the in-process
  // dashboard, since both resolve the path through dbPath() and read isDemo().
  if (cmd === 'demo' || flags.demo) {
    process.env.AEGIS_DB = demoDbPath();
    process.env.AEGIS_DEMO = '1';
  }

  switch (cmd) {
    case 'demo':
      await cmdDemo(flags);
      break;
    case 'start':
      await cmdStart(flags);
      break;
    case 'today':
    case 'status':
      cmdShow('today', flags);
      break;
    case 'week':
      cmdShow('week', flags);
      break;
    case 'month':
      cmdShow('month', flags);
      break;
    case 'sources':
      cmdSources(flags);
      break;
    case 'connect':
      cmdConnect(flags);
      break;
    case 'init':
      cmdInit();
      break;
    case 'config':
      cmdConfig(flags);
      break;
    case 'budget':
      if (flags.recommend) await cmdBudgetAdvisor(flags);
      else cmdBudget(flags);
      break;
    case 'alerts':
      await cmdAlerts(flags);
      break;
    case 'export':
      cmdExport(flags);
      break;
    case 'guide':
    case 'next':
      await cmdGuide(flags);
      break;
    case 'doctor':
      await cmdDoctor();
      break;
    case 'audit':
      await cmdAudit(flags);
      break;
    case 'yield':
      await cmdYield(flags);
      break;
    case 'realize':
    case 'realization':
      await cmdRealize(flags);
      break;
    case 'roi':
      await cmdRoi(flags);
      break;
    case 'frontier':
      await cmdFrontier(flags);
      break;
    case 'usage':
      await cmdUsage(flags);
      break;
    case 'judge':
      await cmdJudge(flags);
      break;
    case 'team':
      // Bare `team` / `team --me <user>` = the existing local, k-anonymous
      // per-user value view (single machine). `team push` = sign and push a
      // cross-project rollup to a separate, BYO team server (multi-machine).
      // Same top-level verb, two scopes — not a naming collision: `push`
      // lands in flags._[0] because `main()` already consumed argv[0] as `cmd`.
      if (flags._[0] === 'push') {
        await cmdTeamPush(flags);
      } else {
        await cmdTeam(flags);
      }
      break;
    case 'report':
      await cmdReport(flags);
      break;
    case 'exec':
      await cmdExec(flags, wrapped);
      break;
    case 'import':
      await cmdImport(flags);
      break;
    case 'discover':
      await cmdDiscover(flags);
      break;
    case 'scan':
      await cmdScan(flags);
      break;
    case 'receipt':
    case 'receipts':
      await cmdReceipt(flags);
      break;
    case 'prune':
      cmdPrune();
      break;
    case 'pricing':
      await cmdPricing(flags);
      break;
    case 'baseline':
    case 'baselines':
      await cmdBaseline(flags);
      break;
    case 'help':
    case '--help':
    case '-h':
      cmdHelp();
      break;
    case 'version':
    case '--version':
    case '-v':
      console.log(`aegisflow ${packageVersion()}`);
      break;
    default:
      console.error(`  Unknown command: ${cmd}\n  Run "aegisflow help" for usage.`);
      process.exitCode = 1;
  }
}

// A reader closing early (e.g. `aegisflow scan | head`) makes further console.log
// writes throw EPIPE — expected, not a real failure. Exit clean instead of an
// uncaught-exception stack trace; any OTHER stdout error still propagates.
process.stdout.on('error', (err: NodeJS.ErrnoException) => {
  if (err.code === 'EPIPE') process.exit(0);
  throw err;
});

main().catch((err) => {
  console.error('  AegisFlow error:', err);
  process.exitCode = 1;
});
