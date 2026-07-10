/**
 * OIDC relying-party JWT verification — node:crypto only, no jsonwebtoken/jose
 * dependency, so team-server's dependency footprint stays at just `pg`. Per
 * docs/TEAM-TIER-DESIGN.md §3: "verify an incoming JWT against a configured
 * issuer URL and JWKS endpoint, extract an identity claim, done." This is the
 * human-facing auth layer — separate from src/team/rollup.ts's ed25519
 * machine-to-machine trust for POST /rollups (see server.ts's header comment).
 *
 * Security notes (the parts that are easy to get wrong hand-rolling this):
 *  - `alg` is whitelisted to RS256/ES256 only. A JWT with `alg: "none"` (a
 *    real, historical JWT vulnerability class) or an HMAC alg like HS256 is
 *    rejected outright — accepting HS256 here would open an "algorithm
 *    confusion" attack, where an attacker signs a forged token with HMAC
 *    using the issuer's PUBLIC RSA key as the "secret," which a verifier that
 *    trusts the token's own `alg` field would happily accept.
 *  - ES256 signatures are P1363 (raw r||s), NOT the DER/ASN.1 encoding
 *    node:crypto uses by default for ECDSA — `dsaEncoding: 'ieee-p1363'` is
 *    required on verification, or every genuine ES256 token fails to verify.
 *  - The JWKS `kid` in the token header selects which published key to check
 *    against; issuers rotate keys, so this must be looked up per-token, not
 *    cached as "the" key. A kid that isn't in the cached JWKS triggers one
 *    forced refresh (cooled down per jwksUrl) before being rejected, so a
 *    mid-TTL key rotation doesn't 401 every request until the cache expires.
 *  - Multiple JWKS entries can be candidates at once (no kid in the header, or
 *    a JWKS with duplicate kids) — every candidate is tried until one verifies,
 *    never just the first one that happens to be constructible as a KeyObject.
 */

import { createPublicKey, verify as cryptoVerify, type KeyObject } from 'node:crypto';

export interface OidcConfig {
  issuerUrl: string;
  clientId: string;
  /** Skips discovery when set — useful to pin exactly, or in tests. */
  jwksUrl?: string;
  jwksCacheTtlMs?: number;
}

interface Jwk {
  kty: string;
  kid?: string;
  [k: string]: unknown;
}

interface Jwks {
  keys: Jwk[];
}

export interface VerifiedIdentity {
  valid: true;
  claims: Record<string, unknown>;
  subject: string;
}

export interface VerificationFailure {
  valid: false;
  reason: string;
}

export type VerifyResult = VerifiedIdentity | VerificationFailure;

const ALLOWED_ALGS = new Set(['RS256', 'ES256']);
const DEFAULT_JWKS_CACHE_TTL_MS = 10 * 60 * 1000;
const JWKS_FORCE_REFRESH_COOLDOWN_MS = 30_000;

function base64UrlDecode(s: string): Buffer {
  return Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}

const jwksCache = new Map<string, { jwks: Jwks; fetchedAtMs: number }>();
const discoveryCache = new Map<string, { jwksUri: string; fetchedAtMs: number }>();
const jwksForceRefreshedAt = new Map<string, number>();

/** Exposed for tests — a fresh process/module instance clears this naturally, but tests share a module. */
export function clearJwksCacheForTests(): void {
  jwksCache.clear();
  discoveryCache.clear();
  jwksForceRefreshedAt.clear();
}

async function discoverJwksUri(issuerUrl: string): Promise<string> {
  const wellKnown = `${issuerUrl.replace(/\/$/, '')}/.well-known/openid-configuration`;
  const res = await fetch(wellKnown, { signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`OIDC discovery failed: HTTP ${res.status} from ${wellKnown}`);
  const doc = (await res.json()) as { jwks_uri?: unknown };
  if (typeof doc.jwks_uri !== 'string') throw new Error(`OIDC discovery document at ${wellKnown} is missing jwks_uri`);
  return doc.jwks_uri;
}

async function fetchJwks(jwksUrl: string, cacheTtlMs: number, forceRefresh = false): Promise<Jwks> {
  const cached = jwksCache.get(jwksUrl);
  if (!forceRefresh && cached && Date.now() - cached.fetchedAtMs < cacheTtlMs) return cached.jwks;
  if (forceRefresh) {
    const lastForced = jwksForceRefreshedAt.get(jwksUrl) ?? 0;
    if (cached && Date.now() - lastForced < JWKS_FORCE_REFRESH_COOLDOWN_MS) return cached.jwks;
    jwksForceRefreshedAt.set(jwksUrl, Date.now());
  }
  const res = await fetch(jwksUrl, { signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`JWKS fetch failed: HTTP ${res.status} from ${jwksUrl}`);
  const jwks = (await res.json()) as Jwks;
  if (!Array.isArray(jwks.keys)) throw new Error(`JWKS response from ${jwksUrl} is missing a keys array`);
  jwksCache.set(jwksUrl, { jwks, fetchedAtMs: Date.now() });
  return jwks;
}

async function resolveJwksUrl(cfg: OidcConfig): Promise<string> {
  if (cfg.jwksUrl) return cfg.jwksUrl;
  const ttl = cfg.jwksCacheTtlMs ?? DEFAULT_JWKS_CACHE_TTL_MS;
  const cached = discoveryCache.get(cfg.issuerUrl);
  if (cached && Date.now() - cached.fetchedAtMs < ttl) return cached.jwksUri;
  const jwksUri = await discoverJwksUri(cfg.issuerUrl);
  discoveryCache.set(cfg.issuerUrl, { jwksUri, fetchedAtMs: Date.now() });
  return jwksUri;
}

function findCandidates(jwks: Jwks, kid: string | undefined): Jwk[] {
  return kid ? jwks.keys.filter((k) => k.kid === kid) : jwks.keys;
}

/** Verify an OIDC ID token (JWT) against the configured issuer/audience/JWKS. */
export async function verifyIdToken(token: string, cfg: OidcConfig): Promise<VerifyResult> {
  const parts = token.split('.');
  if (parts.length !== 3) return { valid: false, reason: 'malformed token: expected 3 dot-separated segments' };
  const [headerB64, payloadB64, sigB64] = parts as [string, string, string];

  let header: { alg?: unknown; kid?: unknown };
  let payload: Record<string, unknown>;
  try {
    header = JSON.parse(base64UrlDecode(headerB64).toString('utf8')) as { alg?: unknown; kid?: unknown };
    payload = JSON.parse(base64UrlDecode(payloadB64).toString('utf8')) as Record<string, unknown>;
  } catch {
    return { valid: false, reason: 'malformed token: header/payload is not valid JSON' };
  }

  if (typeof header.alg !== 'string' || !ALLOWED_ALGS.has(header.alg)) {
    return {
      valid: false,
      reason: `unsupported or unsafe algorithm: ${JSON.stringify(header.alg)} (only RS256/ES256 accepted)`,
    };
  }
  const alg = header.alg;

  let jwksUrl: string;
  try {
    jwksUrl = await resolveJwksUrl(cfg);
  } catch (err) {
    return { valid: false, reason: `OIDC discovery error: ${String(err)}` };
  }

  const cacheTtlMs = cfg.jwksCacheTtlMs ?? DEFAULT_JWKS_CACHE_TTL_MS;
  let jwks: Jwks;
  try {
    jwks = await fetchJwks(jwksUrl, cacheTtlMs);
  } catch (err) {
    return { valid: false, reason: `JWKS fetch error: ${String(err)}` };
  }

  const kid = typeof header.kid === 'string' ? header.kid : undefined;
  let candidates = findCandidates(jwks, kid);
  if (candidates.length === 0) {
    // The cached JWKS may simply be stale (an IdP key rotation landed mid-TTL)
    // — force one refresh before concluding the key genuinely doesn't exist.
    try {
      jwks = await fetchJwks(jwksUrl, cacheTtlMs, true);
    } catch (err) {
      return { valid: false, reason: `JWKS fetch error: ${String(err)}` };
    }
    candidates = findCandidates(jwks, kid);
    if (candidates.length === 0) {
      return { valid: false, reason: `no matching signing key found in JWKS for kid=${kid ?? '(none)'} (after refresh)` };
    }
  }

  const signingInput = Buffer.from(`${headerB64}.${payloadB64}`);
  const signature = base64UrlDecode(sigB64);
  let sigOk = false;
  for (const jwk of candidates) {
    let publicKey: KeyObject;
    try {
      publicKey = createPublicKey({ key: jwk as unknown as Record<string, unknown>, format: 'jwk' });
    } catch {
      continue;
    }
    try {
      sigOk =
        alg === 'ES256'
          ? cryptoVerify('sha256', signingInput, { key: publicKey, dsaEncoding: 'ieee-p1363' }, signature)
          : cryptoVerify('sha256', signingInput, publicKey, signature);
    } catch {
      sigOk = false;
    }
    if (sigOk) break;
  }
  if (!sigOk) return { valid: false, reason: 'signature mismatch' };

  const now = Math.floor(Date.now() / 1000);
  if (typeof payload['exp'] !== 'number' || payload['exp'] <= now) {
    return { valid: false, reason: 'token expired or missing exp' };
  }
  if (typeof payload['iat'] === 'number' && payload['iat'] > now + 60) {
    return { valid: false, reason: 'token issued in the future (iat) — clock skew beyond tolerance' };
  }
  const iss = payload['iss'];
  if (iss !== cfg.issuerUrl && iss !== cfg.issuerUrl.replace(/\/$/, '')) {
    return { valid: false, reason: `issuer mismatch: token claims iss=${JSON.stringify(iss)}, expected ${cfg.issuerUrl}` };
  }
  const aud = payload['aud'];
  const audMatches = aud === cfg.clientId || (Array.isArray(aud) && aud.includes(cfg.clientId));
  if (!audMatches) {
    return { valid: false, reason: `audience mismatch: token aud=${JSON.stringify(aud)}, expected ${cfg.clientId}` };
  }

  const sub = payload['sub'];
  const email = payload['email'];
  const subject = typeof sub === 'string' ? sub : typeof email === 'string' ? email : null;
  if (!subject) return { valid: false, reason: 'token has no usable identity claim (sub or email)' };

  return { valid: true, claims: payload, subject };
}
