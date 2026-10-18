/**
 * Pure, exact policy for Segreant-process HTTP(S) egress. Socket creation lives
 * only in transport.ts, so a feature cannot silently make its own network path.
 */
import { createHash } from 'node:crypto';
import type { EgressConfig, EgressDataClass, EgressPurpose, EgressRule } from '../config.ts';
import {
  EGRESS_DATA_CLASSES,
  EGRESS_PURPOSES,
  canonicalAuthorizationPath,
  canonicalOrigin,
  normalizePathPrefix,
  validateEgressRule,
} from './ruleValidation.ts';

export { EGRESS_DATA_CLASSES, EGRESS_PURPOSES, validateEgressRule };

export type EgressTargetClass = 'loopback' | 'controlled_cloud';

export interface EgressRequestIntent {
  purpose: EgressPurpose;
  dataClass: EgressDataClass;
  method: string;
  url: string | URL;
}

export interface EgressPolicyDecision {
  allowed: boolean;
  target?: URL;
  targetClass?: EgressTargetClass;
  ruleId?: string;
  reason: string;
}

/**
 * Segreant's own self-maintenance downloads: fixed public files, fetched with a
 * plain GET that carries nothing about the user. With the providers' official
 * APIs (below), they are the built-in exceptions to
 * local_locked, because a rate card that can never update prices every new
 * model by a guess (claude-haiku-5-5 at $3/$15 against a $0.10/$0.50 list
 * price). The match is exact: purpose, data class, GET, and the full URL with no
 * query or fragment, so no caller can reach any other address through it. The
 * DNS answer must still be public and every attempt is in the receipt chain.
 * Like the providers' official APIs it holds in every mode, controlled_cloud
 * included (PR #148). `segreant pricing --auto off` stops Segreant
 * asking on its own; a manual `segreant pricing --refresh` is the user asking.
 */
export const DEFAULT_PRICE_LIST_URL =
  'https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json';

export const MAINTENANCE_RULE_ID = 'segreant-builtin-price-list';

const MAINTENANCE_TARGETS: ReadonlyArray<{ purpose: EgressPurpose; dataClass: EgressDataClass; href: string }> = [
  { purpose: 'pricing_refresh', dataClass: 'pricing_manifest', href: DEFAULT_PRICE_LIST_URL },
];

function maintenanceTarget(target: URL, intent: EgressRequestIntent, method: string): boolean {
  if (method !== 'GET' || target.protocol !== 'https:' || target.search !== '' || target.hash !== '') return false;
  return MAINTENANCE_TARGETS.some((m) => m.purpose === intent.purpose && m.dataClass === intent.dataClass && m.href === target.href);
}

/**
 * The providers' own APIs. A request the user's tool sends to its provider is
 * the user's traffic, already going there before Segreant existed; Segreant only
 * meters it on the way through. Locking it by default made a fresh install
 * refuse every request with a 403 until two egress commands were run, which
 * protected nothing (the owner's call, 2026-10-18). What stays locked is
 * everything that would send Segreant's own data somewhere new: webhooks, team
 * rollups, hosted judging. The match is exact: provider purpose and data class,
 * GET or POST, HTTPS, the official origin, under /v1/. A custom upstream (a
 * gateway, a self-hosted model) is the user's to allow with its own rule.
 */
export const PROVIDER_RULE_ID_PREFIX = 'segreant-builtin-provider-';

const PROVIDER_TARGETS: ReadonlyArray<{ id: string; origin: string; pathPrefix: string }> = [
  { id: 'anthropic', origin: 'https://api.anthropic.com', pathPrefix: '/v1/' },
  { id: 'openai', origin: 'https://api.openai.com', pathPrefix: '/v1/' },
];

function providerTarget(target: URL, intent: EgressRequestIntent, method: string): string | null {
  if (intent.purpose !== 'provider_inference' || intent.dataClass !== 'provider_request') return null;
  if ((method !== 'POST' && method !== 'GET') || target.protocol !== 'https:') return null;
  const match = PROVIDER_TARGETS.find((p) => p.origin === target.origin && pathMatchesPrefix(target.pathname, p.pathPrefix));
  return match ? PROVIDER_RULE_ID_PREFIX + match.id : null;
}

/** Whether requests to this upstream go out with no rule: it is one of the providers' official APIs. */
export function isBuiltInProviderUpstream(url: string): boolean {
  try {
    const target = new URL(url);
    return PROVIDER_TARGETS.some((p) => p.origin === target.origin);
  } catch {
    return false;
  }
}

/**
 * A rule id the egress command accepts (a lowercase letter, then 2-63 of
 * a-z, 0-9, _ or -). The hostname alone was printed before, and its dots made
 * the printed command fail with "Rule refused" (PR #148 review).
 */
export function providerRuleId(origin: string, method = 'POST'): string {
  // Rules are replaced by id, so the id must be unique per origin and method:
  // the method keeps a GET and a POST rule for one host apart, and a short hash
  // of the full canonical origin (scheme, host and port) keeps apart hosts whose
  // slugs collide (api.foo-bar.com / api.foo.bar.com), share a truncated
  // prefix, or differ only by port (PR #148 review). The slug is the hostname,
  // for a readable id.
  let canonical: URL;
  try { canonical = new URL(origin.includes('://') ? origin : `https://${origin}`); } catch { canonical = new URL('https://invalid.invalid'); }
  const host = canonical.hostname.toLowerCase();
  const verb = method.toLowerCase().replace(/[^a-z]/g, '');
  const tag = createHash('sha256').update(canonical.origin).digest('hex').slice(0, 8);
  const slug = host.replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  const head = `provider-${slug}`.slice(0, 64 - tag.length - verb.length - 2).replace(/-+$/, '');
  return `${head}-${tag}-${verb}`;
}

const RULE_METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD']);

/** The one command that lets Segreant forward to an upstream that is not built in (a gateway, a hosted model). */
export function providerRuleCommand(url: string, method = 'POST'): string | null {
  let origin: URL;
  try { origin = new URL(new URL(url).origin); } catch { return null; }
  if (origin.protocol !== 'https:') return null;
  // Only methods a rule can name: printing `--method OPTIONS` would hand the
  // user a command the rule validator refuses (PR #148 review).
  if (!RULE_METHODS.has(method.toUpperCase())) return null;
  return `segreant egress apply --apply --mode controlled_cloud --id ${providerRuleId(origin.origin, method)} --purpose provider_inference --data-class provider_request --method ${method.toUpperCase()} --origin ${origin.origin} --path-prefix /`;
}

/** Built-in routes, the same in every mode: an operator who adds a webhook rule keeps their provider and their price list. */
function builtInRoute(target: URL, intent: EgressRequestIntent, method: string): EgressPolicyDecision | null {
  if (maintenanceTarget(target, intent, method)) {
    // Same transport checks as a cloud rule: the address must resolve public.
    return { allowed: true, target, targetClass: 'controlled_cloud', ruleId: MAINTENANCE_RULE_ID, reason: "Segreant's built-in public price list (GET only)" };
  }
  const provider = providerTarget(target, intent, method);
  if (provider) {
    return { allowed: true, target, targetClass: 'controlled_cloud', ruleId: provider, reason: "your request to the provider's official API (built in)" };
  }
  return null;
}

function literalLoopback(hostname: string): boolean {
  const host = hostname.replace(/(^\[|\]$)/g, '').toLowerCase();
  return host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '::ffff:127.0.0.1';
}

function normalMethod(value: string): string {
  return value.trim().toUpperCase();
}

function pathMatchesPrefix(pathname: string, pathPrefix: string): boolean {
  const canonicalPath = canonicalAuthorizationPath(pathname);
  const normalized = normalizePathPrefix(pathPrefix);
  if (canonicalPath === null || normalized === null) return false;
  if (normalized === '/') return canonicalPath.startsWith('/');
  return canonicalPath === normalized || canonicalPath.startsWith(normalized + '/');
}

function matches(rule: EgressRule, target: URL, intent: EgressRequestIntent): boolean {
  return validateEgressRule(rule).length === 0
    && rule.enabled === true
    && rule.purpose === intent.purpose
    && rule.dataClass === intent.dataClass
    && rule.method === normalMethod(intent.method)
    && canonicalOrigin(rule.origin) === target.origin
    && pathMatchesPrefix(target.pathname, rule.pathPrefix);
}

/**
 * Decides before DNS. Local locked mode permits literal loopback and the exact
 * built-in routes (price list, official provider APIs) only, so it
 * never resolves a potential cloud host before rejecting it.
 */
export function evaluateEgressPolicy(config: EgressConfig, intent: EgressRequestIntent): EgressPolicyDecision {
  let target: URL;
  try {
    target = new URL(intent.url);
  } catch {
    return { allowed: false, reason: 'target is not an absolute URL' };
  }
  if (target.username || target.password) return { allowed: false, reason: 'target URL credentials are forbidden' };
  if (target.protocol !== 'http:' && target.protocol !== 'https:') return { allowed: false, reason: 'only HTTP(S) transport is supported' };
  const method = normalMethod(intent.method);
  if (!/^(GET|POST|PUT|PATCH|DELETE|HEAD)$/.test(method)) return { allowed: false, target, reason: 'method is not supported' };
  if (literalLoopback(target.hostname)) return { allowed: true, target, targetClass: 'loopback', reason: 'literal loopback target is permitted' };
  // A malformed persisted section (mode `invalid`) or any unknown shape refuses
  // before the built-in routes: a typo never lets provider traffic through.
  if (config.mode !== 'local_locked' && (config.mode !== 'controlled_cloud' || !Array.isArray(config.rules))) {
    return { allowed: false, target, reason: 'unknown or malformed egress mode/config is fail-closed; only local_locked or controlled_cloud is supported' };
  }
  const builtIn = builtInRoute(target, intent, method);
  if (builtIn) return builtIn;
  if (config.mode === 'local_locked') {
    return { allowed: false, target, reason: "local_locked permits only literal loopback, the built-in public price list and the providers' official APIs; no other DNS lookup or dial occurs" };
  }
  if (target.protocol !== 'https:') return { allowed: false, target, reason: 'controlled_cloud refuses plaintext HTTP outside literal loopback' };
  const matching = config.rules.filter((rule) => matches(rule, target, { ...intent, method }));
  if (matching.length !== 1) {
    return {
      allowed: false,
      target,
      reason: matching.length === 0
        ? 'no exact enabled rule matches purpose, data class, method, origin, and path'
        : 'more than one enabled rule matches; controlled-cloud rules must be unambiguous',
    };
  }
  return { allowed: true, target, targetClass: 'controlled_cloud', ruleId: matching[0]!.id, reason: 'one exact rule matches' };
}
