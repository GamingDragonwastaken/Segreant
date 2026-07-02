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
import { describeSourceDepth } from './value/sourceDepth.ts';
import { boundedLift } from './value/lift.ts';
import { refreshPricing, pricingStatus } from './cost/pricing.ts';
import { computeFrontier } from './value/frontier.ts';
import { computeUsageRoI } from './value/usage.ts';
import { computeCohort, userValueRows, selfView } from './value/cohort.ts';
import { recommendBudget } from './budget/recommend.ts';
import { recommendAllocation } from './budget/allocate.ts';
import { shadowPriceOfIntelligence, estimateBetaFromPairs } from './value/marginal.ts';
import { driftEProcess } from './value/drift.ts';
import { instrumentationPriority } from './value/voi.ts';
import { estimateBetaPrior, shrinkRate } from './value/reliability.ts';
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
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync, copyFileSync, mkdirSync } from 'node:fs';
import { SOURCE_HEADER, CONNECTORS, opencodeProviderBlock, mergeOpencodeConfig, resolveOpencodeConfigPath, listOpencodeProviders, wrapOpencodeProvider } from './connect/connectors.ts';

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

/** Locate the user's opencode config (env override → project-level → global). */
function opencodeConfigPath(): string | null {
  return resolveOpencodeConfigPath({
    env: process.env.OPENCODE_CONFIG,
    cwd: process.cwd(),
    home: homedir(),
    exists: existsSync,
  });
}

/** Print the provider block, indented under the "provider" key it goes inside. */
function printOpencodeSnippet(block: Record<string, unknown>, tty: boolean): void {
  const snippet = JSON.stringify({ aegisflow: block }, null, 2);
  console.log('');
  for (const line of snippet.split('\n')) console.log(color(tty, C.cyan, '    ' + line));
  console.log('');
}

/** The shared closing note: where the key/model come from + how to verify. */
function finishConnectOpencode(tty: boolean): void {
  console.log(color(tty, C.gray, '  apiKey/model are whatever provider you actually route through AegisFlow — point'));
  console.log(color(tty, C.gray, "  AegisFlow's upstream at that provider. (The example block shows the Gemini free tier;"));
  console.log(color(tty, C.gray, '  swap in the provider + key you already use.) Then run opencode and check:'));
  console.log(color(tty, C.green, '    aegisflow sources'));
  console.log('');
}

/**
 * The honest NATIVE connection: wrap an opencode provider the user ALREADY has.
 * Rewrites that provider's baseURL to the proxy (+ source tag) and sets AegisFlow's
 * upstream to the provider's real base, so opencode keeps working exactly as before
 * but its traffic is metered and forwarded with the user's own key. Two local files
 * change on --write (opencode config + AegisFlow config); read-only preview otherwise.
 */
function wrapOpencodeFlow(cfg: AegisConfig, flags: Flags, tty: boolean, providerName: string, path: string | null): void {
  if (!path) {
    console.log(color(tty, C.yellow, '  No opencode config found to wrap. Run `aegisflow connect opencode` to see your options.'));
    console.log('');
    return;
  }
  let raw = '';
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    /* handled by the parse below */
  }
  const res = wrapOpencodeProvider(raw, providerName, cfg.port);

  console.log('');
  console.log(color(tty, C.bold, `  Connect opencode natively — wrap your "${providerName}" provider`));
  console.log(color(tty, C.gray, '  ' + '─'.repeat(46)));
  if (!res.ok) {
    console.log(color(tty, C.yellow, `  Can't wrap "${providerName}": ${res.error}`));
    const wrappable = listOpencodeProviders(raw).filter((p) => p.wrappable).map((p) => p.name);
    if (wrappable.length) console.log(color(tty, C.gray, `  Wrappable providers: ${wrappable.join(', ')}`));
    console.log('');
    return;
  }
  if (res.alreadyWrapped) {
    console.log(color(tty, C.green, `  ✓ "${providerName}" already routes through AegisFlow.`));
    console.log(color(tty, C.gray, `    AegisFlow openai upstream: ${cfg.upstreams.openai}`));
    console.log('');
    return;
  }
  console.log(color(tty, C.gray, `  opencode keeps using "${providerName}" as-is — but its requests now go to the proxy,`));
  console.log(color(tty, C.gray, `  which forwards them to ${res.originalBaseUrl} with your own key. Your key never`));
  console.log(color(tty, C.gray, "  touches AegisFlow's author, and opencode Zen (if any) is unaffected."));
  console.log('');

  if (!flags.write) {
    console.log(color(tty, C.gray, '  Two local changes (preview — nothing written yet):'));
    console.log(color(tty, C.cyan, `    1. opencode  ${providerName}.options.baseURL → http://localhost:${cfg.port}  (+ ${SOURCE_HEADER}: opencode)`));
    console.log(color(tty, C.cyan, `    2. AegisFlow upstreams.openai          → ${res.originalBaseUrl}`));
    console.log('');
    console.log(color(tty, C.green, `    aegisflow connect opencode --wrap ${providerName} --write`));
    console.log('');
    return;
  }

  try {
    copyFileSync(path, path + '.bak');
    writeFileSync(path, res.merged!, 'utf8');
    saveConfig({ ...cfg, upstreams: { ...cfg.upstreams, openai: res.originalBaseUrl! } });
    console.log(color(tty, C.green, `  ✓ Wrapped "${providerName}". opencode now routes through AegisFlow.`));
    console.log(color(tty, C.gray, `    opencode config: ${path}  (backup at ${path}.bak)`));
    console.log(color(tty, C.gray, `    AegisFlow upstreams.openai → ${res.originalBaseUrl}`));
    console.log(color(tty, C.gray, '    JSON comments were reformatted away; your settings + keys are preserved.'));
    console.log('');
    console.log(color(tty, C.gray, '  Restart AegisFlow (aegisflow start), run opencode, then:  aegisflow sources'));
  } catch (e) {
    console.log(color(tty, C.yellow, `  Could not write: ${String(e)}`));
  }
  console.log('');
}

function connectOpencode(cfg: AegisConfig, flags: Flags, tty: boolean): void {
  const port = cfg.port;
  const block = opencodeProviderBlock(port);
  const path = opencodeConfigPath();

  if (typeof flags.wrap === 'string' && flags.wrap) {
    wrapOpencodeFlow(cfg, flags, tty, flags.wrap, path);
    return;
  }

  console.log('');
  console.log(color(tty, C.bold, '  Connect opencode as a source'));
  console.log(color(tty, C.gray, '  ' + '─'.repeat(46)));
  console.log(color(tty, C.gray, `  Routes opencode through AegisFlow on http://localhost:${port} and tags its`));
  console.log(color(tty, C.gray, `  traffic with  ${SOURCE_HEADER}: opencode  (stripped before it leaves your machine).`));
  console.log('');
  console.log(color(tty, C.gray, '  This meters traffic you ROUTE through AegisFlow. opencode Zen and other managed/'));
  console.log(color(tty, C.gray, '  closed paths go straight to their own servers, so they cannot be metered this way —'));
  console.log(color(tty, C.gray, "  that's the cooperative model (connect, don't intercept), not a gap being hidden."));
  console.log('');

  // Read-only state probe (reading the user's config is fine; we only WRITE on --write).
  let raw = '';
  if (path) {
    try {
      raw = readFileSync(path, 'utf8');
    } catch {
      /* unreadable → treated as absent below */
    }
    const probe = mergeOpencodeConfig(raw, port);
    if (probe.ok && probe.alreadyConnected && !flags.write) {
      console.log(color(tty, C.green, '  ✓ opencode is already connected as a source.'));
      console.log(color(tty, C.gray, `    Config: ${path}`));
      console.log(color(tty, C.gray, '    Run opencode, then:  aegisflow sources'));
      console.log('');
      return;
    }
    console.log(color(tty, C.gray, `  Found your opencode config: ${path}`));
  } else {
    console.log(color(tty, C.gray, '  No opencode config found (checked $OPENCODE_CONFIG, ./opencode.json, ~/.config/opencode/).'));
  }

  // Default (no --write): recommend wrapping a provider the user already has (the
  // honest native path — their key, all their traffic), then offer the stub block.
  if (!flags.write) {
    const providers = raw ? listOpencodeProviders(raw) : [];
    const wrappable = providers.filter((p) => p.wrappable);
    if (wrappable.length) {
      console.log(color(tty, C.bold, '  Recommended — wrap a provider you already use (native; your key, all its traffic):'));
      for (const p of wrappable) console.log(color(tty, C.gray, `    • ${p.name}  → ${p.baseUrl}`));
      console.log(color(tty, C.green, `    aegisflow connect opencode --wrap <provider> --write`));
      const hosted = providers.filter((p) => !p.wrappable).map((p) => p.name);
      if (hosted.length) console.log(color(tty, C.gray, `    (hosted/managed — can't be metered cooperatively: ${hosted.join(', ')})`));
      console.log('');
      console.log(color(tty, C.gray, '  Or add a dedicated metered provider block:'));
    } else {
      console.log(color(tty, C.gray, '  Add this to the "provider" object in your opencode config:'));
    }
    printOpencodeSnippet(block, tty);
    console.log(color(tty, C.gray, '  …or let AegisFlow apply the block for you:'));
    console.log(color(tty, C.green, '    aegisflow connect opencode --write'));
    console.log('');
    finishConnectOpencode(tty);
    return;
  }

  // --write: create a fresh config if none exists.
  if (!path) {
    const dest = join(homedir(), '.config', 'opencode', 'opencode.json');
    const fresh = JSON.stringify({ $schema: 'https://opencode.ai/config.json', provider: { aegisflow: block } }, null, 2) + '\n';
    try {
      mkdirSync(dirname(dest), { recursive: true });
      writeFileSync(dest, fresh, 'utf8');
      console.log(color(tty, C.green, '  ✓ Created an opencode config with the AegisFlow source:'));
      console.log(color(tty, C.gray, `    ${dest}`));
    } catch (e) {
      console.log(color(tty, C.yellow, `  Could not write the config: ${String(e)}`));
      console.log(color(tty, C.gray, '  Add this provider block yourself instead:'));
      printOpencodeSnippet(block, tty);
    }
    console.log('');
    finishConnectOpencode(tty);
    return;
  }

  // --write with an existing config: safe-merge, backing up first.
  const res = mergeOpencodeConfig(raw, port);
  if (!res.ok || !res.merged) {
    console.log(color(tty, C.yellow, `  Could not safely auto-edit the config (${res.error ?? 'unknown error'}).`));
    console.log(color(tty, C.gray, '  Add this provider block yourself instead:'));
    printOpencodeSnippet(block, tty);
    console.log('');
    finishConnectOpencode(tty);
    return;
  }
  if (res.alreadyConnected) {
    console.log(color(tty, C.green, '  ✓ Already connected — no change needed.'));
    console.log('');
    finishConnectOpencode(tty);
    return;
  }
  try {
    copyFileSync(path, path + '.bak');
    writeFileSync(path, res.merged, 'utf8');
    console.log(color(tty, C.green, `  ✓ Connected. Updated ${path}`));
    console.log(color(tty, C.gray, `    A backup of the original is at ${path}.bak`));
    console.log(color(tty, C.gray, '    Note: JSON comments were reformatted away; your settings + keys are preserved.'));
  } catch (e) {
    console.log(color(tty, C.yellow, `  Could not write the config: ${String(e)}`));
    console.log(color(tty, C.gray, '  Add this provider block yourself instead:'));
    printOpencodeSnippet(block, tty);
  }
  console.log('');
  finishConnectOpencode(tty);
}

function connectGenericApi(cfg: AegisConfig, flags: Flags, tty: boolean): void {
  const port = cfg.port;
  // Optional custom source name: `aegisflow connect api my-script`.
  const source = (typeof flags._[1] === 'string' ? flags._[1] : 'api').toLowerCase();
  // The standard OpenAI-SDK convention DOES include /v1 (the SDK appends
  // /chat/completions to it); the proxy forwards the whole path upstream.
  const base = `http://localhost:${port}/v1`;

  console.log('');
  console.log(color(tty, C.bold, `  Connect a raw API / SDK as a source ("${source}")`));
  console.log(color(tty, C.gray, '  ' + '─'.repeat(46)));
  console.log(color(tty, C.gray, '  Point any OpenAI-compatible client at the proxy and tag it with one header:'));
  console.log('');
  console.log(color(tty, C.cyan, `    OPENAI_BASE_URL = ${base}`));
  console.log(color(tty, C.cyan, `    header           ${SOURCE_HEADER}: ${source}`));
  console.log('');
  console.log(color(tty, C.gray, '  OpenAI SDK:'));
  console.log(color(tty, C.cyan, `    new OpenAI({ baseURL: "${base}", defaultHeaders: { "${SOURCE_HEADER}": "${source}" } })`));
  console.log(color(tty, C.gray, '  curl:'));
  console.log(color(tty, C.cyan, `    curl ${base}/chat/completions -H "${SOURCE_HEADER}: ${source}" ...`));
  console.log('');
  console.log(color(tty, C.gray, '  Run it, then check:'));
  console.log(color(tty, C.green, '    aegisflow sources'));
  console.log('');
}

/**
 * `aegisflow connect [<tool>] [--write] [--list]` — turn an AI tool into a source.
 * No tool (or --list) shows the menu; opencode writes/prints its provider block;
 * `api` prints the generic env + header recipe (with an optional custom source name).
 */
function cmdConnect(flags: Flags): void {
  const tty = process.stdout.isTTY ?? false;
  const cfg = loadConfig();
  const tool = (typeof flags._[0] === 'string' ? flags._[0] : '').toLowerCase();

  if (!tool || flags.list) {
    console.log('');
    console.log(color(tty, C.bold, '  Connect an AI tool as a source'));
    console.log(color(tty, C.gray, '  A source is one tool routed through AegisFlow so its spend is metered,'));
    console.log(color(tty, C.gray, "  honestly, at the depth it exposes — connect, don't intercept."));
    console.log('');
    for (const c of CONNECTORS) {
      console.log(`  ${color(tty, C.green, c.id.padEnd(12))} ${color(tty, C.gray, c.summary)}`);
    }
    console.log('');
    console.log(color(tty, C.gray, '  Usage:  aegisflow connect <tool>          e.g. aegisflow connect opencode'));
    console.log(color(tty, C.gray, '          aegisflow connect opencode --write  apply it for you (backs up first)'));
    console.log('');
    return;
  }

  if (tool === 'opencode') {
    connectOpencode(cfg, flags, tty);
    return;
  }
  if (tool === 'api' || tool === 'sdk' || tool === 'openai' || tool === 'generic') {
    connectGenericApi(cfg, flags, tty);
    return;
  }

  console.log('');
  console.log(color(tty, C.yellow, `  Unknown tool "${tool}".`) + color(tty, C.gray, ' Known connectors:'));
  for (const c of CONNECTORS) console.log(`    ${color(tty, C.green, c.id)}  ${color(tty, C.gray, c.summary)}`);
  console.log('');
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
  const price = pricingStatus(cfg.pricing.maxAgeDays);
  const priceAge = price.ageDays === null ? '' : ` · ${price.ageDays}d old`;
  console.log(
    `  ${mark(!price.stale)} Rate card   ${
      price.stale
        ? color(tty, C.yellow, `stale (>${cfg.pricing.maxAgeDays}d${priceAge}) — refresh with "aegisflow pricing --refresh"`)
        : `${price.source === 'cache' ? 'refreshed' : 'bundled'}${priceAge} · ${price.modelCount} models`
    }`,
  );
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

async function cmdUsage(flags: Flags): Promise<void> {
  const cfg = loadConfig();
  const store = new Store(dbPath());
  const now = Date.now();
  const dayMs = 24 * 60 * 60 * 1000;
  const days = flags.days ? Number(flags.days) : 30;
  // Money inputs: org-disclosed outcome baselines + labor rate. The demo assumes
  // illustrative values (clearly labeled) so the dollar face is visible there.
  let laborRate = cfg.lift.laborRatePerHour;
  let outcomeBaselines = cfg.lift.outcomeBaselineMinutes;
  if (isDemo()) {
    if (laborRate === null) laborRate = 120;
    if (Object.keys(outcomeBaselines).length === 0) outcomeBaselines = { used: 10, resolved: 30, published: 90 };
  }
  const rep = computeUsageRoI(store, {
    startMs: now - days * dayMs,
    endMs: now + 1000,
    money: { outcomeBaselineMinutes: outcomeBaselines, laborRatePerHour: laborRate },
  });

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
  if (rep.roi.realizationInterval) {
    const ci = rep.roi.realizationInterval;
    console.log(color(tty, C.gray, `                      ${pct(ci.low)}–${pct(ci.high)} anytime-valid ${Math.round(ci.level * 100)}% — valid at every glance, not just once`));
  }
  // The money face — only when the org disclosed outcome baselines + a rate.
  const rr = rep.roi.returnRatio;
  if (rep.money.priced && rr.basis === 'usd' && rr.grossRatio !== null) {
    const head = rr.causalRatio ?? rr.grossRatio;
    console.log(`  RoI return          ${color(tty, head >= 1 ? C.green : C.red, head.toFixed(2) + '×')}   ${color(tty, C.gray, `${head >= 1 ? 'pays for itself' : 'below break-even'} — outcomes priced by your disclosed baselines${isDemo() ? ' (demo: illustrative baselines)' : ''}`)}`);
  } else if (rep.realizedUnits > 0) {
    console.log(color(tty, C.gray, '                      dollar return un-priced — set lift.outcomeBaselineMinutes + laborRatePerHour to price outcomes'));
  }
  // Reach breakdown — the grade, not a flat "positive". Further-reaching outcomes
  // weigh more in Impact, so this is where non-coding value actually differentiates.
  const m = rep.outcomeMix;
  const reached = m.published + m.resolved + m.used;
  if (reached > 0) {
    const parts: string[] = [];
    if (m.published > 0) parts.push(color(tty, C.green, `${m.published} published`));
    if (m.resolved > 0) parts.push(color(tty, C.cyan, `${m.resolved} resolved`));
    if (m.used > 0) parts.push(`${m.used} used`);
    console.log(`  Reach               ${parts.join(color(tty, C.gray, ' · '))}${m.none > 0 ? color(tty, C.gray, ` · ${m.none} no outcome yet`) : ''}`);
  }
  // VoI: which measurement to buy next for this modality.
  const usageVoi = instrumentationPriority(rep.roi);
  if (usageVoi.length > 0 && rep.roi.roiIndex !== null) {
    const top = usageVoi[0]!;
    console.log(`  Instrument next     ${color(tty, C.cyan, top.lens)}   ${color(tty, C.gray, `largest unmeasured exposure — at a mid ${top.reference} the Index moves ${rep.roi.roiIndex.toFixed(0)} → ${top.indexAtReference.toFixed(0)}`)}`);
  }
  console.log('');
  for (const n of rep.roi.notes) console.log(color(tty, C.gray, `  · ${n}`));
  console.log('');
  console.log(color(tty, C.gray, '  Acceptance/survival are n/a for non-code (no diff, no git) — realized = a reported,'));
  console.log(color(tty, C.gray, '  no-incident outcome. Wire outcomes to move sessions from unknown to realized.'));
  console.log('');
  store.close();
}

async function cmdTeam(flags: Flags): Promise<void> {
  const cfg = loadConfig();
  const store = new Store(dbPath());
  const now = Date.now();
  const dayMs = 24 * 60 * 60 * 1000;
  const days = flags.days ? Number(flags.days) : 30;
  const window = { startMs: now - days * dayMs, endMs: now + 1000 };
  const opts = { enabled: cfg.perUser.enabled, minCohort: cfg.perUser.minCohort };
  const tty = process.stdout.isTTY ?? false;

  // --me <user>: a person's own view of themselves. Their own number is always
  // theirs to see; the peer comparison is gated by opt-in + cohort size.
  if (typeof flags.me === 'string') {
    const rows = userValueRows(store, window);
    const view = selfView(rows, flags.me, opts);
    store.close();
    if (flags.json) {
      process.stdout.write(JSON.stringify(view, null, 2) + '\n');
      return;
    }
    console.log('');
    if (!view) {
      console.log(color(tty, C.gray, `  No attributed sessions for "${flags.me}" in the last ${days}d.`));
      console.log('');
      return;
    }
    console.log(color(tty, C.bold, `  Your AI value — ${view.user}`));
    console.log(color(tty, C.gray, '  ' + '─'.repeat(64)));
    console.log(`  Extraction          ${color(tty, C.cyan, pct(view.extraction))}   ${color(tty, C.gray, 'of your non-coding AI spend reached a realized outcome')}`);
    console.log(`  Confidence          ${pct(view.reliability)}   ${color(tty, C.gray, `${view.sessions} sessions of evidence`)}`);
    if (view.cohortComparable && view.percentile !== null && view.vsMedianPct !== null) {
      const sign = view.vsMedianPct >= 0 ? '+' : '';
      console.log(`  vs. team median     ${color(tty, view.vsMedianPct >= 0 ? C.green : C.yellow, `${sign}${(view.vsMedianPct * 100).toFixed(0)}%`)}   ${color(tty, C.gray, `you extract more than ${(view.percentile * 100).toFixed(0)}% of the team`)}`);
    } else {
      console.log(color(tty, C.gray, '  Peer comparison withheld (per-user value off, or team below the k-anonymity floor).'));
    }
    console.log('');
    console.log(color(tty, C.gray, '  This is your own data. The org view never sees your name — only the distribution.'));
    console.log('');
    return;
  }

  // Org view: distribution + coaching lever only. Never a ranked list of people.
  const rep = computeCohort(store, { ...window, ...opts });
  store.close();
  if (flags.json) {
    process.stdout.write(JSON.stringify(rep, null, 2) + '\n');
    return;
  }
  console.log('');
  console.log(color(tty, C.bold, '  Team value — how non-coding AI spend converts to outcomes across people'));
  console.log(color(tty, C.gray, '  ' + '─'.repeat(64)));
  if (rep.suppressed || !rep.distribution) {
    console.log(color(tty, C.yellow, '  Per-user value is withheld.'));
    console.log(color(tty, C.gray, `  ${rep.reason}.`));
    console.log('');
    if (!rep.enabled) {
      console.log(color(tty, C.gray, '  It is OFF by default on purpose: attributing value to named people is the'));
      console.log(color(tty, C.gray, '  surveillance-prone axis. Enable deliberately in config (perUser.enabled),'));
      console.log(color(tty, C.gray, '  and even then this stays a distribution — never a leaderboard.'));
    }
    console.log('');
    console.log(color(tty, C.gray, '  A person can always see their OWN value:  aegisflow team --me <user>'));
    console.log('');
    return;
  }
  const d = rep.distribution;
  console.log(color(tty, C.gray, `  ${d.cohortSize} people · individuals not identified · distribution only`));
  console.log('');
  console.log(`  Extraction          median ${color(tty, C.cyan, pct(d.medianExtraction))}   ${color(tty, C.gray, `range ${pct(d.p25Extraction)}–${pct(d.p75Extraction)} (p25–p75)`)}`);
  console.log(`  Spread              ${d.broadBased ? color(tty, C.green, 'broad-based') : color(tty, C.yellow, 'concentrated')}   ${color(tty, C.gray, `dispersion ${d.dispersion.toFixed(2)}`)}`);
  console.log(`  Realized value      ${color(tty, C.gray, `${usd(d.totalRealizedValueUsd)} of ${usd(d.totalCostUsd)} spent`)}`);
  console.log('');
  console.log(color(tty, C.bold, `  Coaching headroom   ${color(tty, C.green, usd(d.coachingHeadroomUsd))}`));
  console.log(color(tty, C.gray, '  Latent value if everyone below the median were enabled up to it — at their'));
  console.log(color(tty, C.gray, '  own current spend. A case for training/support, not a ranking of people.'));
  console.log('');
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

  // Goodhart drift alarm (docs §11): is the realization rate being BENT? Run the
  // anytime-valid e-process over mature units in time order. Needs a real stream
  // to say anything (≥10 resolved units); silent below that, honestly.
  const matureOrdered = report.units.filter((u) => !u.maturing).sort((a, b) => a.tsEpochMs - b.tsEpochMs);
  const drift = matureOrdered.length >= 10 ? driftEProcess(matureOrdered.map((u) => u.funnel.realized)) : null;
  // VoI (docs §12): which measurement to buy next — the un-instrumented lens
  // whose measurement would move the Index most, at a disclosed mid reference.
  const voi = instrumentationPriority(roi);

  if (flags.json) {
    process.stdout.write(JSON.stringify({ ...roi, drift, instrumentNext: voi }, null, 2) + '\n');
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
  if (roi.realizationInterval) {
    const ci = roi.realizationInterval;
    console.log(color(tty, C.gray, `                  ${pct(ci.low)}–${pct(ci.high)} anytime-valid ${Math.round(ci.level * 100)}% — safe to watch continuously and act on at any moment`));
  }
  lensRow('Acceptance', roi.lenses.acceptance);
  lensRow('Lift', roi.lenses.lift);
  lensRow('Impact', roi.lenses.impact);

  // Stability: the Goodhart alarm. It detects that the rate MOVED, not why —
  // gaming and a genuine regime change both trip it; its job is to force the question.
  if (drift) {
    console.log('');
    if (drift.alarm) {
      console.log(`  ${color(tty, C.bold, 'Stability')}            ${color(tty, C.red, 'DRIFT DETECTED')}   ${color(tty, C.gray, `realization moved ${pct(drift.overallRate ?? 0)} → ${pct(drift.recentRate ?? 0)} recently (anytime-valid, α=${drift.alpha})`)}`);
      console.log(color(tty, C.gray, '                       ask why: did the work change (new model/workflow → re-baseline), or is the metric being gamed?'));
    } else {
      console.log(`  ${color(tty, C.bold, 'Stability')}            ${color(tty, C.green, 'stable')}   ${color(tty, C.gray, `no drift in the realization stream (${drift.n} units, anytime-valid)`)}`);
    }
  }

  // VoI: name the next measurement worth buying, with the exposure quantified.
  if (voi.length > 0 && roi.roiIndex !== null) {
    const top = voi[0]!;
    console.log('');
    console.log(
      `  ${color(tty, C.bold, 'Instrument next')}      ${color(tty, C.cyan, top.lens)}   ` +
        color(
          tty,
          C.gray,
          `largest unmeasured exposure: measured at a mid ${top.reference}, the Index moves ${roi.roiIndex.toFixed(0)} → ${top.indexAtReference.toFixed(0)} — measuring only makes the number more honest`,
        ),
    );
  }

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

  // The shadow price of intelligence — what one more AI dollar returns, optimally
  // deployed. Reliability-adjust each context's value first (empirical-Bayes
  // shrinkage of its realization rate) so a noisy 2-unit cell can't distort the
  // optimum. (docs/RETURN-ON-INTELLIGENCE.md §8–9.)
  let shadow: ReturnType<typeof shadowPriceOfIntelligence> | null = null;
  let betaEstimate: ReturnType<typeof estimateBetaFromPairs> | null = null;
  if (frontierCells.length >= 2) {
    // β from the org's OWN curvature when history supports it: the same contexts
    // observed in the window's two halves; within-context slopes cancel context
    // quality, so heterogeneous contexts can't bias the elasticity. Falls back to
    // the disclosed planning default (0.5) when not estimable. (docs §9.)
    const units = loadedValue!.report.units;
    let betaOpts: { beta?: number; betaHow?: string } = {};
    if (units.length >= 6) {
      const ts = units.map((u) => u.tsEpochMs).sort((a, b) => a - b);
      const cut = ts[ts.length >> 1]!;
      const early = computeFrontier(units.filter((u) => u.tsEpochMs < cut)).byModelAndTask;
      const late = new Map(computeFrontier(units.filter((u) => u.tsEpochMs >= cut)).byModelAndTask.map((c) => [c.key, c]));
      const pairs = early.flatMap((c) => {
        const l = late.get(c.key);
        return l ? [{ key: c.key, spend1: c.costUsd, value1: c.netRealizedValueUsd, spend2: l.costUsd, value2: l.netRealizedValueUsd }] : [];
      });
      betaEstimate = estimateBetaFromPairs(pairs);
      if (betaEstimate.beta !== null) betaOpts = { beta: betaEstimate.beta, betaHow: betaEstimate.how };
    }
    const prior = estimateBetaPrior(frontierCells.map((c) => ({ k: Math.round(c.realizationRate * c.units), n: c.units })));
    const marginalCells = frontierCells.map((c) => {
      const shrunk = shrinkRate(Math.round(c.realizationRate * c.units), c.units, prior);
      const adj = c.realizationRate > 0 ? shrunk / c.realizationRate : 1; // scale value by the reliable/raw ratio
      return { key: c.key, costUsd: c.costUsd, realizedValueUsd: c.netRealizedValueUsd * adj };
    });
    shadow = shadowPriceOfIntelligence(marginalCells, betaOpts);
  }

  if (flags.json) {
    process.stdout.write(JSON.stringify({ ...rec, allocation, shadowPrice: shadow }, null, 2) + '\n');
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
  // The headline scalar: the marginal return on the next AI dollar at the optimum.
  if (shadow && shadow.budgetUsd > 0 && shadow.optimalValueUsd > 0) {
    const d2 = (n: number) => '$' + n.toFixed(2);
    console.log('');
    console.log(color(tty, C.bold, '  Shadow price of intelligence') + color(tty, C.gray, '   what one more AI $ returns, optimally spent'));
    console.log(
      `    ${color(tty, shadow.paysAtMargin ? C.green : C.red, d2(shadow.shadowPriceUsd) + ' per AI $')}   ` +
        color(tty, C.gray, shadow.paysAtMargin ? 'the next dollar still pays for itself — room to grow' : 'past positive margin — cut before you grow'),
    );
    console.log(color(tty, C.gray, `    same ${d2(shadow.budgetUsd)} budget split optimally: ${d2(shadow.currentValueUsd)} → ${d2(shadow.optimalValueUsd)} realized value (+${d2(shadow.upliftUsd)})`));
    const betaLine = betaEstimate && betaEstimate.beta !== null
      ? `β=${shadow.beta.toFixed(2)} — ${betaEstimate.how}`
      : `β=${shadow.beta.toFixed(2)} — disclosed planning default${betaEstimate ? ` (${betaEstimate.how})` : ''}`;
    console.log(color(tty, C.gray, `    ${betaLine}`));
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

  // Honor pricing.autoRefresh: if the rate card is stale and a manifest is set,
  // pull a fresh one on launch so metering prices at current rates. OFF by default
  // (keeps "zero external requests" true out of the box); a failure never blocks
  // the daemon — we keep the current table and say so.
  if (cfg.pricing.autoRefresh && cfg.pricing.manifestUrl && pricingStatus(cfg.pricing.maxAgeDays).stale) {
    const res = await refreshPricing(cfg.pricing.manifestUrl);
    console.log(
      res.ok
        ? color(tty, C.gray, `  ↻ pricing refreshed — ${res.modelCount} models (${cfg.pricing.manifestUrl})`)
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

  if (flags['refresh']) {
    const url = (typeof flags['url'] === 'string' ? flags['url'] : null) ?? cfg.pricing.manifestUrl;
    if (!flags.json) console.error(`  Refreshing pricing from ${url ?? '(none configured)'} …`);
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
    console.log(`\n  ${color(on, C.dim, 'Refresh with:  aegisflow pricing --refresh')}`);
  }
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
    start                 Start the proxy + local dashboard
    today | week | month  Show spend for a window      (--json)
    sources               Spend by connected source — each AI tool routed here
                          (--all for all-time, --json)
    connect <tool>        Connect an AI tool as a source so its spend is metered:
                          opencode (--write to apply), api (generic SDK/curl recipe).
                          No tool lists the connectors.
    audit --repo <path>   Correlate spend with git commits (--limit N, --json)
    roi --repo <path>     Return on Intelligence: four value lenses (Realization,
                          Acceptance, Lift, Impact) → one composite index
                          (--labor-rate $/hr, --tsf <multiplier> for Lift, --json)
    frontier --repo <p>   What's best for you: RoI by model × task-type, with
                          routing recommendations (--window D, --json)
    usage                 RoI for non-coding usage (chat, research, drafting) —
                          sessions scored from reported outcomes (--days N, --json)
    team                  Per-user value: how much of the spend reaches outcomes.
                          Opt-in, distribution-only, k-anonymous. --me <user> for
                          your own view (--days N, --json)
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
                          Update it:  pricing --refresh  (pulls the latest rates;
                          --url <manifest> to override the source)
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
    case 'team':
      await cmdTeam(flags);
      break;
    case 'report':
      await cmdReport(flags);
      break;
    case 'exec':
      await cmdExec(flags, wrapped);
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
