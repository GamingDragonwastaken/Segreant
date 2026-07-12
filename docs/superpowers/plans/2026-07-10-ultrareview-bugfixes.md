# Ultrareview Bugfixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the 7 bugs found by the 2026-07-10 `/code-review ultra` cloud pass (3 `normal`, 4 `nit`) without regressing any of the 60+ existing tests in `test/*.test.ts` and `team-server/test/*.test.ts`.

**Architecture:** Five independent tasks, grouped by file so no two tasks touch the same file (safe to run in parallel). Each task is TDD: write/extend a failing test that reproduces the reported bug, watch it fail, apply the minimal fix, watch it pass, run the full local test suite for that package, commit.

**Tech Stack:** TypeScript on Node >=24 (native type-stripping, no ts-node/tsx). `node --test` as the test runner (no Jest/Vitest). Root package (`fiscus`) and `team-server/` are separate npm packages with separate `test`/`typecheck` scripts.

---

## Context all tasks share

- Root package tests: `npm test` runs `node --disable-warning=ExperimentalWarning --test test/*.test.ts` from the repo root. Typecheck: `npm run typecheck` (`tsc --noEmit`).
- `team-server/` tests: `cd team-server && npm test` runs `node --disable-warning=ExperimentalWarning --test test/*.test.ts`. Typecheck: `cd team-server && npm run typecheck`.
- Every task below is self-contained — do not touch files outside your task's file list.
- After your task's own steps pass, run the FULL test suite for whichever package(s) you touched (not just your new test) before committing, to catch any accidental regression.
- Commit message format: `fix: <one line>` — this repo does not enforce Conventional Commits scopes beyond that.

---

### Task 1: OIDC auth — 3 bugs in `team-server/src/oidc.ts`

**Bugs fixed:** bug_001 (discovery re-fetched every request), bug_005 (JWKS cache never refreshes on unknown kid → outage on key rotation), bug_012 (only first constructible key is tried, valid tokens rejected when >1 candidate).

**Files:**
- Modify: `team-server/src/oidc.ts`
- Modify: `team-server/test/fakeIdp.ts`
- Modify: `team-server/test/oidc.test.ts`

- [ ] **Step 1: Write the failing tests**

Add to `team-server/test/fakeIdp.ts` — extend the `FakeIdp` interface and `startFakeIdp` to track `.well-known` hits and support simulating a mid-flight key rotation:

```typescript
export interface FakeIdp {
  url: string;
  issuer: string;
  jwksUrl: string;
  rsaKid: string;
  ecKid: string;
  sign(payload: Record<string, unknown>, opts?: { alg?: 'RS256' | 'ES256'; header?: Record<string, unknown> }): string;
  jwksHits: () => number;
  wellKnownHits: () => number;
  /** Publishes a brand-new RSA keypair under the JWKS (simulating an IdP key rotation where the old JWKS was already cached) and returns a signer bound to it. The original rsaKid/ecKid stay published too, mirroring how real IdPs overlap old+new keys during a rotation window. */
  rotateInNewRsaKey(): { kid: string; sign: (payload: Record<string, unknown>) => string };
  close(): Promise<void>;
}
```

Replace the body of `startFakeIdp` with (only the additions are new — `sign`/`signingKey`/`jwksHits` logic is unchanged from today):

```typescript
export async function startFakeIdp(): Promise<FakeIdp> {
  const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const ec = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const rsaKid = 'rsa-key-1';
  const ecKid = 'ec-key-1';

  const rsaJwk = { ...(rsa.publicKey.export({ format: 'jwk' }) as Record<string, unknown>), kid: rsaKid, alg: 'RS256', use: 'sig' };
  const ecJwk = { ...(ec.publicKey.export({ format: 'jwk' }) as Record<string, unknown>), kid: ecKid, alg: 'ES256', use: 'sig' };
  const keys: Record<string, unknown>[] = [rsaJwk, ecJwk];

  let jwksHits = 0;
  let wellKnownHits = 0;
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (url.pathname === '/.well-known/openid-configuration') {
      wellKnownHits += 1;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ issuer: issuerUrl(), jwks_uri: `${issuerUrl()}/jwks.json` }));
      return;
    }
    if (url.pathname === '/jwks.json') {
      jwksHits += 1;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ keys }));
      return;
    }
    res.writeHead(404);
    res.end();
  });

  let base = '';
  function issuerUrl(): string {
    return base;
  }

  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      base = `http://127.0.0.1:${port}`;
      resolve();
    });
  });

  function signingKey(alg: 'RS256' | 'ES256'): KeyObject {
    return alg === 'RS256' ? rsa.privateKey : ec.privateKey;
  }

  function sign(payload: Record<string, unknown>, opts: { alg?: 'RS256' | 'ES256'; header?: Record<string, unknown> } = {}): string {
    const alg = opts.alg ?? 'RS256';
    const header = opts.header ?? { alg, typ: 'JWT', kid: alg === 'RS256' ? rsaKid : ecKid };
    const headerB64 = base64url(Buffer.from(JSON.stringify(header)));
    const payloadB64 = base64url(Buffer.from(JSON.stringify(payload)));
    const signingInput = Buffer.from(`${headerB64}.${payloadB64}`);
    const key = signingKey(alg);
    const signature =
      alg === 'ES256'
        ? cryptoSign('sha256', signingInput, { key, dsaEncoding: 'ieee-p1363' })
        : cryptoSign('sha256', signingInput, key);
    return `${headerB64}.${payloadB64}.${base64url(signature)}`;
  }

  function rotateInNewRsaKey(): { kid: string; sign: (payload: Record<string, unknown>) => string } {
    const fresh = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const kid = 'rsa-key-rotated';
    keys.push({ ...(fresh.publicKey.export({ format: 'jwk' }) as Record<string, unknown>), kid, alg: 'RS256', use: 'sig' });
    return {
      kid,
      sign: (payload: Record<string, unknown>) => {
        const header = { alg: 'RS256', typ: 'JWT', kid };
        const headerB64 = base64url(Buffer.from(JSON.stringify(header)));
        const payloadB64 = base64url(Buffer.from(JSON.stringify(payload)));
        const signingInput = Buffer.from(`${headerB64}.${payloadB64}`);
        const signature = cryptoSign('sha256', signingInput, fresh.privateKey);
        return `${headerB64}.${payloadB64}.${base64url(signature)}`;
      },
    };
  }

  return {
    url: base,
    issuer: base,
    jwksUrl: `${base}/jwks.json`,
    rsaKid,
    ecKid,
    sign,
    jwksHits: () => jwksHits,
    wellKnownHits: () => wellKnownHits,
    rotateInNewRsaKey,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}
```

Add to `team-server/test/oidc.test.ts` (after the existing "OIDC discovery finds it" test):

```typescript
test('verifyIdToken: without an explicit jwksUrl, OIDC discovery is cached — a second verification does not re-hit .well-known', async () => {
  const idp = await startFakeIdp();
  try {
    clearJwksCacheForTests();
    const c: OidcConfig = { issuerUrl: idp.issuer, clientId: CLIENT_ID }; // no jwksUrl — forces discovery
    await verifyIdToken(idp.sign(validPayload(idp)), c);
    const hitsAfterFirst = idp.wellKnownHits();
    await verifyIdToken(idp.sign(validPayload(idp)), c);
    assert.equal(idp.wellKnownHits(), hitsAfterFirst, 'a second verification should reuse the cached discovery result, not re-hit .well-known');
  } finally {
    await idp.close();
  }
});

test('verifyIdToken: a key rotated in after the JWKS was cached is still accepted (forces one refresh on unknown kid)', async () => {
  const idp = await startFakeIdp();
  try {
    clearJwksCacheForTests();
    const c = cfg(idp, { jwksCacheTtlMs: 60_000 });
    await verifyIdToken(idp.sign(validPayload(idp)), c); // primes the cache with the original two keys
    const hitsBeforeRotation = idp.jwksHits();

    const rotated = idp.rotateInNewRsaKey();
    const token = rotated.sign(validPayload(idp));
    const result = await verifyIdToken(token, c);

    assert.equal(result.valid, true, 'a genuinely valid token signed by a newly-rotated key must not be rejected just because the cache predates the rotation');
    assert.ok(idp.jwksHits() > hitsBeforeRotation, 'an unknown kid must force a JWKS refresh, not just fail against the stale cache');
  } finally {
    await idp.close();
  }
});

test('verifyIdToken: a JWT with no kid header is accepted even when multiple JWKS candidates exist (tries every candidate, not just the first)', async () => {
  const idp = await startFakeIdp();
  try {
    // No kid in the header → verifyIdToken must treat every key in the JWKS as
    // a candidate and try each one, not bail out after the first constructible
    // key fails to verify.
    const token = idp.sign(validPayload(idp), { alg: 'RS256', header: { alg: 'RS256', typ: 'JWT' } });
    const result = await verifyIdToken(token, cfg(idp));
    assert.equal(result.valid, true);
  } finally {
    await idp.close();
  }
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd team-server && npx --yes -- node --disable-warning=ExperimentalWarning --test test/oidc.test.ts`
Expected: the 3 new tests FAIL. The "no kid header" test fails because today's `sign()` builds a default header `{ alg, typ: 'JWT', kid: rsaKid }` even without `opts.header` — check that passing `header: { alg: 'RS256', typ: 'JWT' }` (no `kid` key) correctly omits kid; if the fake IdP's `sign()` still needs a tweak to omit `kid` cleanly when the caller passes a header without one, that's fine, `opts.header` already overrides the whole header object today, so passing `{ alg: 'RS256', typ: 'JWT' }` (no kid field) already produces a headerless-kid token — no fakeIdp change needed for this third test beyond what Step 1 already adds. The rotation and discovery-caching tests fail because the production code doesn't have discovery caching or forced-refresh-on-miss yet.

- [ ] **Step 3: Implement the minimal fix in `team-server/src/oidc.ts`**

Replace the whole file with:

```typescript
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd team-server && npx --yes -- node --disable-warning=ExperimentalWarning --test test/oidc.test.ts`
Expected: all tests PASS (12 existing + 3 new = 15).

Then run the full team-server suite to check for regressions in `server.test.ts` (which also exercises `verifyIdToken` indirectly via `/me` and `/dashboard/*`):
Run: `cd team-server && npm test`
Expected: all PASS.
Run: `cd team-server && npm run typecheck`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add team-server/src/oidc.ts team-server/test/fakeIdp.ts team-server/test/oidc.test.ts
git commit -m "fix: OIDC JWKS/discovery caching — refresh on unknown kid, cache discovery, try all key candidates"
```

---

### Task 2: Aggregate dashboard double-counting — `team-server/src/store.ts`

**Bug fixed:** bug_002 (overlapping cumulative-snapshot rollups from the same developer are summed instead of deduplicated, inflating dashboard totals N-fold).

**Files:**
- Modify: `team-server/src/store.ts:228-295` (`PgRollupStore.aggregateProjects` / `aggregateDevelopers`)
- Modify: `team-server/test/fakeStore.ts` (`FakeRollupStore` mirrors the same SQL logic in JS — must be fixed in lockstep, per its own header comment)
- Modify: `team-server/test/server.test.ts`

**Design:** `fiscus team push --window N` sends a full rolling N-day snapshot every time it runs (not a delta). A developer pushing on a cron produces multiple rollups whose `[period_from, period_to)` windows overlap almost entirely. The fix: when aggregating, keep only each developer's SINGLE latest rollup (by `received_at`) among those whose window overlaps the query filter, then sum `rollup_projects` rows only from those surviving rollups. This is additive/non-breaking for the common case (one rollup per developer in the window) and fixes the duplication case (multiple overlapping rollups per developer).

- [ ] **Step 1: Write the failing test**

Add to `team-server/test/server.test.ts` (after the "weights realizationRate by units" test, same file/imports already present):

```typescript
test('team-server: GET /dashboard/projects does not double-count when the same developer pushes overlapping-window rollups (cumulative-snapshot pushes, e.g. daily cron)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'aegis-team-server-'));
  const idp = await startFakeIdp();
  try {
    const dev: KeyPair = loadOrCreateKeyPair(join(dir, 'dev.json'));
    const store = new FakeRollupStore();
    const srv = await startTeamServer({
      store,
      adminToken: null,
      oidc: { issuerUrl: idp.issuer, clientId: 'team-dashboard', jwksUrl: idp.jwksUrl },
      aggregate: { minCohort: 1, exposeDeveloperBreakdown: false },
    });
    try {
      // Simulates `fiscus team push --window 30` run on two consecutive
      // days: each push is a full rolling snapshot of the SAME underlying
      // spend, not incremental new work, so the two periods overlap almost
      // entirely.
      const day1 = { from: '2026-06-04T00:00:00.000Z', to: '2026-07-04T00:00:00.000Z' };
      const day2 = { from: '2026-06-05T00:00:00.000Z', to: '2026-07-05T00:00:00.000Z' };
      const snapshot: ProjectValue[] = [
        { project: 'fiscus', units: 10, costUsd: 100, realizationRate: 0.8, realizedValueUsd: 80, netRealizedValueUsd: 80, roiIndex: 1.0, sources: [] },
      ];
      await pushRollup(srv, store, dev, snapshot, day1);
      await pushRollup(srv, store, dev, snapshot, day2);

      const now = Math.floor(Date.now() / 1000);
      const token = idp.sign({ iss: idp.issuer, aud: 'team-dashboard', sub: 'lead@example.com', iat: now, exp: now + 3600 });
      const res = await fetch(`${srv.url}/dashboard/projects`, { headers: { authorization: `Bearer ${token}` } });
      assert.equal(res.status, 200);
      const payload = (await res.json()) as { ok: boolean; projects: Array<Record<string, unknown>> };
      assert.equal(payload.projects.length, 1);
      const row = payload.projects[0]!;
      assert.equal(row['suppressed'], false);
      // The second push re-snapshots the SAME spend, not additional work —
      // totals must reflect this one developer's true $100/10-unit snapshot,
      // not double it.
      assert.equal(row['totalCostUsd'], 100);
      assert.equal(row['totalUnits'], 10);
      assert.equal(row['totalRealizedValueUsd'], 80);
      assert.equal(row['developerCount'], 1);
      assert.equal(row['rollupCount'], 1);
    } finally {
      await srv.close();
    }
  } finally {
    await idp.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd team-server && npx --yes -- node --disable-warning=ExperimentalWarning --test test/server.test.ts`
Expected: FAIL — `totalCostUsd` is `200`, not `100` (and `totalUnits: 20`, `rollupCount: 2`), proving the double-count.

- [ ] **Step 3: Fix `FakeRollupStore` in `team-server/test/fakeStore.ts`**

Replace `aggregateProjects` and `aggregateDevelopers` with (everything else in the file is unchanged):

```typescript
  /** Mirrors PgRollupStore.aggregateProjects's weighting exactly — see store.ts's header comment on why realizationRate/avgRoiIndex can't be naive averages. */
  async aggregateProjects(filter: PeriodFilter = {}): Promise<ProjectTotals[]> {
    const inWindow = this.rollups.filter((r) => overlapsWindow(r.periodFrom, r.periodTo, filter));
    // Cumulative-snapshot rollups: a developer who pushed more than once with
    // overlapping windows (e.g. a daily cron) must only count once — summing
    // every overlapping snapshot would multiply their true spend by however
    // many times they happened to push. Keep only each developer's single
    // latest (by receivedAt) rollup among those overlapping the filter.
    const latestPerDev = new Map<string, StoredRollup>();
    for (const r of inWindow) {
      const existing = latestPerDev.get(r.keyId);
      if (!existing || r.receivedAt > existing.receivedAt) latestPerDev.set(r.keyId, r);
    }
    const deduped = [...latestPerDev.values()];
    interface Acc {
      developers: Set<string>;
      rollups: Set<string>;
      totalUnits: number;
      totalCostUsd: number;
      totalRealizedValueUsd: number;
      totalNetRealizedValueUsd: number;
      realizationNumerator: number;
      roiNumerator: number;
      roiDenominator: number;
    }
    const byProject = new Map<string, Acc>();
    for (const r of deduped) {
      for (const p of r.body.projects) {
        let acc = byProject.get(p.project);
        if (!acc) {
          acc = {
            developers: new Set(),
            rollups: new Set(),
            totalUnits: 0,
            totalCostUsd: 0,
            totalRealizedValueUsd: 0,
            totalNetRealizedValueUsd: 0,
            realizationNumerator: 0,
            roiNumerator: 0,
            roiDenominator: 0,
          };
          byProject.set(p.project, acc);
        }
        acc.developers.add(r.keyId);
        acc.rollups.add(r.id);
        acc.totalUnits += p.units;
        acc.totalCostUsd += p.costUsd;
        acc.totalRealizedValueUsd += p.realizedValueUsd;
        acc.totalNetRealizedValueUsd += p.netRealizedValueUsd;
        acc.realizationNumerator += p.realizationRate * p.units;
        if (p.roiIndex !== null) {
          acc.roiNumerator += p.roiIndex * p.costUsd;
          acc.roiDenominator += p.costUsd;
        }
      }
    }
    return [...byProject.entries()]
      .map(([project, acc]) => ({
        project,
        developerCount: acc.developers.size,
        rollupCount: acc.rollups.size,
        totalUnits: acc.totalUnits,
        totalCostUsd: acc.totalCostUsd,
        totalRealizedValueUsd: acc.totalRealizedValueUsd,
        totalNetRealizedValueUsd: acc.totalNetRealizedValueUsd,
        realizationRate: acc.totalUnits > 0 ? acc.realizationNumerator / acc.totalUnits : null,
        realizedValueRate: acc.totalCostUsd > 0 ? acc.totalRealizedValueUsd / acc.totalCostUsd : null,
        avgRoiIndex: acc.roiDenominator > 0 ? acc.roiNumerator / acc.roiDenominator : null,
      }))
      .sort((a, b) => b.totalCostUsd - a.totalCostUsd);
  }

  async aggregateDevelopers(filter: PeriodFilter = {}): Promise<DeveloperTotals[]> {
    const inWindow = this.rollups.filter((r) => overlapsWindow(r.periodFrom, r.periodTo, filter));
    const latestPerDev = new Map<string, StoredRollup>();
    for (const r of inWindow) {
      const existing = latestPerDev.get(r.keyId);
      if (!existing || r.receivedAt > existing.receivedAt) latestPerDev.set(r.keyId, r);
    }
    return [...latestPerDev.values()]
      .map((r) => {
        let totalCostUsd = 0;
        let totalRealizedValueUsd = 0;
        for (const p of r.body.projects) {
          totalCostUsd += p.costUsd;
          totalRealizedValueUsd += p.realizedValueUsd;
        }
        return {
          keyId: r.keyId,
          label: this.developers.get(r.keyId)?.label ?? null,
          rollupCount: 1,
          totalCostUsd,
          totalRealizedValueUsd,
          realizedValueRate: totalCostUsd > 0 ? totalRealizedValueUsd / totalCostUsd : null,
          lastPushedAt: r.receivedAt,
        };
      })
      .sort((a, b) => b.totalCostUsd - a.totalCostUsd);
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd team-server && npx --yes -- node --disable-warning=ExperimentalWarning --test test/server.test.ts`
Expected: PASS, including the new test and all pre-existing ones (in particular, the "weights realizationRate by units" test with 3 *different* developers each pushing once must still pass unchanged — dedup-by-developer doesn't affect it since there's nothing to dedupe).

- [ ] **Step 5: Apply the equivalent fix to the real SQL in `team-server/src/store.ts`**

Replace lines 228–295 (the `aggregateProjects` and `aggregateDevelopers` methods) with:

```typescript
  async aggregateProjects(filter: PeriodFilter = {}): Promise<ProjectTotals[]> {
    const res = await this.pool.query<ProjectTotalsRow>(
      `WITH latest_rollup_per_dev AS (
         SELECT DISTINCT ON (r.key_id) r.id
         FROM rollups r
         WHERE ($1::timestamptz IS NULL OR r.period_to > $1::timestamptz)
           AND ($2::timestamptz IS NULL OR r.period_from < $2::timestamptz)
         ORDER BY r.key_id, r.received_at DESC
       )
       SELECT
         rp.project AS project,
         COUNT(DISTINCT r.key_id)::float8 AS developer_count,
         COUNT(DISTINCT r.id)::float8 AS rollup_count,
         COALESCE(SUM(rp.units), 0)::float8 AS total_units,
         COALESCE(SUM(rp.cost_usd), 0)::float8 AS total_cost_usd,
         COALESCE(SUM(rp.realized_value_usd), 0)::float8 AS total_realized_value_usd,
         COALESCE(SUM(rp.net_realized_value_usd), 0)::float8 AS total_net_realized_value_usd,
         (SUM(rp.realization_rate * rp.units) / NULLIF(SUM(rp.units), 0))::float8 AS realization_rate,
         (SUM(rp.realized_value_usd) / NULLIF(SUM(rp.cost_usd), 0))::float8 AS realized_value_rate,
         (SUM(CASE WHEN rp.roi_index IS NOT NULL THEN rp.roi_index * rp.cost_usd ELSE 0 END)
            / NULLIF(SUM(CASE WHEN rp.roi_index IS NOT NULL THEN rp.cost_usd ELSE 0 END), 0))::float8 AS avg_roi_index
       FROM rollup_projects rp
       JOIN rollups r ON r.id = rp.rollup_id
       WHERE r.id IN (SELECT id FROM latest_rollup_per_dev)
       GROUP BY rp.project
       ORDER BY total_cost_usd DESC`,
      [filter.periodFrom ?? null, filter.periodTo ?? null],
    );
    return res.rows.map((row) => ({
      project: row.project,
      developerCount: row.developer_count,
      rollupCount: row.rollup_count,
      totalUnits: row.total_units,
      totalCostUsd: row.total_cost_usd,
      totalRealizedValueUsd: row.total_realized_value_usd,
      totalNetRealizedValueUsd: row.total_net_realized_value_usd,
      realizationRate: row.realization_rate,
      realizedValueRate: row.realized_value_rate,
      avgRoiIndex: row.avg_roi_index,
    }));
  }

  async aggregateDevelopers(filter: PeriodFilter = {}): Promise<DeveloperTotals[]> {
    const res = await this.pool.query<DeveloperTotalsRow>(
      `WITH latest_rollup_per_dev AS (
         SELECT DISTINCT ON (r.key_id) r.id, r.key_id, r.received_at
         FROM rollups r
         WHERE ($1::timestamptz IS NULL OR r.period_to > $1::timestamptz)
           AND ($2::timestamptz IS NULL OR r.period_from < $2::timestamptz)
         ORDER BY r.key_id, r.received_at DESC
       )
       SELECT
         d.key_id AS key_id,
         d.label AS label,
         COUNT(DISTINCT lr.id)::float8 AS rollup_count,
         COALESCE(SUM(rp.cost_usd), 0)::float8 AS total_cost_usd,
         COALESCE(SUM(rp.realized_value_usd), 0)::float8 AS total_realized_value_usd,
         (SUM(rp.realized_value_usd) / NULLIF(SUM(rp.cost_usd), 0))::float8 AS realized_value_rate,
         MAX(lr.received_at) AS last_pushed_at
       FROM developers d
       JOIN latest_rollup_per_dev lr ON lr.key_id = d.key_id
       LEFT JOIN rollup_projects rp ON rp.rollup_id = lr.id
       GROUP BY d.key_id, d.label
       ORDER BY total_cost_usd DESC`,
      [filter.periodFrom ?? null, filter.periodTo ?? null],
    );
    return res.rows.map((row) => ({
      keyId: row.key_id,
      label: row.label,
      rollupCount: row.rollup_count,
      totalCostUsd: row.total_cost_usd,
      totalRealizedValueUsd: row.total_realized_value_usd,
      realizedValueRate: row.realized_value_rate,
      lastPushedAt: row.last_pushed_at.toISOString(),
    }));
  }
```

Note: `DISTINCT ON` is Postgres-specific syntax, consistent with this being a Postgres-only file (`pg` is `team-server`'s only dependency). This cannot be exercised against a real Postgres instance in this environment (no live DB available — `server.test.ts`'s own header comment already documents that real-Postgres integration is unverified here, same as before this fix). Read the SQL carefully against the `FakeRollupStore` JS equivalent above to confirm they implement the same semantics before committing.

- [ ] **Step 6: Run the full team-server suite and typecheck**

Run: `cd team-server && npm test`
Expected: all PASS.
Run: `cd team-server && npm run typecheck`
Expected: no errors (the SQL is a template string, so this only checks the TS types around it — row mapping, function signatures).

- [ ] **Step 7: Commit**

```bash
git add team-server/src/store.ts team-server/test/fakeStore.ts team-server/test/server.test.ts
git commit -m "fix: dedupe overlapping cumulative-snapshot rollups per developer in aggregate dashboard queries"
```

---

### Task 3: k-anonymity floor on the rate distribution — `team-server/src/aggregate.ts`

**Bug fixed:** bug_006 (the k-anonymity floor gates on the full developer cohort, but the disclosed rate distribution is computed over a smaller pool after excluding $0-cost developers, so the disclosed cohort can fall below the configured floor).

**Files:**
- Modify: `team-server/src/aggregate.ts:109-148` (`buildDeveloperReport`)
- Modify: `team-server/test/aggregate.test.ts`

- [ ] **Step 1: Write the failing test, and fix the existing test that currently pins the bug**

In `team-server/test/aggregate.test.ts`, replace the test `'buildDeveloperReport: a developer with $0 cost is counted in cohortSize but excluded from the rate distribution, not folded in as 0'` (lines 123–136) with two tests — one isolating the "$0 cost excluded from rate math" behavior with a cohort big enough to clear the floor on both axes, and one that is the actual bug_006 regression:

```typescript
test('buildDeveloperReport: a developer with $0 cost is counted in cohortSize but excluded from the rate distribution, not folded in as 0', () => {
  const totals = [
    developer({ keyId: 'a', totalCostUsd: 0, totalRealizedValueUsd: 0, realizedValueRate: null }),
    developer({ keyId: 'b', totalCostUsd: 100, totalRealizedValueUsd: 100, realizedValueRate: 1.0 }),
    developer({ keyId: 'c', totalCostUsd: 100, totalRealizedValueUsd: 100, realizedValueRate: 1.0 }),
    developer({ keyId: 'd', totalCostUsd: 100, totalRealizedValueUsd: 100, realizedValueRate: 1.0 }),
  ];
  const config: TeamAggregateConfig = { minCohort: 3, exposeDeveloperBreakdown: true };
  const report = buildDeveloperReport(totals, config);
  assert.equal(report.suppressed, false);
  const d = report.distribution!;
  assert.equal(d.cohortSize, 4); // the $0 developer still counts toward cohort size
  // If the $0 developer's rate had been folded in as 0, the median would be
  // pulled down; excluding it entirely, the median of [1,1,1] is exactly 1.
  assert.equal(d.medianRealizedValueRate, 1);
});

test('buildDeveloperReport: the rate distribution is suppressed on its own when excluding $0-cost developers drops it below the k-anonymity floor, even though the raw cohort clears it', () => {
  const totals = [
    developer({ keyId: 'a', totalCostUsd: 0, totalRealizedValueUsd: 0, realizedValueRate: null }),
    developer({ keyId: 'b', totalCostUsd: 0, totalRealizedValueUsd: 0, realizedValueRate: null }),
    developer({ keyId: 'c', totalCostUsd: 100, totalRealizedValueUsd: 100, realizedValueRate: 1.0 }),
    developer({ keyId: 'd', totalCostUsd: 100, totalRealizedValueUsd: 100, realizedValueRate: 1.0 }),
    developer({ keyId: 'e', totalCostUsd: 100, totalRealizedValueUsd: 100, realizedValueRate: 1.0 }),
  ];
  const config: TeamAggregateConfig = { minCohort: 5, exposeDeveloperBreakdown: true };
  const report = buildDeveloperReport(totals, config);
  // totals.length (5) clears minCohort (5), but rates.length (3, after
  // excluding the two $0-cost developers) does not — the disclosed rate axis
  // must not be shown over a sub-cohort smaller than the configured floor.
  assert.equal(report.suppressed, true);
  assert.equal(report.distribution, null);
  assert.match(report.reason, /rate cohort of 3/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd team-server && npx --yes -- node --disable-warning=ExperimentalWarning --test test/aggregate.test.ts`
Expected: the new "suppressed on its own" test FAILS (today's code returns `suppressed: false` with a 3-developer rate distribution instead of suppressing). The rewritten first test should already PASS since it only widened the cohort, not changed the behavior being tested — confirm it does.

- [ ] **Step 3: Implement the fix in `team-server/src/aggregate.ts`**

Replace the `buildDeveloperReport` function (currently lines 108–148) with:

```typescript
/** The org-facing developer distribution — gated by opt-in, then by k-anonymity. Never returns a named list. */
export function buildDeveloperReport(totals: DeveloperTotals[], config: TeamAggregateConfig): TeamDeveloperReport {
  if (!config.exposeDeveloperBreakdown) {
    return {
      enabled: false,
      suppressed: true,
      reason: 'per-developer breakdown is opt-in and disabled on this server (TEAM_SERVER_EXPOSE_DEVELOPER_BREAKDOWN)',
      distribution: null,
    };
  }
  if (totals.length < config.minCohort) {
    return {
      enabled: true,
      suppressed: true,
      reason: `cohort of ${totals.length} is below the k-anonymity floor of ${config.minCohort}; per-developer breakdown withheld`,
      distribution: null,
    };
  }
  const costs = totals.map((t) => t.totalCostUsd).sort((a, b) => a - b);
  // Rate is undefined (not zero) at $0 cost — exclude those rows from the rate
  // distribution rather than fold them in as 0, the same "unknown never
  // penalizes" discipline realization.ts's netRealizedValueUsd uses.
  const rates = totals
    .filter((t): t is DeveloperTotals & { realizedValueRate: number } => t.realizedValueRate !== null)
    .map((t) => t.realizedValueRate)
    .sort((a, b) => a - b);
  // The k-anonymity floor must hold for whatever population a statistic is
  // actually computed over — the rate axis is computed over a SMALLER,
  // filtered population than the raw cohort, so it needs its own floor check
  // rather than inheriting the one above.
  if (rates.length < config.minCohort) {
    return {
      enabled: true,
      suppressed: true,
      reason: `rate cohort of ${rates.length} (after excluding $0-cost developers) is below the k-anonymity floor of ${config.minCohort}; per-developer breakdown withheld`,
      distribution: null,
    };
  }
  return {
    enabled: true,
    suppressed: false,
    reason: `distribution over ${totals.length} developers; individuals not identified`,
    distribution: {
      cohortSize: totals.length,
      medianCostUsd: quantile(costs, 0.5),
      medianRealizedValueRate: quantile(rates, 0.5),
      p25RealizedValueRate: quantile(rates, 0.25),
      p75RealizedValueRate: quantile(rates, 0.75),
      totalCostUsd: totals.reduce((s, t) => s + t.totalCostUsd, 0),
      totalRealizedValueUsd: totals.reduce((s, t) => s + t.totalRealizedValueUsd, 0),
    },
  };
}
```

(Only the new `if (rates.length < config.minCohort)` block is added; everything else in the function is unchanged.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd team-server && npx --yes -- node --disable-warning=ExperimentalWarning --test test/aggregate.test.ts`
Expected: all PASS.

Run the full team-server suite to check `server.test.ts`'s developer-breakdown tests (3 devs, all non-null rates, minCohort 3 — must still pass unaffected since `rates.length === totals.length` there):
Run: `cd team-server && npm test`
Expected: all PASS.
Run: `cd team-server && npm run typecheck`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add team-server/src/aggregate.ts team-server/test/aggregate.test.ts
git commit -m "fix: k-anonymity floor now also gates the rate distribution's own (smaller) population"
```

---

### Task 4: Judge rationale self-contradiction — `src/judge/orchestrate.ts`

**Bug fixed:** bug_004 (when full-content judging is configured but downgraded to structural at runtime, the rationale keeps the earlier "full session content" claim alongside the corrective note, contradicting itself).

**Files:**
- Modify: `src/judge/orchestrate.ts`
- Modify: `test/judge-orchestrate.test.ts`

- [ ] **Step 1: Write the failing test**

In `test/judge-orchestrate.test.ts`, extend the existing test `'judgeSession: a full-content tier downgrades its REPORTED confidence to structural — never claims fidelity it did not deliver'` by adding one assertion in each of its two blocks (local and hosted):

```typescript
test('judgeSession: a full-content tier downgrades its REPORTED confidence to structural — never claims fidelity it did not deliver', async () => {
  const mock = await startMockJudge(() => chatCompletion(1.0, 'ok'));
  try {
    const j = await judgeSession(
      's1',
      REQUESTS,
      PROPOSALS,
      cfg({ localBaseUrl: mock.url, localModel: 'llama3.1', localSendFullContent: true }),
    );
    assert.equal(j.confidence, 'local-llm', 'local structural and full share one tag, so this alone does not prove the downgrade');
    assert.ok(j.rationale.includes('not yet implemented'), 'the downgrade must be visible in the rationale, not silent');
    assert.doesNotMatch(j.rationale, /full session content/i, 'the rationale must not retain the pre-downgrade fidelity claim');
  } finally {
    await mock.close();
  }

  const mock2 = await startMockJudge(() => chatCompletion(1.0, 'ok'));
  try {
    await withEnv('AEGIS_JUDGE_API_KEY', 'sk-test', async () => {
      const j = await judgeSession(
        's1',
        REQUESTS,
        PROPOSALS,
        cfg({ hostedEnabled: true, hostedBaseUrl: mock2.url, hostedModel: 'gpt-4o-mini', hostedSendFullContent: true }),
      );
      // This is the assertion that actually distinguishes the fix: hosted-full's tag
      // is DIFFERENT from hosted-structural's, so if the downgrade didn't happen this
      // would read 'hosted-llm-full' instead.
      assert.equal(j.confidence, 'hosted-llm-structural');
      assert.ok(j.rationale.includes('not yet implemented'));
      assert.doesNotMatch(j.rationale, /full session content/i, 'the rationale must not claim content left the machine when only the structural summary was sent');
    });
  } finally {
    await mock2.close();
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx --yes -- node --disable-warning=ExperimentalWarning --test test/judge-orchestrate.test.ts`
Expected: FAIL on both new `assert.doesNotMatch` lines — today's rationale contains `"full session content"` (local, lowercase) and `"FULL session content leaves this machine"` (hosted) from `tier.ts`'s seeded note, which `judgeSession` currently only appends to, never removes.

- [ ] **Step 3: Implement the fix in `src/judge/orchestrate.ts`**

Replace the body of `judgeSession` (currently lines 36–88) with:

```typescript
export async function judgeSession(
  sessionId: string,
  requests: RequestRow[],
  proposals: ProposalRow[],
  cfg: JudgeConfig,
): Promise<SessionJudgment> {
  const decision = resolveJudgeTier(cfg, hasHostedJudgeApiKey());
  const notes = [...decision.notes];

  if (decision.tier === 'algorithmic') {
    return neutralJudgment(sessionId, notes.join(' ') || 'Judge tier: algorithmic (default).');
  }

  const isLocal = decision.tier === 'local-structural' || decision.tier === 'local-full';
  const baseUrl = isLocal ? cfg.localBaseUrl : cfg.hostedBaseUrl;
  const model = isLocal ? cfg.localModel : cfg.hostedModel;
  const apiKey = isLocal ? null : (process.env.AEGIS_JUDGE_API_KEY ?? null);

  if (!isSet(baseUrl) || !isSet(model)) {
    const field = isLocal ? 'judge.localModel' : 'judge.hostedModel';
    notes.push(`Judge tier ${decision.tier} is configured but missing a model name (${field}) — falling back to the algorithmic signal.`);
    return neutralJudgment(sessionId, notes.join(' '));
  }

  // Full-content judging is not implemented: the store never persists
  // prompt/response transcript text (payload.ts's docblock), so there is
  // nothing beyond the structural summary to honestly send. Downgrade the
  // ACTUAL payload (there is only ever a structural one to send) and the
  // REPORTED confidence together — never claim a higher-fidelity source than
  // what was truly sent.
  const wantsFullContent = decision.tier === 'local-full' || decision.tier === 'hosted-full';
  const confidence: JudgeConfidence = wantsFullContent
    ? isLocal
      ? 'local-llm'
      : 'hosted-llm-structural'
    : decision.confidence;
  if (wantsFullContent) {
    // decision.notes was seeded by tier.ts based on CONFIGURED intent (before
    // this function knew the payload would be downgraded) and claims a
    // fidelity — "full session content" — that never actually gets sent.
    // Strip that claim rather than merely appending a correction after it, so
    // the rationale never asserts something that didn't happen even
    // momentarily within the same string.
    for (let i = notes.length - 1; i >= 0; i--) {
      if (/full session content/i.test(notes[i]!)) notes.splice(i, 1);
    }
    notes.push(
      isLocal
        ? 'Judge tier: local LLM (full-content configured but downgraded to structural — stays on this machine either way).'
        : 'Judge tier: hosted API (full-content configured but downgraded to structural — only a structural summary leaves this machine, never raw content).',
    );
    notes.push(
      'Full-content judging is configured but not yet implemented (Fiscus does not persist transcript text) — ' +
        'sent the structural summary instead, labeled accordingly.',
    );
  }

  const summary = buildStructuralSummary(requests, proposals, sessionId);
  try {
    const judgment = await callJudgeApi(baseUrl!, model!, apiKey, summary, confidence);
    return notes.length ? { ...judgment, rationale: `${judgment.rationale} (${notes.join(' ')})` } : judgment;
  } catch (err) {
    const reason = err instanceof JudgeCallError ? err.message : String(err);
    notes.push(`Judge call failed (${reason}) — falling back to the algorithmic signal (multiplier 1, no adjustment).`);
    return neutralJudgment(sessionId, notes.join(' '));
  }
}
```

(Only the `if (wantsFullContent)` block changes — it now strips any pre-existing "full session content" note before pushing the neutral role note and the corrective note. Everything else in the file is unchanged.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx --yes -- node --disable-warning=ExperimentalWarning --test test/judge-orchestrate.test.ts`
Expected: all PASS.

Run the full root suite plus typecheck (this file is imported by `src/judge/tier.ts`'s siblings — check `judge-tier.test.ts`/`judge-call.test.ts`/`judge-payload.test.ts` too since they live in the same feature):
Run: `npm test`
Expected: all PASS.
Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add src/judge/orchestrate.ts test/judge-orchestrate.test.ts
git commit -m "fix: judge rationale no longer retains the pre-downgrade full-content claim"
```

---

### Task 5: `team push --json` exit code consistency — `src/cli.ts`

**Bug fixed:** bug_010 ("no realized units to push" returns `{ok:false}` in JSON mode but exit code 0, unlike every other error branch in `cmdTeamPush`, so scripts checking the exit code vs. scripts checking the JSON payload disagree).

**Files:**
- Modify: `src/cli.ts:2669-2679`
- Create: `test/team-push.test.ts`

**Design:** treat "nothing to push yet" as a successful no-op (`{ok: true, projects: 0}`), matching how the non-JSON path already treats it (dim/informational `console.log`, not `console.error`) — this fixes the JSON/exit-code disagreement by making both sides agree it's not a failure, and is a better fit for cron usage than treating an empty/idle window as an error.

- [ ] **Step 1: Write the failing test**

Create `test/team-push.test.ts`:

```typescript
/**
 * `fiscus team push` CLI-level checks — integration-tested through the
 * real CLI process, same pattern as test/exec.test.ts.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CLI = join(import.meta.dirname, '..', 'src', 'cli.ts');

function runCli(args: string[], dbPath: string, home: string): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [CLI, ...args],
      { env: { ...process.env, AEGIS_DB: dbPath, AEGIS_HOME: home, NODE_OPTIONS: '' } },
      (err, stdout, stderr) => {
        const code = err && typeof (err as NodeJS.ErrnoException & { code?: unknown }).code === 'number' ? ((err as unknown as { code: number }).code) : err ? 1 : 0;
        resolve({ code, stdout: String(stdout), stderr: String(stderr) });
      },
    );
  });
}

test('team push: no realized units in the window reports ok:true (projects:0) in JSON mode, agreeing with exit code 0', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'aegis-team-push-'));
  try {
    const db = join(dir, 'push.db');
    const home = join(dir, 'home');
    const r = await runCli(['team', 'push', '--url', 'http://127.0.0.1:1', '--json'], db, home);
    assert.equal(r.code, 0, `a fresh install with no realized units must not be treated as a failure, stderr: ${r.stderr}`);
    const payload = JSON.parse(r.stdout) as { ok: boolean; projects: number };
    assert.equal(payload.ok, true, 'JSON ok must agree with the process exit code (both success)');
    assert.equal(payload.projects, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx --yes -- node --disable-warning=ExperimentalWarning --test test/team-push.test.ts`
Expected: FAIL — `payload.ok` is `false` today even though `r.code` is already `0` (that mismatch is exactly the bug).

- [ ] **Step 3: Implement the fix in `src/cli.ts`**

In `cmdTeamPush`, replace the block at lines 2669–2679:

```typescript
  if (projects.length === 0) {
    const msg = projectFilter
      ? `no realized units found for project "${projectFilter}" in the last ${windowDays}d — nothing to push`
      : `no realized units found in the last ${windowDays}d — nothing to push`;
    if (flags.json) {
      console.log(JSON.stringify({ ok: false, error: msg }, null, 2));
      return;
    }
    console.log(`  ${color(tty, C.dim, msg)}`);
    return;
  }
```

with:

```typescript
  if (projects.length === 0) {
    const msg = projectFilter
      ? `no realized units found for project "${projectFilter}" in the last ${windowDays}d — nothing to push`
      : `no realized units found in the last ${windowDays}d — nothing to push`;
    if (flags.json) {
      console.log(JSON.stringify({ ok: true, projects: 0, note: msg }, null, 2));
      return;
    }
    console.log(`  ${color(tty, C.dim, msg)}`);
    return;
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx --yes -- node --disable-warning=ExperimentalWarning --test test/team-push.test.ts`
Expected: PASS.

Run the full root suite and typecheck:
Run: `npm test`
Expected: all PASS.
Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add src/cli.ts test/team-push.test.ts
git commit -m "fix: team push --json reports ok:true for an empty window, agreeing with its exit code"
```

---

## Self-review notes (already applied above)

- **Spec coverage:** all 7 ultrareview findings map 1:1 to a task (bug_001/005/012 → Task 1, bug_002 → Task 2, bug_006 → Task 3, bug_004 → Task 4, bug_010 → Task 5).
- **File-conflict check:** Tasks 1–5 touch entirely disjoint file sets — safe to run fully in parallel with no worktree isolation needed, as long as each task only runs its own scoped test file during development and the final integration step (full suite + typecheck, both packages) happens after all five land.
- **Type consistency:** `ProjectTotals`/`DeveloperTotals`/`TeamAggregateConfig`/`TeamDeveloperReport` field names used in Task 2 and Task 3 match the interfaces already defined in `team-server/src/store.ts` and `team-server/src/aggregate.ts` — no renames introduced.

## Explicitly out of scope for this plan

Investigation while preparing this plan surfaced several "missing features," but every one of them is already an explicit, deliberate scope boundary recorded in this repo's own design docs (not an oversight):

- Rendered team-dashboard UI — `docs/TEAM-TIER-DESIGN.md`: "a rendered frontend that calls these APIs is still out of scope for this release." A real new application; would need its own planning pass, not a silent addition here.
- OIDC-identity-to-`keyId` linking (a "these are my numbers" self-view) — same doc: "not scoped here."
- Background/cron push scheduling — same doc: "no opt-in background interval exists yet — that remains an open, deferred question."
- Real full-content judging (transcript capture) — `docs/LIFT-AI-SIDE-JUDGE-DESIGN.md`: "blocked on a materially bigger, separate privacy decision" — would require Fiscus to start persisting transcript text, contradicting its core "nothing leaves your machine unless you opt up" pitch.
- `fiscus judge` CLI subcommand / automatic invocation from `fiscus lift` — same doc: "still an open question, not decided here."

None of these are built in this plan. They are candidates for the user to explicitly greenlight, not autonomous follow-on work.
