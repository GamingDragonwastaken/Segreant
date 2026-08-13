/**
 * Local provider-route scope declarations.
 *
 * A declaration is not provider authentication or a reconciliation result. It
 * only records the operator's local statement that traffic sent to one exact,
 * configured OpenAI-compatible endpoint belongs to a named account/project.
 * The stored endpoint representation deliberately contains no credentials,
 * query string, or fragment.
 */

import { createHash, randomUUID } from 'node:crypto';

export type ScopeCaptureStatus = 'legacy_unknown' | 'unscoped' | 'declared_unverified' | 'not_observed';

export interface ProviderScopeDeclaration {
  declarationId: string;
  provider: 'openai';
  billingAccountRef: string;
  providerProjectRef: string | null;
  upstreamFingerprint: string;
  upstreamDisplay: string;
  declaredAtMs: number;
  trust: 'operator_declared_unverified';
}

export interface ActiveProviderScopeRoute {
  provider: 'openai';
  declarationId: string;
  upstreamFingerprint: string;
  activatedAtMs: number;
}

const CONTROL = /[\u0000-\u001F\u007F]/;
const MAX_REF = 200;

function safeRef(value: string, label: string, required: boolean): string | null {
  const trimmed = value.trim();
  if (!trimmed && !required) return null;
  if (!trimmed) throw new Error(`${label} is required`);
  if (trimmed.length > MAX_REF || CONTROL.test(trimmed)) throw new Error(`${label} must be a short, single-line reference`);
  return trimmed;
}

/** Canonical, credential-free identity of the configured upstream endpoint. */
export function normalizeOpenAiUpstream(upstream: string): { display: string; fingerprint: string } {
  if (typeof upstream !== 'string' || !upstream.trim() || CONTROL.test(upstream)) {
    throw new Error('configured OpenAI upstream must be a valid http(s) URL');
  }
  let url: URL;
  try {
    url = new URL(upstream.trim());
  } catch {
    throw new Error('configured OpenAI upstream must be a valid absolute http(s) URL');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('configured OpenAI upstream must use http or https');
  }
  // Credentials are never a scope identity. Reject rather than accidentally
  // normalize a secret-bearing configuration into a durable provenance row.
  if (url.username || url.password) throw new Error('configured OpenAI upstream must not contain credentials');
  url.hash = '';
  url.search = '';
  url.pathname = url.pathname.replace(/\/+$/, '') || '/';
  const display = url.toString().replace(/\/$/, '');
  const fingerprint = createHash('sha256').update(`openai\n${display}`, 'utf8').digest('hex');
  return { display, fingerprint };
}

export function newOpenAiScopeDeclaration(input: {
  billingAccountRef: string;
  providerProjectRef?: string | null;
  upstreamBase: string;
  declaredAtMs?: number;
}): ProviderScopeDeclaration {
  const normalized = normalizeOpenAiUpstream(input.upstreamBase);
  return {
    declarationId: randomUUID(),
    provider: 'openai',
    billingAccountRef: safeRef(input.billingAccountRef, 'account reference', true)!,
    providerProjectRef: safeRef(input.providerProjectRef ?? '', 'project reference', false),
    upstreamFingerprint: normalized.fingerprint,
    upstreamDisplay: normalized.display,
    declaredAtMs: input.declaredAtMs ?? Date.now(),
    trust: 'operator_declared_unverified',
  };
}
