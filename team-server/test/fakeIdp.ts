/**
 * A minimal in-process fake OIDC identity provider for tests: serves
 * .well-known/openid-configuration and a JWKS endpoint, and signs JWTs with
 * real keypairs — so oidc.test.ts proves verifyIdToken against genuine
 * RS256/ES256 signatures rather than assuming node:crypto's JWK/dsaEncoding
 * handling works. Mirrors the startMockJudge/startMockUpstream pattern used
 * elsewhere in this project's tests.
 */

import http from 'node:http';
import { generateKeyPairSync, sign as cryptoSign, type KeyObject } from 'node:crypto';

export interface FakeIdp {
  url: string;
  issuer: string;
  jwksUrl: string;
  rsaKid: string;
  ecKid: string;
  /** Signs a JWT with the given algorithm's keypair. Pass a raw header to override alg/kid for attack scenarios. */
  sign(payload: Record<string, unknown>, opts?: { alg?: 'RS256' | 'ES256'; header?: Record<string, unknown> }): string;
  jwksHits: () => number;
  close(): Promise<void>;
}

function base64url(buf: Buffer): string {
  return buf.toString('base64url');
}

export async function startFakeIdp(): Promise<FakeIdp> {
  const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const ec = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const rsaKid = 'rsa-key-1';
  const ecKid = 'ec-key-1';

  const rsaJwk = { ...(rsa.publicKey.export({ format: 'jwk' }) as Record<string, unknown>), kid: rsaKid, alg: 'RS256', use: 'sig' };
  const ecJwk = { ...(ec.publicKey.export({ format: 'jwk' }) as Record<string, unknown>), kid: ecKid, alg: 'ES256', use: 'sig' };

  let jwksHits = 0;
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (url.pathname === '/.well-known/openid-configuration') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ issuer: issuerUrl(), jwks_uri: `${issuerUrl()}/jwks.json` }));
      return;
    }
    if (url.pathname === '/jwks.json') {
      jwksHits += 1;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ keys: [rsaJwk, ecJwk] }));
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

  return {
    url: base,
    issuer: base,
    jwksUrl: `${base}/jwks.json`,
    rsaKid,
    ecKid,
    sign,
    jwksHits: () => jwksHits,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}
