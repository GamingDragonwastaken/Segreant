/**
 * Read/inspect command cluster — spend windows (today/week/month), sources,
 * CSV export, config display, budget caps, and prune. Extracted verbatim
 * from cli.ts in the per-command-module split.
 */

import { writeFileSync } from 'node:fs';
import { Store } from '../store/db.ts';
import { loadConfig, saveConfig, dbPath, configPath, aegisHome, isDemo, type AegisConfig } from '../config.ts';
import { startOfLocalDay } from '../budget/guard.ts';
import { requestsToCsv } from '../export/csv.ts';
import { computeAlerts } from '../alerts/detect.ts';
import { describeSourceDepth } from '../value/sourceDepth.ts';
import { C, color, usd, num, pct } from './ui.ts';
import { rangeFor, type Flags } from './flags.ts';

export function cmdShow(window: 'today' | 'week' | 'month', flags: Flags): void {
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
  console.log(color(tty, C.bold, `  Fiscus — ${label}`));
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
        `  ${color(tty, sevColor, `● ${alerts.length} ${alerts.length === 1 ? 'alert' : 'alerts'}`)}${crit ? color(tty, C.red, ` (${crit} critical)`) : ''}  ${color(tty, C.gray, `— ${top.title}. Run: fiscus alerts`)}`,
      );
    }
  }

  if (cfg.budget.dailyUsd !== null) {
    // The cap line reads the ENFORCEMENT basis (live proxy spend unless
    // capIncludesImported), so "% used" matches when requests actually block.
    const liveOnly = !cfg.budget.capIncludesImported;
    const capSpend = liveOnly ? store.spendBetween(startOfLocalDay(), Date.now() + 1000, true) : todaySpend;
    const importedToday = todaySpend - capSpend;
    const remaining = Math.max(0, cfg.budget.dailyUsd - capSpend);
    const pct = Math.min(100, (capSpend / cfg.budget.dailyUsd) * 100);
    console.log('');
    console.log(`  Daily cap   ${usd(cfg.budget.dailyUsd)}   ${color(tty, pct > 90 ? C.red : pct > 70 ? C.yellow : C.green, `${pct.toFixed(0)}% used`)}   ${color(tty, C.gray, `${usd(remaining)} left`)}`);
    if (liveOnly && importedToday > 0.005) {
      console.log(color(tty, C.gray, `              + ${usd(importedToday)} imported today — outside the cap (include it: fiscus budget --include-imported on)`));
    }
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
    console.log(color(tty, C.gray, '  → per-source depth + model mix:  fiscus sources'));
  }
  console.log('');
  console.log(color(tty, C.gray, `  Dashboard: run "fiscus start" then open http://localhost:${cfg.dashboardPort}`));
  console.log('');
  store.close();
}

/**
 * Spend by connected source — each AI tool deliberately routed through Fiscus.
 * This is the "connect, don't intercept" view: a source is a feed, and its depth
 * is honest about how much of the loop it exposes (a proxy-connected tool gives
 * spend + attribution; untagged traffic is 'direct' and spend-only).
 */
export function cmdSources(flags: Flags): void {
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
  console.log(color(tty, C.bold, '  Fiscus — sources (connected AI feeds)'));
  console.log(color(tty, C.gray, '  ' + '─'.repeat(46)));
  if (isDemo()) console.log(color(tty, C.yellow, '  ● DEMO DATA — synthetic, isolated in demo.db'));
  console.log(color(tty, C.gray, `  ${all ? 'all time' : 'last 30 days'} · spend grouped by the tool each request was routed from`));
  console.log('');

  if (!bySource.length) {
    console.log(color(tty, C.gray, '  No metered traffic yet. Connect a tool as a source, then run it:'));
    console.log(color(tty, C.green, '    fiscus connect opencode'));
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
  console.log(color(tty, C.gray, "  A source is one AI tool deliberately routed through Fiscus (connect, don't intercept)."));
  console.log(color(tty, C.gray, '  Tag one with:  fiscus connect <tool>   — the tag is stripped before traffic leaves your machine.'));
  console.log('');
  store.close();
}

export function cmdExport(flags: Flags): void {
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

export function cmdConfig(flags: Flags): void {
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

export function cmdBudget(flags: Flags): void {
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
  if (flags['include-imported'] !== undefined) {
    const v = String(flags['include-imported']);
    next.budget.capIncludesImported = !(v === 'off' || v === 'false' || v === 'no');
  }
  saveConfig(next);

  console.log('');
  console.log('  Budget updated:');
  console.log(`    Daily hard cap:   ${next.budget.dailyUsd === null ? 'off' : usd(next.budget.dailyUsd)}`);
  console.log(`    Daily soft warn:  ${next.budget.dailySoftUsd === null ? 'off' : usd(next.budget.dailySoftUsd)}`);
  console.log(`    Per-session cap:  ${next.budget.sessionUsd === null ? 'off' : usd(next.budget.sessionUsd)}`);
  console.log(`    Runaway guard:    ${next.budget.runawayMaxUsd === null ? 'off' : `${usd(next.budget.runawayMaxUsd)} / ${next.budget.runawayWindowSec}s`}`);
  console.log(`    Cap counts:       ${next.budget.capIncludesImported ? 'ALL observed spend (live + imported)' : 'live proxy spend only (imported excluded — it cannot be blocked)'}`);
  console.log('');
}

export function cmdPrune(): void {
  const cfg = loadConfig();
  const store = new Store(dbPath());
  const requestsBefore = Date.now() - cfg.retentionDays * 24 * 60 * 60 * 1000;
  const proposalsBefore = Date.now() - cfg.proposalRetentionDays * 24 * 60 * 60 * 1000;
  const requestsRemoved = store.prune(requestsBefore);
  const proposalsRemoved = store.pruneProposals(proposalsBefore);
  console.log(`  Pruned ${requestsRemoved} request rows older than ${cfg.retentionDays} days.`);
  console.log(`  Pruned ${proposalsRemoved} stored proposal rows older than ${cfg.proposalRetentionDays} days.`);
  console.log('  Database compacted.');
  store.close();
}

/**
 * Project label management. Tool launch cwds fragment one real project across
 * labels; aliases merge them AT QUERY TIME — raw ledger rows are never rewritten,
 * so a merge is reversible (`unalias`) and the record stays honest.
 *
 *   fiscus project                      list projects (canonical) + alias table
 *   fiscus project merge <from...> --into <name>
 *   fiscus project alias <alias> <canonical>
 *   fiscus project unalias <alias>
 */
export function cmdProject(flags: Flags): void {
  const store = new Store(dbPath());
  const tty = process.stdout.isTTY ?? false;
  const sub = flags._[0] ?? 'list';
  try {
    if (sub === 'merge' || sub === 'alias') {
      const args = flags._.slice(1);
      const into = sub === 'merge' ? flags.into : args[1];
      const froms = sub === 'merge' ? args : args.slice(0, 1);
      if (typeof into !== 'string' || !into || froms.length === 0 || froms.some((f) => !f)) {
        console.error(
          sub === 'merge'
            ? '  Usage: fiscus project merge <label...> --into <canonical>'
            : '  Usage: fiscus project alias <alias> <canonical>',
        );
        process.exitCode = 1;
        return;
      }
      for (const from of froms) {
        try {
          store.setProjectAlias(from, into);
          console.log(`  ${color(tty, C.green, '✓')} "${from}" → "${store.canonicalProject(from)}"`);
        } catch (e) {
          console.error(`  ✗ ${from}: ${(e as Error).message}`);
          process.exitCode = 1;
        }
      }
      console.log(color(tty, C.gray, '  Merged at query time only — raw rows unchanged. Undo: fiscus project unalias <label>'));
      return;
    }
    if (sub === 'unalias') {
      const alias = flags._[1];
      if (!alias) {
        console.error('  Usage: fiscus project unalias <alias>');
        process.exitCode = 1;
        return;
      }
      console.log(store.removeProjectAlias(alias) ? `  Removed alias "${alias}".` : `  No alias "${alias}" exists.`);
      return;
    }
    // list (default)
    const byProject = store.byProject(0, Date.now() + 1000);
    const aliases = store.listProjectAliases();
    if (flags.json) {
      process.stdout.write(JSON.stringify({ projects: byProject, aliases }, null, 2) + '\n');
      return;
    }
    console.log('');
    console.log(color(tty, C.bold, '  Projects — all time (aliases applied)'));
    for (const p of byProject.slice(0, 20)) {
      console.log(`  ${p.label.padEnd(34)} ${usd(p.costUsd).padStart(11)}  ${color(tty, C.gray, `${num(p.requests)} req`)}`);
    }
    if (aliases.length) {
      console.log('');
      console.log(color(tty, C.bold, '  Aliases'));
      for (const a of aliases) console.log(`  ${a.alias.padEnd(34)} → ${a.canonical}`);
    } else {
      console.log('');
      console.log(color(tty, C.gray, '  No aliases. Merge fragmented labels: fiscus project merge <label...> --into <name>'));
    }
    console.log('');
  } finally {
    store.close();
  }
}
