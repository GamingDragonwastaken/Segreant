/**
 * Local web dashboard.
 *
 * A small read-only HTTP server over the same Store the proxy writes to. It
 * exposes a JSON API and serves a single self-contained HTML page. Bound to
 * localhost only — like everything else, nothing leaves the machine.
 */

import http from 'node:http';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import type { Store } from '../store/db.ts';
import { isDemo, type AegisConfig } from '../config.ts';
import { startOfLocalDay } from '../budget/guard.ts';
import { loadRealization, projectValueBreakdown, liftOptionsFromStore, moneyInputsFromStore } from '../value/realization.ts';
import { demoLiftOptions } from '../demo/seed.ts';
import { recommendAllocation } from '../budget/allocate.ts';
import { computeReturnOnIntelligence } from '../value/lenses.ts';
import { describeSourceDepth } from '../value/sourceDepth.ts';
import { computeFrontier } from '../value/frontier.ts';
import { computeUsageRoI } from '../value/usage.ts';
import { computeCohort } from '../value/cohort.ts';
import { driftEProcess } from '../value/drift.ts';
import { buildGuide } from '../guide.ts';
import { recommendBudget } from '../budget/recommend.ts';
import { computeAlerts } from '../alerts/detect.ts';
import { requestsToCsv } from '../export/csv.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const INDEX_HTML = join(__dirname, 'web', 'index.html');

/**
 * Loopback-only Host allowlist. The server is bound to 127.0.0.1, but a remote
 * page could still reach it via DNS-rebinding (rebind a hostname to 127.0.0.1,
 * then read responses as same-origin). Rejecting any non-loopback Host closes
 * that — a rebound request carries the attacker's hostname, not localhost.
 */
function isLocalHost(host: string | undefined): boolean {
  if (!host) return true; // no Host header → only reachable on the loopback we bind to
  const name = host.replace(/:\d+$/, '').replace(/^\[|\]$/g, '').toLowerCase();
  return name === 'localhost' || name === '127.0.0.1' || name === '::1';
}

/** Only honor a ?repo= that is an existing directory; otherwise the dashboard's cwd. */
function safeRepo(param: string | null): string {
  if (param) {
    try {
      if (existsSync(param) && statSync(param).isDirectory()) return param;
    } catch {
      /* unreadable path → fall back to cwd */
    }
  }
  return process.cwd();
}

type RangeKey = 'today' | '7d' | '30d' | 'all';

function resolveRange(range: RangeKey, now: number): { startMs: number; endMs: number; bucketMs: number } {
  const day = 24 * 60 * 60 * 1000;
  switch (range) {
    case 'today':
      return { startMs: startOfLocalDay(now), endMs: now + 1000, bucketMs: 60 * 60 * 1000 };
    case '7d':
      return { startMs: now - 7 * day, endMs: now + 1000, bucketMs: day };
    case '30d':
      return { startMs: now - 30 * day, endMs: now + 1000, bucketMs: day };
    case 'all':
      return { startMs: 0, endMs: now + 1000, bucketMs: day };
  }
}

function buildOverview(store: Store, config: AegisConfig, range: RangeKey) {
  const now = Date.now();
  const { startMs, endMs, bucketMs } = resolveRange(range, now);

  const dayStart = startOfLocalDay(now);
  const todaySpend = store.spendBetween(dayStart, now + 1000);

  return {
    range,
    demo: isDemo(),
    generatedAt: new Date(now).toISOString(),
    budget: {
      dailyUsd: config.budget.dailyUsd,
      dailySoftUsd: config.budget.dailySoftUsd,
      todaySpendUsd: todaySpend,
      remainingDailyUsd: config.budget.dailyUsd === null ? null : Math.max(0, config.budget.dailyUsd - todaySpend),
    },
    summary: store.summary(startMs, endMs),
    byModel: store.byModel(startMs, endMs),
    byProject: store.byProject(startMs, endMs),
    byUser: store.byUser(startMs, endMs),
    // Each source carries its measured depth (spend / + acceptance / + RoI),
    // computed server-side so the dashboard and CLI render identical wording.
    bySource: store.bySourceWithDepth(startMs, endMs).map((s) => ({ ...s, ...describeSourceDepth(s) })),
    series: store.series(startMs, endMs, bucketMs),
    recent: store.recent(40),
    // Governance alerts refresh on the live poll. Realized-value alerts (git-gated)
    // are surfaced in /api/value; here we pass null so they're simply omitted.
    alerts: computeAlerts(store, config, { now }),
  };
}

export interface DashboardDeps {
  store: Store;
  config: AegisConfig;
}

export function createDashboardServer(deps: DashboardDeps): http.Server {
  const { store, config } = deps;

  return http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');

    // Loopback Host guard — defeats DNS-rebinding that could otherwise let a
    // remote page read your local spend/value data despite the 127.0.0.1 bind.
    if (!isLocalHost(req.headers.host)) {
      res.writeHead(403, { 'content-type': 'text/plain' });
      res.end('forbidden');
      return;
    }

    if (url.pathname === '/api/health') {
      return json(res, 200, { ok: true, service: 'aegisflow-dashboard' });
    }

    if (url.pathname === '/api/overview') {
      const range = (url.searchParams.get('range') as RangeKey) ?? 'today';
      const valid: RangeKey[] = ['today', '7d', '30d', 'all'];
      const safe = valid.includes(range) ? range : 'today';
      try {
        return json(res, 200, buildOverview(store, config, safe));
      } catch (err) {
        return json(res, 500, { error: String(err) });
      }
    }

    if (url.pathname === '/api/export.csv') {
      const range = (url.searchParams.get('range') as RangeKey) ?? '30d';
      const valid: RangeKey[] = ['today', '7d', '30d', 'all'];
      const safe = valid.includes(range) ? range : '30d';
      try {
        const { startMs, endMs } = resolveRange(safe, Date.now());
        const csv = requestsToCsv(store.requestsInRange(startMs, endMs));
        res.writeHead(200, {
          'content-type': 'text/csv; charset=utf-8',
          'content-disposition': `attachment; filename="aegisflow-${safe}.csv"`,
        });
        res.end(csv);
      } catch (err) {
        return json(res, 500, { error: String(err) });
      }
      return;
    }

    if (url.pathname === '/api/realization') {
      const repo = safeRepo(url.searchParams.get('repo'));
      const windowDays = Number(url.searchParams.get('window') || '14') || 14;
      void (async () => {
        try {
          const loaded = await loadRealization(store, repo, { limit: 40, windowDays, persist: false });
          if (!loaded) return json(res, 200, { available: false, repo });
          return json(res, 200, { available: true, source: loaded.source, repo, report: loaded.report });
        } catch (err) {
          return json(res, 500, { error: String(err) });
        }
      })();
      return;
    }

    if (url.pathname === '/api/guide') {
      // Same journey engine as `aegisflow guide` — one truth, two renderers.
      void (async () => {
        try {
          const now = Date.now();
          const day = 24 * 60 * 60 * 1000;
          let proxyUp = false;
          try {
            const r = await fetch(`http://localhost:${config.port}/__aegis/health`, { signal: AbortSignal.timeout(500) });
            proxyUp = r.ok;
          } catch {
            proxyUp = false;
          }
          return json(res, 200, buildGuide({
            demo: isDemo(),
            port: config.port,
            dashboardPort: config.dashboardPort,
            proxyUp,
            requestsAllTime: store.summary(0, now + 1000).requests,
            spend30dUsd: store.summary(now - 30 * day, now + 1000).costUsd,
            dailyCapUsd: config.budget.dailyUsd,
            outcomeSignals: store.countSignals(),
            realizationUnits: store.countRealizationUnits(),
            laborRateSet: config.lift.laborRatePerHour !== null,
          }));
        } catch (err) {
          return json(res, 500, { error: String(err) });
        }
      })();
      return;
    }

    if (url.pathname === '/api/value') {
      const repo = safeRepo(url.searchParams.get('repo'));
      const windowDays = Number(url.searchParams.get('window') || '14') || 14;
      void (async () => {
        try {
          const now = Date.now();
          const day = 24 * 60 * 60 * 1000;
          const series = store.series(now - 30 * day, now + 1000, day);
          const dailySpends = series.map((s) => s.costUsd);
          // Money inputs mirror the CLI exactly (demo assumes labeled illustrative
          // values) so the two surfaces can't disagree on the non-coding dollar.
          let usageRate = config.lift.laborRatePerHour;
          let usageBaselines = config.lift.outcomeBaselineMinutes;
          if (isDemo()) {
            if (usageRate === null) usageRate = 120;
            if (Object.keys(usageBaselines).length === 0) usageBaselines = { used: 10, resolved: 30, published: 90 };
          }
          const usage = computeUsageRoI(store, {
            startMs: now - 30 * day,
            endMs: now + 1000,
            money: { outcomeBaselineMinutes: usageBaselines, laborRatePerHour: usageRate },
          });
          // Per-user VALUE — distribution only, gated by opt-in + k-anonymity. When
          // disabled/suppressed this carries no per-user data (suppressed:true), so
          // the dashboard can render the guardrail state without ever seeing names.
          const team = computeCohort(store, {
            startMs: now - 30 * day,
            endMs: now + 1000,
            enabled: config.perUser.enabled,
            minCohort: config.perUser.minCohort,
          });

          // Live git when a real repo is attached; otherwise persisted snapshots
          // (what a manager's dashboard / the demo reads). One resolver, so the
          // numbers can't diverge between the two paths.
          const loaded = await loadRealization(store, repo, { limit: 40, windowDays, persist: false });
          let realization = null;
          let roi = null;
          let frontier = null;
          let projects = null;
          let projectAllocation = null;
          let drift = null;
          if (loaded) {
            const rep = loaded.report;
            // Goodhart drift alarm (docs §11) over mature units in time order —
            // same computation as the CLI so the two surfaces can't disagree.
            const matureOrdered = rep.units.filter((u) => !u.maturing).sort((a, b) => a.tsEpochMs - b.tsEpochMs);
            if (matureOrdered.length >= 10) drift = driftEProcess(matureOrdered.map((u) => u.funnel.realized));
            realization = { matured: rep.matured, firstPassAcceptance: rep.firstPassAcceptance, proposalCoverage: rep.proposalCoverage, units: rep.units };
            // Lift: in demo mode a labeled synthetic TSF; otherwise the REAL source
            // — measured "time with AI" × configured task baselines — so the 4th lens
            // and the RoI interval reflect this machine's own behavioral data.
            const roiOpts = isDemo()
              ? demoLiftOptions()
              : (() => {
                  const dl = liftOptionsFromStore(store, rep, config.lift.baselineMinutes);
                  return { lift: dl.lift, liftRange: dl.liftRange };
                })();
            // The money number, priced exactly like the CLI (shared helper). Labor
            // rate falls back to config; the demo assumes an illustrative rate so the
            // dollar return is visible. Threaded only into the headline RoI — not the
            // shared roiOpts — so per-project values aren't given a global numerator.
            let laborRate = config.lift.laborRatePerHour;
            if (laborRate === null && isDemo()) laborRate = 120;
            const money = moneyInputsFromStore(store, rep, config.lift.baselineMinutes, laborRate);
            roi = computeReturnOnIntelligence(rep, {
              ...roiOpts,
              laborRatePerHour: laborRate,
              grossRealizedValueUsd: money.grossRealizedValueUsd,
              supervisionMinutes: money.supervisionMinutes,
            });
            frontier = computeFrontier(rep.units);
            // Per-project value (the budget owner's view) + cross-project allocation.
            projects = projectValueBreakdown(store, { windowDays, roiOptions: roiOpts });
            if (projects.length >= 2) {
              projectAllocation = recommendAllocation(
                projects.map((p) => ({ key: p.project, costUsd: p.costUsd, roiIndex: p.roiIndex, realizedValueUsd: p.netRealizedValueUsd })),
              );
            }
          }
          const budget = recommendBudget({
            dailySpends,
            realizedValueRate: realization?.matured.realizedValueRate ?? null,
            frontier: frontier?.byModelAndTask ?? [],
          });
          // Forward-looking allocation over the same model×task frontier.
          const allocation =
            frontier && frontier.byModelAndTask.length >= 2
              ? recommendAllocation(
                  frontier.byModelAndTask.map((c) => ({ key: c.key, costUsd: c.costUsd, roiIndex: c.roiIndex, realizedValueUsd: c.netRealizedValueUsd })),
                )
              : null;
          return json(res, 200, {
            gitRepo: loaded?.source === 'git',
            valueSource: loaded?.source ?? null,
            repo,
            generatedAt: new Date(now).toISOString(),
            realization,
            roi,
            frontier,
            budget,
            allocation,
            projects,
            projectAllocation,
            usage,
            team,
            drift,
          });
        } catch (err) {
          return json(res, 500, { error: String(err) });
        }
      })();
      return;
    }

    if (url.pathname === '/' || url.pathname === '/index.html') {
      try {
        const html = readFileSync(INDEX_HTML, 'utf8');
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end(html);
      } catch {
        res.writeHead(500, { 'content-type': 'text/plain' });
        res.end('dashboard UI not found');
      }
      return;
    }

    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('not found');
  });
}

function json(res: http.ServerResponse, status: number, payload: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(payload));
}
