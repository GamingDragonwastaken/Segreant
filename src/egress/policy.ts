/**
 * Pure, exact policy for Fiscus-process HTTP(S) egress. Socket creation lives
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
    return { allowed: false, target, reason: 'local_locked permits only literal loopback; no non-loopback DNS lookup or dial occurs' };
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
