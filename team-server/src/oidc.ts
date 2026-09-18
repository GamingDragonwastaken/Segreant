/**
 * OIDC relying-party JWT verification. Per docs/TEAM-TIER-DESIGN.md §3:
 * "verify an incoming JWT against a configured issuer URL and JWKS endpoint,
 * extract an identity claim, done." This is the human-facing auth layer —
 * separate from src/team/rollup.ts's ed25519 machine-to-machine trust for
 * POST /rollups (see server.ts's header comment).
 *
 * WHAT `jose` DOES HERE AND WHAT IT DOES NOT (WP-H02, D-223). The JWS step —
 * importing a candidate JWK for the header's algorithm and verifying the
 * compact signature — is delegated to `jose` (`importJWK` + `compactVerify`),
 * the one runtime dependency team-server carries besides `pg`; the root
 * package stays at zero. Everything around it stays this module's
 * responsibility and is tested here rather than assumed of the library:
 * canonical base64url of every segment before any key is fetched, the
 * RS256/ES256 allowlist read from the header before `jose` sees the token,
 * JWKS discovery/caching/forced-refresh cooldown, JWK metadata reconciliation
 * (`kty`/`alg`/`use`/`key_ops`/`crv`) against the header algorithm, trying
 * every candidate that shares a kid, and every relying-party claim rule
 * (exp with no leeway, iat/nbf skew, issuer, audience, azp, sub). The
 * adversarial matrix in test/oidc-adversarial.test.ts is what makes that
 * division checkable; test/oidc.test.ts holds the D-209 strictness cases.
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

import { compactVerify, importJWK, type CryptoKey, type KeyObject } from 'jose';

export interface OidcConfig {
  issuerUrl: string;
  clientId: string;
  /** Skips discovery when set — useful to pin exactly, or in tests. */
  jwksUrl?: string;
  jwksCacheTtlMs?: number;
  /** Minimum time between forced (unknown-kid) JWKS refreshes per endpoint. Default 30 s. */
  jwksRefreshCooldownMs?: number;
  /** Timeout for one discovery or JWKS fetch. Default 10 s. */
  jwksFetchTimeoutMs?: number;
}

/**
 * Verification dependencies that are deliberately separate from deploy-time
 * OIDC configuration. Keeping the clock here means latency in discovery/JWKS
 * work cannot change the semantics of a boundary test, while production still
 * defaults to the real wall clock.
 */
export interface OidcVerificationContext {
  nowEpochSeconds?: () => number;
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
const DEFAULT_JWKS_FORCE_REFRESH_COOLDOWN_MS = 30_000;
const DEFAULT_FETCH_TIMEOUT_MS = 10_000;
const MAX_IDP_JSON_BYTES = 256 * 1024;
const BASE64URL_RE = /^[A-Za-z0-9_-]*$/;

function base64UrlDecode(s: string): Buffer {
  // Buffer.from(..., 'base64') is intentionally permissive: it ignores
  // illegal characters, accepts padding, and tolerates non-zero discarded
  // bits. Compact JOSE serialization needs the unpadded canonical spelling,
  // so validate the alphabet and round-trip the decoded bytes before use.
  if (!BASE64URL_RE.test(s) || s.length % 4 === 1) {
    throw new Error('not canonical base64url');
  }
  const decoded = Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
  if (decoded.toString('base64url') !== s) throw new Error('not canonical base64url');
  return decoded;
}

function jwkMatchesAlgorithm(jwk: Jwk, alg: string): boolean {
  const expectedKty = alg === 'RS256' ? 'RSA' : 'EC';
  if (jwk.kty !== expectedKty) return false;
  if ('alg' in jwk && jwk.alg !== alg) return false;
  if ('use' in jwk && jwk.use !== 'sig') return false;
  if ('key_ops' in jwk) {
    if (!Array.isArray(jwk.key_ops) || !jwk.key_ops.every((op) => typeof op === 'string') || !jwk.key_ops.includes('verify')) {
      return false;
    }
  }
  if (alg === 'ES256') {
    if (jwk.crv !== 'P-256') return false;
  } else if ('crv' in jwk) {
    return false;
  }
  return true;
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

function validateEndpoint(raw: string, label: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(`${label} must be an absolute URL`);
  }
  const loopback = parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1' || parsed.hostname === '[::1]';
  if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && loopback)) {
    throw new Error(`${label} must use HTTPS (HTTP is allowed only for literal loopback)`);
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error(`${label} must not contain credentials, query parameters, or a fragment`);
  }
  return parsed;
}

async function readJsonLimited<T>(response: Response, label: string): Promise<T> {
  const declaredLength = response.headers.get('content-length');
  if (declaredLength !== null) {
    const length = Number(declaredLength);
    if (!Number.isSafeInteger(length) || length < 0 || length > MAX_IDP_JSON_BYTES) {
      await response.body?.cancel().catch(() => undefined);
      throw new Error(`${label} response exceeds the ${MAX_IDP_JSON_BYTES}-byte limit`);
    }
  }
  if (!response.body) return await response.json() as T;
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  for (;;) {
    const next = await reader.read();
    if (next.done) break;
    const chunk = Buffer.from(next.value);
    total += chunk.byteLength;
    if (total > MAX_IDP_JSON_BYTES) {
      await reader.cancel();
      throw new Error(`${label} response exceeds the ${MAX_IDP_JSON_BYTES}-byte limit`);
    }
    chunks.push(chunk);
  }
  const bytes = Buffer.concat(chunks);
  try {
    return JSON.parse(bytes.toString('utf8')) as T;
  } catch {
    throw new Error(`${label} response is not valid JSON`);
  } finally {
    bytes.fill(0);
  }
}

async function discoverJwksUri(issuerUrl: string): Promise<string> {
  const issuer = validateEndpoint(issuerUrl, 'OIDC issuer URL');
  const wellKnown = new URL(`${issuer.pathname.replace(/\/$/, '')}/.well-known/openid-configuration`, issuer.origin);
  const res = await fetch(wellKnown, { signal: AbortSignal.timeout(10_000), redirect: 'error', headers: { accept: 'application/json' } });
  if (!res.ok) {
    await res.body?.cancel().catch(() => undefined);
    throw new Error(`OIDC discovery failed: HTTP ${res.status} from ${wellKnown.origin}`);
  }
  const doc = await readJsonLimited<{ jwks_uri?: unknown; issuer?: unknown }>(res, 'OIDC discovery');
  // Issuer substitution: a discovery document is only trusted for the issuer
  // it names. OpenID Connect Discovery §4.3 requires `issuer` to equal the
  // issuer the document was fetched for; a document that names another
  // issuer would otherwise hand this verifier a JWKS for the wrong party.
  const documentIssuer = typeof doc.issuer === 'string' ? doc.issuer.replace(/\/$/, '') : null;
  if (documentIssuer === null || documentIssuer !== issuerUrl.replace(/\/$/, '')) {
    throw new Error(`OIDC discovery document at ${wellKnown.origin} names issuer ${JSON.stringify(doc.issuer)}, not the configured ${issuerUrl}`);
  }
  if (typeof doc.jwks_uri !== 'string') throw new Error(`OIDC discovery document at ${wellKnown.origin} is missing jwks_uri`);
  const jwks = validateEndpoint(doc.jwks_uri, 'discovered JWKS URL');
  if (jwks.origin !== issuer.origin) {
    throw new Error('discovered JWKS URL must share the configured OIDC issuer origin');
  }
  return jwks.href;
}

async function fetchJwks(jwksUrl: string, cacheTtlMs: number, cooldownMs: number, timeoutMs: number, forceRefresh = false): Promise<Jwks> {
  const jwksEndpoint = validateEndpoint(jwksUrl, 'JWKS URL');
  const cacheKey = jwksEndpoint.href;
  const cached = jwksCache.get(cacheKey);
  if (!forceRefresh && cached && Date.now() - cached.fetchedAtMs < cacheTtlMs) return cached.jwks;
  if (forceRefresh) {
    const lastForced = jwksForceRefreshedAt.get(cacheKey) ?? 0;
    if (cached && Date.now() - lastForced < cooldownMs) return cached.jwks;
    jwksForceRefreshedAt.set(cacheKey, Date.now());
  }
  const res = await fetch(jwksEndpoint, { signal: AbortSignal.timeout(timeoutMs), redirect: 'error', headers: { accept: 'application/json' } });
  if (!res.ok) {
    await res.body?.cancel().catch(() => undefined);
    throw new Error(`JWKS fetch failed: HTTP ${res.status} from ${jwksEndpoint.origin}`);
  }
  const jwks = await readJsonLimited<Jwks>(res, 'JWKS');
  if (!Array.isArray(jwks.keys)) throw new Error(`JWKS response from ${jwksUrl} is missing a keys array`);
  jwksCache.set(jwksEndpoint.href, { jwks, fetchedAtMs: Date.now() });
  return jwks;
}

async function resolveJwksUrl(cfg: OidcConfig): Promise<string> {
  if (cfg.jwksUrl) return validateEndpoint(cfg.jwksUrl, 'configured JWKS URL').href;
  const ttl = cfg.jwksCacheTtlMs ?? DEFAULT_JWKS_CACHE_TTL_MS;
  const cached = discoveryCache.get(cfg.issuerUrl);
  if (cached && Date.now() - cached.fetchedAtMs < ttl) return cached.jwksUri;
  const jwksUri = await discoverJwksUri(cfg.issuerUrl);
  discoveryCache.set(cfg.issuerUrl, { jwksUri, fetchedAtMs: Date.now() });
  return jwksUri;
}

/**
 * Which published keys may verify this token. A header WITHOUT a kid may be
 * checked against every key; a header WITH one — including an empty string
 * or a non-string value — names a key, and a name nothing carries matches
 * nothing. Coercing a present-but-odd kid into "no kid" would widen the
 * candidate set exactly when the token is least trustworthy.
 */
function findCandidates(jwks: Jwks, kid: unknown): Jwk[] {
  if (kid === undefined) return jwks.keys;
  if (typeof kid !== 'string') return [];
  return jwks.keys.filter((k) => typeof k.kid === 'string' && k.kid === kid);
}

function verifierNow(context: OidcVerificationContext): number | null {
  const now = context.nowEpochSeconds?.() ?? Math.floor(Date.now() / 1000);
  return Number.isSafeInteger(now) ? now : null;
}

/** Verify an OIDC ID token (JWT) against the configured issuer/audience/JWKS. */
export async function verifyIdToken(
  token: string,
  cfg: OidcConfig,
  context: OidcVerificationContext = {},
): Promise<VerifyResult> {
  const parts = token.split('.');
  if (parts.length !== 3) return { valid: false, reason: 'malformed token: expected 3 dot-separated segments' };
  const [headerB64, payloadB64, sigB64] = parts as [string, string, string];

  let header: { alg?: unknown; kid?: unknown };
  let payload: Record<string, unknown>;
  let headerBytes: Buffer;
  let payloadBytes: Buffer;
  try {
    headerBytes = base64UrlDecode(headerB64);
    payloadBytes = base64UrlDecode(payloadB64);
  } catch {
    return { valid: false, reason: 'malformed token: header or payload is not canonical base64url' };
  }
  try {
    header = JSON.parse(headerBytes.toString('utf8')) as { alg?: unknown; kid?: unknown };
    payload = JSON.parse(payloadBytes.toString('utf8')) as Record<string, unknown>;
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

  let signature: Buffer;
  try {
    signature = base64UrlDecode(sigB64);
  } catch {
    return { valid: false, reason: 'malformed token: signature is not canonical base64url' };
  }

  let jwksUrl: string;
  try {
    jwksUrl = await resolveJwksUrl(cfg);
  } catch (err) {
    return { valid: false, reason: `OIDC discovery error: ${String(err)}` };
  }

  const cacheTtlMs = cfg.jwksCacheTtlMs ?? DEFAULT_JWKS_CACHE_TTL_MS;
  const cooldownMs = cfg.jwksRefreshCooldownMs ?? DEFAULT_JWKS_FORCE_REFRESH_COOLDOWN_MS;
  const timeoutMs = cfg.jwksFetchTimeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS;
  let jwks: Jwks;
  try {
    jwks = await fetchJwks(jwksUrl, cacheTtlMs, cooldownMs, timeoutMs);
  } catch (err) {
    return { valid: false, reason: `JWKS fetch error: ${String(err)}` };
  }

  const kid: unknown = 'kid' in header ? header.kid : undefined;
  let candidates = findCandidates(jwks, kid);
  if (candidates.length === 0) {
    try {
      jwks = await fetchJwks(jwksUrl, cacheTtlMs, cooldownMs, timeoutMs, true);
    } catch (err) {
      return { valid: false, reason: `JWKS fetch error: ${String(err)}` };
    }
    candidates = findCandidates(jwks, kid);
    if (candidates.length === 0) {
      return { valid: false, reason: `no matching signing key found in JWKS for kid=${kid === undefined ? '(none)' : typeof kid === 'string' ? kid : JSON.stringify(kid)} (after refresh)` };
    }
  }

  // The JWS step is jose's. `compactVerify` re-parses the protected header
  // itself (so an unknown `crit` or a header that disagrees with the
  // reconciled key is jose's refusal, not a silent pass), verifies against the
  // ONE algorithm this module already reconciled, and returns the payload
  // bytes it actually verified — which are what the claim checks below read.
  let verifiedPayload: Buffer | null = null;
  let compatibleCandidateFound = false;
  for (const jwk of candidates) {
    if (!jwkMatchesAlgorithm(jwk, alg)) continue;
    compatibleCandidateFound = true;
    let publicKey: CryptoKey | KeyObject | Uint8Array;
    try {
      publicKey = await importJWK(jwk as unknown as Parameters<typeof importJWK>[0], alg);
    } catch {
      continue;
    }
    try {
      const result = await compactVerify(token, publicKey, { algorithms: [alg] });
      verifiedPayload = Buffer.from(result.payload);
    } catch {
      verifiedPayload = null;
    }
    if (verifiedPayload !== null) break;
  }
  if (!compatibleCandidateFound) return { valid: false, reason: 'signing key metadata conflict' };
  if (verifiedPayload === null) return { valid: false, reason: 'signature mismatch' };
  if (!verifiedPayload.equals(payloadBytes)) return { valid: false, reason: 'malformed token: verified payload differs from the parsed payload' };
  void signature;

  const now = verifierNow(context);
  if (now === null) return { valid: false, reason: 'OIDC verification clock returned invalid epoch seconds' };
  if (typeof payload['exp'] !== 'number' || payload['exp'] <= now) {
    return { valid: false, reason: 'token expired or missing exp' };
  }
  if (typeof payload['iat'] === 'number' && payload['iat'] > now + 60) {
    return { valid: false, reason: 'token issued in the future (iat) — clock skew beyond tolerance' };
  }
  if (typeof payload['nbf'] === 'number' && payload['nbf'] > now + 60) {
    return { valid: false, reason: 'token is not valid yet (nbf) — clock skew beyond tolerance' };
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
  if (Array.isArray(aud) && aud.length > 1 && payload['azp'] !== cfg.clientId) {
    return { valid: false, reason: `authorized party mismatch: token azp=${JSON.stringify(payload['azp'])}, expected ${cfg.clientId} for multiple audiences` };
  }

  const subject = payload['sub'];
  if (typeof subject !== 'string' || subject.length === 0) {
    return { valid: false, reason: 'token has no non-empty OIDC subject claim (sub)' };
  }

  return { valid: true, claims: payload, subject };
}
