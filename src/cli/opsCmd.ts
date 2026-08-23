/**
 * Setup & health command cluster — alerts, doctor, init, guide, and audit.
 * Extracted verbatim from cli.ts in the per-command-module split;
 * gatherGuideFacts stays module-internal to cmdGuide.
 */

import { Store } from '../store/db.ts';
import { loadConfig, saveConfig, dbPath, configPath, isDemo } from '../config.ts';
import { attributeCommits, isGitRepo } from '../git/correlate.ts';
import { loadRealization } from '../value/realization.ts';
import { buildGuide, type GuideFacts } from '../guide.ts';
import { computeAlerts } from '../alerts/detect.ts';
import { notifyWebhook } from '../alerts/notify.ts';
import { pricingStatus } from '../cost/pricing.ts';
import { baselineManifestStatus } from '../value/liftBaseline.ts';
import { egressFetch } from '../egress/transport.ts';
import { C, color, usd, num, printNotAGitRepo } from './ui.ts';
import { type Flags } from './flags.ts';

export async function cmdAlerts(flags: Flags): Promise<void> {
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
      console.error('  No webhook configured. Set one with: fiscus alerts --set-webhook <url>  (or pass --notify-url <url>)');
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
      if (r.action) console.error(color(tty, C.gray, `  Action: ${r.action}`));
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
  console.log(color(tty, C.bold, '  Fiscus — governance alerts'));
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
export async function cmdDoctor(): Promise<void> {
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
    const r = await egressFetch('http://localhost:' + cfg.port + '/__fiscus/health', {
      purpose: 'local_healthcheck',
      dataClass: 'healthcheck',
      signal: AbortSignal.timeout(800),
    });
    proxyUp = r.ok;
  } catch {
    proxyUp = false;
  }

  const mark = (good: boolean) => (good ? color(tty, C.green, '✓') : color(tty, C.yellow, '!'));
  console.log('');
  console.log(color(tty, C.bold, '  Fiscus — doctor'));
  console.log(color(tty, C.gray, '  ' + '─'.repeat(58)));
  console.log(`  ${mark(true)} Config      ${color(tty, C.gray, configPath())}`);
  console.log(`  ${mark(true)} Database    ${color(tty, C.gray, `${dbPath()}  (${num(sum30.requests)} req · ${usd(sum30.costUsd)} in 30d)`)}`);
  console.log(`  ${mark(proxyUp)} Proxy       ${proxyUp ? color(tty, C.green, `running on :${cfg.port}`) : color(tty, C.yellow, `not reachable on :${cfg.port} — start with "fiscus start"`)}`);
  console.log(`  ${mark(cfg.budget.dailyUsd !== null)} Daily cap   ${cfg.budget.dailyUsd !== null ? usd(cfg.budget.dailyUsd) : color(tty, C.yellow, 'none — metering only (set with "fiscus budget --daily N")')}`);
  console.log(`  ${mark(estShare <= 0.2)} Pricing     ${estShare > 0 ? `${Math.round(estShare * 100)}% of 30d spend used estimated rates` : 'all spend priced from the rate card'}`);
  const price = pricingStatus(cfg.pricing.maxAgeDays);
  const priceAge = price.ageDays === null ? '' : ` · ${price.ageDays}d old`;
  const priceEvidence = price.source === 'cache'
    ? `${price.sourceKind} cache · ${price.cacheIntegrity} integrity · local list-price estimate`
    : 'bundled package card · local list-price estimate';
  console.log(
    `  ${mark(!price.stale)} Rate card   ${
      price.stale
        ? color(tty, C.yellow, `stale (>${cfg.pricing.maxAgeDays}d${priceAge}) · ${priceEvidence} — refresh with "fiscus pricing --refresh"`)
        : `${priceEvidence}${priceAge} · ${price.modelCount} models`
    }`,
  );
  const base = baselineManifestStatus();
  const baseAge = base.ageDays === null ? '' : ` · ${base.ageDays}d old`;
  console.log(
    `  ${mark(!base.stale)} Baseline    ${
      base.stale
        ? color(tty, C.yellow, `stale (${baseAge.trim()}) — refresh with "fiscus baseline --refresh --url <manifest>" if you have one to trust`)
        : `${base.source === 'cache' ? 'refreshed' : 'bundled'}${baseAge} · ${base.taskTypeCount} task-types`
    }`,
  );
  console.log(`  ${mark(criticals === 0)} Alerts      ${alerts.length ? `${num(alerts.length)} active (${criticals} critical) — see "fiscus alerts"` : color(tty, C.green, 'all clear')}`);
  console.log('');
  console.log(color(tty, C.gray, '  Point your AI tools at the proxy:'));
  console.log(color(tty, C.gray, `    ANTHROPIC_BASE_URL=http://localhost:${cfg.port}   OPENAI_BASE_URL=http://localhost:${cfg.port}/v1`));
  console.log('');
  store.close();
}

export function cmdInit(): void {
  const cfg = loadConfig();
  saveConfig(cfg);
  const tty = process.stdout.isTTY ?? false;
  console.log('');
  console.log(color(tty, C.bold, '  Fiscus initialized'));
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
  console.log(`  Then run: ${color(tty, C.green, 'fiscus start')}`);
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
    const r = await egressFetch('http://localhost:' + cfg.port + '/__fiscus/health', {
      purpose: 'local_healthcheck',
      dataClass: 'healthcheck',
      signal: AbortSignal.timeout(800),
    });
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

export async function cmdGuide(flags: Flags): Promise<void> {
  const report = buildGuide(await gatherGuideFacts());
  if (flags.json) {
    process.stdout.write(JSON.stringify(report, null, 2) + '\n');
    return;
  }

  const tty = process.stdout.isTTY ?? false;
  console.log('');
  console.log(color(tty, C.bold, '  Fiscus — where you are') + (isDemo() ? color(tty, C.yellow, '   ● DEMO DATA') : ''));
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
  console.log(color(tty, C.gray, '  fiscus help — every command · fiscus doctor — health check'));
  console.log('');
}

export async function cmdAudit(flags: Flags): Promise<void> {
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
