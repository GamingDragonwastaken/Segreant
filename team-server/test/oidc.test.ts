/**
 * Contract tests for oidc.ts's verifyIdToken — proves the jose-backed
 * verification (D-209) actually works against genuine RS256 and ES256
 * signatures and keeps the reasons server.ts and operators read, not just
 * that the code compiles. The adversarial matrix (algorithm confusion, key
 * types, malformed segments, claim shapes, clock boundaries, JWKS failure,
 * kid handling, issuer substitution, Unicode/coercion) is in
 * oidc-adversarial.test.ts. Both the signer (fakeIdp.ts) and verifier are
 * exercised together, the same "prove both sides interoperate" approach used
 * for the CLI↔server integration check in this slice.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { once } from 'node:events';
import { verifyIdToken, clearJwksCacheForTests, type OidcConfig } from '../src/oidc.ts';
import { startFakeIdp, type FakeIdp } from './fakeIdp.ts';

const CLIENT_ID = 'team-dashboard';

async function listen(server: http.Server): Promise<string> {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = (server.address() as AddressInfo).port;
  return `http://127.0.0.1:${port}`;
}

function close(server: http.Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

function unsignedToken(issuer: string): string {
  const now = Math.floor(Date.now() / 1000);
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT', kid: 'not-used' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({ iss: issuer, aud: CLIENT_ID, sub: 'alice@example.com', exp: now + 3600 })).toString('base64url');
  return `${header}.${payload}.AA`;
}

function cfg(idp: FakeIdp, overrides: Partial<OidcConfig> = {}): OidcConfig {
  return { issuerUrl: idp.issuer, clientId: CLIENT_ID, jwksUrl: idp.jwksUrl, ...overrides };
}

function validPayload(idp: FakeIdp, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const now = Math.floor(Date.now() / 1000);
  return { iss: idp.issuer, aud: CLIENT_ID, sub: 'alice@example.com', iat: now, exp: now + 3600, ...overrides };
}

async function serveMutatedJwks(
  idp: FakeIdp,
  kid: string,
  mutate: (key: Record<string, unknown>) => void,
): Promise<{ server: http.Server; url: string }> {
  const response = await fetch(idp.jwksUrl);
  assert.equal(response.ok, true);
  const document = await response.json() as { keys?: unknown };
  assert.ok(Array.isArray(document.keys));
  const key = document.keys.find(
    (candidate): candidate is Record<string, unknown> =>
      typeof candidate === 'object' && candidate !== null && (candidate as Record<string, unknown>).kid === kid,
  );
  assert.ok(key, `fake IdP did not publish a key with kid=${kid}`);
  mutate(key);

  const server = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ keys: document.keys }));
  });
  const base = await listen(server);
  return { server, url: `${base}/jwks.json` };
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

test('verifyIdToken: a signed token without sub is rejected even if it has an email claim', async () => {
  const idp = await startFakeIdp();
  try {
    const token = idp.sign(validPayload(idp, { sub: undefined, email: 'alice@example.com' }));
    const result = await verifyIdToken(token, cfg(idp));
    assert.equal(result.valid, false);
    if (!result.valid) assert.match(result.reason, /non-empty OIDC subject claim/);
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

test('verifyIdToken: a token with nbf inside the 60-second clock-skew allowance is accepted', async () => {
  const idp = await startFakeIdp();
  try {
    const verifierNow = 1_800_000_000;
    const token = idp.sign(validPayload(idp, { iat: verifierNow, exp: verifierNow + 3600, nbf: verifierNow + 30 }));
    const result = await verifyIdToken(token, cfg(idp), { nowEpochSeconds: () => verifierNow });
    assert.equal(result.valid, true);
  } finally {
    await idp.close();
  }
});

test('verifyIdToken: a token exactly at the 60-second clock-skew boundary is accepted', async () => {
  const idp = await startFakeIdp();
  try {
    const verifierNow = 1_800_000_000;
    const token = idp.sign(validPayload(idp, { iat: verifierNow, exp: verifierNow + 3600, nbf: verifierNow + 60 }));
    const result = await verifyIdToken(token, cfg(idp), { nowEpochSeconds: () => verifierNow });
    assert.equal(result.valid, true);
  } finally {
    await idp.close();
  }
});

test('verifyIdToken: a token one second beyond the clock-skew allowance is rejected', async () => {
  const idp = await startFakeIdp();
  try {
    const verifierNow = 1_800_000_000;
    const token = idp.sign(validPayload(idp, { iat: verifierNow, exp: verifierNow + 3600, nbf: verifierNow + 61 }));
    const result = await verifyIdToken(token, cfg(idp), { nowEpochSeconds: () => verifierNow });
    assert.equal(result.valid, false);
    if (!result.valid) assert.match(result.reason, /not valid yet \(nbf\)/);
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

test('verifyIdToken: a multi-audience token with a matching azp is accepted', async () => {
  const idp = await startFakeIdp();
  try {
    const token = idp.sign(validPayload(idp, { aud: [CLIENT_ID, 'another-application'], azp: CLIENT_ID }));
    const result = await verifyIdToken(token, cfg(idp));
    assert.equal(result.valid, true);
  } finally {
    await idp.close();
  }
});

test('verifyIdToken: a multi-audience token without a matching azp is rejected', async () => {
  const idp = await startFakeIdp();
  try {
    const token = idp.sign(validPayload(idp, { aud: [CLIENT_ID, 'another-application'] }));
    const result = await verifyIdToken(token, cfg(idp));
    assert.equal(result.valid, false);
    if (!result.valid) assert.match(result.reason, /authorized party mismatch/);
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

test('verifyIdToken: an illegal character in the header segment is rejected before JWKS retrieval', async () => {
  const idp = await startFakeIdp();
  try {
    clearJwksCacheForTests();
    const [header, payload, signature] = idp.sign(validPayload(idp)).split('.') as [string, string, string];
    const result = await verifyIdToken(`${header}!.${payload}.${signature}`, cfg(idp));
    assert.equal(result.valid, false);
    if (!result.valid) assert.match(result.reason, /canonical base64url/);
    assert.equal(idp.jwksHits(), 0, 'malformed header encoding must fail before fetching signing keys');
  } finally {
    await idp.close();
  }
});

test('verifyIdToken: non-canonical padding in the payload segment is rejected before JWKS retrieval', async () => {
  const idp = await startFakeIdp();
  try {
    clearJwksCacheForTests();
    const [header, payload, signature] = idp.sign(validPayload(idp)).split('.') as [string, string, string];
    const result = await verifyIdToken(`${header}.${payload}=.${signature}`, cfg(idp));
    assert.equal(result.valid, false);
    if (!result.valid) assert.match(result.reason, /canonical base64url/);
    assert.equal(idp.jwksHits(), 0, 'malformed payload encoding must fail before fetching signing keys');
  } finally {
    await idp.close();
  }
});

test('verifyIdToken: an illegal character in the signature segment is rejected instead of being ignored', async () => {
  const idp = await startFakeIdp();
  try {
    clearJwksCacheForTests();
    const [header, payload, signature] = idp.sign(validPayload(idp)).split('.') as [string, string, string];
    const result = await verifyIdToken(`${header}.${payload}.${signature}!`, cfg(idp));
    assert.equal(result.valid, false);
    if (!result.valid) assert.match(result.reason, /canonical base64url/);
  } finally {
    await idp.close();
  }
});

test('verifyIdToken: non-canonical padding in the signature segment is rejected instead of being ignored', async () => {
  const idp = await startFakeIdp();
  try {
    clearJwksCacheForTests();
    const [header, payload, signature] = idp.sign(validPayload(idp)).split('.') as [string, string, string];
    const result = await verifyIdToken(`${header}.${payload}.${signature}=`, cfg(idp));
    assert.equal(result.valid, false);
    if (!result.valid) assert.match(result.reason, /canonical base64url/);
  } finally {
    await idp.close();
  }
});

const jwkMetadataConflictCases: Array<{
  field: string;
  alg: 'RS256' | 'ES256';
  kid: string;
  mutate: (key: Record<string, unknown>) => void;
}> = [
  { field: 'alg', alg: 'RS256', kid: 'rsa-key-1', mutate: (key) => { key.alg = 'ES256'; } },
  { field: 'kty', alg: 'RS256', kid: 'rsa-key-1', mutate: (key) => { key.kty = 'EC'; } },
  { field: 'use', alg: 'RS256', kid: 'rsa-key-1', mutate: (key) => { key.use = 'enc'; } },
  { field: 'key_ops', alg: 'RS256', kid: 'rsa-key-1', mutate: (key) => { key.key_ops = ['encrypt']; } },
  { field: 'crv', alg: 'ES256', kid: 'ec-key-1', mutate: (key) => { key.crv = 'P-384'; } },
];

for (const conflict of jwkMetadataConflictCases) {
  test(`verifyIdToken: a JWK ${conflict.field} conflict is rejected`, async () => {
    const idp = await startFakeIdp();
    let mutated: { server: http.Server; url: string } | undefined;
    try {
      clearJwksCacheForTests();
      mutated = await serveMutatedJwks(idp, conflict.kid, conflict.mutate);
      const token = idp.sign(validPayload(idp), { alg: conflict.alg });
      const result = await verifyIdToken(token, cfg(idp, { jwksUrl: mutated.url }));
      assert.equal(result.valid, false);
      if (!result.valid) assert.match(result.reason, /signing key metadata conflict/);
    } finally {
      if (mutated) await close(mutated.server);
      await idp.close();
    }
  });
}

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
    const c: OidcConfig = { issuerUrl: idp.issuer, clientId: CLIENT_ID };
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
    const c: OidcConfig = { issuerUrl: idp.issuer, clientId: CLIENT_ID };
    await verifyIdToken(idp.sign(validPayload(idp)), c);
    const hitsAfterFirst = idp.wellKnownHits();
    await verifyIdToken(idp.sign(validPayload(idp)), c);
    assert.equal(idp.wellKnownHits(), hitsAfterFirst, 'a second verification should reuse the cached discovery result, not re-hit .well-known');
  } finally {
    await idp.close();
  }
});

test('verifyIdToken: a key rotated in after the JWKS was cached is still accepted (forces one refresh on unknown kid once the cooldown allows)', async () => {
  const idp = await startFakeIdp();
  try {
    clearJwksCacheForTests();
    // The refresh cooldown is measured from the last successful JWKS fetch
    // (jose semantics, D-209), so with the default 30s cooldown a rotation
    // landing seconds after the cache primed would be refused until the
    // cooldown lapses. Zero here isolates the rotation behaviour; the
    // cooldown itself is proven in oidc-adversarial.test.ts (unknown-kid storm).
    const c = cfg(idp, { jwksCacheTtlMs: 60_000, jwksRefreshCooldownMs: 0 } as Partial<OidcConfig>);
    await verifyIdToken(idp.sign(validPayload(idp)), c);
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
    const token = idp.sign(validPayload(idp), { alg: 'RS256', header: { alg: 'RS256', typ: 'JWT' } });
    const result = await verifyIdToken(token, cfg(idp));
    assert.equal(result.valid, true);
  } finally {
    await idp.close();
  }
});

test('verifyIdToken: a JWKS redirect is refused and never followed to its Location target', async () => {
  let sinkHits = 0;
  const sink = http.createServer((_req, res) => {
    sinkHits += 1;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ keys: [] }));
  });
  const sinkUrl = await listen(sink);
  const redirect = http.createServer((_req, res) => {
    res.writeHead(302, { location: `${sinkUrl}/jwks.json` });
    res.end();
  });
  const issuer = await listen(redirect);
  try {
    clearJwksCacheForTests();
    const result = await verifyIdToken(unsignedToken(issuer), {
      issuerUrl: issuer,
      clientId: CLIENT_ID,
      jwksUrl: `${issuer}/jwks.json`,
    });
    assert.equal(result.valid, false);
    assert.equal(sinkHits, 0, 'JWKS redirects must not reach a second destination');
  } finally {
    await close(redirect);
    await close(sink);
  }
});

test('verifyIdToken: discovered JWKS must remain on the configured issuer origin', async () => {
  let sinkHits = 0;
  const sink = http.createServer((_req, res) => {
    sinkHits += 1;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ keys: [] }));
  });
  const sinkUrl = await listen(sink);
  const discovery = http.createServer((req, res) => {
    const path = new URL(req.url ?? '/', 'http://localhost').pathname;
    if (path === '/.well-known/openid-configuration') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ jwks_uri: `${sinkUrl}/jwks.json` }));
      return;
    }
    res.writeHead(404);
    res.end();
  });
  const issuer = await listen(discovery);
  try {
    clearJwksCacheForTests();
    const result = await verifyIdToken(unsignedToken(issuer), { issuerUrl: issuer, clientId: CLIENT_ID });
    assert.equal(result.valid, false);
    assert.equal(sinkHits, 0, 'discovery must not redirect JWKS retrieval to an unrelated origin');
  } finally {
    await close(discovery);
    await close(sink);
  }
});

test('verifyIdToken: oversized discovery/JWKS bodies fail closed before a second refresh', async () => {
  let hits = 0;
  const oversized = http.createServer((_req, res) => {
    hits += 1;
    const body = JSON.stringify({ keys: [], padding: 'x'.repeat(300_000) });
    res.writeHead(200, { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(body)) });
    res.end(body);
  });
  const issuer = await listen(oversized);
  try {
    clearJwksCacheForTests();
    const result = await verifyIdToken(unsignedToken(issuer), {
      issuerUrl: issuer,
      clientId: CLIENT_ID,
      jwksUrl: `${issuer}/jwks.json`,
    });
    assert.equal(result.valid, false);
    assert.equal(hits, 1, 'an oversized JWKS must not trigger the unknown-kid refresh loop');
  } finally {
    await close(oversized);
  }
});
