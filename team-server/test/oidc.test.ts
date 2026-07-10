/**
 * Adversarial tests for oidc.ts's verifyIdToken — proves the hand-rolled
 * node:crypto JWT verification (no jsonwebtoken/jose dependency) actually
 * works against genuine RS256 and ES256 signatures, not just that the code
 * compiles. Both the signer (fakeIdp.ts) and verifier are exercised together,
 * the same "prove both sides interoperate" approach used for the CLI↔server
 * integration check in this slice.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { verifyIdToken, clearJwksCacheForTests, type OidcConfig } from '../src/oidc.ts';
import { startFakeIdp, type FakeIdp } from './fakeIdp.ts';

const CLIENT_ID = 'team-dashboard';

function cfg(idp: FakeIdp, overrides: Partial<OidcConfig> = {}): OidcConfig {
  return { issuerUrl: idp.issuer, clientId: CLIENT_ID, jwksUrl: idp.jwksUrl, ...overrides };
}

function validPayload(idp: FakeIdp, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const now = Math.floor(Date.now() / 1000);
  return { iss: idp.issuer, aud: CLIENT_ID, sub: 'alice@example.com', iat: now, exp: now + 3600, ...overrides };
}

test('verifyIdToken: a genuine RS256 token is accepted', async () => {
  const idp = await startFakeIdp();
  try {
    const token = idp.sign(validPayload(idp), { alg: 'RS256' });
    const result = await verifyIdToken(token, cfg(idp));
    assert.equal(result.valid, true);
    if (result.valid) assert.equal(result.subject, 'alice@example.com');
  } finally {
    await idp.close();
  }
});

test('verifyIdToken: a genuine ES256 token is accepted (proves IEEE-P1363 signature handling)', async () => {
  const idp = await startFakeIdp();
  try {
    const token = idp.sign(validPayload(idp), { alg: 'ES256' });
    const result = await verifyIdToken(token, cfg(idp));
    assert.equal(result.valid, true);
    if (result.valid) assert.equal(result.subject, 'alice@example.com');
  } finally {
    await idp.close();
  }
});

test('verifyIdToken: an expired token is rejected', async () => {
  const idp = await startFakeIdp();
  try {
    const now = Math.floor(Date.now() / 1000);
    const token = idp.sign(validPayload(idp, { exp: now - 60 }));
    const result = await verifyIdToken(token, cfg(idp));
    assert.equal(result.valid, false);
    if (!result.valid) assert.match(result.reason, /expired/);
  } finally {
    await idp.close();
  }
});

test('verifyIdToken: a wrong issuer is rejected', async () => {
  const idp = await startFakeIdp();
  try {
    const token = idp.sign(validPayload(idp, { iss: 'https://not-the-configured-issuer.example' }));
    const result = await verifyIdToken(token, cfg(idp));
    assert.equal(result.valid, false);
    if (!result.valid) assert.match(result.reason, /issuer mismatch/);
  } finally {
    await idp.close();
  }
});

test('verifyIdToken: a wrong audience is rejected', async () => {
  const idp = await startFakeIdp();
  try {
    const token = idp.sign(validPayload(idp, { aud: 'some-other-app' }));
    const result = await verifyIdToken(token, cfg(idp));
    assert.equal(result.valid, false);
    if (!result.valid) assert.match(result.reason, /audience mismatch/);
  } finally {
    await idp.close();
  }
});

test('verifyIdToken: a tampered payload invalidates the signature', async () => {
  const idp = await startFakeIdp();
  try {
    const token = idp.sign(validPayload(idp, { sub: 'alice@example.com' }));
    const [h, p, s] = token.split('.');
    const forgedPayload = Buffer.from(JSON.stringify(validPayload(idp, { sub: 'admin@example.com' }))).toString('base64url');
    const tampered = `${h}.${forgedPayload}.${s}`;
    const result = await verifyIdToken(tampered, cfg(idp));
    assert.equal(result.valid, false);
    if (!result.valid) assert.match(result.reason, /signature mismatch/);
  } finally {
    await idp.close();
  }
});

test('verifyIdToken: alg "none" is rejected outright (the classic JWT vulnerability)', async () => {
  const idp = await startFakeIdp();
  try {
    const headerB64 = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
    const payloadB64 = Buffer.from(JSON.stringify(validPayload(idp))).toString('base64url');
    const forged = `${headerB64}.${payloadB64}.`;
    const result = await verifyIdToken(forged, cfg(idp));
    assert.equal(result.valid, false);
    if (!result.valid) assert.match(result.reason, /unsupported or unsafe algorithm/);
  } finally {
    await idp.close();
  }
});

test('verifyIdToken: alg "HS256" is rejected (prevents RSA-key-as-HMAC-secret algorithm confusion)', async () => {
  const idp = await startFakeIdp();
  try {
    // Doesn't need a real HMAC signature — the alg whitelist rejects before signature checking.
    const headerB64 = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT', kid: idp.rsaKid })).toString('base64url');
    const payloadB64 = Buffer.from(JSON.stringify(validPayload(idp))).toString('base64url');
    const forged = `${headerB64}.${payloadB64}.deadbeef`;
    const result = await verifyIdToken(forged, cfg(idp));
    assert.equal(result.valid, false);
    if (!result.valid) assert.match(result.reason, /unsupported or unsafe algorithm/);
  } finally {
    await idp.close();
  }
});

test('verifyIdToken: an unknown kid is rejected', async () => {
  const idp = await startFakeIdp();
  try {
    const token = idp.sign(validPayload(idp), { alg: 'RS256', header: { alg: 'RS256', typ: 'JWT', kid: 'not-a-real-key' } });
    const result = await verifyIdToken(token, cfg(idp));
    assert.equal(result.valid, false);
    if (!result.valid) assert.match(result.reason, /no matching signing key/);
  } finally {
    await idp.close();
  }
});

test('verifyIdToken: a malformed token (not 3 segments) is rejected', async () => {
  const idp = await startFakeIdp();
  try {
    const result = await verifyIdToken('not.a.jwt.at.all', cfg(idp));
    assert.equal(result.valid, false);
    if (!result.valid) assert.match(result.reason, /malformed token/);
  } finally {
    await idp.close();
  }
});

test('verifyIdToken: JWKS is cached — a second verification within the TTL does not re-fetch', async () => {
  const idp = await startFakeIdp();
  try {
    clearJwksCacheForTests();
    const c = cfg(idp, { jwksCacheTtlMs: 60_000 });
    await verifyIdToken(idp.sign(validPayload(idp)), c);
    const hitsAfterFirst = idp.jwksHits();
    await verifyIdToken(idp.sign(validPayload(idp)), c);
    assert.equal(idp.jwksHits(), hitsAfterFirst, 'a second verification within the TTL should reuse the cached JWKS');
  } finally {
    await idp.close();
  }
});

test('verifyIdToken: without an explicit jwksUrl, OIDC discovery finds it via .well-known/openid-configuration', async () => {
  const idp = await startFakeIdp();
  try {
    clearJwksCacheForTests();
    const c: OidcConfig = { issuerUrl: idp.issuer, clientId: CLIENT_ID }; // no jwksUrl — forces discovery
    const token = idp.sign(validPayload(idp));
    const result = await verifyIdToken(token, c);
    assert.equal(result.valid, true);
  } finally {
    await idp.close();
  }
});

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
