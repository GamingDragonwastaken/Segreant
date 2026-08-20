/**
 * The dashboard's API routes: one named handler per endpoint, plus the table
 * that maps a method and path onto it.
 *
 * Route MATCHING and route HANDLING are deliberately separate concerns here.
 * The table below states, declaratively and in one readable place, which
 * methods each path answers and which of them require the same-origin header —
 * so the security posture of the whole API can be read at a glance instead of
 * reconstructed by tracing an if-chain. `server.ts` does the matching and
 * enforces those declarations uniformly; nothing in this file re-implements a
 * 405 or a 403.
 *
 * Handlers are module-level named functions, not closures over the server, so
 * each one can be called directly with a request/response pair and its own
 * dependencies. Everything a handler needs arrives in `RouteContext`.
 */

import type http from 'node:http';
import { existsSync, statSync } from 'node:fs';
import type { Store } from '../store/db.ts';
import { isDemo, type AegisConfig } from '../config.ts';
import { buildSettingsSnapshot, applySettingsPatch, type SettingsPatch } from './settings.ts';
import { serveHtml } from './static.ts';
import { startOfLocalDay } from '../budget/guard.ts';
import { loadRealization, realizeDiscoveredProjects } from '../value/realization.ts';
// The one composition of the value primitives, shared with the CLI — see the
// '/api/value' handler below and src/value/report.ts for why it is not inline.
import { valueReport } from '../value/report.ts';
import { projectName } from '../git/correlate.ts';
import { scanWithDiff, saveScan } from '../scan/scan.ts';
import { describeSourceDepth } from '../value/sourceDepth.ts';
import { buildGuide } from '../guide.ts';
import { computeAlerts } from '../alerts/detect.ts';
import { requestsToCsv } from '../export/csv.ts';
import { DIMENSIONS } from '../value/characterization.ts';
import { IMPORTERS, emptyImportSummary, type ImportSummary } from '../connect/importShared.ts';
import { importClaudeCode, defaultClaudeCodeRoot } from '../connect/claudeCode.ts';
import { importOpencode, defaultOpencodeDbPath } from '../connect/opencode.ts';
import { importCodex, defaultCodexRoot } from '../connect/codex.ts';
import { judgeSessionFromStore } from '../judge/orchestrate.ts';
import { resolveJudgeTier, hasHostedJudgeApiKey } from '../judge/tier.ts';
import { pricingStatus } from '../cost/pricing.ts';

/**
 * Config persistence is injectable so the dashboard can be exercised without
 * touching a developer's real local configuration.
 */
export interface ConfigPersistence {
  load: () => AegisConfig;
  save: (config: AegisConfig) => void;
}

/** Everything a handler is allowed to reach for. Nothing else is in scope. */
export interface RouteContext {
  req: http.IncomingMessage;
  res: http.ServerResponse;
  /** The parsed request URL — handlers read `searchParams` off this. */
  url: URL;
  store: Store;
  config: AegisConfig;
  /** This package's version — surfaced read-only in the Settings view. */
  version: string;
  configPersistence: ConfigPersistence;
}

export interface Route {
  /** Exact pathname. Matching is exact equality, never a prefix. */
  path: string;
  /**
   * Methods this route answers. `null` means "any method" — the read-only
   * routes that have never method-checked; keeping that explicit is what stops
   * this refactor from quietly adding a 405 where there was none.
   */
  methods: readonly string[] | null;
  /**
   * The `Allow` header sent with a 405. Defaults to `methods` joined, and is
   * only set explicitly where the historical header differs from the methods
   * actually served (see '/api/settings').
   */
  allow?: string;
  /**
   * Methods that additionally require `x-aegis-local: 1`. A cross-origin page
   * cannot set a custom header without a preflight this server never answers,
   * so a malicious site cannot drive the operator's local Fiscus. This is the
   * CSRF gate on every mutating route — never relax it.
   */
  localOnly?: readonly string[];
  handler: (ctx: RouteContext) => void;
}

export function json(res: http.ServerResponse, status: number, payload: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(payload));
}

/** Only honor a ?repo= that is an existing directory; otherwise the dashboard's cwd. */
export function safeRepo(param: string | null): string {
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

export function buildOverview(store: Store, config: AegisConfig, range: RangeKey) {
  const now = Date.now();
  const { startMs, endMs, bucketMs } = resolveRange(range, now);

  const dayStart = startOfLocalDay(now);
  // The budget panel reads the same basis the guard ENFORCES on (live proxy spend
  // unless capIncludesImported) — a bar that disagrees with the blocker is a lie.
  const liveOnly = !config.budget.capIncludesImported;
  const todaySpend = store.spendBetween(dayStart, now + 1000, liveOnly);
  const todayTotal = liveOnly ? store.spendBetween(dayStart, now + 1000) : todaySpend;
  const summary = store.summary(startMs, endMs);
  const pricingWindow = store.healthStats(startMs, endMs);

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
    summary,
    // Rate-card freshness and estimate share are local evidence about the
    // numbers shown in this Overview. They do not trigger a refresh, reprice
    // historical rows, or turn a list-price estimate into provider billing.
    pricing: {
      status: pricingStatus(config.pricing.maxAgeDays),
      autoRefresh: config.pricing.autoRefresh,
      estimatedCostUsd: pricingWindow.estimatedCostUsd,
      estimatedSpendShare: pricingWindow.totalCostUsd > 0
        ? pricingWindow.estimatedCostUsd / pricingWindow.totalCostUsd
        : 0,
      // Per-row provenance, grouped without mixing cards or match paths. This
      // is deliberately separate from the active card above: a refresh never
      // rewrites the evidence captured for historical requests.
      provenance: store.pricingEvidenceByModel(startMs, endMs),
    },
    byModel: store.byModel(startMs, endMs),
    byProject: store.byProject(startMs, endMs),
    // Same grouping as byProject, split by how each label was obtained, so the
    // per-project money panel can say what its attribution rests on instead of
    // presenting a self-declared header as settled fact.
    attributionEvidence: store.attributionEvidenceByProject(startMs, endMs),
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

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

export function handleHealth({ res }: RouteContext): void {
  return json(res, 200, { ok: true, service: 'fiscus-dashboard' });
}

/**
 * Which native importers exist on THIS machine — drives the dashboard's
 * one-click "Import local usage" panel so non-CLI users never touch a terminal.
 */
export function handleImporters({ res }: RouteContext): void {
  return json(res, 200, {
    importers: DASH_IMPORTERS.map((imp) => {
      const location = imp.locate();
      return { id: imp.id, label: imp.label, blurb: imp.blurb, available: location !== null, location };
    }),
  });
}

/**
 * Trigger a native import from the dashboard. POST-only + a custom header the
 * browser only sets same-origin (declared in the route table): a cross-site form
 * can't forge it (no CORS preflight is answered), so this is CSRF-safe despite
 * mutating the local DB.
 */
export function handleImport({ req, res, url, store }: RouteContext): void {
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
        const sum = available ? await imp.run(store, {}) : emptyImportSummary(0);
        results[imp.id] = { ...sum, available };
      }
      const totalNew = Object.values(results).reduce((n, r) => n + r.inserted, 0);
      return json(res, 200, { ok: true, totalNew, results });
    } catch (err) {
      return json(res, 500, { error: String(err) });
    }
  })();
}

/**
 * Auto-correlate imported projects into per-project RoI — the "no --repo, no
 * wiring" native path. POST-only + the same local-only header guard as
 * /api/import (it mutates the DB by persisting realization snapshots).
 */
export function handleDiscover({ req, res, url, store }: RouteContext): void {
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
}

/**
 * The proactive, opt-in SYSTEM SCAN — the one-click onboarding path.
 *   GET  /api/scan[?path=]  → dry-run preview: detected tools + git repos under
 *        the root (default: home). Read-only; imports and mutates nothing.
 *   POST /api/scan          → the deliberate setup step (CSRF-guarded like the
 *        other mutating routes): import every detected tool, correlate every
 *        discovered project into per-project RoI, and record the scan baseline.
 *        Same engines as import+discover.
 *
 * The baseline belongs to POST alone. `diff` answers "what changed since the
 * last scan you COMMITTED to", so the preview that reports it must not also
 * move the mark it is measured against — a GET that advanced the baseline made
 * the drift it just reported unobservable to the next reader, and made itself
 * the one write on this server reachable without `x-aegis-local: 1`.
 */
export function handleScan({ req, res, url, store }: RouteContext): void {
  const path = url.searchParams.get('path') || undefined;
  if (req.method === 'POST') {
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
        // Records what this deliberate step actually saw, so the next preview
        // diffs against the setup the operator ran rather than against a walk
        // some page they visited happened to trigger.
        const { plan } = scanWithDiff(store, { roots: path ? [path] : undefined });
        saveScan(store, plan);
        return json(res, 200, { ok: true, totalNew, imported, correlated: discovered.length, discovered });
      } catch (err) {
        return json(res, 500, { error: String(err) });
      }
    })();
    return;
  }
  // GET preview. The filesystem walk is bounded (depth + visit budget), so this
  // stays responsive; repo paths are capped in the payload for large trees. It
  // reports what changed since the last scan of these roots and writes nothing.
  try {
    const { plan, diff } = scanWithDiff(store, { roots: path ? [path] : undefined });
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

export function handleOverview({ res, url, store, config }: RouteContext): void {
  const range = (url.searchParams.get('range') as RangeKey) ?? 'today';
  const valid: RangeKey[] = ['today', '7d', '30d', 'all'];
  const safe = valid.includes(range) ? range : 'today';
  try {
    return json(res, 200, buildOverview(store, config, safe));
  } catch (err) {
    return json(res, 500, { error: String(err) });
  }
}

/**
 * Provider billing evidence has a different truth contract from the local
 * request ledger: an operator supplied it, Fiscus has not verified it with
 * the provider, and there is no account-bound reconciliation yet. Keep this
 * deliberately separate from /api/overview and /api/value so an imported
 * charge line cannot silently affect metering, budgets, ROI, or advice.
 */
export function handleBilling({ res, store }: RouteContext): void {
  try {
    return json(res, 200, {
      demo: isDemo(),
      generatedAt: new Date().toISOString(),
      evidence: {
        kind: 'provider_billing_evidence',
        sourceKind: 'operator_supplied_provider_report',
        trust: 'operator_supplied_unverified',
        rawRetention: 'digest_only',
        reconciliationStatus: 'not_reconciled',
        requestLedgerIncluded: false,
        usedFor: [],
        excludedFrom: [
          'request_metered_spend',
          'budget_enforcement',
          'outcome_attribution',
          'roi',
          'model_recommendations',
        ],
      },
      summary: store.billingSummary(),
      imports: store.billingImportRuns(25),
      // Explicit, read-only provider API observations use a different
      // source contract from imported operator reports. They remain a
      // separate snapshot/status surface and never become overview spend.
      directOpenAiCosts: {
        kind: 'openai_organization_costs_observation',
        sourceKind: 'provider_api_observation',
        trust: 'provider_observation_unreconciled',
        rawRetention: 'digest_only',
        reconciliationStatus: 'not_reconciled',
        status: store.openAiCostsObservationStatus(),
        coverage: store.openAiCostsCaptureCoverage(),
      },
      // Reconciliation is a DERIVED, immutable record — read here, never
      // computed here. Serving a freshly computed variance from a GET would
      // make the dashboard disagree with the recorded runs the moment a new
      // snapshot landed, and the recorded runs are the evidence.
      reconciliation: {
        kind: 'scope_conditional_reconciliation',
        grain: 'provider_project_day_total',
        runs: store.reconciliationRuns(10),
        excludedFrom: [
          'request_metered_spend',
          'budget_enforcement',
          'outcome_attribution',
          'roi',
          'model_recommendations',
        ],
      },
    });
  } catch (err) {
    return json(res, 500, { error: String(err) });
  }
}

/**
 * Cost-centre allocation — the showback surface, written for a BUDGET OWNER.
 *
 * Recorded runs only. Like reconciliation, this route reads what
 * `fiscus alloc run --apply` recorded and never computes a run of its own: a
 * freshly computed allocation would disagree with the recorded one the
 * moment a rule changed or new spend landed in the period, and the recorded
 * run is the statement someone has to stand behind.
 *
 * Cost centres and rules ARE served live, because they are configuration
 * rather than derived money — the page needs them to name a centre and to
 * show which rule version placed each line.
 */
export function handleAllocation({ res, store }: RouteContext): void {
  try {
    const reconciliationRuns = store.reconciliationRuns(1);
    return json(res, 200, {
      demo: isDemo(),
      generatedAt: new Date().toISOString(),
      kind: 'derived_cost_allocation',
      trust: 'derived_allocation_of_local_estimates',
      /** Showback, never chargeback: a chargeback implies a settlement this product does not have. */
      basis: 'showback_only',
      excludedFrom: [
        'request_metered_spend',
        'budget_enforcement',
        'roi',
        'model_recommendations',
      ],
      costCentres: store.costCentres(),
      rules: store.allocationRules(),
      runs: store.allocationRuns(10),
      // A cross-reference, not a computation. Whether ANY reconciliation has
      // been recorded decides whether the residual underneath every figure
      // on that page has been looked at — which is the difference between a
      // defensible showback number and a confident guess.
      reconciliation: {
        everRun: reconciliationRuns.length > 0,
        latestComputedAtMs: reconciliationRuns[0]?.computedAtMs ?? null,
      },
    });
  } catch (err) {
    return json(res, 500, { error: String(err) });
  }
}

export function handleExportCsv({ res, url, store }: RouteContext): void {
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
}

export function handleRealization({ res, url, store }: RouteContext): void {
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
}

export function handleGuide({ res, store, config }: RouteContext): void {
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
}

/**
 * Judge a real session on demand from the Value view. POST-only + the same
 * same-origin header guard as the other action routes: with an LLM judge
 * tier configured this can reach a user-chosen endpoint, so a cross-site
 * page must never be able to trigger it. Judges the newest-activity session
 * in the window unless the body names one; the resolved tier's
 * sendsContentOffDevice bit rides along so the UI can warn before the fact.
 */
export function handleJudge({ req, res, store, config }: RouteContext): void {
  void (async () => {
    try {
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      let body: { project?: string; sessionId?: string; windowDays?: number } = {};
      try {
        body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
      } catch {
        /* an empty/invalid body means "use the defaults" */
      }
      const project = typeof body.project === 'string' && body.project ? body.project : await projectName(safeRepo(null));
      const windowDays = Math.min(90, Math.max(1, Number(body.windowDays) || 7));
      const endMs = Date.now();
      const startMs = endMs - windowDays * 86_400_000;
      const sessions = store.sessionsInWindow(project, startMs, endMs);
      const picked = body.sessionId ? (sessions.find((s) => s.sessionId === body.sessionId) ?? null) : (sessions[0] ?? null);
      if (!picked) {
        return json(res, 200, { error: 'no-sessions-in-window', project, windowDays });
      }
      const tier = resolveJudgeTier(config.judge, hasHostedJudgeApiKey());
      const judgment = await judgeSessionFromStore(store, project, picked.sessionId, startMs, endMs, config.judge);
      return json(res, 200, {
        judgment,
        session: { sessionId: picked.sessionId, tool: picked.tool, requestCount: picked.requestCount },
        tier: { tier: tier.tier, sendsContentOffDevice: tier.sendsContentOffDevice },
      });
    } catch (err) {
      return json(res, 500, { error: String(err) });
    }
  })();
}

export function handleValue({ res, url, store, config }: RouteContext): void {
  const repo = safeRepo(url.searchParams.get('repo'));
  const windowDays = Number(url.searchParams.get('window') || '14') || 14;
  void (async () => {
    try {
      // The whole composition — realization, baseline, Lift, money, RoI,
      // drift, time reclaimed, frontier, per-project value, usage, cohort and
      // budget advice — lives in src/value/report.ts, which the CLI's `roi` /
      // `saved` commands call too. The two surfaces used to sequence these
      // primitives independently, held in step only by comments claiming they
      // matched. Now there is one sequence, so they cannot drift apart.
      //
      // `repo` is never empty — `safeRepo` falls back to the dashboard's
      // launch directory when no `?repo=` is given, the same
      // `flags.repo ?? process.cwd()` convention every CLI command uses — so
      // the baseline mines that directory's git history exactly as
      // `fiscus roi` (no `--repo`) would.
      //
      // `discloseLiftSource: false` keeps this payload's strings exactly as
      // they have always been: the CLI names its Lift source in
      // `roi.lenses.lift.how` and labels the demo's synthetic TSF in
      // `roi.notes`; this endpoint never has. It is a disclosure difference
      // only — every value, interval and dollar is computed identically.
      const value = await valueReport(store, config, {
        repo,
        windowDays,
        limit: 40,
        persist: false,
        discloseLiftSource: false,
      });
      const spine = value.spine;
      const rep = spine?.loaded.report ?? null;
      // The payload's realization slice is deliberately narrower than the
      // full report: the fields the GUI declares, and no more.
      const realization = rep
        ? {
            matured: rep.matured,
            firstPassAcceptance: rep.firstPassAcceptance,
            proposalCoverage: rep.proposalCoverage,
            projectScoped: rep.projectScoped,
            costStaleUnits: rep.costStaleUnits,
            units: rep.units,
          }
        : null;
      // Raw frontier cells may be unlike tasks. The dashboard exposes only
      // the separately gated, within-task model trials from `frontier`.
      const allocation = null;
      // Cross-project allocation is not comparable/reliable enough to
      // recommend from raw RoI alone; per-project value stays descriptive.
      const projectAllocation = null;
      return json(res, 200, {
        demo: value.demo,
        gitRepo: spine?.loaded.source === 'git',
        valueSource: spine?.loaded.source ?? null,
        // Whether the realized-value dollars came from spend SCOPED to this
        // project (imports / tagged proxy) vs the project-blind window sum —
        // disclosed so the number's basis is never silent.
        projectScoped: rep?.projectScoped ?? null,
        repo,
        generatedAt: new Date(value.generatedAtMs).toISOString(),
        realization,
        roi: spine?.roi ?? null,
        frontier: spine?.frontier ?? null,
        budget: value.budget,
        allocation,
        projects: value.projects,
        projectAllocation,
        usage: value.usage,
        team: value.team,
        drift: spine?.drift ?? null,
        reclaimed: spine?.reclaimed ?? null,
      });
    } catch (err) {
      return json(res, 500, { error: String(err) });
    }
  })();
}

/**
 * Settings snapshot for the dashboard's Settings view — read-only, no local-header
 * guard needed (same-machine-only already enforced by the loopback Host check).
 */
export function handleSettings({ res, store, config, version }: RouteContext): void {
  try {
    return json(res, 200, buildSettingsSnapshot(store, config, version));
  } catch (err) {
    return json(res, 500, { error: String(err) });
  }
}

/**
 * Apply a settings patch (budget / metadataOnly / retention). POST-only + the same
 * same-origin header guard as every other mutating route.
 */
export function handleSettingsUpdate({ req, res, store, config, version, configPersistence }: RouteContext): void {
  void (async () => {
    try {
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      const patch = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as SettingsPatch;
      const current = configPersistence.load();
      const next = applySettingsPatch(current, patch);
      configPersistence.save(next);
      // Keep this process's in-memory config in sync so a later plain GET
      // /api/settings doesn't read back stale values until a restart. Note this
      // does NOT reach the separately-constructed proxy server's own config
      // object — live budget enforcement still needs a restart to pick up edits,
      // same as any existing CLI config mutation today.
      Object.assign(config, next);
      return json(res, 200, buildSettingsSnapshot(store, config, version));
    } catch (err) {
      return json(res, 500, { error: String(err) });
    }
  })();
}

/**
 * Privacy control: purge every stored proposal (the AI's proposed code) right now,
 * regardless of age. POST-only + the same header guard.
 */
export function handleClearProposals({ req, res, store }: RouteContext): void {
  req.resume();
  try {
    const removed = store.clearProposals();
    return json(res, 200, { ok: true, removed });
  } catch (err) {
    return json(res, 500, { error: String(err) });
  }
}

/** '/' and '/index.html' serve the GUI; '/classic' serves the legacy console. */
export function handleHtmlEntry({ res, url }: RouteContext): void {
  serveHtml(res, url.pathname);
}

// ---------------------------------------------------------------------------
// The table
// ---------------------------------------------------------------------------

/**
 * Every route this server answers. `server.ts` matches on `path`, enforces
 * `methods` / `localOnly`, and calls `handler`. Anything not listed here falls
 * through to the static assets and then to 404.
 */
export const ROUTES: readonly Route[] = [
  { path: '/api/health', methods: null, handler: handleHealth },
  { path: '/api/importers', methods: null, handler: handleImporters },
  { path: '/api/import', methods: ['POST'], localOnly: ['POST'], handler: handleImport },
  { path: '/api/discover', methods: ['POST'], localOnly: ['POST'], handler: handleDiscover },
  // GET previews (read-only), POST performs the import+correlate — so only the
  // POST carries the CSRF gate.
  { path: '/api/scan', methods: ['GET', 'POST'], localOnly: ['POST'], handler: handleScan },
  { path: '/api/overview', methods: null, handler: handleOverview },
  { path: '/api/billing', methods: ['GET'], handler: handleBilling },
  { path: '/api/allocation', methods: ['GET'], handler: handleAllocation },
  { path: '/api/export.csv', methods: null, handler: handleExportCsv },
  { path: '/api/realization', methods: null, handler: handleRealization },
  { path: '/api/guide', methods: null, handler: handleGuide },
  { path: '/api/judge', methods: ['POST'], localOnly: ['POST'], handler: handleJudge },
  { path: '/api/value', methods: null, handler: handleValue },
  // Reads GET only, but has always advertised 'GET, POST' on the 405 — the
  // POST that Settings actually performs goes to /api/settings/update. The
  // header is preserved verbatim rather than "corrected": it is part of the
  // published response contract, and changing it is a behaviour change.
  { path: '/api/settings', methods: ['GET'], allow: 'GET, POST', handler: handleSettings },
  { path: '/api/settings/update', methods: ['POST'], localOnly: ['POST'], handler: handleSettingsUpdate },
  { path: '/api/settings/clear-proposals', methods: ['POST'], localOnly: ['POST'], handler: handleClearProposals },
  { path: '/', methods: null, handler: handleHtmlEntry },
  { path: '/index.html', methods: null, handler: handleHtmlEntry },
  { path: '/classic', methods: null, handler: handleHtmlEntry },
];
