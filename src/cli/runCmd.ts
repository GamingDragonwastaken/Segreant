/**
 * Runtime & feed command cluster — start (proxy + dashboard), demo, and the
 * two refreshable manifests (pricing, lift baselines). Extracted verbatim
 * from cli.ts in the per-command-module split; printBanner stays
 * module-internal to cmdStart.
 */

import { join } from 'node:path';
import { Store } from '../store/db.ts';
import { createProxyServer } from '../proxy/server.ts';
import { createDashboardServer } from '../dashboard/server.ts';
import { loadConfig, saveConfig, dbPath, demoDbPath, isDemo, unlinkDemoDb, aegisHome, type AegisConfig } from '../config.ts';
import { seedDemo } from '../demo/seed.ts';
import { startOfLocalDay } from '../budget/guard.ts';
import { refreshPricing, pricingStatus, computeCost, DEFAULT_MANIFEST_URL, type Provider } from '../cost/pricing.ts';
import { refreshBaselineManifest, baselineManifestStatus } from '../value/liftBaseline.ts';
import { C, color, usd, num } from './ui.ts';
import { type Flags } from './flags.ts';

export async function cmdStart(flags: Flags): Promise<void> {
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
  line(color(tty, C.bold, '║   Fiscus  ·  local AI-spend proxy is running         ║'));
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
    line(`Daily cap  ${usd(cfg.budget.dailyUsd)}  ${color(tty, C.gray, '(set with: fiscus budget --daily N)')}`);
  } else {
    line(color(tty, C.gray, 'No budget cap set. Add one: fiscus budget --daily 25 --soft 18'));
  }
  console.log('');
  line(color(tty, C.gray, 'Press Ctrl+C to stop. Traffic falls straight through if Fiscus is off.'));
  console.log('');
}

export async function cmdDemo(flags: Flags): Promise<void> {
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
  console.log(color(tty, C.bold, '  Fiscus — demo data generated'));
  console.log(color(tty, C.gray, '  ' + '─'.repeat(52)));
  console.log(
    `  ${num(res.requests)} requests · ${num(res.blocked)} blocked · ` +
      `${num(res.sessions)} sessions · ${num(res.signals)} reported outcomes`,
  );
  console.log(`  ${color(tty, C.green, usd(res.totalCostUsd))} of synthetic spend across ${res.days} days`);
  console.log('');
  console.log(color(tty, C.yellow, '  ● DEMO DATA — synthetic, priced by the real engine, isolated in demo.db.'));
  console.log(color(tty, C.gray, '    It never mixes with real metering. Clear it: fiscus demo --clear'));
  console.log('');
  console.log(color(tty, C.bold, '  Explore it:'));
  console.log(`    fiscus today --demo        ${color(tty, C.gray, '# spend, by-model, by-user')}`);
  console.log(`    fiscus alerts --demo       ${color(tty, C.gray, '# budget, spike, throttling')}`);
  console.log(`    fiscus usage --demo        ${color(tty, C.gray, '# RoI for sessions without code signals')}`);
  console.log(`    fiscus budget --recommend --demo`);
  console.log(`    fiscus start --demo        ${color(tty, C.gray, '# dashboard, pointed at the demo data')}`);
  console.log('');

  if (flags.serve || flags.start) {
    console.log(color(tty, C.gray, '  Launching the dashboard against the demo data…'));
    await cmdStart(flags);
  }
}

export async function cmdPricing(flags: Flags): Promise<void> {
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
      console.log(`  ${color(on, C.green, '✓')} Auto-refresh ON — "fiscus start" updates the rate card when it is older than ${cfg.pricing.maxAgeDays}d.`);
      console.log(`  ${color(on, C.dim, `Source: ${cfg.pricing.manifestUrl ?? DEFAULT_MANIFEST_URL}`)}`);
      console.log(`  ${color(on, C.dim, 'The fetch is a GET of a public pricing file — it sends nothing about you. Turn off: fiscus pricing --auto off')}`);
    } else {
      console.log(`  ${color(on, C.green, '✓')} Auto-refresh OFF — the rate card only changes when you run "fiscus pricing --refresh".`);
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
      console.log(`  ${color(on, C.dim, 'Applies to new traffic and future imports; rows already metered keep the price recorded at the time.')}`);
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
  console.log(`\n  ${color(on, C.bold, 'Fiscus pricing')}`);
  console.log(`  Source     ${st.source === 'cache' ? 'refreshed cache (~/.aegisflow/pricing)' : 'bundled with the package'}`);
  const age = st.ageDays === null ? '' : `  (${num(st.ageDays)}d ago)`;
  const stale = st.stale ? color(on, C.yellow, '  — STALE') : '';
  console.log(`  Updated    ${st.updated}${age}${stale}`);
  console.log(`  Models     ${num(st.modelCount)} across ${st.providers.join(', ')}`);
  if (st.stale || st.source === 'bundled') {
    console.log(`\n  ${color(on, C.dim, 'Refresh now:   fiscus pricing --refresh')}`);
    console.log(`  ${color(on, C.dim, 'Keep current:  fiscus pricing --auto     (refreshes on start when stale)')}`);
  }
  console.log('');
}

/**
 * `fiscus baseline [--refresh --url <url>] [--json]` — status and refresh for
 * the Lift population-prior manifest (`baselines/lift-baselines.json`), the CLI
 * surface `docs/RETURN-ON-INTELLIGENCE.md` §7.1 promises but that, until now, had
 * no command to reach it. Deliberately NOT a mirror of `pricing --auto`: there is
 * no established machine-readable feed for this (METR publishes research, not a
 * versioned endpoint), so there is no default URL and no auto-refresh-on-stale —
 * `--url` is required on every refresh, never silently reused from a prior run.
 */
export async function cmdBaseline(flags: Flags): Promise<void> {
  const on = process.stdout.isTTY ?? false;

  if (flags['refresh']) {
    const url = typeof flags['url'] === 'string' ? flags['url'] : null;
    if (!url) {
      const msg = 'no URL given — Lift baselines have no default source (unlike pricing). Pass one you trust: fiscus baseline --refresh --url <url>';
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
  console.log(`\n  ${color(on, C.bold, 'Fiscus Lift baselines')}`);
  console.log(`  Source     ${st.source === 'cache' ? 'refreshed cache (~/.aegisflow/baselines)' : 'bundled with the package'}`);
  const age = st.ageDays === null ? '' : `  (${num(st.ageDays)}d ago)`;
  const stale = st.stale ? color(on, C.yellow, '  — STALE') : '';
  console.log(`  Curated    ${st.curated}${age}${stale}`);
  console.log(`  Task-types ${num(st.taskTypeCount)}`);
  console.log(`  ${color(on, C.dim, 'Real per-project numbers (blended with your own git history): fiscus roi')}`);
  console.log(`\n  ${color(on, C.dim, 'Refresh from a source you trust:  fiscus baseline --refresh --url <url>')}`);
  console.log(`  ${color(on, C.dim, 'No default source exists for this — unlike pricing, METR publishes research, not a feed.')}`);
  console.log('');
}

/**
 * Re-cost stored ESTIMATED rows against the current rate card. Rows priced with
 * an exact rate are never touched — their price was right when metered. A row is
 * rewritten only when the current card resolves its model to an EXACT rate
 * (refreshed feed learned the model); rows that would still be estimates keep
 * their original number, because swapping one guess for another adds no honesty.
 * Dry-run by default; --apply writes, in one transaction.
 */
export function cmdReprice(flags: Flags): void {
  const store = new Store(dbPath());
  const tty = process.stdout.isTTY ?? false;
  try {
    const rows = store.estimatedRequestRows();
    const updates: Array<{ requestId: string; costUsd: number }> = [];
    const byModel = new Map<string, { n: number; before: number; after: number }>();
    let stillEstimated = 0;

    for (const r of rows) {
      const c = computeCost(r.provider as Provider, r.model, {
        inputTokens: r.inputTokens,
        outputTokens: r.outputTokens,
        cacheWriteTokens: r.cacheWriteTokens,
        cacheReadTokens: r.cacheReadTokens,
      });
      if (c.estimated) {
        stillEstimated++;
        continue; // still a guess — keep the original guess rather than churn numbers
      }
      updates.push({ requestId: r.requestId, costUsd: c.costUsd });
      const key = `${r.provider}/${r.model}`;
      const agg = byModel.get(key) ?? { n: 0, before: 0, after: 0 };
      agg.n++;
      agg.before += r.costUsd;
      agg.after += c.costUsd;
      byModel.set(key, agg);
    }

    const before = [...byModel.values()].reduce((a, v) => a + v.before, 0);
    const after = [...byModel.values()].reduce((a, v) => a + v.after, 0);

    if (flags.json) {
      console.log(JSON.stringify({
        applied: !!flags.apply, estimatedRows: rows.length, repriceable: updates.length,
        stillEstimated, totalBeforeUsd: before, totalAfterUsd: after,
        byModel: [...byModel.entries()].map(([model, v]) => ({ model, rows: v.n, beforeUsd: v.before, afterUsd: v.after })),
      }, null, 2));
      if (flags.apply && updates.length) store.applyRepricedCosts(updates);
      return;
    }

    console.log('');
    console.log(color(tty, C.bold, '  Reprice — estimated rows vs the current rate card'));
    if (!rows.length) {
      console.log('  Nothing to do: no stored rows carry an estimated price.');
      console.log('');
      return;
    }
    console.log(`  Estimated rows       ${num(rows.length)}`);
    console.log(`  Now exactly priced   ${num(updates.length)}  ${color(tty, C.gray, '(current card has an exact rate for these models)')}`);
    if (stillEstimated) console.log(`  Still estimates      ${num(stillEstimated)}  ${color(tty, C.gray, 'left untouched — a new guess is not more honest than the old one')}`);
    if (updates.length) {
      console.log('');
      for (const [model, v] of [...byModel.entries()].sort((a, b) => b[1].after - a[1].after).slice(0, 10)) {
        const delta = v.after - v.before;
        const dc = delta > 0 ? C.red : C.green;
        console.log(`  ${model.padEnd(40)} ${num(v.n).padStart(6)} rows  ${usd(v.before).padStart(10)} → ${usd(v.after).padStart(10)}  ${color(tty, dc, (delta >= 0 ? '+' : '') + usd(delta))}`);
      }
      console.log('');
      console.log(`  Total                ${usd(before)} → ${usd(after)}  ${color(tty, after - before >= 0 ? C.red : C.green, (after - before >= 0 ? '+' : '') + usd(after - before))}`);
      if (flags.apply) {
        store.applyRepricedCosts(updates);
        console.log(color(tty, C.green, `  ✓ Applied — ${num(updates.length)} rows re-costed, estimated flag cleared.`));
        console.log(color(tty, C.gray, '  Stored realized-value snapshots keep their at-compute costs until the next realize/scan --setup.'));
      } else {
        console.log(color(tty, C.gray, '  Dry run — nothing written. Apply with: fiscus reprice --apply'));
        console.log(color(tty, C.gray, '  Tip: refresh the card first (fiscus pricing --refresh) so unknown models resolve.'));
      }
    }
    console.log('');
  } finally {
    store.close();
  }
}
