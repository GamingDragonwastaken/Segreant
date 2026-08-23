/**
 * Configuration + on-disk paths.
 *
 * Everything Fiscus persists lives under a single directory:
 *   Windows : %USERPROFILE%\.fiscus
 *   macOS   : ~/.fiscus
 *   Linux   : ~/.fiscus
 *
 * Override it with FISCUS_HOME. FISCUS_DB and FISCUS_DEMO override the database
 * path and the demo flag the same way. See ENV_OVERRIDES below.
 *
 * Config is plain JSON so it stays dependency-free and hand-editable.
 */

import { homedir } from 'node:os';
import { join } from 'node:path';
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';

export interface BudgetConfig {
  /** Hard daily cap in USD. Requests are blocked once exceeded. null = unlimited. */
  dailyUsd: number | null;
  /** Soft daily threshold in USD. A warning header is injected past this. null = off. */
  dailySoftUsd: number | null;
  /** Hard per-session cap in USD. null = unlimited. */
  sessionUsd: number | null;
  /** Sliding window (seconds) used for runaway-loop detection. */
  runawayWindowSec: number;
  /** Spend within the window that flags a runaway loop. null = off. */
  runawayMaxUsd: number | null;
  /**
   * Whether IMPORTED spend (native importers reading a tool's own logs) counts
   * toward cap ENFORCEMENT. Default false: imported subscription usage is sunk
   * cost observed after the fact — in dogfooding it tripped the daily cap and
   * blocked live proxy traffic that had spent almost nothing. Set true to make
   * the cap govern total observed AI spend instead of blockable spend.
   */
  capIncludesImported: boolean;
}

export interface AlertsConfig {
  /**
   * Opt-in webhook for alert delivery (e.g. a Slack/Teams/PagerDuty incoming URL).
   * null = off (the default). When set, Fiscus POSTs ONLY alert metadata —
   * id, severity, title, detail, and a short metric. Never prompts, code, or keys.
   */
  webhookUrl: string | null;
  /** Minimum severity delivered to the webhook. */
  minSeverity: 'critical' | 'warn' | 'info';
}

export interface LiftConfig {
  /**
   * Estimated manual minutes a developer would spend per task-type — the
   * counterfactual baseline for the Lift lens. An auditable ORG input (like the
   * labor rate), never self-report. The Lift TSF = (these minutes, summed over
   * realized work) ÷ (measured "time with AI"). Override per task-type to fit your
   * team; an unknown task-type simply doesn't contribute (Lift stays honest).
   */
  baselineMinutes: Record<string, number>;
  /** Labor rate ($/hr) for break-even + effort tax. null = effort priced at 0. */
  laborRatePerHour: number | null;
  /**
   * Manual-equivalent minutes for NON-CODING outcomes, by reported reach
   * (used / resolved / published) — the org input that upgrades non-coding value
   * from its honest floor ("realized value = the spend that realized") to a real
   * dollar estimate, exactly like `baselineMinutes` does for code. Empty (the
   * default) = the dollar return for non-coding stays honestly un-priced.
   */
  outcomeBaselineMinutes: Record<string, number>;
}

export interface PricingConfig {
  /**
   * Remote pricing manifest. `fiscus pricing --refresh` pulls it into
   * ~/.fiscus/pricing/models.json, which then overrides the bundled table.
   * Accepts our native schema OR a LiteLLM price file (auto-detected and
   * transformed). Provider rates drift, and pricing is a core dependability,
   * so this keeps it current without a reinstall. The fetch is a plain GET of
   * a public file — it sends nothing about you. null = the default community
   * feed (LiteLLM's model_prices file, updated with every model release).
   */
  manifestUrl: string | null;
  /** Past this age, the table is flagged stale (in `pricing`, `doctor`). */
  maxAgeDays: number;
  /**
   * When true, `fiscus start` refreshes pricing on launch if the cache is
   * older than maxAgeDays. OFF by default so a normal local start has no
   * optional manifest request. Any refresh still needs a matching controlled
   * cloud egress rule; a denied refresh leaves the active local table intact.
   */
  autoRefresh: boolean;
}

export interface PerUserConfig {
  /**
   * Opt-in for per-user VALUE (extraction rate, coaching headroom). OFF by
   * default: spend-by-user is cost governance and always available, but attributing
   * VALUE to named people is the surveillance-prone axis, so it stays dark until a
   * team deliberately turns it on. Even then the org view is distribution-only and
   * gated by k-anonymity — this flag never unlocks a leaderboard.
   */
  enabled: boolean;
  /**
   * k-anonymity floor: the minimum number of identified users before ANY per-user
   * value is shown. Below this a team is too small to report on without fingering
   * an individual. Default 5.
   */
  minCohort: number;
}

export interface JudgeConfig {
  /**
   * Local OpenAI-compatible inference server for the AI-side Lift judge (e.g. a
   * local Ollama). null = the local-LLM judge tier is off. A separate field from
   * upstreams.openai on purpose — judge calls are never metered proxy traffic and
   * must never share a base URL with what's actually being measured. The tier's
   * egress evidence treats only a validated loopback URL as on-device; another
   * configured URL is reported as remote/off-device.
   */
  localBaseUrl: string | null;
  /**
   * Model name to request from localBaseUrl (e.g. "llama3.1"). Required
   * operationally — a Chat Completions call needs a model field — but there is
   * no safe universal default the way there is for judge.hostedModel below,
   * since local installs vary. null = the local tier stays off even if
   * localBaseUrl is set (see judge/orchestrate.ts, not the privacy gate in
   * judge/tier.ts — this is an executability check, not a consent check).
   */
  localModel: string | null;
  /**
   * Loud opt-in: once the local tier is active, also send full session content
   * (not just the structural proposal-count/timing summary) to it. Independent
   * of hostedSendFullContent below — turning this on never affects the hosted
   * tier. Still explicit, still off by default, even though the trust boundary
   * ("your machine") isn't crossed any more than it already is by the coding
   * tool itself (docs/LIFT-AI-SIDE-JUDGE-DESIGN.md §2).
   */
  localSendFullContent: boolean;
  /**
   * Explicit opt-in for the HOSTED judge tier. The credential itself
   * (FISCUS_JUDGE_API_KEY) must ALSO be set as an environment variable — never
   * stored here. config.json can end up committed, backed up, or shared, and a
   * bearer key for a separate judge account has no business living next to Lift
   * baselines. Both this flag AND the env var must independently be set before
   * any hosted call is made — see resolveJudgeTier in src/judge/tier.ts.
   */
  hostedEnabled: boolean;
  /**
   * Which OpenAI-compatible hosted endpoint to call once hostedEnabled AND the
   * env var are both set. This is operationally required (a call needs a URL),
   * not itself a third consent gate — the two real privacy decisions are
   * hostedEnabled and the env var.
   */
  hostedBaseUrl: string | null;
  /** Model name to request from hostedBaseUrl. Same executability role as
   * localModel above — required to build a valid request, not a consent gate. */
  hostedModel: string | null;
  /** Loud opt-in: once the hosted tier is active, also send full session content,
   * not just the structural summary. Independent of localSendFullContent. */
  hostedSendFullContent: boolean;
}

/**
 * A permission is specific to why Fiscus is sending a request and what class of
 * data the request may carry. A rule never acts as a generic network wildcard.
 */
export type EgressPurpose =
  | 'provider_inference'
  | 'pricing_refresh'
  | 'baseline_refresh'
  | 'alert_delivery'
  | 'provider_cost_observation'
  | 'team_rollup'
  | 'hosted_judge'
  | 'local_judge'
  | 'local_healthcheck';

export type EgressDataClass =
  | 'provider_request'
  | 'pricing_manifest'
  | 'baseline_manifest'
  | 'alert_metadata'
  | 'provider_cost_aggregate'
  | 'team_rollup'
  | 'judge_structural_summary'
  | 'judge_transcript_excerpt'
  | 'healthcheck';

export interface EgressRule {
  id: string;
  enabled: boolean;
  purpose: EgressPurpose;
  dataClass: EgressDataClass;
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'HEAD';
  /** Exact HTTPS origin only: no credential, query, fragment, or wildcard. */
  origin: string;
  /** Absolute leading path prefix only; query matching is never delegated to a rule. */
  pathPrefix: string;
}

export interface EgressConfig {
  /** Local mode refuses every non-loopback Fiscus HTTP(S) target before DNS. */
  mode: 'local_locked' | 'controlled_cloud';
  rules: EgressRule[];
}

export interface FiscusConfig {
  port: number;
  dashboardPort: number;
  upstreams: {
    anthropic: string;
    openai: string;
  };
  /**
   * When true, a request may override the OpenAI-compatible upstream per call via
   * the `x-fiscus-openai-base` header (to meter OpenRouter / Ollama / DeepSeek / a
   * local server from one proxy). OFF by default: that header forwards your
   * provider auth to the named URL, so honoring an attacker-influenced header
   * could exfiltrate the key. For the common case just set `upstreams.openai` to
   * your compatible base — no flag, no per-request risk.
   */
  allowOpenAIBaseOverride: boolean;
  /**
   * Milliseconds to wait for the upstream to START responding (connection +
   * first byte / headers) before failing transparently with a 504. The timer is
   * cleared once headers arrive, so a long streaming BODY is never cut — only a
   * genuinely hung or unreachable provider trips it.
   */
  upstreamTimeoutMs: number;
  budget: BudgetConfig;
  alerts: AlertsConfig;
  lift: LiftConfig;
  judge: JudgeConfig;
  pricing: PricingConfig;
  perUser: PerUserConfig;
  egress: EgressConfig;
  /** Prune request rows older than this many days during maintenance. */
  retentionDays: number;
  /**
   * When true, the proxy stores ONLY token/cost metadata and skips capturing
   * proposed-edit content. That turns OFF First-Pass Acceptance (the proposal⇄commit
   * diff needs the AI's proposed lines stored locally). Default false so the signal
   * works out of the box. This only controls what is persisted in the local DB;
   * provider traffic still follows the configured egress boundary.
   */
  metadataOnly: boolean;
  /**
   * Prune PROPOSAL rows (the AI's literal proposed code, stored locally to correlate
   * against a later git commit) older than this many days. Deliberately much shorter
   * than `retentionDays`: proposals only need to survive the correlation window
   * (`windowDays`, default 14) plus a safety margin, unlike request/cost history which
   * has standing value for longer. This is the privacy-facing retention control —
   * `fiscus prune` and the dashboard "clear stored proposals now" button both use it.
   */
  proposalRetentionDays: number;
}

export const DEFAULT_CONFIG: FiscusConfig = {
  port: 8090,
  dashboardPort: 8091,
  upstreams: {
    anthropic: 'https://api.anthropic.com',
    openai: 'https://api.openai.com',
  },
  allowOpenAIBaseOverride: false,
  upstreamTimeoutMs: 120_000,
  budget: {
    dailyUsd: null,
    dailySoftUsd: null,
    sessionUsd: null,
    runawayWindowSec: 60,
    runawayMaxUsd: null,
    capIncludesImported: false,
  },
  alerts: {
    webhookUrl: null,
    minSeverity: 'warn',
  },
  lift: {
    // Rough industry baselines (manual minutes per task-type) — illustrative
    // defaults that make Lift work out of the box; tune them to your team via
    // `fiscus config`. The measured denominator (time with AI) keeps Lift
    // honest regardless of these.
    baselineMinutes: { feature: 240, fix: 90, refactor: 120, test: 60, docs: 45, perf: 120, chore: 30, other: 90 },
    laborRatePerHour: null,
    outcomeBaselineMinutes: {},
  },
  judge: {
    // Every judge tier above the always-on algorithmic default is OFF until the
    // user takes an explicit action — no field here defaults to anything that
    // sends data anywhere. See docs/LIFT-AI-SIDE-JUDGE-DESIGN.md §4.
    localBaseUrl: null,
    localModel: null,
    localSendFullContent: false,
    hostedEnabled: false,
    hostedBaseUrl: null,
    hostedModel: null,
    hostedSendFullContent: false,
  },
  pricing: {
    // null = the default community feed (LiteLLM's price file — maintained by
    // hundreds of contributors, updated with every model release). A previous
    // placeholder here pointed at a repo that 404'd; null is the self-maintaining
    // choice and still overridable for orgs that pin their own manifest.
    manifestUrl: null,
    maxAgeDays: 30,
    autoRefresh: false,
  },
  perUser: {
    enabled: false,
    minCohort: 5,
  },
  // Strong default: local operation works immediately, while any cloud route
  // needs a deliberate, inspectable exact rule created through `fiscus egress`.
  egress: {
    mode: 'local_locked',
    rules: [],
  },
  retentionDays: 180,
  metadataOnly: false,
  proposalRetentionDays: 30,
};

/**
 * The environment overrides. `FISCUS_*` is the only family the product reads.
 *
 * A second family briefly existed, carried over from the name this project used
 * before it was Fiscus, and was honoured as a fallback. It is gone — not
 * deprecated, not read, not warned about. Two spellings for one setting is a
 * precedence rule, and a precedence rule is a thing to get wrong: this one was,
 * for exactly one commit, during which an ambient `FISCUS_HOME` silently
 * outranked the older name that every test used to isolate itself, and the
 * suite began writing into whatever real home the developer had exported.
 *
 * An EMPTY value counts as unset. `FISCUS_HOME=` in a shell sets the variable
 * to the empty string, and `??` would happily accept it — resolving the home to
 * a relative path and writing the operator's ledger into whatever directory
 * they happened to be standing in.
 */
export const ENV_OVERRIDES = ['HOME', 'DB', 'DEMO'] as const;

function envOverride(name: (typeof ENV_OVERRIDES)[number]): string | undefined {
  const value = process.env[`FISCUS_${name}`];
  return typeof value === 'string' && value.trim() !== '' ? value : undefined;
}

/**
 * The override's name, for code that must SET one rather than read it — the
 * `demo` switch in `cli.ts` above all. Keeping the spelling in one place means
 * a caller cannot write a variable this module does not read.
 */
export function envOverrideKey(name: (typeof ENV_OVERRIDES)[number]): string {
  return `FISCUS_${name}`;
}

export function fiscusHome(): string {
  return envOverride('HOME') ?? join(homedir(), '.fiscus');
}

export function configPath(): string {
  return join(fiscusHome(), 'config.json');
}

export function dbPath(): string {
  return envOverride('DB') ?? join(fiscusHome(), 'fiscus.db');
}

/** Isolated database for `fiscus demo` — never mixed with real metering. */
export function demoDbPath(): string {
  return join(fiscusHome(), 'demo.db');
}

/** True when the process is running against demo data (set by the `demo` command / `--demo`). */
export function isDemo(): boolean {
  return envOverride('DEMO') === '1';
}

/** Remove the demo database (and its WAL/SHM sidecars) for a clean re-seed. */
export function unlinkDemoDb(): void {
  for (const suffix of ['', '-wal', '-shm']) {
    const p = demoDbPath() + suffix;
    if (existsSync(p)) rmSync(p);
  }
}

/**
 * Representative caps so the demo visibly exercises governance (budget, soft,
 * session, runaway). Applied only in demo mode, only where the user hasn't set
 * their own value, and NEVER written to disk.
 */
function withDemoDefaults(cfg: FiscusConfig): FiscusConfig {
  const budget = { ...cfg.budget };
  if (budget.dailyUsd === null) budget.dailyUsd = 30;
  if (budget.dailySoftUsd === null) budget.dailySoftUsd = 20;
  if (budget.sessionUsd === null) budget.sessionUsd = 8;
  if (budget.runawayMaxUsd === null) budget.runawayMaxUsd = 5;
  // Per-user VALUE is opt-in and off in real deployments; the demo enables it so
  // the feature is visible. The demo roster is synthetic, so there's no privacy
  // cost, and this is never persisted.
  const perUser = { ...cfg.perUser, enabled: true };
  // The demo discloses a labor rate + outcome baselines so every value surface
  // (and the guide's journey) tells the fully-priced story. Never persisted;
  // real deployments keep the honest "un-priced until disclosed" default.
  const lift = { ...cfg.lift };
  if (lift.laborRatePerHour === null) lift.laborRatePerHour = 120;
  if (Object.keys(lift.outcomeBaselineMinutes).length === 0) {
    lift.outcomeBaselineMinutes = { used: 10, resolved: 30, published: 90 };
  }
  return { ...cfg, budget, perUser, lift };
}

export function ensureHome(): string {
  const home = fiscusHome();
  if (!existsSync(home)) mkdirSync(home, { recursive: true });
  return home;
}

function deepMerge<T>(base: T, override: Partial<T>): T {
  const out = { ...base } as Record<string, unknown>;
  for (const [k, v] of Object.entries(override ?? {})) {
    if (k === '__proto__' || k === 'constructor' || k === 'prototype') continue;
    if (v && typeof v === 'object' && !Array.isArray(v) && typeof out[k] === 'object') {
      out[k] = deepMerge(out[k] as Record<string, unknown>, v as Record<string, unknown>);
    } else if (v !== undefined) {
      out[k] = v;
    }
  }
  return out as T;
}

const VALID_EGRESS_PURPOSES: readonly EgressPurpose[] = [
  'provider_inference', 'pricing_refresh', 'baseline_refresh', 'alert_delivery',
  'provider_cost_observation', 'team_rollup', 'hosted_judge', 'local_judge', 'local_healthcheck',
];

const VALID_EGRESS_DATA_CLASSES: readonly EgressDataClass[] = [
  'provider_request', 'pricing_manifest', 'baseline_manifest', 'alert_metadata',
  'provider_cost_aggregate', 'team_rollup', 'judge_structural_summary',
  'judge_transcript_excerpt', 'healthcheck',
];

const VALID_EGRESS_METHODS: readonly EgressRule['method'][] = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD'];

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function validEgressRule(value: unknown): value is EgressRule {
  if (!isRecord(value)) return false;
  return typeof value.id === 'string'
    && typeof value.enabled === 'boolean'
    && VALID_EGRESS_PURPOSES.includes(value.purpose as EgressPurpose)
    && VALID_EGRESS_DATA_CLASSES.includes(value.dataClass as EgressDataClass)
    && VALID_EGRESS_METHODS.includes(value.method as EgressRule['method'])
    && typeof value.origin === 'string'
    && typeof value.pathPrefix === 'string';
}

/**
 * JSON configuration is an untrusted boundary. Deep merge is useful for the
 * broad config surface, but it cannot decide whether an egress object is
 * authorization data. An absent or ambiguous egress object therefore returns
 * the local-locked default; a controlled-cloud object must have an exact mode,
 * an array of exact rule shapes, and boolean enabled flags.
 */
function sanitizeEgressConfig(value: unknown): EgressConfig {
  if (!isRecord(value)) return { mode: 'local_locked', rules: [] };
  if (value.mode !== 'local_locked' && value.mode !== 'controlled_cloud') {
    return { mode: 'local_locked', rules: [] };
  }
  if (!Array.isArray(value.rules) || !value.rules.every(validEgressRule)) {
    return { mode: 'local_locked', rules: [] };
  }
  return {
    mode: value.mode,
    rules: value.rules.map((rule) => ({ ...rule })),
  };
}

export function loadConfig(): FiscusConfig {
  const path = configPath();
  let cfg: FiscusConfig;
  if (!existsSync(path)) {
    cfg = { ...DEFAULT_CONFIG };
  } else {
    try {
      const raw = JSON.parse(readFileSync(path, 'utf8')) as unknown;
      cfg = deepMerge(DEFAULT_CONFIG, isRecord(raw) ? raw as Partial<FiscusConfig> : {});
      cfg = { ...cfg, egress: sanitizeEgressConfig(isRecord(raw) ? raw.egress : undefined) };
    } catch {
      // A corrupt config should never take the daemon down. Fall back to defaults.
      cfg = { ...DEFAULT_CONFIG };
    }
  }
  return isDemo() ? withDemoDefaults(cfg) : cfg;
}

export function saveConfig(config: FiscusConfig): void {
  ensureHome();
  writeFileSync(configPath(), JSON.stringify(config, null, 2) + '\n', 'utf8');
}
