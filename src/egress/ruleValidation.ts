import type { EgressDataClass, EgressPurpose, EgressRule } from '../config.ts';

export const EGRESS_PURPOSES = [
  'provider_inference', 'pricing_refresh', 'baseline_refresh', 'alert_delivery',
  'provider_cost_observation', 'team_rollup', 'hosted_judge', 'local_judge', 'local_healthcheck',
] as const satisfies readonly EgressPurpose[];

export const EGRESS_DATA_CLASSES = [
  'provider_request', 'pricing_manifest', 'baseline_manifest', 'alert_metadata',
  'provider_cost_aggregate', 'team_rollup', 'judge_structural_summary',
  'judge_transcript_excerpt', 'healthcheck',
] as const satisfies readonly EgressDataClass[];

const EGRESS_RULE_KEYS = [
  'id', 'enabled', 'purpose', 'dataClass', 'method', 'origin', 'pathPrefix',
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function canonicalOrigin(value: string): string | null {
  try {
    const parsed = new URL(value);
    if (parsed.username || parsed.password || parsed.protocol !== 'https:') return null;
    if (parsed.pathname !== '/' || parsed.search || parsed.hash) return null;
    return parsed.origin;
  } catch {
    return null;
  }
}

/**
 * Produce the only path representation used for egress authorization.
 * Percent-encoded RFC 3986 unreserved characters receive one canonical decode.
 * The result may contain only '/' plus unreserved characters; every reserved,
 * sub-delimiter, malformed escape, or remaining percent sign is refused so a
 * heterogeneous downstream parser cannot reinterpret the authorized path more
 * broadly. Query and fragment data are absent: callers pass URL.pathname.
 */
export function canonicalAuthorizationPath(value: string): string | null {
  if (!value.startsWith('/') || value.length === 0) return null;
  if (value.includes('?') || value.includes('#') || value.includes('\\')) return null;
  if (/[\u0000-\u001f\u007f]/.test(value)) return null;
  for (let index = 0; index < value.length; index++) {
    if (value[index] !== '%') continue;
    const octet = value.slice(index + 1, index + 3);
    if (!/^[0-9a-f]{2}$/i.test(octet)) return null;
    const decodedOctet = String.fromCharCode(parseInt(octet, 16));
    if (!/^[A-Za-z0-9._~-]$/.test(decodedOctet)) return null;
    index += 2;
  }
  let decoded: string;
  try {
    decoded = decodeURIComponent(value);
  } catch {
    return null;
  }
  if (!decoded.startsWith('/') || decoded.includes('%')) return null;
  if (!/^\/[A-Za-z0-9._~\/-]*$/.test(decoded)) return null;
  if (decoded.includes('?') || decoded.includes('#') || decoded.includes('\\')) return null;
  if (/[\u0000-\u001f\u007f]/.test(decoded)) return null;
  if (decoded.split('/').some((segment) => segment === '.' || segment === '..')) return null;
  if (decoded !== '/' && decoded.includes('//')) return null;
  return decoded;
}

/**
 * Return the canonical authorization form of a rule path. A trailing slash is
 * only a spelling choice for a non-root prefix; root remains exactly '/'.
 */
export function normalizePathPrefix(value: string): string | null {
  const canonical = canonicalAuthorizationPath(value);
  if (canonical === null) return null;
  if (canonical === '/') return '/';
  const normalized = canonical.endsWith('/') ? canonical.slice(0, -1) : canonical;
  return normalized.length > 0 && normalized !== '/' ? normalized : null;
}

function exactRuleKeys(value: Record<string, unknown>): boolean {
  const keys = Object.keys(value).sort();
  return keys.length === EGRESS_RULE_KEYS.length
    && keys.every((key, index) => key === [...EGRESS_RULE_KEYS].sort()[index]);
}

/**
 * Shared semantic validator for both CLI-authored and JSON-loaded rules.
 * Loading must not accept a shape that the operator-facing validator would
 * refuse, because that would create a second authorization language.
 */
export function validateEgressRule(value: unknown): string[] {
  if (!isRecord(value)) return ['rule must be an object'];
  const failures: string[] = [];
  if (!exactRuleKeys(value)) failures.push('rule fields must be exact; unexpected or missing fields are refused');
  if (typeof value.id !== 'string' || !/^[a-z][a-z0-9_-]{2,63}$/.test(value.id)) {
    failures.push('id must be 3-64 lowercase letters, digits, _ or -');
  }
  if (typeof value.enabled !== 'boolean') failures.push('enabled must be a boolean');
  if (!EGRESS_PURPOSES.includes(value.purpose as EgressPurpose)) failures.push('purpose is not a supported Fiscus purpose');
  if (!EGRESS_DATA_CLASSES.includes(value.dataClass as EgressDataClass)) failures.push('dataClass is not a supported Fiscus data class');
  if (typeof value.method !== 'string' || !/^(GET|POST|PUT|PATCH|DELETE|HEAD)$/.test(value.method)) {
    failures.push('method must be exact uppercase HTTP');
  }
  if (typeof value.origin !== 'string' || canonicalOrigin(value.origin) !== value.origin) {
    failures.push('origin must be canonical HTTPS origin without path, query, fragment, or credentials');
  }
  if (typeof value.pathPrefix !== 'string' || normalizePathPrefix(value.pathPrefix) === null) {
    failures.push('pathPrefix must have one stable absolute authorization form without delimiters, controls, or traversal');
  }
  return failures;
}

export function isValidEgressRule(value: unknown): value is EgressRule {
  return validateEgressRule(value).length === 0;
}
