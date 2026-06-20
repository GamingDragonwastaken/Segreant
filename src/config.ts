/**
 * Configuration + on-disk paths.
 *
 * Everything AegisFlow persists lives under a single directory:
 *   Windows : %USERPROFILE%\.aegisflow
 *   macOS   : ~/.aegisflow
 *   Linux   : ~/.aegisflow   (XDG override honored via AEGIS_HOME)
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
}

export interface AlertsConfig {
  /**
   * Opt-in webhook for alert delivery (e.g. a Slack/Teams/PagerDuty incoming URL).
   * null = off (the default). When set, AegisFlow POSTs ONLY alert metadata —
   * id, severity, title, detail, and a short metric. Never prompts, code, or keys.
   */
  webhookUrl: string | null;
  /** Minimum severity delivered to the webhook. */
  minSeverity: 'critical' | 'warn' | 'info';
}

export interface AegisConfig {
  port: number;
  dashboardPort: number;
  upstreams: {
    anthropic: string;
    openai: string;
  };
  budget: BudgetConfig;
  alerts: AlertsConfig;
  /** Prune request rows older than this many days during maintenance. */
  retentionDays: number;
  /** When true, the proxy logs only metadata and never the prompt/response bodies. */
  metadataOnly: boolean;
}

export const DEFAULT_CONFIG: AegisConfig = {
  port: 8090,
  dashboardPort: 8091,
  upstreams: {
    anthropic: 'https://api.anthropic.com',
    openai: 'https://api.openai.com',
  },
  budget: {
    dailyUsd: null,
    dailySoftUsd: null,
    sessionUsd: null,
    runawayWindowSec: 60,
    runawayMaxUsd: null,
  },
  alerts: {
    webhookUrl: null,
    minSeverity: 'warn',
  },
  retentionDays: 180,
  metadataOnly: true,
};

export function aegisHome(): string {
  return process.env.AEGIS_HOME ?? join(homedir(), '.aegisflow');
}

export function configPath(): string {
  return join(aegisHome(), 'config.json');
}

export function dbPath(): string {
  return process.env.AEGIS_DB ?? join(aegisHome(), 'aegis.db');
}

/** Isolated database for `aegisflow demo` — never mixed with real metering. */
export function demoDbPath(): string {
  return join(aegisHome(), 'demo.db');
}

/** True when the process is running against demo data (set by the `demo` command / `--demo`). */
export function isDemo(): boolean {
  return process.env.AEGIS_DEMO === '1';
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
function withDemoDefaults(cfg: AegisConfig): AegisConfig {
  const budget = { ...cfg.budget };
  if (budget.dailyUsd === null) budget.dailyUsd = 30;
  if (budget.dailySoftUsd === null) budget.dailySoftUsd = 20;
  if (budget.sessionUsd === null) budget.sessionUsd = 8;
  if (budget.runawayMaxUsd === null) budget.runawayMaxUsd = 5;
  return { ...cfg, budget };
}

export function ensureHome(): string {
  const home = aegisHome();
  if (!existsSync(home)) mkdirSync(home, { recursive: true });
  return home;
}

function deepMerge<T>(base: T, override: Partial<T>): T {
  const out = { ...base } as Record<string, unknown>;
  for (const [k, v] of Object.entries(override ?? {})) {
    if (v && typeof v === 'object' && !Array.isArray(v) && typeof out[k] === 'object') {
      out[k] = deepMerge(out[k] as Record<string, unknown>, v as Record<string, unknown>);
    } else if (v !== undefined) {
      out[k] = v;
    }
  }
  return out as T;
}

export function loadConfig(): AegisConfig {
  const path = configPath();
  let cfg: AegisConfig;
  if (!existsSync(path)) {
    cfg = { ...DEFAULT_CONFIG };
  } else {
    try {
      const raw = JSON.parse(readFileSync(path, 'utf8')) as Partial<AegisConfig>;
      cfg = deepMerge(DEFAULT_CONFIG, raw);
    } catch {
      // A corrupt config should never take the daemon down. Fall back to defaults.
      cfg = { ...DEFAULT_CONFIG };
    }
  }
  return isDemo() ? withDemoDefaults(cfg) : cfg;
}

export function saveConfig(config: AegisConfig): void {
  ensureHome();
  writeFileSync(configPath(), JSON.stringify(config, null, 2) + '\n', 'utf8');
}
