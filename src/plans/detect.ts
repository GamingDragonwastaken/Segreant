/**
 * Which plan each tool runs on, read from the tool's own local files.
 *
 * Subscription usage is the main reason a Segreant number is a list-price
 * estimate rather than a bill: a $20 plan can do hundreds of dollars of
 * list-price work. Saying which plan a source is on lets every surface name
 * both bases side by side ("your $20 plan did $X of list-price work").
 *
 * The plan is detected; the PRICE is never assumed. What a person pays depends
 * on the channel (an App Store subscription costs more than the web one), tax,
 * annual billing and discounts, so the price comes only from the person
 * (`segreant plan set`). The public prices below are offered as a suggestion
 * when asking, with their date, and never used as a figure.
 *
 * Reads only plan fields. Claude Code's plan comes from `~/.claude.json`
 * (`oauthAccount`), never from the credentials file, which holds tokens.
 */
import { closeSync, existsSync, openSync, readFileSync, readSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export type PlanSource = 'claude-code' | 'codex';

export interface DetectedPlan {
  source: PlanSource;
  /** The tool's own name for the plan ('pro', 'max', 'plus', 'team', …), or null when not found. */
  plan: string | null;
  /** A finer tier when the tool states one (Claude Max: '5x' or '20x'). */
  tier: string | null;
  /** How it is paid when the tool says (Claude: 'stripe_subscription', 'apple_subscription', …). */
  billing: string | null;
  /** Where the answer came from, for the user to check. */
  evidence: string;
}

/** Public monthly prices, as a suggestion when asking only. Checked 2026-10-08. */
export const PUBLIC_PLAN_PRICES: Readonly<Record<string, number>> = {
  'claude-code:pro': 20,
  'claude-code:max:5x': 100,
  'claude-code:max:20x': 200,
  'codex:plus': 20,
  'codex:pro': 200,
};
export const PUBLIC_PLAN_PRICES_CHECKED = '2026-10-08';

export const PLAN_LABELS: Readonly<Record<PlanSource, string>> = {
  'claude-code': 'Claude',
  codex: 'ChatGPT',
};

export function suggestedPrice(p: DetectedPlan): number | null {
  if (p.plan === null) return null;
  return PUBLIC_PLAN_PRICES[`${p.source}:${p.plan}${p.tier ? `:${p.tier}` : ''}`]
    ?? PUBLIC_PLAN_PRICES[`${p.source}:${p.plan}`]
    ?? null;
}

/** "Claude Max 20x", "ChatGPT Plus", or null when the plan is unknown. */
export function planName(p: DetectedPlan): string | null {
  if (p.plan === null) return null;
  const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
  return `${PLAN_LABELS[p.source]} ${cap(p.plan)}${p.tier ? ` ${p.tier}` : ''}`;
}

export function detectClaudePlan(home: string = homedir()): DetectedPlan {
  const path = join(home, '.claude.json');
  const none = (evidence: string): DetectedPlan => ({ source: 'claude-code', plan: null, tier: null, billing: null, evidence });
  if (!existsSync(path)) return none('no ~/.claude.json');
  let account: Record<string, unknown>;
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as { oauthAccount?: unknown };
    if (parsed.oauthAccount === null || typeof parsed.oauthAccount !== 'object') return none('~/.claude.json has no signed-in account (an API key, or signed out)');
    account = parsed.oauthAccount as Record<string, unknown>;
  } catch {
    return none('~/.claude.json could not be read');
  }
  const str = (k: string): string | null => (typeof account[k] === 'string' && account[k] !== '' ? account[k] as string : null);
  const orgType = str('organizationType');
  const plan = orgType === null ? null : orgType.replace(/^claude_/, '');
  // Max states its usage multiple in the rate-limit tier ("default_claude_max_20x").
  const tierSource = str('userRateLimitTier') ?? str('organizationRateLimitTier') ?? '';
  const tier = plan === 'max' ? (/(\d+x)\b/.exec(tierSource)?.[1] ?? null) : null;
  return {
    source: 'claude-code',
    plan,
    tier,
    billing: str('billingType'),
    evidence: orgType === null ? '~/.claude.json: no organizationType' : `~/.claude.json: organizationType ${orgType}`,
  };
}

const PLAN_TYPE = /"plan_type":"([a-z_]+)"/g;

/** The plan named in the newest Codex session log (its rate-limit events carry plan_type). */
export function detectCodexPlan(root: string = join(homedir(), '.codex', 'sessions')): DetectedPlan {
  const none = (evidence: string): DetectedPlan => ({ source: 'codex', plan: null, tier: null, billing: null, evidence });
  const newest = newestJsonl(root);
  if (newest === null) return none('no Codex session logs');
  const tail = readTail(newest, 512 * 1024);
  let plan: string | null = null;
  for (const m of tail.matchAll(PLAN_TYPE)) plan = m[1]!;
  if (plan === null) return none('the newest Codex session log names no plan');
  return { source: 'codex', plan, tier: null, billing: null, evidence: 'newest Codex session log: plan_type ' + plan };
}

export function detectPlans(): DetectedPlan[] {
  return [detectClaudePlan(), detectCodexPlan()];
}

/** Newest *.jsonl under a sessions/YYYY/MM/DD tree, walking newest directories first. */
function newestJsonl(root: string): string | null {
  const dirsDesc = (dir: string): string[] => {
    try {
      return readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort().reverse();
    } catch {
      return [];
    }
  };
  const walk = (dir: string, depth: number): string | null => {
    if (depth === 0) {
      let best: { path: string; mtime: number } | null = null;
      let names: string[] = [];
      try { names = readdirSync(dir).filter((n) => n.endsWith('.jsonl')); } catch { return null; }
      for (const n of names) {
        const p = join(dir, n);
        try {
          const m = statSync(p).mtimeMs;
          if (best === null || m > best.mtime) best = { path: p, mtime: m };
        } catch { /* gone */ }
      }
      return best?.path ?? null;
    }
    for (const d of dirsDesc(dir)) {
      const hit = walk(join(dir, d), depth - 1);
      if (hit !== null) return hit;
    }
    return null;
  };
  return walk(root, 3);
}

function readTail(path: string, bytes: number): string {
  const fd = openSync(path, 'r');
  try {
    const size = statSync(path).size;
    const len = Math.min(size, bytes);
    const buf = Buffer.alloc(len);
    readSync(fd, buf, 0, len, size - len);
    return buf.toString('utf8');
  } finally {
    closeSync(fd);
  }
}
