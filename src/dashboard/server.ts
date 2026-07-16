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
import { isDemo, DEFAULT_CONFIG, type AegisConfig } from '../config.ts';
import { startOfLocalDay } from '../budget/guard.ts';
import { loadRealization, projectValueBreakdown, liftOptionsFromStore, moneyInputsFromStore, realizeDiscoveredProjects } from '../value/realization.ts';
import { projectName } from '../git/correlate.ts';
import { resolveBaselineMinutesForRepo } from '../value/liftBaseline.ts';
import { scanWithDiff, saveScan } from '../scan/scan.ts';
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
import { DIMENSIONS } from '../value/characterization.ts';
import { IMPORTERS, type ImportSummary } from '../connect/importShared.ts';
import { importClaudeCode, defaultClaudeCodeRoot } from '../connect/claudeCode.ts';
import { importOpencode, defaultOpencodeDbPath } from '../connect/opencode.ts';
import { importCodex, defaultCodexRoot } from '../connect/codex.ts';

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
  // The budget panel reads the same basis the guard ENFORCES on (live proxy spend
  // unless capIncludesImported) — a bar that disagrees with the blocker is a lie.
  const liveOnly = !config.budget.capIncludesImported;
  const todaySpend = store.spendBetween(dayStart, now + 1000, liveOnly);
  const todayTotal = liveOnly ? store.spendBetween(dayStart, now + 1000) : todaySpend;

  return {
    range,
    demo: isDemo(),
    generatedAt: new Date(now).toISOString(),
    budget: {
      dailyUsd: config.budget.dailyUsd,
      dailySoftUsd: config.budget.dailySoftUsd,
      todaySpendUsd: todaySpend,
      todayImportedUsd: Math.max(0, todayTotal - todaySpend),
      capExcludesImported: liveOnly,
      remainingDailyUsd: config.budget.dailyUsd === null ? null : Math.max(0, config.budget.dailyUsd - todaySpend),
    },
    summary: store.summary(startMs, endMs),
    byModel: store.byModel(startMs, endMs),
    byProject: store.byProject(startMs, endMs),
    byUser: store.byUser(startMs, endMs),
    // Each source carries its measured depth (spend / + acceptance / + RoI),
    // computed server-side so the dashboard and CLI render identical wording.
    bySource: store.bySourceWithDepth(startMs, endMs).map((s) => ({ ...s, ...describeSourceDepth(s) })),
    // Canonical, typed characterization of this window's spend across the flat axes
    // (project/model/source/user) — one shape shared by the CLI and API, plus the
    // axis vocabulary itself. The depth-augmented `bySource` above stays for the
    // existing UI; this is the typed section API consumers read (characterization.ts).
    characterization: store.characterization(startMs, endMs),
    dimensions: DIMENSIONS,
    series: store.series(startMs, endMs, bucketMs),
    recent: store.recent(40),
    // Governance alerts refresh on the live poll. Realized-value alerts (git-gated)
    // are surfaced in /api/value; here we pass null so they're simply omitted.
    alerts: computeAlerts(store, config, { now }),
  };
}

/**
 * Server-side view of the importers: where each tool's local data lives, whether
 * it's present on this machine, and how to read it. Lets non-CLI users click to
 * meter their tools from the dashboard — same engines as `fiscus import`.
 */
interface DashImporter {
  id: string;
  label: string;
  blurb: string;
  locate: () => string | null;
  run: (store: Store, opts: { sinceMs?: number }) => ImportSummary | Promise<ImportSummary>;
}

const DASH_IMPORTERS: DashImporter[] = [
  {
    ...IMPORTERS.find((i) => i.id === 'claude-code')!,
    locate: () => (existsSync(defaultClaudeCodeRoot()) ? defaultClaudeCodeRoot() : null),
    run: (store, opts) => importClaudeCode(store, opts),
  },
  {
    ...IMPORTERS.find((i) => i.id === 'opencode')!,
    locate: () => defaultOpencodeDbPath(),
    run: (store, opts) => importOpencode(store, opts),
  },
  {
    ...IMPORTERS.find((i) => i.id === 'codex')!,
    locate: () => defaultCodexRoot(),
    run: (store, opts) => importCodex(store, opts),
  },
];

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
      return json(res, 200, { ok: true, service: 'fiscus-dashboard' });
    }

    // Which native importers exist on THIS machine — drives the dashboard's
    // one-click "Import local usage" panel so non-CLI users never touch a terminal.
    if (url.pathname === '/api/importers') {
      return json(res, 200, {
        importers: DASH_IMPORTERS.map((imp) => {
          const location = imp.locate();
          return { id: imp.id, label: imp.label, blurb: imp.blurb, available: location !== null, location };
        }),
      });
    }

    // Trigger a native import from the dashboard. POST-only + a custom header the
    // browser only sets same-origin: a cross-site form can't forge it (no CORS
    // preflight is answered), so this is CSRF-safe despite mutating the local DB.
    if (url.pathname === '/api/import') {
      if (req.method !== 'POST') {
        res.writeHead(405, { 'content-type': 'text/plain', allow: 'POST' });
        res.end('method not allowed');
        return;
      }
      if (req.headers['x-aegis-local'] !== '1') {
        res.writeHead(403, { 'content-type': 'text/plain' });
        res.end('forbidden');
        return;
      }
      const tool = url.searchParams.get('tool') ?? 'all';
      const targets = tool === 'all' ? DASH_IMPORTERS : DASH_IMPORTERS.filter((i) => i.id === tool);
      if (targets.length === 0) return json(res, 400, { error: `unknown tool: ${tool}` });
      // Drain (and ignore) the request body so the socket frees cleanly.
      req.resume();
      void (async () => {
        try {
          const results: Record<string, ImportSummary & { available: boolean }> = {};
          for (const imp of targets) {
            const available = imp.locate() !== null;
            const sum = available ? await imp.run(store, {}) : { files: 0, eventsSeen: 0, inserted: 0, costUsd: 0, estimatedCostUsd: 0, byModel: {}, earliestMs: null, latestMs: null };
            results[imp.id] = { ...sum, available };
          }
          const totalNew = Object.values(results).reduce((n, r) => n + r.inserted, 0);
          return json(res, 200, { ok: true, totalNew, results });
        } catch (err) {
          return json(res, 500, { error: String(err) });
        }
      })();
      return;
    }

    // Auto-correlate imported projects into per-project RoI — the "no --repo, no
    // wiring" native path. POST-only + the same local-only header guard as
    // /api/import (it mutates the DB by persisting realization snapshots).
    if (url.pathname === '/api/discover') {
      if (req.method !== 'POST') {
        res.writeHead(405, { 'content-type': 'text/plain', allow: 'POST' });
        res.end('method not allowed');
        return;
      }
      if (req.headers['x-aegis-local'] !== '1') {
        res.writeHead(403, { 'content-type': 'text/plain' });
        res.end('forbidden');
        return;
      }
      req.resume();
      void (async () => {
        try {
          const windowDays = Number(url.searchParams.get('window') || '14') || 14;
          const foundFolders = store.projectPaths().length;
          const discovered = await realizeDiscoveredProjects(store, { windowDays });
          return json(res, 200, { ok: true, foundFolders, correlated: discovered.length, discovered });
        } catch (err) {
          return json(res, 500, { error: String(err) });
        }
      })();
      return;
    }

    // The proactive, opt-in SYSTEM SCAN — the one-click onboarding path.
    //   GET  /api/scan[?path=]  → dry-run preview: detected tools + git repos under
    //        the root (default: home). Read-only; imports and mutates nothing.
    //   POST /api/scan          → the deliberate setup step (CSRF-guarded like the
    //        other mutating routes): import every detected tool, then correlate every
    //        discovered project into per-project RoI. Same engines as import+discover.
    if (url.pathname === '/api/scan') {
      if (req.method === 'POST') {
        if (req.headers['x-aegis-local'] !== '1') {
          res.writeHead(403, { 'content-type': 'text/plain' });
          res.end('forbidden');
          return;
        }
        req.resume();
        void (async () => {
          try {
            const imported: Record<string, { inserted: number; costUsd: number; available: boolean }> = {};
            let totalNew = 0;
            for (const imp of DASH_IMPORTERS) {
              const available = imp.locate() !== null;
              const sum = available ? await imp.run(store, {}) : null;
              imported[imp.id] = { inserted: sum?.inserted ?? 0, costUsd: sum?.costUsd ?? 0, available };
              totalNew += sum?.inserted ?? 0;
            }
            const discovered = await realizeDiscoveredProjects(store, {});
            return json(res, 200, { ok: true, totalNew, imported, correlated: discovered.length, discovered });
          } catch (err) {
            return json(res, 500, { error: String(err) });
          }
        })();
        return;
      }
      if (req.method !== 'GET') {
        res.writeHead(405, { 'content-type': 'text/plain', allow: 'GET, POST' });
        res.end('method not allowed');
        return;
      }
      // GET preview. The filesystem walk is bounded (depth + visit budget), so this
      // stays responsive; repo paths are capped in the payload for large trees. It
      // also reports what changed since the last scan of these roots, then records
      // this scan as the new baseline (a local marker — imports/correlates nothing).
      try {
        const path = url.searchParams.get('path') || undefined;
        const { plan, diff } = scanWithDiff(store, { roots: path ? [path] : undefined });
        saveScan(store, plan);
        return json(res, 200, {
          ok: true,
          tools: plan.tools,
          otherApps: plan.otherApps.filter((a) => a.present),
          roots: plan.roots,
          repoCount: plan.repos.length,
          repos: plan.repos.slice(0, 50),
          reposWithSpend: plan.reposWithSpend.length,
          hitBudget: plan.scan.hitBudget,
          dirsVisited: plan.scan.dirsVisited,
          unreadableDirs: plan.scan.unreadableDirs.length,
          diff,
        });
      } catch (err) {
        return json(res, 500, { error: String(err) });
      }
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
          'content-disposition': `attachment; filename="fiscus-${safe}.csv"`,
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
      // Same journey engine as `fiscus guide` — one truth, two renderers.
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
            realization = { matured: rep.matured, firstPassAcceptance: rep.firstPassAcceptance, proposalCoverage: rep.proposalCoverage, projectScoped: rep.projectScoped, units: rep.units };
            // Baseline minutes, resolved exactly like the CLI (config override >
            // personal git history, shrunk toward a cited population prior >
            // population prior alone). `repo` is never empty — `safeRepo` falls back
            // to the dashboard's launch directory when no `?repo=` is given, the same
            // `flags.repo ?? process.cwd()` convention every CLI command already uses
            // — so this mines that directory's git history exactly as `fiscus roi`
            // (no `--repo`) would. Only demo mode skips it (the seeded snapshots
            // aren't this checkout's real history).
            const resolvedBaseline = !isDemo()
              ? await resolveBaselineMinutesForRepo(store, repo, await projectName(repo), config.lift.baselineMinutes, DEFAULT_CONFIG.lift.baselineMinutes)
              : { minutes: config.lift.baselineMinutes, minutesLow: config.lift.baselineMinutes, minutesHigh: config.lift.baselineMinutes, basis: {}, notes: [] as string[] };
            const baselineMinutes = resolvedBaseline.minutes;
            // Lift: in demo mode a labeled synthetic TSF; otherwise the REAL source
            // — measured "time with AI" × resolved task baselines — so the 4th lens
            // and the RoI interval reflect this machine's own behavioral data. Notes
            // (incl. which baseline source won, per task-type) are threaded into
            // `roi.notes` below so the dashboard explains itself exactly like the CLI.
            let liftNotes: string[] = [];
            const roiOpts = isDemo()
              ? demoLiftOptions()
              : (() => {
                  const dl = liftOptionsFromStore(store, rep, baselineMinutes, { low: resolvedBaseline.minutesLow, high: resolvedBaseline.minutesHigh });
                  liftNotes = [...dl.notes, ...resolvedBaseline.notes];
                  return { lift: dl.lift, liftRange: dl.liftRange };
                })();
            // The money number, priced exactly like the CLI (shared helper). Labor
            // rate falls back to config; the demo assumes an illustrative rate so the
            // dollar return is visible. Threaded only into the headline RoI — not the
            // shared roiOpts — so per-project values aren't given a global numerator.
            let laborRate = config.lift.laborRatePerHour;
            if (laborRate === null && isDemo()) laborRate = 120;
            const money = moneyInputsFromStore(store, rep, baselineMinutes, laborRate);
            roi = computeReturnOnIntelligence(rep, {
              ...roiOpts,
              laborRatePerHour: laborRate,
              grossRealizedValueUsd: money.grossRealizedValueUsd,
              supervisionMinutes: money.supervisionMinutes,
            });
            roi.notes.unshift(...liftNotes);
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
            // Whether the realized-value dollars came from spend SCOPED to this
            // project (imports / tagged proxy) vs the project-blind window sum —
            // disclosed so the number's basis is never silent.
            projectScoped: loaded?.report.projectScoped ?? null,
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
