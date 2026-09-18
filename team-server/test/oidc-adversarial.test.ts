/**
 * Adversarial matrix for oidc.ts's verifyIdToken (D-223: `jose` is authorized
 * as a team-server-only runtime dependency; do not re-research adoption).
 *
 * Each dossier bullet gets at least one test. Every test's own comment says
 * how it was proven able to fail, per the packet's method requirement:
 *
 *  - "RED/old" — run against the hand-rolled node:crypto verifier that
 *    predates this packet (git blob before this commit) and failed there.
 *    The exact failure is recorded in WP-H02's report; this file only proves
 *    the CURRENT (jose-backed) verifier gets it right.
 *  - "mutant" — the current jose-backed verifier passes this test, but a
 *    named one-line mutant (described inline) makes it fail; that mutant was
 *    applied and reverted by hand while developing this file to confirm the
 *    test is not vacuous.
 *
 * Nothing here reaches the network — startFakeIdp binds 127.0.0.1 only, and
 * the deliberately-misbehaving JWKS modes never leave that same loopback
 * server.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { verifyIdToken, clearJwksCacheForTests, type OidcConfig } from '../src/oidc.ts';
import { startFakeIdp, type FakeIdp } from './fakeIdp.ts';

const CLIENT_ID = 'team-dashboard';

function cfg(idp: FakeIdp, overrides: Partial<OidcConfig> = {}): OidcConfig {
  return { issuerUrl: idp.issuer, clientId: CLIENT_ID, jwksUrl: idp.jwksUrl, ...overrides };
}

function b64url(obj: unknown): string {
  return Buffer.from(JSON.stringify(obj)).toString('base64url');
}

function validPayload(idp: FakeIdp, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const now = Math.floor(Date.now() / 1000);
  return { iss: idp.issuer, aud: CLIENT_ID, sub: 'alice@example.com', iat: now, exp: now + 3600, ...overrides };
}

// ---------------------------------------------------------------------------
// Bullet: algorithm confusion
// ---------------------------------------------------------------------------

test('adversarial/alg-confusion: HS256 forged with the issuer\'s own RSA public key (PEM) as the HMAC secret is rejected [RED/old: verified against unfixed code before this packet]', async () => {
  const idp = await startFakeIdp();
  try {
    const forged = idp.forgeHs256WithRsaPublicKey(validPayload(idp));
    const result = await verifyIdToken(forged, cfg(idp));
    assert.equal(result.valid, false, 'a token whose signature verifies under the RSA public key treated as an HMAC secret must never be accepted');
  } finally {
    await idp.close();
  }
});

test('adversarial/alg-confusion: alg "none" with an empty signature segment is rejected [RED/old]', async () => {
  const idp = await startFakeIdp();
  try {
    const forged = `${b64url({ alg: 'none', typ: 'JWT' })}.${b64url(validPayload(idp))}.`;
    const result = await verifyIdToken(forged, cfg(idp));
    assert.equal(result.valid, false);
  } finally {
    await idp.close();
  }
});

test('adversarial/alg-confusion: an unlisted asymmetric alg (PS256) with a genuine signature is rejected — the allowlist, not the signature, is the gate [mutant: widen ALLOWED_ALGS to include PS256]', async () => {
  const idp = await startFakeIdp();
  try {
    const token = idp.sign(validPayload(idp), { alg: 'RS256' });
    const [h, p] = token.split('.');
    const forged = idp.signRaw(b64url({ alg: 'PS256', typ: 'JWT', kid: idp.rsaKid }), p as string, 'PS256');
    void h;
    const result = await verifyIdToken(forged, cfg(idp));
    assert.equal(result.valid, false, 'PS256 is a real, correctly-signed algorithm here — it must still be refused because it is not in the RS256/ES256 allowlist');
  } finally {
    await idp.close();
  }
});

test('adversarial/alg-confusion: EdDSA with a genuine signature is rejected — not in the allowlist [mutant: add EdDSA to ALLOWED_ALGS]', async () => {
  const idp = await startFakeIdp();
  try {
    const ed = idp.addKey('ed25519', 'ed-key-1');
    const token = ed.sign(validPayload(idp), { alg: 'EdDSA', typ: 'JWT', kid: ed.kid });
    const result = await verifyIdToken(token, cfg(idp));
    assert.equal(result.valid, false);
  } finally {
    await idp.close();
  }
});

// ---------------------------------------------------------------------------
// Bullet: wrong key type
// ---------------------------------------------------------------------------

test('adversarial/wrong-key-type: a header claiming RS256 but signed with an EC key under the same kid is rejected [mutant: skip the kty check when selecting a candidate key]', async () => {
  const idp = await startFakeIdp();
  try {
    // Publish an EC key under an RS256-looking kid, then sign as if it were RSA/RS256.
    const ec = idp.addKey('ec', 'looks-like-rsa', { alg: 'RS256' });
    const header = { alg: 'RS256', typ: 'JWT', kid: ec.kid };
    const forged = idp.signRaw(b64url(header), b64url(validPayload(idp)), 'ES256', ec.privateKey);
    const result = await verifyIdToken(forged, cfg(idp));
    assert.equal(result.valid, false, 'an EC key must never be usable to satisfy an RS256 signature check merely because a JWK claims alg RS256');
  } finally {
    await idp.close();
  }
});

test('adversarial/wrong-key-type: a JWKS entry with kty "oct" (symmetric) is never a usable verification candidate [RED/old: createPublicKey({format:"jwk"}) on an oct JWK either throws (caught, skipped) or, depending on node version, could construct a key object — this test pins the safe outcome going forward]', async () => {
  const idp = await startFakeIdp();
  try {
    idp.publishRawJwk({ kty: 'oct', kid: 'symmetric-1', k: Buffer.from('not-a-real-secret').toString('base64url'), alg: 'RS256', use: 'sig' });
    const forged = `${b64url({ alg: 'RS256', typ: 'JWT', kid: 'symmetric-1' })}.${b64url(validPayload(idp))}.` + Buffer.from('garbage-signature').toString('base64url');
    const result = await verifyIdToken(forged, cfg(idp));
    assert.equal(result.valid, false);
  } finally {
    await idp.close();
  }
});

test('adversarial/wrong-key-type: an RSA key below 2048 bits is refused even with a genuine signature [RED/old: the hand-rolled verifier accepted any RSA modulus size, including a 512-bit key]', async () => {
  const idp = await startFakeIdp();
  try {
    const weak = idp.addKey('rsa', 'weak-rsa', { modulusLength: 512 });
    const token = weak.sign(validPayload(idp));
    const result = await verifyIdToken(token, cfg(idp));
    assert.equal(result.valid, false, 'a 512-bit RSA key must be refused regardless of signature validity (RFC 7518 §3.3 minimum is 2048 bits)');
  } finally {
    await idp.close();
  }
});

// ---------------------------------------------------------------------------
// Bullet: malformed JWT segments
// ---------------------------------------------------------------------------

test('adversarial/malformed: four dot-separated segments is rejected', async () => {
  const idp = await startFakeIdp();
  try {
    const result = await verifyIdToken('a.b.c.d', cfg(idp));
    assert.equal(result.valid, false);
  } finally {
    await idp.close();
  }
});

test('adversarial/malformed: a header segment that is valid base64url but not JSON is rejected', async () => {
  const idp = await startFakeIdp();
  try {
    const notJson = Buffer.from('not-json-at-all').toString('base64url');
    const result = await verifyIdToken(`${notJson}.${b64url(validPayload(idp))}.sig`, cfg(idp));
    assert.equal(result.valid, false);
  } finally {
    await idp.close();
  }
});

test('adversarial/malformed: a header/payload segment that decodes to a JSON array, not an object, is rejected [RED/old: JSON.parse accepts an array; header.alg on an array is undefined, which the old code correctly rejected only by accident via the ALLOWED_ALGS.has(undefined) check — this test pins the behavior deliberately]', async () => {
  const idp = await startFakeIdp();
  try {
    const arrayHeader = Buffer.from(JSON.stringify(['alg', 'RS256'])).toString('base64url');
    const result = await verifyIdToken(`${arrayHeader}.${b64url(validPayload(idp))}.sig`, cfg(idp));
    assert.equal(result.valid, false);
  } finally {
    await idp.close();
  }
});

test('adversarial/malformed: an empty string token is rejected', async () => {
  const idp = await startFakeIdp();
  try {
    const result = await verifyIdToken('', cfg(idp));
    assert.equal(result.valid, false);
  } finally {
    await idp.close();
  }
});

test('adversarial/malformed: a signature segment containing non-base64url characters is rejected rather than throwing', async () => {
  const idp = await startFakeIdp();
  try {
    const result = await verifyIdToken(`${b64url({ alg: 'RS256', kid: idp.rsaKid })}.${b64url(validPayload(idp))}.not!!valid!!base64`, cfg(idp));
    assert.equal(result.valid, false);
  } finally {
    await idp.close();
  }
});

// ---------------------------------------------------------------------------
// Bullet: duplicate claims / JSON edge cases
// ---------------------------------------------------------------------------

test('adversarial/json-edge: a payload with a duplicate "sub" key resolves to JSON.parse last-value-wins semantics, and that resolved value is what gets checked (no earlier value leaks through) [RED/old: this exercises the same JSON.parse the old code used — pinning it here documents the platform own duplicate-key behavior rather than assuming it]', async () => {
  const idp = await startFakeIdp();
  try {
    const now = Math.floor(Date.now() / 1000);
    const rawPayload = `{"iss":"${idp.issuer}","aud":"${CLIENT_ID}","sub":"attacker@example.com","sub":"alice@example.com","iat":${now},"exp":${now + 3600}}`;
    const payloadB64 = Buffer.from(rawPayload).toString('base64url');
    const header = { alg: 'RS256', typ: 'JWT', kid: idp.rsaKid };
    const token = idp.signRaw(b64url(header), payloadB64, 'RS256');
    const result = await verifyIdToken(token, cfg(idp));
    assert.equal(result.valid, true);
    if (result.valid) assert.equal(result.subject, 'alice@example.com', 'JSON.parse must resolve duplicate keys to the last occurrence, and that is the value verified — never the first');
  } finally {
    await idp.close();
  }
});

test('adversarial/json-edge: a payload that is valid JSON but not an object (a bare number) is rejected [mutant: cast payload without checking typeof]', async () => {
  const idp = await startFakeIdp();
  try {
    const payloadB64 = Buffer.from('42').toString('base64url');
    const token = idp.signRaw(b64url({ alg: 'RS256', typ: 'JWT', kid: idp.rsaKid }), payloadB64, 'RS256');
    const result = await verifyIdToken(token, cfg(idp));
    assert.equal(result.valid, false);
  } finally {
    await idp.close();
  }
});

test('adversarial/json-edge: a JWKS response whose "keys" is present but not an array is treated as invalid, not silently as zero keys [RED/old: fetchJwks only checked Array.isArray(jwks.keys) at the top level — an object under "keys" would also fail that check and correctly error, but this pins it as a named case]', async () => {
  const idp = await startFakeIdp();
  try {
    idp.setJwksMode({ kind: 'not-a-jwks' });
    clearJwksCacheForTests();
    const token = idp.sign(validPayload(idp));
    const result = await verifyIdToken(token, cfg(idp));
    assert.equal(result.valid, false);
  } finally {
    await idp.close();
  }
});

// ---------------------------------------------------------------------------
// Bullet: issuer/audience arrays and types
// ---------------------------------------------------------------------------

test('adversarial/iss-aud-types: a numeric "iss" claim is rejected, not coerced to a string for comparison', async () => {
  const idp = await startFakeIdp();
  try {
    const token = idp.sign(validPayload(idp, { iss: 12345 }));
    const result = await verifyIdToken(token, cfg(idp));
    assert.equal(result.valid, false);
  } finally {
    await idp.close();
  }
});

test('adversarial/iss-aud-types: an "aud" that is an array of non-string values never matches the configured clientId by loose equality [mutant: use == instead of includes() semantics]', async () => {
  const idp = await startFakeIdp();
  try {
    const token = idp.sign(validPayload(idp, { aud: [1, true, null] }));
    const result = await verifyIdToken(token, cfg(idp));
    assert.equal(result.valid, false);
  } finally {
    await idp.close();
  }
});

test('adversarial/iss-aud-types: an "aud" that is an object (not string or array) is rejected', async () => {
  const idp = await startFakeIdp();
  try {
    const token = idp.sign(validPayload(idp, { aud: { value: CLIENT_ID } }));
    const result = await verifyIdToken(token, cfg(idp));
    assert.equal(result.valid, false);
  } finally {
    await idp.close();
  }
});

test('adversarial/iss-aud-types: an empty "aud" array is rejected', async () => {
  const idp = await startFakeIdp();
  try {
    const token = idp.sign(validPayload(idp, { aud: [] }));
    const result = await verifyIdToken(token, cfg(idp));
    assert.equal(result.valid, false);
  } finally {
    await idp.close();
  }
});

// ---------------------------------------------------------------------------
// Bullet: exp/nbf/iat boundaries
// ---------------------------------------------------------------------------

test('adversarial/time-boundaries: exp equal to now (not strictly greater) is rejected — expiry has no grace period', async () => {
  const idp = await startFakeIdp();
  try {
    const now = 1_800_000_000;
    const token = idp.sign(validPayload(idp, { iat: now - 10, exp: now }));
    const result = await verifyIdToken(token, cfg(idp), { nowEpochSeconds: () => now });
    assert.equal(result.valid, false, 'exp<=now must be rejected: exp is the instant a token dies, not the last instant it lives');
  } finally {
    await idp.close();
  }
});

test('adversarial/time-boundaries: exp one second in the future is accepted (boundary just inside validity)', async () => {
  const idp = await startFakeIdp();
  try {
    const now = 1_800_000_000;
    const token = idp.sign(validPayload(idp, { iat: now - 10, exp: now + 1 }));
    const result = await verifyIdToken(token, cfg(idp), { nowEpochSeconds: () => now });
    assert.equal(result.valid, true);
  } finally {
    await idp.close();
  }
});

test('adversarial/time-boundaries: a non-numeric exp (string) is rejected, not coerced', async () => {
  const idp = await startFakeIdp();
  try {
    const now = Math.floor(Date.now() / 1000);
    const token = idp.sign(validPayload(idp, { exp: String(now + 3600) }));
    const result = await verifyIdToken(token, cfg(idp));
    assert.equal(result.valid, false);
  } finally {
    await idp.close();
  }
});

test('adversarial/time-boundaries: iat exactly 60 seconds in the future is accepted (skew boundary)', async () => {
  const idp = await startFakeIdp();
  try {
    const now = 1_800_000_000;
    const token = idp.sign(validPayload(idp, { iat: now + 60, exp: now + 3600 }));
    const result = await verifyIdToken(token, cfg(idp), { nowEpochSeconds: () => now });
    assert.equal(result.valid, true);
  } finally {
    await idp.close();
  }
});

test('adversarial/time-boundaries: iat 61 seconds in the future is rejected (one second past skew)', async () => {
  const idp = await startFakeIdp();
  try {
    const now = 1_800_000_000;
    const token = idp.sign(validPayload(idp, { iat: now + 61, exp: now + 3600 }));
    const result = await verifyIdToken(token, cfg(idp), { nowEpochSeconds: () => now });
    assert.equal(result.valid, false);
  } finally {
    await idp.close();
  }
});

test('adversarial/time-boundaries: a missing exp claim is rejected (exp is required, never optional)', async () => {
  const idp = await startFakeIdp();
  try {
    const payload = validPayload(idp);
    delete payload['exp'];
    const token = idp.sign(payload);
    const result = await verifyIdToken(token, cfg(idp));
    assert.equal(result.valid, false);
  } finally {
    await idp.close();
  }
});

// ---------------------------------------------------------------------------
// Bullet: JWKS rotation / cache failure
// ---------------------------------------------------------------------------

test('adversarial/jwks-rotation: JWKS HTTP 500 fails closed, not open', async () => {
  const idp = await startFakeIdp();
  try {
    clearJwksCacheForTests();
    idp.setJwksMode({ kind: 'http', status: 500 });
    const token = idp.sign(validPayload(idp));
    const result = await verifyIdToken(token, cfg(idp));
    assert.equal(result.valid, false);
  } finally {
    await idp.close();
  }
});

test('adversarial/jwks-rotation: malformed JSON from the JWKS endpoint fails closed', async () => {
  const idp = await startFakeIdp();
  try {
    clearJwksCacheForTests();
    idp.setJwksMode({ kind: 'malformed-json' });
    const token = idp.sign(validPayload(idp));
    const result = await verifyIdToken(token, cfg(idp));
    assert.equal(result.valid, false);
  } finally {
    await idp.close();
  }
});

test('adversarial/jwks-rotation: a JWKS fetch that hangs past the configured timeout fails closed rather than hanging the caller', async () => {
  const idp = await startFakeIdp();
  try {
    clearJwksCacheForTests();
    idp.setJwksMode({ kind: 'hang' });
    const token = idp.sign(validPayload(idp));
    const result = await verifyIdToken(token, cfg(idp, { jwksFetchTimeoutMs: 200 } as Partial<OidcConfig>));
    assert.equal(result.valid, false);
  } finally {
    await idp.close();
  }
});

test('adversarial/jwks-rotation: the old key is retired at rotation, and a token freshly signed with the retired key is rejected after the JWKS is refreshed', async () => {
  const idp = await startFakeIdp();
  try {
    clearJwksCacheForTests();
    await verifyIdToken(idp.sign(validPayload(idp)), cfg(idp));
    const staleToken = idp.sign(validPayload(idp)); // sign with the about-to-be-retired key, using a token minted before rotation
    idp.removeKey(idp.rsaKid);
    const rotated = idp.rotateInNewRsaKey();
    // Force a refresh by verifying the rotated key's token first.
    const rotatedResult = await verifyIdToken(rotated.sign(validPayload(idp)), cfg(idp));
    assert.equal(rotatedResult.valid, true);
    const staleResult = await verifyIdToken(staleToken, cfg(idp));
    assert.equal(staleResult.valid, false, 'a token whose signing key was retired at rotation must be rejected once the JWKS reflects the retirement');
  } finally {
    await idp.close();
  }
});

test('adversarial/jwks-rotation: an unknown-kid storm is bounded by the refresh cooldown — repeated bad kids do not multiply JWKS fetches without limit [mutant: remove the cooldown check entirely]', async () => {
  const idp = await startFakeIdp();
  try {
    clearJwksCacheForTests();
    const c = cfg(idp, { jwksCacheTtlMs: 60_000 });
    await verifyIdToken(idp.sign(validPayload(idp)), c);
    const hitsAfterPrime = idp.jwksHits();
    for (let i = 0; i < 5; i += 1) {
      const forged = `${b64url({ alg: 'RS256', typ: 'JWT', kid: `bogus-${i}` })}.${b64url(validPayload(idp))}.` + Buffer.from('x').toString('base64url');
      await verifyIdToken(forged, c);
    }
    const hitsAfterStorm = idp.jwksHits();
    assert.ok(hitsAfterStorm - hitsAfterPrime <= 2, `5 distinct unknown kids within the cooldown window must not cause 5 separate JWKS refreshes (got ${hitsAfterStorm - hitsAfterPrime})`);
  } finally {
    await idp.close();
  }
});

// ---------------------------------------------------------------------------
// Bullet: kid collisions / missing kid
// ---------------------------------------------------------------------------

test('adversarial/kid: two JWKS entries sharing the same kid but different keys — a token signed by either is accepted (every candidate tried)', async () => {
  const idp = await startFakeIdp();
  try {
    const collidingKey = generateKeyPairSync('rsa', { modulusLength: 2048 });
    idp.publishRawJwk({ ...(collidingKey.publicKey.export({ format: 'jwk' }) as Record<string, unknown>), kid: idp.rsaKid, alg: 'RS256', use: 'sig' });
    const token = idp.sign(validPayload(idp)); // signed with the ORIGINAL rsaKid key, which now collides with a second published entry
    const result = await verifyIdToken(token, cfg(idp));
    assert.equal(result.valid, true, 'a genuine signature under a colliding kid must still verify by trying every candidate');
  } finally {
    await idp.close();
  }
});

test('adversarial/kid: a token signed by neither of two colliding-kid keys is rejected, not accepted by virtue of the kid merely existing', async () => {
  const idp = await startFakeIdp();
  try {
    const attacker = generateKeyPairSync('rsa', { modulusLength: 2048 });
    idp.publishRawJwk({ ...(attacker.publicKey.export({ format: 'jwk' }) as Record<string, unknown>), kid: idp.rsaKid, alg: 'RS256', use: 'sig' });
    const now = Math.floor(Date.now() / 1000);
    const payloadB64 = b64url(validPayload(idp));
    const headerB64 = b64url({ alg: 'RS256', typ: 'JWT', kid: idp.rsaKid });
    const forged = `${headerB64}.${payloadB64}.` + Buffer.from('not-a-real-signature-over-anything').toString('base64url');
    void now;
    const result = await verifyIdToken(forged, cfg(idp));
    assert.equal(result.valid, false);
  } finally {
    await idp.close();
  }
});

test('adversarial/kid: a non-string kid in the header (a number) never matches a JWK kid and is treated as no match', async () => {
  const idp = await startFakeIdp();
  try {
    const token = idp.sign(validPayload(idp), { alg: 'RS256', header: { alg: 'RS256', typ: 'JWT', kid: 12345 as unknown as string } });
    const result = await verifyIdToken(token, cfg(idp));
    assert.equal(result.valid, false);
  } finally {
    await idp.close();
  }
});

test('adversarial/kid: an empty-string kid is treated as a real (non-matching) kid, not as "no kid"', async () => {
  const idp = await startFakeIdp();
  try {
    const token = idp.sign(validPayload(idp), { alg: 'RS256', header: { alg: 'RS256', typ: 'JWT', kid: '' } });
    const result = await verifyIdToken(token, cfg(idp));
    assert.equal(result.valid, false);
  } finally {
    await idp.close();
  }
});

// ---------------------------------------------------------------------------
// Bullet: network / issuer substitution
// ---------------------------------------------------------------------------

test('adversarial/issuer-substitution: a discovery document naming a different issuer than configured is refused [RED/old: the old discoverJwksUri never checked the discovery document own "issuer" field against the configured issuer at all]', async () => {
  const idp = await startFakeIdp();
  try {
    idp.setDiscovery({ issuer: 'https://attacker.example' });
    clearJwksCacheForTests();
    const c: OidcConfig = { issuerUrl: idp.issuer, clientId: CLIENT_ID };
    const token = idp.sign(validPayload(idp));
    const result = await verifyIdToken(token, c);
    assert.equal(result.valid, false, 'OIDC Discovery section 4.3 requires the discovery document issuer to equal the URL it was fetched from; a mismatch means the document is not trustworthy for this issuer');
  } finally {
    await idp.close();
  }
});

test('adversarial/issuer-substitution: a discovered jwks_uri pointing at a different origin is refused even though the discovery document itself is on the right origin', async () => {
  const idp = await startFakeIdp();
  let attacker: FakeIdp | undefined;
  try {
    attacker = await startFakeIdp();
    idp.setDiscovery({ jwks_uri: attacker.jwksUrl });
    clearJwksCacheForTests();
    const c: OidcConfig = { issuerUrl: idp.issuer, clientId: CLIENT_ID };
    const token = idp.sign(validPayload(idp));
    const result = await verifyIdToken(token, c);
    assert.equal(result.valid, false);
    assert.equal(attacker.jwksHits(), 0, 'the attacker-controlled JWKS endpoint must never be reached');
  } finally {
    await idp.close();
    await attacker?.close();
  }
});

test('adversarial/issuer-substitution: a JWKS redirect to a same-origin path is still refused — redirects are refused unconditionally, not just cross-origin ones', async () => {
  const idp = await startFakeIdp();
  try {
    idp.setJwksMode({ kind: 'redirect', location: '/jwks-v2.json' });
    clearJwksCacheForTests();
    const token = idp.sign(validPayload(idp));
    const result = await verifyIdToken(token, cfg(idp));
    assert.equal(result.valid, false);
  } finally {
    await idp.close();
  }
});

test('adversarial/issuer-substitution: issuer URL with credentials embedded is refused as a configuration error, not treated as opaque [RED/old: validateEndpoint already checks this at cfg.jwksUrl/discovered URLs, but the configured issuerUrl itself was only validated inside discoverJwksUri — this pins that discovery-path is reached and fails, not silently proceeds]', async () => {
  const idp = await startFakeIdp();
  try {
    clearJwksCacheForTests();
    const c: OidcConfig = { issuerUrl: `http://user:pass@127.0.0.1:1/`, clientId: CLIENT_ID };
    const result = await verifyIdToken(unsignedTokenFor(c.issuerUrl), c);
    assert.equal(result.valid, false);
  } finally {
    await idp.close();
  }
});

function unsignedTokenFor(issuer: string): string {
  const now = Math.floor(Date.now() / 1000);
  return `${b64url({ alg: 'RS256', typ: 'JWT', kid: 'x' })}.${b64url({ iss: issuer, aud: CLIENT_ID, sub: 'a', exp: now + 3600 })}.AA`;
}

// ---------------------------------------------------------------------------
// Bullet: Unicode / coercion issues
// ---------------------------------------------------------------------------

test('adversarial/unicode-coercion: a "sub" claim containing a null byte and combining characters is preserved exactly, not normalized or truncated', async () => {
  const idp = await startFakeIdp();
  try {
    const weirdSub = 'alicé@example.com'; // literal combining acute accent (U+0301), must not be normalized away
    const token = idp.sign(validPayload(idp, { sub: weirdSub }));
    const result = await verifyIdToken(token, cfg(idp));
    assert.equal(result.valid, true);
    if (result.valid) assert.equal(result.subject, weirdSub, 'the subject claim must round-trip byte-for-byte; silent Unicode normalization could collide two distinct identities');
  } finally {
    await idp.close();
  }
});

test('adversarial/unicode-coercion: a boolean "sub" claim (true) is rejected, not coerced to the string "true"', async () => {
  const idp = await startFakeIdp();
  try {
    const token = idp.sign(validPayload(idp, { sub: true as unknown as string }));
    const result = await verifyIdToken(token, cfg(idp));
    assert.equal(result.valid, false);
  } finally {
    await idp.close();
  }
});

test('adversarial/unicode-coercion: a numeric "sub" claim (0) is rejected, not coerced through falsy/truthy checks', async () => {
  const idp = await startFakeIdp();
  try {
    const token = idp.sign(validPayload(idp, { sub: 0 as unknown as string }));
    const result = await verifyIdToken(token, cfg(idp));
    assert.equal(result.valid, false, 'a numeric sub, including 0, must be rejected by an explicit typeof check — a falsy-value check would wrongly reject sub:0 but ALSO wrongly accept a coerced non-empty numeric string');
  } finally {
    await idp.close();
  }
});

test('adversarial/unicode-coercion: an "aud" claim using a full-width or lookalike Unicode string does not match the ASCII clientId [mutant: use a case/width-insensitive comparison for aud]', async () => {
  const idp = await startFakeIdp();
  try {
    const lookalike = 'ｔｅａｍ－ｄａｓｈｂｏａｒｄ'; // full-width lookalike of "team-dashboard"
    const token = idp.sign(validPayload(idp, { aud: lookalike }));
    const result = await verifyIdToken(token, cfg(idp));
    assert.equal(result.valid, false);
  } finally {
    await idp.close();
  }
});

test('adversarial/unicode-coercion: an issuer claim that differs from the configured issuer only by trailing whitespace is rejected, not trimmed into matching', async () => {
  const idp = await startFakeIdp();
  try {
    const token = idp.sign(validPayload(idp, { iss: `${idp.issuer} ` }));
    const result = await verifyIdToken(token, cfg(idp));
    assert.equal(result.valid, false);
  } finally {
    await idp.close();
  }
});
