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
import { reconciliationReadiness } from '../billing/readiness.ts';
import { CLAIM_USES } from '../epistemic/claim-uses.ts';
import { existsSync, statSync } from 'node:fs';
import type { Store } from '../store/db.ts';
import {
  allocatedClaimSupport,
  billedClaimSupport,
  meteredClaimSupport,
  realizedClaimSupport,
} from './claim-support.ts';
import { isDemo, type FiscusConfig } from '../config.ts';
import { probeProxyState } from '../egress/proxyHealth.ts';
import { buildSettingsSnapshot, applySettingsPatch, SettingsValidationError, type SettingsPatch } from './settings.ts';
import { serveHtml } from './static.ts';
import { resolveEnforcedSpend, startOfLocalDay } from '../budget/guard.ts';
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
import { economicRequestsToCsv } from '../export/economic.ts';
import { instant, type Instant } from '../epistemic/time.ts';
import { DIMENSIONS } from '../value/characterization.ts';
import { IMPORTERS, emptyImportSummary, type ImportSummary } from '../connect/importShared.ts';
import { importClaudeCode, defaultClaudeCodeRoot } from '../connect/claudeCode.ts';
import { importOpencode, defaultOpencodeDbPath } from '../connect/opencode.ts';
import { importCodex, defaultCodexRoot } from '../connect/codex.ts';
import { judgeSessionFromStore } from '../judge/orchestrate.ts';
import { resolveJudgeTier, hasHostedJudgeApiKey } from '../judge/tier.ts';
import { pricingStatus } from '../cost/pricing.ts';
import { pricingCoverage } from '../cost/coverage.ts';
import { RESOURCE_LIMITS } from '../util/resource-limits.ts';
import { buildEconomicReport } from '../cli/economicCmd.ts';
import { verifyBlockedAssignmentPlan } from '../causal/assignment.ts';
import { estimateCausalStudy } from '../causal/estimate.ts';
import { stringifyJson } from '../util/json.ts';
import { dashboardApiContract, type DashboardApiContractId } from './contracts.ts';
import type { DashboardResponseFor } from './shared-types.ts';

/**
 * Config persistence is injectable so the dashboard can be exercised without
 * touching a developer's real local configuration.
 */
export interface ConfigPersistence {
  load: () => FiscusConfig;
  save: (config: FiscusConfig) => void;
}

/** Everything a handler is allowed to reach for. Nothing else is in scope. */
export interface RouteContext {
  req: http.IncomingMessage;
  res: http.ServerResponse;
  /** The parsed request URL — handlers read `searchParams` off this. */
  url: URL;
  store: Store;
  config: FiscusConfig;
  /** This package's version — surfaced read-only in the Settings view. */
  version: string;
  configPersistence: ConfigPersistence;
}

export interface Route {
  /** Exact pathname. Matching is exact equality, never a prefix. */
  path: string;
  /**
   * Methods this route answers. Everything else gets a 405 and an `Allow`.
   *
   * There is deliberately no "any method" value. Ten read routes used to carry
   * one, inherited from the pre-refactor if-chain where they simply never
   * checked — so they answered DELETE and PATCH with 200 and a full payload.
   * Every one of those handlers is a read, so nothing was corruptible through
   * them, but a table whose whole purpose is to make the security posture
   * readable should not have a row that means "unrestricted". Requiring the
   * list makes the fall-open unrepresentable rather than merely absent.
   *
   * `OPTIONS` is not in any route's list, on purpose. The CSRF gate below rests
   * on this server never answering a preflight; a route that started answering
   * OPTIONS is the one change that could quietly undo it. OPTIONS gets a 405
   * like any other unserved method, which no browser treats as preflight
   * approval.
   */
  methods: readonly string[];
  /**
   * The `Allow` header sent with a 405. Defaults to `methods` joined, and is
   * only set explicitly where the historical header differs from the methods
   * actually served (see '/api/settings').
   */
  allow?: string;
  /**
   * Methods that additionally require `x-fiscus-local: 1`. A cross-origin page
   * cannot set a custom header without a preflight this server never answers,
   * so a malicious site cannot drive the operator's local Fiscus. This is the
   * CSRF gate on every mutating route — never relax it.
   */
  localOnly?: readonly string[];
  handler: (ctx: RouteContext) => void;
}

/** Declare an API route from the shared contract, never a second path/method literal. */
function apiRoute(id: DashboardApiContractId, handler: Route['handler']): Route {
  const contract = dashboardApiContract(id);
  return {
    path: contract.path,
    methods: contract.methods,
    ...(contract.allow === undefined ? {} : { allow: contract.allow }),
    ...(contract.localOnly.length === 0 ? {} : { localOnly: contract.localOnly }),
    handler,
  };
}

export function json(res: http.ServerResponse, status: number, payload: unknown): void {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(stringifyJson(payload, 0));
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

export function buildOverview(store: Store, config: FiscusConfig, range: RangeKey): DashboardResponseFor<'overview'> {
  const now = Date.now();
  const { startMs, endMs, bucketMs } = resolveRange(range, now);

  const dayStart = startOfLocalDay(now);
  // The budget panel reads the same basis the guard ENFORCES on (live proxy spend
  // unless capIncludesImported) — a bar that disagrees with the blocker is a lie.
  // ...which means resolving it the same WAY, not merely over the same rows. The
  // guard enforces on the exact effective projection whenever one is available;
  // reading the raw float here made the bar disagree with the blocker by exactly
  // the corrections the economic ledger had recorded (D-107).
  const liveOnly = !config.budget.capIncludesImported;
  const exactDay = (from: number, to: number, live: boolean) =>
    (typeof store.exactSpendBetween === 'function' ? store.exactSpendBetween(from, to, live) : null);
  const todayResolved = resolveEnforcedSpend(
    exactDay(dayStart, now + 1000, liveOnly),
    store.spendBetween(dayStart, now + 1000, liveOnly),
  );
  const todaySpend = todayResolved.usd;
  const todayTotal = liveOnly
    ? resolveEnforcedSpend(exactDay(dayStart, now + 1000, false), store.spendBetween(dayStart, now + 1000)).usd
    : todaySpend;
  const summary = store.summary(startMs, endMs);
  const pricingWindow = store.healthStats(startMs, endMs);

  return {
    range,
    demo: isDemo(),
    // What this claim's evidence reaches, on named axes, stated by the side that
    // holds the evidence. The GUI used to infer this from `estimatedSpendShare`
    // in the browser, which answered `complete` for a window with no spend in it.
    claimSupport: meteredClaimSupport({
      totalCostUsd: pricingWindow.totalCostUsd,
      estimatedCostUsd: pricingWindow.estimatedCostUsd,
    }),
    generatedAt: new Date(now).toISOString(),
    budget: {
      dailyUsd: config.budget.dailyUsd,
      dailySoftUsd: config.budget.dailySoftUsd,
      todaySpendUsd: todaySpend,
      todayImportedUsd: Math.max(0, todayTotal - todaySpend),
      capExcludesImported: liveOnly,
      remainingDailyUsd: config.budget.dailyUsd === null ? null : Math.max(0, config.budget.dailyUsd - todaySpend),
      todaySpendBasis: todayResolved.basis,
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
 * the one write on this server reachable without `x-fiscus-local: 1`.
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
    // Read once: the same recorded runs decide the claim's support and are
    // served as the evidence behind it. Reading them twice would let the two
    // disagree the moment a run landed between the calls.
    const runs = store.reconciliationRuns(10);
    const summary = store.billingSummary();
    return json(res, 200, {
      demo: isDemo(),
      // `conflicted` lives here and nowhere else in this payload. Repeated
      // provider observations of the same days that disagree contradict the
      // billed claim rather than establishing it, and the browser's count-based
      // inference had no branch that could say so.
      claimSupport: billedClaimSupport({
        recordCount: summary.recordCount,
        runCount: runs.length,
        latest: runs[0]?.result ?? null,
      }),
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
      summary,
      imports: store.billingImportRuns(25),
      kernel: {
        kind: 'trusted_epistemic_kernel_billing',
        claims: store.billingKernelClaims(25),
        observedClaims: store.openAiCostsKernelClaims(25),
        reconciliationClaims: store.billingReconciliationKernelClaims(25),
      },
      // Readiness is served BEFORE a credential is minted, which is the only
      // moment it is useful. `directOpenAiCosts.coverage` below is the
      // post-observation partition and is null until a snapshot exists, so on
      // a ledger whose OpenAI spend all arrived by import — the case this
      // warning was written for — it says nothing at all. Same computation the
      // CLI prints, imported rather than reimplemented.
      readiness: reconciliationReadiness(store),
      // Exact imported-record mapping coverage is a read-only accounting
      // projection. Operator declarations stay visibly separate from provider
      // authority and cannot enter request spend, budgets, RoI, or advice.
      mapping: store.billingMappingCoverage(),
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
        runs,
        // READ, NOT RESTATED. The comment above says this route serves recorded
        // runs rather than computing them, so the page cannot disagree with the
        // evidence — and the exclusion list beside them was hand-written, and
        // disagreed: five names here against the four each record carries, with
        // `outcome_attribution` appearing nowhere else under `src/` (WP-B05).
        // The record is the evidence for its own exclusions too.
        //
        // With no runs there is no record to read, so the declared vocabulary
        // stands in — every use, which is the conservative answer when there is
        // nothing to be conservative about yet.
        excludedFrom: runs.length > 0 ? [...runs[0]!.result.excludedFrom] : [...CLAIM_USES],
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
    const costCentres = store.costCentres();
    const allocationRuns = store.allocationRuns(10);
    return json(res, 200, {
      demo: isDemo(),
      // Showback: cost centres with no recorded run are partial coverage of a
      // claim that is still unknown, never a refuted one.
      claimSupport: allocatedClaimSupport({
        costCentreCount: costCentres.length,
        runCount: allocationRuns.length,
      }),
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
      costCentres,
      rules: store.allocationRules(),
      runs: allocationRuns,
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

/**
 * Exact economic-ledger projection — the dashboard/API counterpart of
 * `fiscus economic --json`. This is deliberately a read-only projection: it
 * exposes the same source/effective coverage and role-aware balances as the
 * CLI, without recomputing or mutating historical events.
 *
 * `all=1` (or `all=true`) takes precedence over `days`. An invalid window is a
 * 400 rather than a silent fallback, because a caller must not mistake a
 * different time range for the one it requested. The upper bound mirrors the
 * CLI so an accidental multi-century query cannot turn a local dashboard poll
 * into an unbounded replay.
 */
export function handleEconomic({ res, url, store }: RouteContext): void {
  try {
    const all = url.searchParams.get('all') === '1' || url.searchParams.get('all') === 'true';
    const rawDays = url.searchParams.get('days');
    const days = rawDays === null ? 30 : Number(rawDays);
    if (!all && (!Number.isFinite(days) || days <= 0 || days > 3650)) {
      return json(res, 400, { error: 'days must be a finite number between 0 and 3650 (or pass all=1)' });
    }
    const targetCurrency = url.searchParams.get('targetCurrency');
    if (targetCurrency !== null && targetCurrency.trim().length === 0) {
      return json(res, 400, { error: 'targetCurrency must be non-empty when supplied' });
    }
    let asOf: Instant | undefined;
    const rawAsOf = url.searchParams.get('asOf');
    if (rawAsOf !== null) {
      try {
        asOf = instant(rawAsOf);
      } catch (error) {
        return json(res, 400, { error: `asOf must be a canonical UTC ISO-8601 instant: ${error instanceof Error ? error.message : String(error)}` });
      }
    }
    let effectiveAt: Instant | undefined;
    const rawEffectiveAt = url.searchParams.get('effectiveAt');
    if (rawEffectiveAt !== null) {
      try {
        effectiveAt = instant(rawEffectiveAt);
      } catch (error) {
        return json(res, 400, { error: `effectiveAt must be a canonical UTC ISO-8601 instant: ${error instanceof Error ? error.message : String(error)}` });
      }
    }
    const now = Date.now();
    const dayMs = 24 * 60 * 60 * 1000;
    const startMs = all ? 0 : now - days * dayMs;
    const endMs = now + 1000;
    return json(res, 200, buildEconomicReport(store, {
      startMs,
      endMs,
      demo: isDemo(),
      ...(targetCurrency === null ? {} : { targetUnit: targetCurrency.trim() }),
      ...(asOf === undefined ? {} : { asOf }),
      ...(effectiveAt === undefined ? {} : { effectiveAt }),
    }));
  } catch (err) {
    return json(res, 500, { error: String(err) });
  }
}

/**
 * Pricing provenance — the read-only GUI counterpart of `fiscus pricing
 * --coverage`, answering how each recorded amount was actually priced.
 *
 * Parity here is literal, not asserted: both surfaces call `pricingCoverage`
 * in src/cost/coverage.ts, so neither can drift into a different answer about
 * provenance. That is the same fix `src/value/report.ts` applied to the value
 * arithmetic, for the same reason.
 *
 * What this route must never become. It reads. It cannot refresh a rate card,
 * cannot reprice a historical row, and cannot present a local list-price
 * estimate as provider-billed or reconciled cost — the payload carries
 * `boundary` so that claim travels with the number instead of depending on
 * whichever surface renders it.
 *
 * `all=1` takes precedence over `days`, matching the CLI's `--all`. An
 * unparseable or non-positive `days` is a 400 rather than a silent default:
 * quietly substituting 30 days would answer a different question than the one
 * asked, over a window the caller never sees.
 */
export function handlePricing({ res, url, store, config }: RouteContext): void {
  try {
    const all = url.searchParams.get('all') === '1' || url.searchParams.get('all') === 'true';
    const raw = url.searchParams.get('days');
    const days = raw === null ? 30 : Number(raw);
    if (!all && (!Number.isFinite(days) || days <= 0)) {
      return json(res, 400, { error: 'days must be a positive number (or pass all=1)' });
    }
    const payload = pricingCoverage(store, { all, days, maxAgeDays: config.pricing.maxAgeDays });
    return json(res, 200, { demo: isDemo(), generatedAt: new Date().toISOString(), ...payload });
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
    const economic = url.searchParams.get('economic') === '1' || url.searchParams.get('economic') === 'true';
    const targetUnit = url.searchParams.get('targetCurrency');
    const rawAsOf = url.searchParams.get('asOf');
    if (targetUnit !== null && targetUnit.trim().length === 0) {
      return json(res, 400, { error: 'targetCurrency must be non-empty when supplied' });
    }
    let asOf: string | undefined;
    if (rawAsOf !== null) {
      try {
        asOf = instant(rawAsOf);
      } catch (error) {
        return json(res, 400, { error: `asOf must be a canonical UTC ISO-8601 instant: ${error instanceof Error ? error.message : String(error)}` });
      }
    }
    const csv = economic
      ? economicRequestsToCsv(store.economicRequestsInRange(startMs, endMs, {
        ...(targetUnit === null ? {} : { targetUnit }),
        ...(asOf === undefined ? {} : { asOf }),
      }))
      : requestsToCsv(store.requestsInRange(startMs, endMs));
    res.writeHead(200, {
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': `attachment; filename="fiscus-${safe}.csv"`,
      'cache-control': 'no-store',
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
      const proxyStatus = await probeProxyState(config);
      return json(res, 200, buildGuide({
        demo: isDemo(),
        port: config.port,
        dashboardPort: config.dashboardPort,
        proxyUp: proxyStatus.kind === 'up',
        proxyStatus,
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
      let bytes = 0;
      for await (const c of req) {
        const chunk = c as Buffer;
        bytes += chunk.byteLength;
        if (bytes > RESOURCE_LIMITS.dashboardRequestBytes) {
          req.resume();
          return json(res, 413, { error: { code: 'DASHBOARD_REQUEST_TOO_LARGE', message: 'judge request body exceeds the bounded dashboard limit' } });
        }
        chunks.push(chunk);
      }
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
      // The money claim is `returnRatio.manualEquivalentValueUsd`, and only when
      // the payload's own `basis` says it is priced. A dollar figure is never
      // invented from a bare ratio.
      const ratio = spine?.roi?.returnRatio ?? null;
      const roiCoverage = spine?.roi?.coverage;
      return json(res, 200, {
        demo: value.demo,
        // Contradicted gate evidence lands on COVERAGE here rather than on the
        // epistemic axis, because mature units are different propositions and a
        // population of contradictions is not a contradiction in the aggregate.
        // See `src/dashboard/claim-support.ts`.
        claimSupport: realizedClaimSupport({
          maturedUnits: rep?.matured?.units ?? 0,
          realizedUnits: rep?.matured?.realizedUnits ?? 0,
          gateConflicts: rep?.matured?.gateConflicts ?? null,
          roiCoverage: typeof roiCoverage === 'number' ? roiCoverage : null,
          valued: ratio?.basis === 'usd' && typeof ratio.manualEquivalentValueUsd === 'number',
        }),
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
 * Read-only causal-study inspector. It intentionally omits randomisation
 * material and raw record payloads: the dashboard gets the evidence state,
 * protocol hash, counts, and replay verdict, while local CLI/export tooling
 * remains the controlled surface for detailed evidence handling.
 */
export function handleCausal({ res, url, store }: RouteContext): void {
  try {
    const summaries = store.causalStudySummaries();
    const requested = url.searchParams.get('study');
    const selected = requested
      ? summaries.find((summary) => summary.studyId === requested) ?? null
      : summaries[0] ?? null;
    if (requested && !selected) {
      return json(res, 404, { error: 'causal study not found', studyId: requested });
    }
    if (!selected) {
      return json(res, 200, {
        demo: isDemo(),
        generatedAt: new Date().toISOString(),
        studies: [],
        study: null,
        causalEvidence: 'No publicly inspectable retained version-1 causal study. Version-2 public projection is deferred. Value output remains an observed/manual-equivalent scenario.',
        boundary: 'Read-only local status. This endpoint cannot change routing, budgets, or provider configuration.',
      });
    }
    const data = store.causalStudyData(selected.studyId);
    if (!data) throw new Error('causal summary exists without its local protocol');
    const estimate = estimateCausalStudy(data);
    const assignmentReplay = store.causalAssignmentPlans(selected.studyId).map((plan) => ({
      blockId: plan.blockId,
      allocationHash: plan.allocationHash,
      errors: verifyBlockedAssignmentPlan(data.protocol, plan),
    }));
    return json(res, 200, {
      demo: isDemo(),
      generatedAt: new Date().toISOString(),
      studies: summaries,
      study: {
        studyId: selected.studyId,
        protocolHash: data.protocol.protocolHash,
        committedAtMs: data.protocol.committedAtMs,
        question: data.protocol.question,
        counts: {
          decisions: data.decisions.length,
          executions: data.executions.length,
          outcomes: data.outcomes.length,
        },
        qualification: estimate.qualification,
        allowedClaim: estimate.allowedClaim,
        jointInference: estimate.jointInference,
        assignmentReplay,
      },
      causalEvidence: 'Local randomized-study evidence only. Ordinary Lift, pricing, and value scenarios cannot create a causal claim.',
      boundary: 'Read-only local status. This endpoint cannot change routing, budgets, or provider configuration.',
    });
  } catch (err) {
    if (typeof err === 'object' && err !== null && Reflect.get(err, 'code') === 'CAUSAL_INTEGRITY_FAILURE') {
      return json(res, 409, {
        error: 'CAUSAL_INTEGRITY_FAILURE',
        causalEvidence: 'Stored causal evidence failed integrity verification. Public causal projection is unavailable until the local Store is repaired.',
      });
    }
    return json(res, 500, { error: String(err) });
  }
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
      let bytes = 0;
      for await (const c of req) {
        const chunk = c as Buffer;
        bytes += chunk.byteLength;
        if (bytes > RESOURCE_LIMITS.dashboardRequestBytes) {
          req.resume();
          throw new SettingsValidationError('request body exceeds the 16 KiB settings limit');
        }
        chunks.push(chunk);
      }
      const patch = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as SettingsPatch;
      const current = configPersistence.load();
      const next = applySettingsPatch(current, patch);
      configPersistence.save(next);
      // Mutate the shared config object IN PLACE rather than rebinding it.
      // `fiscus start` hands this same object to the proxy, and the guard holds
      // it as a getter (`new BudgetGuard(store, () => config.budget)`) that is
      // re-read per request — so this assignment makes a saved cap live, with no
      // restart. Verified end to end: with no cap a proxied request returned
      // 200; a $0.01 cap posted here made the next one 429 in the same process.
      //
      // An earlier comment here claimed the opposite, and the Control view
      // repeated it to operators as "Changes need a restart". Replacing the
      // object instead of assigning into it would make that stale claim true
      // again, silently — the proxy would keep the old reference.
      Object.assign(config, next);
      return json(res, 200, buildSettingsSnapshot(store, config, version));
    } catch (err) {
      if (err instanceof SettingsValidationError) {
        return json(res, 400, { error: { code: err.code, message: err.message } });
      }
      if (err instanceof SyntaxError) {
        return json(res, 400, { error: { code: 'SETTINGS_INVALID_JSON', message: 'settings request body must be valid JSON' } });
      }
      return json(res, 500, { error: { code: 'SETTINGS_UPDATE_FAILED', message: 'settings could not be persisted' } });
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
  apiRoute('health', handleHealth),
  apiRoute('importers', handleImporters),
  apiRoute('import', handleImport),
  apiRoute('discover', handleDiscover),
  // GET previews (read-only), POST performs the import+correlate — so only the
  // POST carries the CSRF gate.
  apiRoute('scan', handleScan),
  apiRoute('overview', handleOverview),
  apiRoute('billing', handleBilling),
  apiRoute('allocation', handleAllocation),
  apiRoute('economic', handleEconomic),
  apiRoute('pricing', handlePricing),
  apiRoute('export-csv', handleExportCsv),
  apiRoute('realization', handleRealization),
  apiRoute('guide', handleGuide),
  apiRoute('judge', handleJudge),
  apiRoute('value', handleValue),
  apiRoute('causal', handleCausal),
  // Reads GET only, but has always advertised 'GET, POST' on the 405 — the
  // POST that Settings actually performs goes to /api/settings/update. The
  // header is preserved verbatim rather than "corrected": it is part of the
  // published response contract, and changing it is a behaviour change.
  apiRoute('settings', handleSettings),
  apiRoute('settings-update', handleSettingsUpdate),
  apiRoute('clear-proposals', handleClearProposals),
  { path: '/', methods: ['GET', 'HEAD'], handler: handleHtmlEntry },
  { path: '/index.html', methods: ['GET', 'HEAD'], handler: handleHtmlEntry },
  { path: '/classic', methods: ['GET', 'HEAD'], handler: handleHtmlEntry },
];
