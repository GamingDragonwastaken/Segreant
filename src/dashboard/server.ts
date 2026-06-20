/**
 * Local web dashboard.
 *
 * A small read-only HTTP server over the same Store the proxy writes to. It
 * exposes a JSON API and serves a single self-contained HTML page. Bound to
 * localhost only — like everything else, nothing leaves the machine.
 */

import http from 'node:http';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import type { Store } from '../store/db.ts';
import { isDemo, type AegisConfig } from '../config.ts';
import { startOfLocalDay } from '../budget/guard.ts';
import { loadRealization, projectValueBreakdown } from '../value/realization.ts';
import { demoLiftOptions } from '../demo/seed.ts';
import { recommendAllocation } from '../budget/allocate.ts';
import { computeReturnOnIntelligence } from '../value/lenses.ts';
import { computeFrontier } from '../value/frontier.ts';
import { computeUsageRoI } from '../value/usage.ts';
import { recommendBudget } from '../budget/recommend.ts';
import { computeAlerts } from '../alerts/detect.ts';
import { requestsToCsv } from '../export/csv.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const INDEX_HTML = join(__dirname, 'web', 'index.html');

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
      const repo = url.searchParams.get('repo') || process.cwd();
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

    if (url.pathname === '/api/value') {
      const repo = url.searchParams.get('repo') || process.cwd();
      const windowDays = Number(url.searchParams.get('window') || '14') || 14;
      void (async () => {
        try {
          const now = Date.now();
          const day = 24 * 60 * 60 * 1000;
          const series = store.series(now - 30 * day, now + 1000, day);
          const dailySpends = series.map((s) => s.costUsd);
          const usage = computeUsageRoI(store, { startMs: now - 30 * day, endMs: now + 1000 });

          // Live git when a real repo is attached; otherwise persisted snapshots
          // (what a manager's dashboard / the demo reads). One resolver, so the
          // numbers can't diverge between the two paths.
          const loaded = await loadRealization(store, repo, { limit: 40, windowDays, persist: false });
          let realization = null;
          let roi = null;
          let frontier = null;
          let projects = null;
          let projectAllocation = null;
          if (loaded) {
            const rep = loaded.report;
            realization = { matured: rep.matured, firstPassAcceptance: rep.firstPassAcceptance, proposalCoverage: rep.proposalCoverage, units: rep.units };
            // In demo mode, thread a labeled synthetic TSF so the 4th lens and the
            // RoI interval show live (production reads its own behavioral baseline).
            const roiOpts = isDemo() ? demoLiftOptions() : {};
            roi = computeReturnOnIntelligence(rep, roiOpts);
            frontier = computeFrontier(rep.units);
            // Per-project value (the budget owner's view) + cross-project allocation.
            projects = projectValueBreakdown(store, { windowDays, roiOptions: roiOpts });
            if (projects.length >= 2) {
              projectAllocation = recommendAllocation(
                projects.map((p) => ({ key: p.project, costUsd: p.costUsd, roiIndex: p.roiIndex, realizedValueUsd: p.realizedValueUsd })),
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
                  frontier.byModelAndTask.map((c) => ({ key: c.key, costUsd: c.costUsd, roiIndex: c.roiIndex, realizedValueUsd: c.realizedValueUsd })),
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
