/**
 * Pure, exact policy for Segreant-process HTTP(S) egress. Socket creation lives
 * only in transport.ts, so a feature cannot silently make its own network path.
 */
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
 * plain GET that carries nothing about the user. They are the one exception to
 * local_locked, because a rate card that can never update prices every new
 * model by a guess (claude-haiku-5-5 at $3/$15 against a $0.10/$0.50 list
 * price). The match is exact: purpose, data class, GET, and the full URL with no
 * query or fragment, so no caller can reach any other address through it. The
 * DNS answer must still be public, every attempt is in the receipt chain, and
 * controlled_cloud still needs its own exact rule (an operator who enumerates
 * every route keeps that power). `segreant pricing --auto off` stops Segreant
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
 * Decides before DNS. Local locked mode permits only literal loopback, so it
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
  if (config.mode === 'local_locked') {
    if (maintenanceTarget(target, intent, method)) {
      // Same transport checks as a cloud rule: the address must resolve public.
      return { allowed: true, target, targetClass: 'controlled_cloud', ruleId: MAINTENANCE_RULE_ID, reason: "Segreant's built-in public price list (GET only)" };
    }
    return { allowed: false, target, reason: 'local_locked permits only literal loopback and the built-in public price list; no other DNS lookup or dial occurs' };
  }
  if (config.mode !== 'controlled_cloud' || !Array.isArray(config.rules)) {
    return { allowed: false, target, reason: 'unknown or malformed egress mode/config is fail-closed; only local_locked or controlled_cloud is supported' };
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
