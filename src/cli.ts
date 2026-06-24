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
  type AegisConfig,
} from './config.ts';
import { seedDemo, demoLiftOptions } from './demo/seed.ts';
import { startOfLocalDay } from './budget/guard.ts';
import { attributeCommits, isGitRepo, projectName, resolveCommit } from './git/correlate.ts';
import { computeQuality } from './git/quality.ts';
import { computeRealization, loadRealization, liftOptionsFromStore, moneyInputsFromStore } from './value/realization.ts';
import { computeReturnOnIntelligence } from './value/lenses.ts';
import { boundedLift } from './value/lift.ts';
import { computeFrontier } from './value/frontier.ts';
import { computeUsageRoI } from './value/usage.ts';
import { recommendBudget } from './budget/recommend.ts';
import { recommendAllocation } from './budget/allocate.ts';
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
} from './value/receipt.ts';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';

const C = {
  reset: '\x1b[0m',
  dim: '\x1b[2m',
  bold: '\x1b[1m',
  cyan: '\x1b[36m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  red: '\x1b[31m',
  gray: '\x1b[90m',
};

function color(on: boolean, code: string, s: string): string {
  return on ? `${code}${s}${C.reset}` : s;
}

function usd(n: number): string {
  if (n === 0) return '$0.00';
  if (n >= 1) return `$${n.toFixed(2)}`;
  if (n >= 0.01) return `$${n.toFixed(4)}`;
  return `$${n.toFixed(6)}`;
}

function num(n: number): string {
  return n.toLocaleString('en-US');
}

/** Actionable not-a-git-repo message: tell the user what to do, not just what's wrong. */
function printNotAGitRepo(repo: string): void {
  console.error(`  Not a git repository: ${repo}`);
  console.error('  Run this from inside your repo, or pass --repo <path>. Non-coding usage needs no git: aegisflow usage');
}

interface Flags {
  _: string[];
  [k: string]: string | boolean | string[];
}

function parseFlags(argv: string[]): Flags {
  const flags: Flags = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) {
        flags[key] = true;
      } else {
        flags[key] = next;
        i++;
      }
    } else {
      (flags._ as string[]).push(a);
    }
  }
  return flags;
}

function rangeFor(window: 'today' | 'week' | 'month'): { startMs: number; endMs: number; label: string } {
  const now = Date.now();
  const day = 24 * 60 * 60 * 1000;
  if (window === 'today') return { startMs: startOfLocalDay(now), endMs: now + 1000, label: 'Today' };
  if (window === 'week') return { startMs: now - 7 * day, endMs: now + 1000, label: 'Last 7 days' };
  return { startMs: now - 30 * day, endMs: now + 1000, label: 'Last 30 days' };
}

function cmdShow(window: 'today' | 'week' | 'month', flags: Flags): void {
  const cfg = loadConfig();
  const store = new Store(dbPath());
  const { startMs, endMs, label } = rangeFor(window);
  const summary = store.summary(startMs, endMs);
  const byModel = store.byModel(startMs, endMs);
  const byProject = store.byProject(startMs, endMs);
  const byUser = store.byUser(startMs, endMs);

  if (flags.json) {
    process.stdout.write(JSON.stringify({ window, label, demo: isDemo(), summary, byModel, byProject, byUser }, null, 2) + '\n');
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
  console.log('');
  console.log(color(tty, C.gray, `  Dashboard: run "aegisflow start" then open http://localhost:${cfg.dashboardPort}`));
  console.log('');
  store.close();
}

async function cmdAlerts(flags: Flags): Promise<void> {
  const tty = process.stdout.isTTY ?? false;

  // Config-only sub-actions: set/clear the opt-in delivery webhook.
  if (typeof flags['set-webhook'] === 'string') {
    const c = loadConfig();
    c.alerts.webhookUrl = String(flags['set-webhook']);
    saveConfig(c);
    console.log(color(tty, C.green, '  Alert webhook saved.') + color(tty, C.gray, ' Delivery sends ONLY alert metadata — never prompts, code, or keys.'));
    return;
  }
  if (flags['clear-webhook']) {
    const c = loadConfig();
    c.alerts.webhookUrl = null;
    saveConfig(c);
    console.log(color(tty, C.gray, '  Alert webhook cleared.'));
    return;
  }

  const cfg = loadConfig();
  const store = new Store(dbPath());

  // Include realized-value alerts only when a git repo is available to measure them.
  let realizedValueRate: number | null = null;
  const repo = flags.repo as string | undefined;
  const loadedValue = await loadRealization(store, repo, { persist: false });
  if (loadedValue) realizedValueRate = loadedValue.report.matured.realizedValueRate;
  const alerts = computeAlerts(store, cfg, { realizedValueRate });

  // Deliver to the configured webhook (cron-friendly), then exit.
  if (flags.notify) {
    const url = typeof flags['notify-url'] === 'string' ? String(flags['notify-url']) : cfg.alerts.webhookUrl;
    if (!url) {
      console.error('  No webhook configured. Set one with: aegisflow alerts --set-webhook <url>  (or pass --notify-url <url>)');
      process.exitCode = 1;
      store.close();
      return;
    }
    const r = await notifyWebhook(url, alerts, { minSeverity: cfg.alerts.minSeverity });
    if (r.posted === 0) {
      console.log(color(tty, C.gray, `  No alerts at or above "${cfg.alerts.minSeverity}" — nothing to deliver.`));
    } else if (r.delivered) {
      console.log(color(tty, C.green, `  Delivered ${r.posted} alert(s) to the webhook (HTTP ${r.status}).`) + color(tty, C.gray, ' Metadata only.'));
    } else {
      console.error(color(tty, C.red, `  Delivery failed (${r.error ?? 'HTTP ' + r.status}); ${r.posted} alert(s) not sent.`));
      process.exitCode = 1;
    }
    store.close();
    return;
  }

  if (flags.json) {
    process.stdout.write(JSON.stringify(alerts, null, 2) + '\n');
    store.close();
    if (alerts.some((a) => a.severity === 'critical')) process.exitCode = 1;
    return;
  }

  console.log('');
  console.log(color(tty, C.bold, '  AegisFlow — governance alerts'));
  console.log(color(tty, C.gray, '  ' + '─'.repeat(58)));
  if (alerts.length === 0) {
    console.log(color(tty, C.green, '  ✓ All clear — no active alerts.'));
    if (!repo) console.log(color(tty, C.gray, '  (pass --repo <path> to include realized-value alerts)'));
    console.log('');
    store.close();
    return;
  }
  for (const a of alerts) {
    const mark =
      a.severity === 'critical' ? color(tty, C.red, '● CRITICAL')
      : a.severity === 'warn' ? color(tty, C.yellow, '▲ WARN    ')
      : color(tty, C.gray, 'ℹ INFO    ');
    console.log(`  ${mark}  ${color(tty, C.bold, a.title)}${a.metric ? color(tty, C.gray, `  · ${a.metric}`) : ''}`);
    console.log(color(tty, C.gray, `              ${a.detail}`));
  }
  console.log('');
  if (alerts.some((a) => a.severity === 'critical')) process.exitCode = 1;
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

async function cmdDoctor(): Promise<void> {
  const tty = process.stdout.isTTY ?? false;
  const cfg = loadConfig();
  const store = new Store(dbPath());
  const now = Date.now();
  const day = 24 * 60 * 60 * 1000;
  const sum30 = store.summary(now - 30 * day, now + 1000);
  const health = store.healthStats(now - 30 * day, now + 1000);
  const estShare = health.totalCostUsd > 0 ? health.estimatedCostUsd / health.totalCostUsd : 0;
  const alerts = computeAlerts(store, cfg, { now });
  const criticals = alerts.filter((a) => a.severity === 'critical').length;

  let proxyUp = false;
  try {
    const r = await fetch(`http://localhost:${cfg.port}/__aegis/health`, { signal: AbortSignal.timeout(800) });
    proxyUp = r.ok;
  } catch {
    proxyUp = false;
  }

  const mark = (good: boolean) => (good ? color(tty, C.green, '✓') : color(tty, C.yellow, '!'));
  console.log('');
  console.log(color(tty, C.bold, '  AegisFlow — doctor'));
  console.log(color(tty, C.gray, '  ' + '─'.repeat(58)));
  console.log(`  ${mark(true)} Config      ${color(tty, C.gray, configPath())}`);
  console.log(`  ${mark(true)} Database    ${color(tty, C.gray, `${dbPath()}  (${num(sum30.requests)} req · ${usd(sum30.costUsd)} in 30d)`)}`);
  console.log(`  ${mark(proxyUp)} Proxy       ${proxyUp ? color(tty, C.green, `running on :${cfg.port}`) : color(tty, C.yellow, `not reachable on :${cfg.port} — start with "aegisflow start"`)}`);
  console.log(`  ${mark(cfg.budget.dailyUsd !== null)} Daily cap   ${cfg.budget.dailyUsd !== null ? usd(cfg.budget.dailyUsd) : color(tty, C.yellow, 'none — metering only (set with "aegisflow budget --daily N")')}`);
  console.log(`  ${mark(estShare <= 0.2)} Pricing     ${estShare > 0 ? `${Math.round(estShare * 100)}% of 30d spend used estimated rates` : 'all spend priced from the rate card'}`);
  console.log(`  ${mark(criticals === 0)} Alerts      ${alerts.length ? `${num(alerts.length)} active (${criticals} critical) — see "aegisflow alerts"` : color(tty, C.green, 'all clear')}`);
  console.log('');
  console.log(color(tty, C.gray, '  Point your AI tools at the proxy:'));
  console.log(color(tty, C.gray, `    ANTHROPIC_BASE_URL=http://localhost:${cfg.port}   OPENAI_BASE_URL=http://localhost:${cfg.port}/v1`));
  console.log('');
  store.close();
}

function cmdInit(): void {
  const cfg = loadConfig();
  saveConfig(cfg);
  const tty = process.stdout.isTTY ?? false;
  console.log('');
  console.log(color(tty, C.bold, '  AegisFlow initialized'));
  console.log(`  Config: ${configPath()}`);
  console.log(`  Data:   ${dbPath()}`);
  console.log('');
  console.log(color(tty, C.bold, '  Point your AI tools at the proxy:'));
  console.log('');
  console.log(color(tty, C.cyan, '  PowerShell'));
  console.log(`    $env:ANTHROPIC_BASE_URL="http://localhost:${cfg.port}"`);
  console.log(`    $env:OPENAI_BASE_URL="http://localhost:${cfg.port}/v1"`);
  console.log('');
  console.log(color(tty, C.cyan, '  bash / zsh'));
  console.log(`    export ANTHROPIC_BASE_URL="http://localhost:${cfg.port}"`);
  console.log(`    export OPENAI_BASE_URL="http://localhost:${cfg.port}/v1"`);
  console.log('');
  console.log(`  Then run: ${color(tty, C.green, 'aegisflow start')}`);
  console.log('');
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

async function cmdAudit(flags: Flags): Promise<void> {
  const repo = (flags.repo as string) ?? process.cwd();
  const limit = flags.limit ? Number(flags.limit) : 20;
  if (!(await isGitRepo(repo))) {
    printNotAGitRepo(repo);
    process.exitCode = 1;
    return;
  }
  const store = new Store(dbPath());
  const rows = await attributeCommits(store, repo, { limit, persist: true });
  if (flags.json) {
    process.stdout.write(JSON.stringify(rows, null, 2) + '\n');
    store.close();
    return;
  }
  const tty = process.stdout.isTTY ?? false;
  console.log('');
  console.log(color(tty, C.bold, `  Cost per commit — ${repo}`));
  console.log(color(tty, C.gray, '  ' + '─'.repeat(72)));
  console.log(color(tty, C.gray, '  commit    spend       req   +/-lines     $ / 100 lines   subject'));
  for (const r of rows) {
    const short = r.hash.slice(0, 7);
    const lines = `+${r.linesAdded}/-${r.linesDeleted}`.padEnd(12);
    const per = r.costPerHundredLines === null ? '—' : usd(r.costPerHundredLines);
    const subject = r.subject.length > 28 ? r.subject.slice(0, 27) + '…' : r.subject;
    console.log(
      `  ${short}  ${usd(r.attributedCostUsd).padStart(10)}  ${String(r.attributedRequests).padStart(4)}  ${lines}  ${per.padStart(13)}   ${color(tty, C.gray, subject)}`,
    );
  }
  console.log('');
  console.log(color(tty, C.gray, '  Note: attribution is a heuristic (spend in the window before each commit), not a quality score.'));
  console.log('');
  store.close();
}

function pct(n: number): string {
  return `${(n * 100).toFixed(0)}%`;
}

async function cmdYield(flags: Flags): Promise<void> {
  const repo = (flags.repo as string) ?? process.cwd();
  const limit = flags.limit ? Number(flags.limit) : 30;
  const windowDays = flags.window ? Number(flags.window) : 14;
  if (!(await isGitRepo(repo))) {
    printNotAGitRepo(repo);
    process.exitCode = 1;
    return;
  }
  const store = new Store(dbPath());
  const report = await computeQuality(store, repo, { limit, windowDays, persist: true });

  if (flags.json) {
    process.stdout.write(JSON.stringify(report, null, 2) + '\n');
    store.close();
    return;
  }

  const tty = process.stdout.isTTY ?? false;
  const m = report.matured;
  console.log('');
  console.log(color(tty, C.bold, '  AI Yield — durable output per dollar of AI spend'));
  console.log(color(tty, C.gray, `  Survival measured to date · ${m.commits} matured commits (older than ${windowDays}d)`));
  console.log(color(tty, C.gray, '  ' + '─'.repeat(64)));
  if (m.commits === 0) {
    console.log(color(tty, C.gray, `  No commits older than ${windowDays}d yet — yield needs time to mature.`));
    console.log(color(tty, C.gray, '  Recent commits below are provisional (survival still settling).'));
  } else {
    const yieldStr = m.aiYield === null ? 'n/a (no AI cost attributed)' : `${m.aiYield.toFixed(1)} surviving lines / $`;
    console.log(`  ${color(tty, C.bold, 'AI Yield')}            ${color(tty, C.green, yieldStr)}`);
    console.log(`  Effective spend     ${m.effectiveSpendRatio === null ? '—' : color(tty, m.effectiveSpendRatio > 0.5 ? C.green : C.yellow, pct(m.effectiveSpendRatio))}   ${color(tty, C.gray, 'of $ landed in durable code')}`);
    console.log(`  Code survival       ${color(tty, m.survivalRatio > 0.7 ? C.green : C.yellow, pct(m.survivalRatio))}   ${color(tty, C.gray, `churn ${pct(m.churnRatio)}`)}`);
    console.log(`  Revert rate         ${color(tty, m.revertRate < 0.05 ? C.green : C.red, pct(m.revertRate))}`);
    console.log(`  AI cost (matured)   ${usd(m.totalCostUsd)}   ${color(tty, C.gray, `${num(m.survivingLines)} surviving lines`)}`);
    if (m.costPerSurvivingLine !== null) {
      console.log(`  Cost / durable line ${usd(m.costPerSurvivingLine)}`);
    }
  }

  console.log('');
  console.log(color(tty, C.bold, '  Per commit'));
  console.log(color(tty, C.gray, '  commit    age    cost       +lines  survived   churn   yield   status'));
  for (const c of report.commits.slice(0, 18)) {
    const short = c.hash.slice(0, 7);
    const age = c.ageDays < 1 ? `${Math.round(c.ageDays * 24)}h` : `${Math.round(c.ageDays)}d`;
    const surv = `${c.survivingLines}/${c.linesAdded}`;
    const churn = pct(c.churnRatio);
    const yld = c.aiYield === null ? '—' : c.aiYield.toFixed(0);
    const status = c.reverted
      ? color(tty, C.red, 'REVERTED')
      : c.maturing
        ? color(tty, C.yellow, 'maturing')
        : color(tty, C.green, 'matured');
    console.log(
      `  ${short}  ${age.padStart(4)}  ${usd(c.attributedCostUsd).padStart(9)}  ${String(c.linesAdded).padStart(6)}  ${surv.padStart(9)}  ${churn.padStart(5)}  ${yld.padStart(5)}   ${status}`,
    );
  }
  console.log('');
  console.log(color(tty, C.gray, '  Yield = surviving lines ÷ AI cost. A coaching signal, not a leaderboard —'));
  console.log(color(tty, C.gray, '  read it as a team trend, never a per-developer ranking. (docs/RESEARCH-REVIEW.md)'));
  console.log('');
  store.close();
}

/** A one-line honesty note when realized-value figures come from stored snapshots. */
function noteSource(tty: boolean, source: 'git' | 'store'): void {
  if (source === 'store') {
    console.log(color(tty, C.gray, '  ● stored realization snapshot — no live repo attached; figures are as of the last realize run.'));
  }
}

function glyph(tty: boolean, v: Verdict): string {
  if (v === 'pass') return color(tty, C.green, '✓');
  if (v === 'fail') return color(tty, C.red, '✗');
  return color(tty, C.gray, '·');
}

async function cmdRealize(flags: Flags): Promise<void> {
  const repo = (flags.repo as string) ?? process.cwd();
  const limit = flags.limit ? Number(flags.limit) : 30;
  const windowDays = flags.window ? Number(flags.window) : 14;
  const store = new Store(dbPath());
  const loaded = await loadRealization(store, repo, { limit, windowDays, persist: true });
  if (!loaded) {
    printNotAGitRepo(repo);
    process.exitCode = 1;
    store.close();
    return;
  }
  const report = loaded.report;

  if (flags.json) {
    process.stdout.write(JSON.stringify(report, null, 2) + '\n');
    store.close();
    return;
  }

  const tty = process.stdout.isTTY ?? false;
  const m = report.matured;
  const wiredGates = GATE_LADDER.filter((g) => m.instrumentation[g] > 0).length;

  console.log('');
  console.log(color(tty, C.bold, '  The Realization Standard — did AI spend become real outcomes?'));
  console.log(color(tty, C.gray, `  ${m.units} matured units (older than ${windowDays}d) · ${wiredGates} of ${GATE_LADDER.length} gates instrumented`));
  console.log(color(tty, C.gray, '  ' + '─'.repeat(64)));
  noteSource(tty, loaded.source);

  if (m.units === 0) {
    console.log(color(tty, C.gray, `  No units older than ${windowDays}d yet — realization needs the window to elapse.`));
  } else {
    const rr = pct(m.realizationRate);
    const rv = m.realizedValueRate === null ? '—' : pct(m.realizedValueRate);
    console.log(`  ${color(tty, C.bold, 'Realization Rate')}    ${color(tty, m.realizationRate > 0.6 ? C.green : C.yellow, rr.padStart(4))}   ${color(tty, C.gray, 'production — units that reached verified durable value')}`);
    console.log(`  Realized Value      ${color(tty, C.green, usd(m.realizedValueUsd))} / ${usd(m.totalCostUsd)}  ${color(tty, C.gray, `(${rv})  the money lens`)}`);
    console.log(`  Net of rework       ${color(tty, C.green, usd(m.netRealizedValueUsd))}  ${color(tty, C.gray, 'realized value after first-pass acceptance — reworked output is worth less')}`);
  }
  const fpa = report.firstPassAcceptance;
  console.log(`  First-Pass Accept.  ${fpa === null ? color(tty, C.gray, 'n/a (no proposals captured)') : color(tty, fpa > 0.7 ? C.green : C.yellow, pct(fpa).padStart(4)) + color(tty, C.gray, '   collaboration — of AI-proposed lines, how much shipped')}`);

  // Waste P&L
  if (m.wasteByStage.length) {
    console.log('');
    console.log(color(tty, C.bold, '  Where the spend went (P&L)'));
    for (const b of m.wasteByStage) {
      const label = b.stage === 'realized' ? 'realized ✓' : b.stage === 'unverified' ? 'unverified' : `died at ${b.stage}`;
      const isGood = b.stage === 'realized';
      console.log(`    ${label.padEnd(20)} ${color(tty, isGood ? C.green : C.yellow, usd(b.costUsd).padStart(10))}   ${color(tty, C.gray, `${b.units} unit${b.units === 1 ? '' : 's'}`)}`);
    }
  }

  // Gate coverage
  console.log('');
  console.log(color(tty, C.bold, '  Gate coverage') + color(tty, C.gray, '   (wire more with: aegisflow report)'));
  for (const g of GATE_LADDER) {
    const n = m.instrumentation[g];
    const meta = GATE_META[g];
    const awaiting = meta.source === 'signal' ? 'awaiting CI/deploy signal' : `awaiting ${meta.source} capture`;
    const state = n > 0 ? color(tty, C.green, `wired · ${n}/${m.units}`) : color(tty, C.gray, awaiting);
    console.log(`    ${meta.label.padEnd(11)} ${state}`);
  }

  // Per unit
  console.log('');
  console.log(color(tty, C.bold, '  Per unit') + color(tty, C.gray, `   funnel: ${GATE_LADDER.map((g) => g[0]).join(' ')}  (✓pass ✗fail ·unknown)`));
  for (const u of report.units.slice(0, 16)) {
    const short = u.hash.slice(0, 7);
    const age = u.ageDays < 1 ? `${Math.round(u.ageDays * 24)}h` : `${Math.round(u.ageDays)}d`;
    const acc = u.acceptance === null ? '  —' : pct(u.acceptance).padStart(3);
    const funnel = u.funnel.results.map((r) => glyph(tty, r.verdict)).join(' ');
    const status = u.maturing
      ? color(tty, C.yellow, 'maturing')
      : u.funnel.realized
        ? color(tty, C.green, 'REALIZED')
        : color(tty, C.red, `died:${u.funnel.diedAt ?? '—'}`);
    console.log(`    ${short}  ${age.padStart(4)}  ${usd(u.attributedCostUsd).padStart(9)}  acc ${acc}  ${funnel}  ${status}`);
  }
  console.log('');
  console.log(color(tty, C.gray, '  Production is dollar-free (Realization Rate); cost is a lens on top. See docs/THE-STANDARD.md'));
  console.log('');
  store.close();
}

async function cmdReport(flags: Flags): Promise<void> {
  const kind = String(flags.kind ?? '');
  const codeKinds = ['tested', 'merged', 'shipped', 'incident'];
  const usageKinds = ['used', 'resolved', 'published', 'accepted', 'redone', 'discarded'];
  const allowed = [...codeKinds, ...usageKinds];
  if (!allowed.includes(kind)) {
    console.error(`  Usage: aegisflow report --kind <${allowed.join('|')}>`);
    console.error('         code:  --commit <hash>      non-code:  --session <id>      [--verdict pass|fail] [--detail "..."]');
    process.exitCode = 1;
    return;
  }
  const negative = ['incident', 'redone', 'discarded'].includes(kind);
  const verdict = negative ? 'fail' : String(flags.verdict ?? 'pass') === 'fail' ? 'fail' : 'pass';
  const tty = process.stdout.isTTY ?? false;

  // Resolve the ref: a git commit (code) or a session id (non-code).
  let ref: string | null = null;
  let project = 'default';
  if (flags.commit) {
    const repo = (flags.repo as string) ?? process.cwd();
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
  } else if (flags.session) {
    ref = String(flags.session);
  } else if (usageKinds.includes(kind)) {
    console.error('  Non-code outcomes need --session <id>.');
    process.exitCode = 1;
    return;
  }

  const store = new Store(dbPath());
  store.insertSignal({
    signalId: randomUUID(),
    kind,
    commitHash: ref,
    project,
    tsEpochMs: Date.now(),
    verdict,
    detail: flags.detail ? String(flags.detail) : null,
  });
  console.log('');
  console.log(`  Recorded ${color(tty, C.bold, kind)} = ${verdict}` + (ref ? ` for ${ref.slice(0, 12)}` : ' (project-wide)'));
  console.log(color(tty, C.gray, '  It resolves the matching gate on the next "aegisflow realize" / "usage".'));
  console.log('');
  store.close();
}

async function cmdUsage(flags: Flags): Promise<void> {
  const store = new Store(dbPath());
  const now = Date.now();
  const dayMs = 24 * 60 * 60 * 1000;
  const days = flags.days ? Number(flags.days) : 30;
  const rep = computeUsageRoI(store, { startMs: now - days * dayMs, endMs: now + 1000 });

  if (flags.json) {
    process.stdout.write(JSON.stringify(rep, null, 2) + '\n');
    store.close();
    return;
  }

  const tty = process.stdout.isTTY ?? false;
  console.log('');
  console.log(color(tty, C.bold, '  Return on Intelligence — non-coding usage (chat, research, drafting)'));
  console.log(color(tty, C.gray, `  ${rep.units.length} sessions · outcomes via "aegisflow report --session <id> --kind used|resolved|…"`));
  console.log(color(tty, C.gray, '  ' + '─'.repeat(64)));
  if (rep.units.length === 0) {
    console.log(color(tty, C.gray, '  No non-coding sessions in range. Tag sessions with X-Aegis-Session-Id to measure them.'));
    console.log('');
    store.close();
    return;
  }
  const idx = rep.roi.roiIndex;
  console.log(`  RoI Index           ${idx === null ? color(tty, C.gray, 'n/a') : color(tty, idx > 60 ? C.green : C.yellow, `${idx.toFixed(0)} / 100`)}`);
  console.log(`  Realized            ${rep.realizedUnits}/${rep.units.length} sessions   ${color(tty, C.gray, `${usd(rep.totalCostUsd)} total`)}`);
  console.log('');
  for (const n of rep.roi.notes) console.log(color(tty, C.gray, `  · ${n}`));
  console.log('');
  console.log(color(tty, C.gray, '  Acceptance/survival are n/a for non-code (no diff, no git) — realized = a reported,'));
  console.log(color(tty, C.gray, '  no-incident outcome. Wire outcomes to move sessions from unknown to realized.'));
  console.log('');
  store.close();
}

async function cmdReceipt(flags: Flags): Promise<void> {
  const tty = process.stdout.isTTY ?? false;

  // Publish this machine's signing identity so others can pin it when verifying.
  if (flags.pubkey) {
    const keys = loadOrCreateKeyPair(join(aegisHome(), 'receipt-key.json'));
    if (flags.json) {
      process.stdout.write(JSON.stringify({ keyId: keys.keyId, publicKey: keys.publicPem }, null, 2) + '\n');
      return;
    }
    console.log('');
    console.log(color(tty, C.bold, '  AegisFlow signing identity') + color(tty, C.gray, '   publish this so others can verify your receipts'));
    console.log(`  keyId: ${color(tty, C.cyan, keys.keyId)}`);
    console.log('');
    process.stdout.write(keys.publicPem.endsWith('\n') ? keys.publicPem : keys.publicPem + '\n');
    console.log(color(tty, C.gray, '  A buyer/auditor verifies your receipts against this identity with:'));
    console.log(color(tty, C.gray, `    aegisflow receipt --verify <file> --key-id ${keys.keyId}`));
    console.log('');
    return;
  }

  if (flags.verify) {
    const file = String(flags.verify);
    let receipt: SignedReceipt;
    try {
      receipt = JSON.parse(readFileSync(file, 'utf8')) as SignedReceipt;
    } catch (e) {
      console.error(`  Could not read receipt: ${String(e)}`);
      process.exitCode = 1;
      return;
    }
    // Optional out-of-band trust anchor: pin the expected signer.
    const opts: VerifyOptions = {};
    if (typeof flags['key-id'] === 'string') opts.trustedKeyId = flags['key-id'];
    if (typeof flags.key === 'string') {
      try {
        opts.trustedPublicKeyPem = readFileSync(String(flags.key), 'utf8');
      } catch (e) {
        console.error(`  Could not read pinned key file: ${String(e)}`);
        process.exitCode = 1;
        return;
      }
    }
    const res = verifyReceipt(receipt, opts);
    console.log('');
    console.log(`  Receipt for unit ${receipt.body.unit.slice(0, 7)} · signed by key ${res.keyId || receipt.keyId}`);
    if (res.valid) {
      console.log(color(tty, C.green, '  ✓ INTACT — signature and body hash check out'));
      if (res.pinned) {
        console.log(color(tty, C.green, '  ✓ AUTHENTIC — signed by the key you pinned'));
      } else {
        console.log(color(tty, C.yellow, `  ! NOT PINNED — integrity only. Confirm key ${res.keyId} is the signer you expect,`));
        console.log(color(tty, C.yellow, '    or re-run with --key-id <fingerprint> / --key <publisher.pem> to prove authenticity.'));
      }
    } else {
      console.log(color(tty, C.red, `  ✗ INVALID — ${res.reason}`));
      process.exitCode = 1; // scriptable for CI / auditors
    }
    console.log('');
    return;
  }

  const repo = (flags.repo as string) ?? process.cwd();
  const windowDays = flags.window ? Number(flags.window) : 14;
  const limit = flags.limit ? Number(flags.limit) : 30;
  if (!(await isGitRepo(repo))) {
    printNotAGitRepo(repo);
    process.exitCode = 1;
    return;
  }
  const store = new Store(dbPath());
  const report = await computeRealization(store, repo, { limit, windowDays, persist: false });
  const project = await projectName(repo);
  const keys = loadOrCreateKeyPair(join(aegisHome(), 'receipt-key.json'));

  const units = report.units.filter(
    (u) => !u.maturing && (!flags.unit || u.hash.startsWith(String(flags.unit))),
  );
  const receipts = units.map((u) =>
    signReceipt(buildReceiptBody(u.hash, project, u.attributedCostUsd, u.acceptance, u.funnel), keys),
  );
  for (const r of receipts) {
    store.saveReceipt({ unit: r.body.unit, project, tsEpochMs: Date.now(), realized: r.body.realized, receiptJson: JSON.stringify(r) });
  }

  if (flags.json) {
    process.stdout.write(JSON.stringify(receipts, null, 2) + '\n');
    store.close();
    return;
  }

  console.log('');
  console.log(color(tty, C.bold, '  Value Receipts') + color(tty, C.gray, `   signed with key ${keys.keyId} (ed25519)`));
  console.log(color(tty, C.gray, '  Portable, verifiable proof of cost → outcome.'));
  console.log(color(tty, C.gray, `  Publish your identity:  aegisflow receipt --pubkey   (keyId ${keys.keyId})`));
  console.log(color(tty, C.gray, '  Others verify + pin it: aegisflow receipt --verify <file> --key-id <keyId>'));
  console.log(color(tty, C.gray, '  ' + '─'.repeat(64)));
  if (receipts.length === 0) {
    console.log(color(tty, C.gray, `  No matured units to certify yet (need commits older than ${windowDays}d).`));
  }
  for (const r of receipts.slice(0, 16)) {
    const v = r.body.realized ? color(tty, C.green, 'VERIFIED VALUE') : color(tty, C.yellow, `died:${r.body.diedAt ?? '—'}`);
    console.log(`    ${r.body.unit.slice(0, 7)}  ${usd(r.body.costUsd).padStart(9)}  ${v}`);
  }
  if (receipts.length) {
    console.log('');
    console.log(color(tty, C.gray, '  Example receipt (canonical, signed):'));
    console.log(color(tty, C.gray, JSON.stringify(receipts[0], null, 2).split('\n').map((l) => '    ' + l).join('\n')));
  }
  console.log('');
  store.close();
}

async function cmdRoi(flags: Flags): Promise<void> {
  const repo = (flags.repo as string) ?? process.cwd();
  const windowDays = flags.window ? Number(flags.window) : 14;
  const cfg = loadConfig();
  // Labor rate prices both the effort tax and the money number's denominator.
  // Falls back to config; in the demo we assume an illustrative rate so the dollar
  // return is visible (clearly labeled), since the demo has no real org rate.
  let laborRate = flags['labor-rate'] !== undefined ? Number(flags['labor-rate']) : cfg.lift.laborRatePerHour;
  if (laborRate === null && isDemo()) laborRate = 120;
  const riskAversion = flags['risk'] !== undefined ? Number(flags['risk']) : 0;
  const store = new Store(dbPath());
  const loaded = await loadRealization(store, repo, { windowDays, persist: true });
  if (!loaded) {
    printNotAGitRepo(repo);
    process.exitCode = 1;
    store.close();
    return;
  }
  const report = loaded.report;
  // Lift source, in priority order — self-report is NEVER accepted:
  //   1. --tsf <x>   an externally measured TSF (transcript judge / RCT) — gold standard
  //   2. demo mode   a labeled synthetic TSF, so the interval shows in the demo
  //   3. real data   measured "time with AI" × configured task baselines (the
  //                  default real path; uninstrumented if there's no measured time
  //                  or no baselined realized work)
  let liftOpts: { lift: number | null; liftRange: { low: number | null; high: number | null }; liftHow: string };
  let liftNotes: string[];
  if (flags.tsf !== undefined) {
    const e = boundedLift({ tsfUpperBound: Number(flags.tsf) });
    liftOpts = { lift: e.lensScore, liftRange: { low: e.lensLow, high: e.lensHigh }, liftHow: 'externally measured TSF (transcript judge / A-B)' };
    liftNotes = e.notes;
  } else if (isDemo()) {
    liftOpts = { ...demoLiftOptions(), liftHow: 'labeled synthetic TSF (demo stand-in for a real A-B)' };
    liftNotes = ['Demo: Lift uses a synthetic TSF stand-in for a real transcript-judge / A-B measurement.'];
  } else {
    const dl = liftOptionsFromStore(store, report, cfg.lift.baselineMinutes);
    liftOpts = { lift: dl.lift, liftRange: dl.liftRange, liftHow: 'measured time-with-AI × configured task baselines (estimate, not a controlled A/B)' };
    liftNotes = dl.notes;
  }
  // The money number's inputs, measured from the same data the lenses use (shared
  // with the dashboard via moneyInputsFromStore, so both price the return identically).
  const { grossRealizedValueUsd, supervisionMinutes } = moneyInputsFromStore(store, report, cfg.lift.baselineMinutes, laborRate);

  const roi = computeReturnOnIntelligence(report, {
    laborRatePerHour: laborRate,
    grossRealizedValueUsd,
    supervisionMinutes,
    riskAversion,
    ...liftOpts,
  });
  roi.notes.unshift(...liftNotes);

  if (flags.json) {
    process.stdout.write(JSON.stringify(roi, null, 2) + '\n');
    store.close();
    return;
  }

  const tty = process.stdout.isTTY ?? false;
  console.log('');
  console.log(color(tty, C.bold, '  Return on Intelligence — how much you actually got from the AI'));
  console.log(color(tty, C.gray, `  ${Math.round(roi.coverage * 4)} of 4 value lenses instrumented · docs/RETURN-ON-INTELLIGENCE.md`));
  console.log(color(tty, C.gray, '  ' + '─'.repeat(64)));
  noteSource(tty, loaded.source);

  const idx = roi.roiIndex;
  const iv = roi.roiInterval;
  const hasBand = iv.low !== null && iv.high !== null && idx !== null && (iv.high - iv.low) > 0.5;
  const band = hasBand ? color(tty, C.gray, `  [${iv.low!.toFixed(0)}–${iv.high!.toFixed(0)}]`) : '';
  console.log(`  ${color(tty, C.bold, 'RoI Index')}           ${idx === null ? color(tty, C.gray, 'n/a (no lenses instrumented)') : color(tty, idx > 60 ? C.green : idx > 30 ? C.yellow : C.red, `${idx.toFixed(0)} / 100`)}${band}   ${color(tty, C.gray, hasBand ? 'point in a partially-identified interval' : 'geometric mean — no axis can carry it alone')}`);
  if (roi.indexIsUpperBound && idx !== null) {
    console.log(color(tty, C.gray, `  ${''.padEnd(20)}↑ upper bound — wiring more lenses can only lower it toward the truth`));
  }
  const eff = roi.realizedEfficiency;
  console.log(`  Realized efficiency  ${eff === null ? '—' : color(tty, C.green, pct(eff))}   ${color(tty, C.gray, `of $${(roi.tokenCostUsd + roi.effortTaxUsd).toFixed(2)} spent (tokens${roi.effortTaxUsd > 0 ? ' + effort' : ''})`)}`);

  // The money number — value ÷ cost, ≥1 ⟺ it paid for itself.
  const rr = roi.returnRatio;
  if (rr.basis === 'usd' && rr.grossRatio !== null) {
    const headline = rr.causalRatio ?? rr.grossRatio;
    const col = headline >= 1 ? C.green : C.red;
    const band =
      rr.causalRange.low !== null && rr.causalRange.high !== null
        ? color(tty, C.gray, ` [${rr.causalRange.low.toFixed(2)}–${rr.causalRange.high.toFixed(2)}×]`)
        : '';
    const tail = (headline >= 1 ? 'pays for itself' : 'below break-even') + (rr.causalRatio === null ? ' (gross — wire Lift to credit the counterfactual)' : '');
    console.log(`  ${color(tty, C.bold, 'RoI return')}           ${color(tty, col, headline.toFixed(2) + '×')}${band}   ${color(tty, C.gray, tail)}`);
    console.log(color(tty, C.gray, `  ${''.padEnd(20)}$${(rr.realizedValueUsd ?? 0).toFixed(0)} realized work (manual-equiv, net of rework) ÷ $${rr.costUsd.toFixed(2)} cost (tokens + your time)`));
  } else if (rr.realizedValueUsd !== null && !rr.supervisionPriced) {
    console.log(`  ${color(tty, C.bold, 'RoI return')}           ${color(tty, C.gray, 'un-priced — wire proxy traffic so your time-with-AI can be measured')}`);
  } else {
    console.log(`  ${color(tty, C.bold, 'RoI return')}           ${color(tty, C.gray, 'pass --labor-rate (or set lift.laborRatePerHour) to price the dollar return')}`);
  }
  const ce = roi.certaintyEquivalent;
  if (ce.riskAversion > 0 && ce.index !== null) {
    console.log(`  Risk-adjusted Index  ${color(tty, C.yellow, `${ce.index.toFixed(0)} / 100`)}   ${color(tty, C.gray, `γ=${ce.riskAversion.toFixed(2)} conservative read — toward the partial-ID lower bound`)}`);
  }

  console.log('');
  console.log(color(tty, C.bold, '  Value lenses'));
  const lensRow = (name: string, l: { value: number | null; instrumented: boolean; how: string }) => {
    const v = l.value === null ? color(tty, C.gray, 'uninstrumented') : color(tty, l.value > 0.6 ? C.green : l.value > 0.3 ? C.yellow : C.red, pct(l.value).padStart(4));
    console.log(`    ${name.padEnd(13)} ${v}   ${color(tty, C.gray, l.how)}`);
  };
  lensRow('Realization', roi.lenses.realization);
  lensRow('Acceptance', roi.lenses.acceptance);
  lensRow('Lift', roi.lenses.lift);
  lensRow('Impact', roi.lenses.impact);

  if (roi.notes.length) {
    console.log('');
    for (const n of roi.notes) console.log(color(tty, C.gray, `  · ${n}`));
  }
  console.log('');
  store.close();
}

async function cmdBudgetAdvisor(flags: Flags): Promise<void> {
  const cfg = loadConfig();
  const store = new Store(dbPath());
  const now = Date.now();
  const dayMs = 24 * 60 * 60 * 1000;
  const days = flags.days ? Number(flags.days) : 30;
  const series = store.series(now - days * dayMs, now + 1000, dayMs);
  const dailySpends = series.map((s) => s.costUsd);

  let realizedValueRate: number | null = null;
  let frontierCells: ReturnType<typeof computeFrontier>['byModelAndTask'] = [];
  const repo = flags.repo as string | undefined;
  const loadedValue = await loadRealization(store, repo, { persist: false });
  if (loadedValue) {
    realizedValueRate = loadedValue.report.matured.realizedValueRate;
    frontierCells = computeFrontier(loadedValue.report.units).byModelAndTask;
  }

  const rec = recommendBudget({ dailySpends, realizedValueRate, frontier: frontierCells });
  // Forward-looking allocation: re-weight the same budget by return + quantify the moves.
  const allocation =
    frontierCells.length >= 2
      ? recommendAllocation(
          frontierCells.map((c) => ({ key: c.key, costUsd: c.costUsd, roiIndex: c.roiIndex, realizedValueUsd: c.netRealizedValueUsd })),
        )
      : null;

  if (flags.json) {
    process.stdout.write(JSON.stringify({ ...rec, allocation }, null, 2) + '\n');
    store.close();
    return;
  }

  const tty = process.stdout.isTTY ?? false;
  console.log('');
  console.log(color(tty, C.bold, '  Budget advisor — a cap that fits real usage and follows the value'));
  console.log(color(tty, C.gray, `  Based on ${rec.basisDays} active days${loadedValue ? ' + realized-value data' : ' (usage only — pass --repo for value-based)'}`));
  console.log(color(tty, C.gray, '  ' + '─'.repeat(64)));
  if (rec.recommendedDailyUsd === null || rec.recommendedSoftUsd === null) {
    console.log(color(tty, C.gray, `  ${rec.rationale[0] ?? 'No spend history yet — run some traffic through the proxy first.'}`));
    console.log('');
    store.close();
    return;
  }
  const dailyCap = rec.recommendedDailyUsd;
  const softCap = rec.recommendedSoftUsd;
  console.log(`  Recommended daily cap   ${color(tty, C.green, usd(dailyCap))}   ${color(tty, C.gray, `soft warn ${usd(softCap)}`)}`);
  console.log(`  Observed daily          median ${usd(rec.observed.medianDaily)} · p90 ${usd(rec.observed.p90Daily)} · max ${usd(rec.observed.maxDaily)}`);
  if (rec.realizedValueRate !== null) {
    console.log(`  Realized-value rate     ${color(tty, rec.realizedValueRate > 0.5 ? C.green : C.yellow, pct(rec.realizedValueRate))}`);
  }
  if (rec.projectedMonthlyWasteUsd !== null) {
    console.log(`  Projected monthly waste ${color(tty, C.red, usd(rec.projectedMonthlyWasteUsd))}   ${color(tty, C.gray, 'spend not turning into kept outcomes')}`);
  }
  console.log('');
  for (const r of rec.rationale) console.log(color(tty, C.gray, `  · ${r}`));
  // Prefer the quantified allocation (concrete $ moves + projected value gain);
  // fall back to the qualitative trim/grow when there isn't enough frontier data.
  if (allocation && allocation.moves.length) {
    const d2 = (n: number) => '$' + n.toFixed(2); // aggregate dollars read best at 2dp
    console.log('');
    console.log(
      color(tty, C.bold, '  Allocate the same budget by return') +
        color(tty, C.gray, `   → ≈ +${d2(allocation.projectedValueGainUsd)} realized value`),
    );
    for (const m of allocation.moves.slice(0, 5)) {
      console.log(
        `    ${color(tty, C.yellow, 'MOVE')} ${d2(m.amountUsd).padStart(8)}  ` +
          `${color(tty, C.gray, `${m.fromKey} → ${m.toKey}`)}  ${color(tty, C.green, '+' + d2(m.projectedValueGainUsd))}`,
      );
    }
    console.log(color(tty, C.gray, `  ${allocation.assumptions[1]}`));
  } else if (rec.reallocations.length) {
    console.log('');
    console.log(color(tty, C.bold, '  Reallocate'));
    for (const re of rec.reallocations) {
      const tag = re.action === 'grow' ? color(tty, C.green, 'GROW') : color(tty, C.yellow, 'TRIM');
      console.log(`    ${tag}  ${re.context.padEnd(28)} ${color(tty, C.gray, re.reason)}`);
    }
  }
  if (flags.apply) {
    cfg.budget.dailyUsd = dailyCap;
    cfg.budget.dailySoftUsd = softCap;
    saveConfig(cfg);
    console.log('');
    console.log(color(tty, C.green, `  Applied: daily cap ${usd(dailyCap)}, soft ${usd(softCap)} written to config.`));
  } else {
    console.log('');
    console.log(color(tty, C.gray, '  Re-run with --apply to write these to your config.'));
  }
  console.log('');
  store.close();
}

async function cmdFrontier(flags: Flags): Promise<void> {
  const repo = (flags.repo as string) ?? process.cwd();
  const windowDays = flags.window ? Number(flags.window) : 14;
  const store = new Store(dbPath());
  const loaded = await loadRealization(store, repo, { windowDays, persist: true });
  if (!loaded) {
    printNotAGitRepo(repo);
    process.exitCode = 1;
    store.close();
    return;
  }
  const report = loaded.report;
  const fr = computeFrontier(report.units);

  if (flags.json) {
    process.stdout.write(JSON.stringify(fr, null, 2) + '\n');
    store.close();
    return;
  }

  const tty = process.stdout.isTTY ?? false;
  const idx = (n: number | null) => (n === null ? '—' : n.toFixed(0));
  console.log('');
  console.log(color(tty, C.bold, '  The per-context frontier — what AI is worth it, for what'));
  console.log(color(tty, C.gray, '  RoI compared within like-for-like work · docs/RETURN-ON-INTELLIGENCE.md'));
  console.log(color(tty, C.gray, '  ' + '─'.repeat(64)));
  noteSource(tty, loaded.source);

  console.log(color(tty, C.bold, '  By model'));
  console.log(color(tty, C.gray, '    model                        units   cost      realized   RoI'));
  for (const c of fr.byModel) {
    console.log(`    ${(c.model ?? '—').padEnd(28)} ${String(c.units).padStart(4)}   ${usd(c.costUsd).padStart(8)}   ${pct(c.realizationRate).padStart(6)}   ${color(tty, C.green, idx(c.roiIndex).padStart(3))}`);
  }

  console.log('');
  console.log(color(tty, C.bold, '  By task-type × model'));
  console.log(color(tty, C.gray, '    context                      units   cost      realized   RoI'));
  for (const c of fr.byModelAndTask.slice(0, 12)) {
    console.log(`    ${c.key.padEnd(28)} ${String(c.units).padStart(4)}   ${usd(c.costUsd).padStart(8)}   ${pct(c.realizationRate).padStart(6)}   ${color(tty, C.green, idx(c.roiIndex).padStart(3))}`);
  }

  console.log('');
  console.log(color(tty, C.bold, '  What to route where'));
  for (const r of fr.recommendations) console.log(color(tty, C.gray, `  → ${r}`));
  console.log('');
  store.close();
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
    start                 Start the proxy + local dashboard
    today | week | month  Show spend for a window      (--json)
    audit --repo <path>   Correlate spend with git commits (--limit N, --json)
    roi --repo <path>     Return on Intelligence: four value lenses (Realization,
                          Acceptance, Lift, Impact) → one composite index
                          (--labor-rate $/hr, --tsf <multiplier> for Lift, --json)
    frontier --repo <p>   What's best for you: RoI by model × task-type, with
                          routing recommendations (--window D, --json)
    usage                 RoI for non-coding usage (chat, research, drafting) —
                          sessions scored from reported outcomes (--days N, --json)
    report --kind K       Wire an outcome: code --commit <hash>, non-code --session <id>
                          kinds: tested|merged|shipped|incident|used|resolved|published|…
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
  const cmd = argv[0] ?? 'help';
  const flags = parseFlags(argv.slice(1));

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
    case 'report':
      await cmdReport(flags);
      break;
    case 'receipt':
    case 'receipts':
      await cmdReceipt(flags);
      break;
    case 'prune':
      cmdPrune();
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

main().catch((err) => {
  console.error('  AegisFlow error:', err);
  process.exitCode = 1;
});
