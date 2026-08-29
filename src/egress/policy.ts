/**
 * Pure, exact policy for Fiscus-process HTTP(S) egress. Socket creation lives
 * only in transport.ts, so a feature cannot silently make its own network path.
 */
import type { EgressConfig, EgressDataClass, EgressPurpose, EgressRule } from '../config.ts';

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

export const EGRESS_PURPOSES = [
  'provider_inference', 'pricing_refresh', 'baseline_refresh', 'alert_delivery',
  'provider_cost_observation', 'team_rollup', 'hosted_judge', 'local_judge', 'local_healthcheck',
] as const satisfies readonly EgressPurpose[];

export const EGRESS_DATA_CLASSES = [
  'provider_request', 'pricing_manifest', 'baseline_manifest', 'alert_metadata',
  'provider_cost_aggregate', 'team_rollup', 'judge_structural_summary',
  'judge_transcript_excerpt', 'healthcheck',
] as const satisfies readonly EgressDataClass[];

function canonicalOrigin(value: string): string | null {
  try {
    const parsed = new URL(value);
    if (parsed.username || parsed.password || parsed.protocol !== 'https:') return null;
    if (parsed.pathname !== '/' || parsed.search || parsed.hash) return null;
    return parsed.origin;
  } catch {
    return null;
  }
}

function safePathPrefix(value: string): boolean {
  return value.startsWith('/')
    && !value.includes('?')
    && !value.includes('#')
    && !/(^|\/)\.\.?(?:\/|$)/.test(value);
}

export function validateEgressRule(rule: EgressRule): string[] {
  const failures: string[] = [];
  if (!/^[a-z][a-z0-9_-]{2,63}$/.test(rule.id)) failures.push('id must be 3-64 lowercase letters, digits, _ or -');
  if (!EGRESS_PURPOSES.includes(rule.purpose)) failures.push('purpose is not a supported Fiscus purpose');
  if (!EGRESS_DATA_CLASSES.includes(rule.dataClass)) failures.push('dataClass is not a supported Fiscus data class');
  if (!/^(GET|POST|PUT|PATCH|DELETE|HEAD)$/.test(rule.method)) failures.push('method must be exact uppercase HTTP');
  if (canonicalOrigin(rule.origin) === null) failures.push('origin must be exact HTTPS origin without path, query, fragment, or credentials');
  if (!safePathPrefix(rule.pathPrefix)) failures.push('pathPrefix must be absolute, query-free, and contain no dot segment');
  return failures;
}

function literalLoopback(hostname: string): boolean {
  const host = hostname.replace(/(^\[|\]$)/g, '').toLowerCase();
  return host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '::ffff:127.0.0.1';
}

function normalMethod(value: string): string {
  return value.trim().toUpperCase();
}

function matches(rule: EgressRule, target: URL, intent: EgressRequestIntent): boolean {
  return rule.enabled
    && rule.purpose === intent.purpose
    && rule.dataClass === intent.dataClass
    && rule.method === normalMethod(intent.method)
    && canonicalOrigin(rule.origin) === target.origin
    && target.pathname.startsWith(rule.pathPrefix);
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
