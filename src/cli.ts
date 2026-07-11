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

/**
 * Antigravity's BUILT-IN Gemini agent routes through Google's own servers — a
 * managed backend no cooperative proxy can meter (same class as opencode Zen).
 * But Antigravity supports CUSTOM OpenAI-compatible providers (base URL + key),
 * and those we meter fully: provider → proxy → the upstream of your choice.
 * `--write` points the proxy's OpenAI upstream at Gemini's OpenAI-compatible
 * endpoint, the free-tier test path; the user's key passes through untouched.
 */
function connectAntigravity(cfg: AegisConfig, flags: Flags, tty: boolean): void {
  const base = `http://localhost:${cfg.port}/v1`;

  if (flags.write) {
    const next: AegisConfig = { ...cfg, upstreams: { ...cfg.upstreams, openai: GEMINI_OPENAI_COMPAT_BASE } };
    saveConfig(next);
    console.log('');
    console.log(`  ${color(tty, C.green, '✓')} OpenAI-path upstream set to Gemini's OpenAI-compatible endpoint:`);
    console.log(color(tty, C.cyan, `      ${GEMINI_OPENAI_COMPAT_BASE}`));
    console.log(color(tty, C.gray, '    (undo: set upstreams.openai back to https://api.openai.com in config)'));
  }

  console.log('');
  console.log(color(tty, C.bold, '  Connect Google Antigravity as a source'));
  console.log(color(tty, C.gray, '  ' + '─'.repeat(52)));
  console.log(color(tty, C.gray, '  Antigravity’s built-in Gemini agent runs on Google’s servers — unmeterable'));
  console.log(color(tty, C.gray, '  by any cooperative proxy. Its CUSTOM providers, however, meter fully:'));
  console.log('');
  console.log(`  1) ${color(tty, C.bold, 'Choose the upstream')} the proxy forwards to. For the Gemini free tier:`);
  console.log(color(tty, C.green, '       aegisflow connect antigravity --write'));
  console.log(color(tty, C.gray, `       (sets upstreams.openai → ${GEMINI_OPENAI_COMPAT_BASE})`));
  console.log('');
  console.log(`  2) ${color(tty, C.bold, 'In Antigravity')}: Settings → Models → add a custom provider:`);
  console.log(color(tty, C.cyan, '       Provider type   OpenAI-compatible'));
  console.log(color(tty, C.cyan, `       Base URL        ${base}`));
  console.log(color(tty, C.cyan, '       API key         your provider key (passes through the proxy; never stored)'));
  console.log(color(tty, C.cyan, '       Model           e.g. gemini-2.5-flash'));
  console.log('');
  console.log(`  3) ${color(tty, C.bold, 'Run it')}: aegisflow start, use Antigravity with that model, then:`);
  console.log(color(tty, C.green, '       aegisflow today') + color(tty, C.gray, '   — the requests and their cost appear live'));
  console.log('');
  console.log(color(tty, C.gray, '  Note: without a custom-headers field the spend lands under the "direct"'));
  console.log(color(tty, C.gray, '  source. Metering, caps, and RoI all work the same.'));
  console.log('');
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
    console.log(color(tty, C.gray, '  No base URL to wire? Meter subscription tools natively — no routing, no key:'));
    console.log(color(tty, C.green, '          aegisflow import claude-code | opencode | codex | all   ') + color(tty, C.gray, '(--watch = live)'));
    console.log('');
    return;
  }

  if (tool === 'opencode') {
    connectOpencode(cfg, flags, tty);
    return;
  }
  if (tool === 'antigravity') {
    connectAntigravity(cfg, flags, tty);
    return;
  }
  if (tool === 'claude-code' || tool === 'claudecode') {
    console.log('');
    console.log(color(tty, C.bold, '  Connect Claude Code — natively, no routing'));
    console.log(color(tty, C.gray, '  ' + '─'.repeat(52)));
    console.log(color(tty, C.gray, '  Claude Code already writes exact usage (model, tokens, cache splits) to'));
    console.log(color(tty, C.gray, '  local transcripts — including on Pro/Max subscriptions that never touch a'));
    console.log(color(tty, C.gray, '  proxy. No base URL to change, no key to move. Import it:'));
    console.log('');
    console.log(color(tty, C.green, '    aegisflow import claude-code'));
    console.log('');
    console.log(color(tty, C.gray, '  Idempotent — re-run any time (or cron it); only new traffic is added.'));
    console.log('');
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
  const base = baselineManifestStatus();
  const baseAge = base.ageDays === null ? '' : ` · ${base.ageDays}d old`;
  console.log(
    `  ${mark(!base.stale)} Baseline    ${
      base.stale
        ? color(tty, C.yellow, `stale (${baseAge.trim()}) — refresh with "aegisflow baseline --refresh --url <manifest>" if you have one to trust`)
        : `${base.source === 'cache' ? 'refreshed' : 'bundled'}${baseAge} · ${base.taskTypeCount} task-types`
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

/**
 * Every guide fact is read from the database or probed live — never inferred
 * from what the user ran before. Re-running `guide` after any action shows the
 * journey advance, which is the whole point: the tool teaches by reflecting state.
 */
async function gatherGuideFacts(): Promise<GuideFacts> {
  const cfg = loadConfig();
  const store = new Store(dbPath());
  const now = Date.now();
  const day = 24 * 60 * 60 * 1000;
  const all = store.summary(0, now + 1000);
  const sum30 = store.summary(now - 30 * day, now + 1000);
  const outcomeSignals = store.countSignals();
  const realizationUnits = store.countRealizationUnits();
  store.close();

  let proxyUp = false;
  try {
    const r = await fetch(`http://localhost:${cfg.port}/__aegis/health`, { signal: AbortSignal.timeout(800) });
    proxyUp = r.ok;
  } catch {
    proxyUp = false;
  }

  return {
    demo: isDemo(),
    port: cfg.port,
    dashboardPort: cfg.dashboardPort,
    proxyUp,
    requestsAllTime: all.requests,
    spend30dUsd: sum30.costUsd,
    dailyCapUsd: cfg.budget.dailyUsd,
    outcomeSignals,
    realizationUnits,
    laborRateSet: cfg.lift.laborRatePerHour !== null,
  };
}

async function cmdGuide(flags: Flags): Promise<void> {
  const report = buildGuide(await gatherGuideFacts());
  if (flags.json) {
    process.stdout.write(JSON.stringify(report, null, 2) + '\n');
    return;
  }

  const tty = process.stdout.isTTY ?? false;
  console.log('');
  console.log(color(tty, C.bold, '  AegisFlow — where you are') + (isDemo() ? color(tty, C.yellow, '   ● DEMO DATA') : ''));
  console.log(color(tty, C.gray, '  ' + '─'.repeat(58)));
  console.log(`  ${color(tty, C.bold, report.headline)}`);
  console.log('');

  for (const step of report.steps) {
    const isNext = step.id === report.next.id;
    const mark = step.done ? color(tty, C.green, '✓') : isNext ? color(tty, C.cyan, '→') : color(tty, C.gray, '·');
    const padded = step.title.padEnd(24);
    const title = step.done ? padded : isNext ? color(tty, C.cyan, padded) : color(tty, C.gray, padded);
    console.log(`  ${mark} ${title} ${color(tty, C.gray, step.state)}`);
    if (isNext) {
      console.log(`      ${step.why}`);
      for (const c of step.commands) console.log(color(tty, C.cyan, `        ${c}`));
    }
  }

  console.log('');
  if (report.hint) console.log(color(tty, C.gray, `  ${report.hint}`));
  console.log(color(tty, C.gray, '  aegisflow help — every command · aegisflow doctor — health check'));
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

/**
 * Judge a recent window's AI-assisted efficiency (src/judge/orchestrate.ts).
 * One CLI invocation is one ad-hoc judged window, not a detected session
 * boundary — real session-boundary detection doesn't exist in this codebase
 * yet, so `sessionId` is freshly generated per call, not looked up. With no
 * judge.* tier configured (the default), this always returns the zero-cost
 * algorithmic signal — that's the expected steady state, not a degraded one.
 * See docs/LIFT-AI-SIDE-JUDGE-DESIGN.md §4 for the trust-ladder this reads.
 */
async function cmdJudge(flags: Flags): Promise<void> {
  const tty = process.stdout.isTTY ?? false;
  const repo = (flags.repo as string) ?? process.cwd();

  let project: string;
  if (typeof flags.project === 'string') {
    project = flags.project;
  } else {
    if (!(await isGitRepo(repo))) {
      printNotAGitRepo(repo);
      process.exitCode = 1;
      return;
    }
    project = await projectName(repo);
  }

  const windowDays = flags.window ? Number(flags.window) : 1;
  const windowEndMs = Date.now();
  const windowStartMs = windowEndMs - windowDays * 86_400_000;
  const sessionId = randomUUID();

  const cfg = loadConfig();
  const store = new Store(dbPath());
  const judgment = await judgeSessionFromStore(store, project, sessionId, windowStartMs, windowEndMs, cfg.judge);
  store.close();

  if (flags.json) {
    process.stdout.write(JSON.stringify(judgment, null, 2) + '\n');
    return;
  }

  // Escalating ladder, matching the design doc's "a richer source must never
  // look as cheap as algorithmic" principle (§3) — confidence is the most
  // load-bearing field here, so it gets the most visually distinct color.
  const confColor: string =
    judgment.confidence === 'algorithmic' ? C.gray
    : judgment.confidence === 'local-llm' ? C.cyan
    : judgment.confidence === 'hosted-llm-structural' ? C.yellow
    : C.red; // 'hosted-llm-full'

  console.log('');
  console.log(color(tty, C.bold, `  AegisFlow — session judge · ${project}`));
  console.log(color(tty, C.gray, '  ' + '─'.repeat(46)));
  console.log(color(tty, C.gray, `  window: last ${windowDays}d · session ${sessionId}`));
  console.log('');
  console.log(`  Efficiency    ${color(tty, judgment.efficiencyMultiplier >= 1 ? C.green : C.yellow, judgment.efficiencyMultiplier.toFixed(2) + 'x')}`);
  console.log(`  Confidence    ${color(tty, confColor, judgment.confidence)}`);
  console.log('');
  console.log(color(tty, C.gray, `  ${judgment.rationale}`));
  if (judgment.confidence === 'algorithmic') {
    console.log('');
    console.log(color(tty, C.gray, '  No LLM judge tier is configured — this is the always-on algorithmic signal.'));
    console.log(color(tty, C.gray, '  Opt into a local or hosted LLM judge via config.judge.* — see docs/LIFT-AI-SIDE-JUDGE-DESIGN.md §4.'));
  }
  console.log('');
}

type PushResult =
  | { status: 'empty'; message: string }
  | { status: 'dry-run'; signed: SignedRollup }
  | { status: 'ok'; keyId: string; projectCount: number }
  | { status: 'error'; message: string };

/**
 * Sign and (unless dryRun) push a rollup of the given projects. Pure: no
 * printing, no process.exitCode — callers decide how to present each
 * PushResult. Shared by the one-shot and --watch paths (cmdTeamPush,
 * cmdTeamPushWatch) so both stay in lockstep on message text and JSON shape.
 */
async function signAndPushRollup(
  projects: ProjectValue[],
  opts: { windowDays: number; projectFilter: string | null; keys: KeyPair; url: string | null; dryRun: boolean; strata?: ProjectTaskStratum[] },
): Promise<PushResult> {
  if (projects.length === 0) {
    const message = opts.projectFilter
      ? `no realized units found for project "${opts.projectFilter}" in the last ${opts.windowDays}d — nothing to push`
      : `no realized units found in the last ${opts.windowDays}d — nothing to push`;
    return { status: 'empty', message };
  }

  const to = new Date();
  const from = new Date(to.getTime() - opts.windowDays * 86_400_000);
  const body = buildRollupBody(opts.keys, projects, { from: from.toISOString(), to: to.toISOString() }, opts.strata);
  const signed: SignedRollup = signRollup(body, opts.keys);

  if (opts.dryRun) {
    return { status: 'dry-run', signed };
  }

  try {
    const res = await fetch(opts.url!.replace(/\/$/, '') + '/rollups', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(signed),
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      const message = `push failed: HTTP ${res.status} from ${opts.url}${detail ? ` — ${detail.slice(0, 200)}` : ''}`;
      return { status: 'error', message };
    }
    return { status: 'ok', keyId: opts.keys.keyId, projectCount: projects.length };
  } catch (e) {
    return { status: 'error', message: `push failed: ${String(e)}` };
  }
}

/**
 * Push a signed, numeric-only rollup of this machine's per-project value/RoI to
 * an enterprise-run team server. See docs/TEAM-TIER-DESIGN.md — AegisFlow hosts
 * nothing; --url points at infrastructure the team already runs and trusts.
 * Uses a SEPARATE keypair from `receipt --pubkey` on purpose (src/team/rollup.ts).
 * `--watch` keeps pushing on an interval (--every seconds) — see cmdTeamPushWatch,
 * the same pattern as `import --watch` (cmdImportWatch).
 */
async function cmdTeamPush(flags: Flags): Promise<void> {
  const tty = process.stdout.isTTY ?? false;
  const keyPath = join(aegisHome(), 'team-key.json');
  const sub = typeof flags._[0] === 'string' ? flags._[0] : '';

  if (sub !== 'push') {
    console.log('');
    console.log(color(tty, C.bold, '  Team tier — push a signed rollup to a team server you run'));
    console.log(color(tty, C.gray, '  AegisFlow hosts nothing; --url points at infrastructure your team already trusts.'));
    console.log('');
    console.log(color(tty, C.gray, '  Usage:  aegisflow team push --url <url>          send this window\'s per-project value/RoI'));
    console.log(color(tty, C.gray, '          aegisflow team push --dry-run             preview without sending'));
    console.log(color(tty, C.gray, '          aegisflow team push --pubkey              print this machine\'s rollup signing identity'));
    console.log(color(tty, C.gray, '          aegisflow team push --url <url> --window 7 --project <name>'));
    console.log(color(tty, C.gray, '          aegisflow team push --url <url> --watch --every 3600   background interval (seconds)'));
    console.log('');
    return;
  }

  if (flags.pubkey) {
    const keys = loadOrCreateKeyPair(keyPath);
    if (flags.json) {
      process.stdout.write(JSON.stringify({ keyId: keys.keyId, publicKey: keys.publicPem }, null, 2) + '\n');
      return;
    }
    console.log('');
    console.log(color(tty, C.bold, '  AegisFlow team-rollup identity') + color(tty, C.gray, '   register this with your team server'));
    console.log(`  keyId: ${color(tty, C.cyan, keys.keyId)}`);
    console.log('');
    process.stdout.write(keys.publicPem.endsWith('\n') ? keys.publicPem : keys.publicPem + '\n');
    console.log('');
    return;
  }

  const url = typeof flags['url'] === 'string' ? flags['url'] : null;
  const dryRun = Boolean(flags['dry-run']);
  if (!url && !dryRun) {
    const msg = 'no team server URL given — pass one your team runs: aegisflow team push --url <url>  (or --dry-run to preview without sending)';
    if (flags.json) {
      console.log(JSON.stringify({ ok: false, error: msg }, null, 2));
      process.exitCode = 1;
      return;
    }
    console.error(`  ${color(tty, C.yellow, '✗')} ${msg}`);
    process.exitCode = 1;
    return;
  }

  const windowDays = flags.window ? Number(flags.window) : 30;
  const projectFilter = typeof flags['project'] === 'string' ? flags['project'] : null;

  if (flags.watch) {
    if (!url) {
      const msg = 'no team server URL given — --watch needs somewhere to push: aegisflow team push --url <url> --watch';
      if (flags.json) {
        console.log(JSON.stringify({ ok: false, error: msg }, null, 2));
        process.exitCode = 1;
        return;
      }
      console.error(`  ${color(tty, C.yellow, '✗')} ${msg}`);
      process.exitCode = 1;
      return;
    }
    await cmdTeamPushWatch({ keyPath, url, windowDays, projectFilter, intervalMs: typeof flags.every === 'string' ? Number(flags.every) * 1000 : undefined });
    return;
  }

  const store = new Store(dbPath());
  let projects = projectValueBreakdown(store, { windowDays });
  // Task strata travel with the rollup so the server can standardize on a fixed
  // task basket (src/team/standardize.ts) — same project filter as the totals.
  let strata = projectTaskStrata(store, { windowDays });
  store.close();
  if (projectFilter) {
    projects = projects.filter((p) => p.project === projectFilter);
    strata = strata.filter((s) => s.project === projectFilter);
  }

  const keys = loadOrCreateKeyPair(keyPath);
  const result = await signAndPushRollup(projects, { windowDays, projectFilter, keys, url, dryRun, strata });

  if (result.status === 'empty') {
    if (flags.json) {
      console.log(JSON.stringify({ ok: true, projects: 0, note: result.message }, null, 2));
      return;
    }
    console.log(`  ${color(tty, C.dim, result.message)}`);
    return;
  }

  if (result.status === 'dry-run') {
    if (flags.json) {
      console.log(JSON.stringify(result.signed, null, 2));
      return;
    }
    console.log('');
    console.log(color(tty, C.bold, `  Dry run — would push ${projects.length} project(s), signed by key ${keys.keyId}`));
    for (const p of projects) {
      const roiStr = p.roiIndex === null ? 'RoI —' : `RoI ${Math.round(p.roiIndex)}`;
      console.log(`    ${p.project.padEnd(24)} ${usd(p.costUsd).padStart(12)}   ${roiStr}`);
    }
    console.log(color(tty, C.gray, `  Nothing was sent. Re-run with --url <url> to actually push.`));
    console.log('');
    return;
  }

  if (result.status === 'error') {
    if (flags.json) {
      console.log(JSON.stringify({ ok: false, error: result.message }, null, 2));
      process.exitCode = 1;
      return;
    }
    console.error(`  ${color(tty, C.red, '✗')} ${result.message}`);
    process.exitCode = 1;
    return;
  }

  if (flags.json) {
    console.log(JSON.stringify({ ok: true, keyId: result.keyId, projects: result.projectCount }, null, 2));
    return;
  }
  console.log(`  ${color(tty, C.green, '✓')} Pushed ${result.projectCount} project(s) to ${url}, signed by key ${result.keyId}`);
}

/**
 * Live team push: re-sign and push the rolling window on an interval — same
 * poll/print-one-line/Ctrl+C-to-stop pattern as cmdImportWatch. Keeps the store
 * open across ticks (the one-shot path above opens, reads, and closes once) and
 * re-queries project totals fresh each tick, so a long-running watch reflects
 * work completed after it started.
 */
async function cmdTeamPushWatch(opts: {
  keyPath: string;
  url: string;
  windowDays: number;
  projectFilter: string | null;
  intervalMs?: number;
}): Promise<void> {
  const tty = process.stdout.isTTY ?? false;
  const intervalMs = Math.max(2000, opts.intervalMs ?? 5000);
  const store = new Store(dbPath());
  const keys = loadOrCreateKeyPair(opts.keyPath);

  console.log('');
  console.log(color(tty, C.bold, `  Team push — watching, pushing every ${Math.round(intervalMs / 1000)}s`));
  console.log(
    color(
      tty,
      C.gray,
      `  Window: last ${opts.windowDays}d${opts.projectFilter ? ` · project ${opts.projectFilter}` : ''} · target ${opts.url} · Ctrl+C to stop`,
    ),
  );
  console.log('');

  let running = true;
  const tick = async (): Promise<void> => {
    const time = new Date().toLocaleTimeString('en-US', { hour12: false });
    try {
      let projects = projectValueBreakdown(store, { windowDays: opts.windowDays });
      let strata = projectTaskStrata(store, { windowDays: opts.windowDays });
      if (opts.projectFilter) {
        projects = projects.filter((p) => p.project === opts.projectFilter);
        strata = strata.filter((s) => s.project === opts.projectFilter);
      }
      const result = await signAndPushRollup(projects, {
        windowDays: opts.windowDays,
        projectFilter: opts.projectFilter,
        keys,
        url: opts.url,
        dryRun: false,
        strata,
      });
      if (result.status === 'ok') {
        console.log(color(tty, C.gray, `  ${time}  `) + color(tty, C.green, `✓ pushed ${result.projectCount} project(s)`));
      } else if (result.status === 'empty') {
        console.log(color(tty, C.gray, `  ${time}  ${result.message}`));
      } else if (result.status === 'error') {
        console.log(color(tty, C.gray, `  ${time}  `) + color(tty, C.red, `✗ ${result.message}`));
      }
    } catch (e) {
      console.log(color(tty, C.gray, `  ${time}  `) + color(tty, C.red, `✗ push tick failed: ${String(e)}`));
    }
  };

  await tick();
  const timer = setInterval(() => {
    if (running) void tick();
  }, intervalMs);

  await new Promise<void>((resolve) => {
    const stop = () => {
      running = false;
      clearInterval(timer);
      store.close();
      console.log('\n  Stopped watching.');
      resolve();
    };
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
  });
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
