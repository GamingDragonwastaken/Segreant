/**
 * A minimal in-process fake OIDC identity provider for tests: serves
 * .well-known/openid-configuration and a JWKS endpoint, and signs JWTs with
 * real keypairs — so oidc.test.ts and oidc-adversarial.test.ts prove
 * verifyIdToken against genuine signatures rather than assuming the JWK/
 * signature handling works. Mirrors the startMockJudge/startMockUpstream
 * pattern used elsewhere in this project's tests.
 *
 * Beyond the happy path it can misbehave on demand, because the adversarial
 * suite needs an IdP that:
 *  - signs arbitrary raw header/payload segments with a genuine key
 *    (`signRaw`), so claim-shape edge cases carry a real signature and reach
 *    the claim checks instead of dying at the signature check;
 *  - publishes extra keys of any type/strength under any kid (`addKey`) and
 *    retires them (`removeKey`), for rotation, kid-collision, weak-key and
 *    wrong-key-type cases;
 *  - fails its JWKS endpoint in controlled ways (`setJwksMode`): HTTP 500,
 *    malformed JSON, a non-JWKS document, a redirect to another origin, or a
 *    hang;
 *  - lies in its discovery document (`setDiscovery`) — a different `issuer`
 *    or a `jwks_uri` pointing somewhere else — for issuer-substitution cases.
 * Nothing here leaves the loopback interface.
 */

import http from 'node:http';
import {
  constants as cryptoConstants,
  generateKeyPairSync,
  createHmac,
  sign as cryptoSign,
  type KeyObject,
} from 'node:crypto';

export type FakeAlg = 'RS256' | 'ES256' | 'RS512' | 'PS256' | 'EdDSA';

export interface FakeKey {
  kid: string;
  privateKey: KeyObject;
  publicJwk: Record<string, unknown>;
  /** Signs a JSON payload under this key. `header` replaces the default {alg, typ, kid} header entirely when given. */
  sign(payload: Record<string, unknown>, header?: Record<string, unknown>): string;
}

export type JwksMode =
  | { kind: 'ok' }
  | { kind: 'http'; status: number }
  | { kind: 'malformed-json' }
  | { kind: 'not-a-jwks' }
  | { kind: 'redirect'; location: string }
  | { kind: 'oversized' }
  | { kind: 'hang' };

export interface FakeIdpOptions {
  /** Publish `alg` on each JWK (default true). Entra ID, for one, omits it — and only then does the verifier's own allowlist stand alone. */
  publishJwkAlg?: boolean;
}

export interface FakeIdp {
  url: string;
  issuer: string;
  jwksUrl: string;
  rsaKid: string;
  ecKid: string;
  rsaPublicKeyPem: string;
  sign(payload: Record<string, unknown>, opts?: { alg?: 'RS256' | 'ES256'; header?: Record<string, unknown> }): string;
  /** Genuine signature over arbitrary, already-encoded segments — the signing input is exactly `${headerB64}.${payloadB64}`. */
  signRaw(headerB64: string, payloadB64: string, alg?: FakeAlg, key?: KeyObject): string;
  /** The classic algorithm-confusion forgery: HS256 keyed with the issuer's own RSA public key PEM. */
  forgeHs256WithRsaPublicKey(payload: Record<string, unknown>, header?: Record<string, unknown>): string;
  jwksHits: () => number;
  wellKnownHits: () => number;
  /** Publishes a brand-new RSA keypair under the JWKS (simulating an IdP key rotation where the old JWKS was already cached) and returns a signer bound to it. The original rsaKid/ecKid stay published too, mirroring how real IdPs overlap old+new keys during a rotation window. */
  rotateInNewRsaKey(kid?: string): FakeKey;
  /** Publishes an additional key of the given kind under `kid`; `jwkOverrides` is merged into the published JWK (e.g. a wrong `alg`, `use`, or `kty`). */
  addKey(kind: 'rsa' | 'ec' | 'ed25519', kid: string, opts?: { modulusLength?: number; alg?: string | null; jwkOverrides?: Record<string, unknown> }): FakeKey;
  /** Retires every published key with this kid. */
  removeKey(kid: string): void;
  /** Publishes a raw JWK object verbatim (no private key — for entries that must never verify anything). */
  publishRawJwk(jwk: Record<string, unknown>): void;
  setJwksMode(mode: JwksMode): void;
  setDiscovery(overrides: { issuer?: string; jwks_uri?: string }): void;
  close(): Promise<void>;
}

function base64url(buf: Buffer): string {
  return buf.toString('base64url');
}

export async function startFakeIdp(options: FakeIdpOptions = {}): Promise<FakeIdp> {
  const publishJwkAlg = options.publishJwkAlg ?? true;
  const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const ec = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const rsaKid = 'rsa-key-1';
  const ecKid = 'ec-key-1';

  function jwkFor(publicKey: KeyObject, kid: string, alg: string | null, overrides: Record<string, unknown> = {}): Record<string, unknown> {
    const base = publicKey.export({ format: 'jwk' }) as Record<string, unknown>;
    return { ...base, kid, ...(alg ? { alg } : {}), use: 'sig', ...overrides };
  }

  const keys: Record<string, unknown>[] = [
    jwkFor(rsa.publicKey, rsaKid, publishJwkAlg ? 'RS256' : null),
    jwkFor(ec.publicKey, ecKid, publishJwkAlg ? 'ES256' : null),
  ];

  let jwksMode: JwksMode = { kind: 'ok' };
  let discoveryOverrides: { issuer?: string; jwks_uri?: string } = {};
  const hanging = new Set<http.ServerResponse>();

  let jwksHits = 0;
  let wellKnownHits = 0;
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (url.pathname === '/.well-known/openid-configuration') {
      wellKnownHits += 1;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ issuer: issuerUrl(), jwks_uri: `${issuerUrl()}/jwks.json`, ...discoveryOverrides }));
      return;
    }
    if (url.pathname === '/jwks.json') {
      jwksHits += 1;
      switch (jwksMode.kind) {
        case 'http':
          res.writeHead(jwksMode.status, { 'content-type': 'text/plain' });
          res.end('jwks unavailable');
          return;
        case 'malformed-json':
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end('{"keys": [');
          return;
        case 'not-a-jwks':
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ message: 'not a key set' }));
          return;
        case 'redirect':
          res.writeHead(302, { location: jwksMode.location });
          res.end();
          return;
        case 'oversized': {
          const body = JSON.stringify({ keys, padding: 'x'.repeat(300_000) });
          res.writeHead(200, { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(body)) });
          res.end(body);
          return;
        }
        case 'hang':
          hanging.add(res);
          return; // never answered; closed on close()
        case 'ok':
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ keys }));
          return;
      }
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

  function rawSignature(signingInput: Buffer, alg: FakeAlg, key: KeyObject): Buffer {
    switch (alg) {
      case 'ES256':
        return cryptoSign('sha256', signingInput, { key, dsaEncoding: 'ieee-p1363' });
      case 'RS512':
        return cryptoSign('sha512', signingInput, key);
      case 'PS256':
        return cryptoSign('sha256', signingInput, { key, padding: cryptoConstants.RSA_PKCS1_PSS_PADDING, saltLength: 32 });
      case 'EdDSA':
        return cryptoSign(null, signingInput, key);
      case 'RS256':
        return cryptoSign('sha256', signingInput, key);
    }
  }

  function defaultKeyFor(alg: FakeAlg): KeyObject {
    return alg === 'ES256' ? ec.privateKey : rsa.privateKey;
  }

  function signRaw(headerB64: string, payloadB64: string, alg: FakeAlg = 'RS256', key: KeyObject = defaultKeyFor(alg)): string {
    const signingInput = Buffer.from(`${headerB64}.${payloadB64}`);
    return `${headerB64}.${payloadB64}.${base64url(rawSignature(signingInput, alg, key))}`;
  }

  function signWithKey(privateKey: KeyObject, alg: FakeAlg, kid: string) {
    return (payload: Record<string, unknown>, header?: Record<string, unknown>): string => {
      const h = header ?? { alg, typ: 'JWT', kid };
      return signRaw(base64url(Buffer.from(JSON.stringify(h))), base64url(Buffer.from(JSON.stringify(payload))), alg, privateKey);
    };
  }

  function sign(payload: Record<string, unknown>, opts: { alg?: 'RS256' | 'ES256'; header?: Record<string, unknown> } = {}): string {
    const alg = opts.alg ?? 'RS256';
    const header = opts.header ?? { alg, typ: 'JWT', kid: alg === 'RS256' ? rsaKid : ecKid };
    return signRaw(base64url(Buffer.from(JSON.stringify(header))), base64url(Buffer.from(JSON.stringify(payload))), alg);
  }

  const rsaPublicKeyPem = rsa.publicKey.export({ format: 'pem', type: 'spki' }) as string;

  function forgeHs256WithRsaPublicKey(payload: Record<string, unknown>, header: Record<string, unknown> = { alg: 'HS256', typ: 'JWT', kid: rsaKid }): string {
    const headerB64 = base64url(Buffer.from(JSON.stringify(header)));
    const payloadB64 = base64url(Buffer.from(JSON.stringify(payload)));
    const mac = createHmac('sha256', rsaPublicKeyPem).update(`${headerB64}.${payloadB64}`).digest();
    return `${headerB64}.${payloadB64}.${base64url(mac)}`;
  }

  function addKey(kind: 'rsa' | 'ec' | 'ed25519', kid: string, opts: { modulusLength?: number; alg?: string | null; jwkOverrides?: Record<string, unknown> } = {}): FakeKey {
    let pair: { publicKey: KeyObject; privateKey: KeyObject };
    let alg: FakeAlg;
    let defaultJwkAlg: string;
    switch (kind) {
      case 'rsa':
        pair = generateKeyPairSync('rsa', { modulusLength: opts.modulusLength ?? 2048 });
        alg = 'RS256';
        defaultJwkAlg = 'RS256';
        break;
      case 'ec':
        pair = generateKeyPairSync('ec', { namedCurve: 'P-256' });
        alg = 'ES256';
        defaultJwkAlg = 'ES256';
        break;
      case 'ed25519':
        pair = generateKeyPairSync('ed25519');
        alg = 'EdDSA';
        defaultJwkAlg = 'EdDSA';
        break;
    }
    const jwkAlg = opts.alg === undefined ? (publishJwkAlg ? defaultJwkAlg : null) : opts.alg;
    const publicJwk = jwkFor(pair.publicKey, kid, jwkAlg, opts.jwkOverrides);
    keys.push(publicJwk);
    return { kid, privateKey: pair.privateKey, publicJwk, sign: signWithKey(pair.privateKey, alg, kid) };
  }

  function rotateInNewRsaKey(kid = 'rsa-key-rotated'): FakeKey {
    return addKey('rsa', kid);
  }

  function removeKey(kid: string): void {
    for (let i = keys.length - 1; i >= 0; i -= 1) {
      if (keys[i]?.['kid'] === kid) keys.splice(i, 1);
    }
  }

  return {
    url: base,
    issuer: base,
    jwksUrl: `${base}/jwks.json`,
    rsaKid,
    ecKid,
    rsaPublicKeyPem,
    sign,
    signRaw,
    forgeHs256WithRsaPublicKey,
    jwksHits: () => jwksHits,
    wellKnownHits: () => wellKnownHits,
    rotateInNewRsaKey,
    addKey,
    removeKey,
    publishRawJwk: (jwk) => {
      keys.push(jwk);
    },
    setJwksMode: (mode) => {
      jwksMode = mode;
    },
    setDiscovery: (overrides) => {
      discoveryOverrides = overrides;
    },
    close: () =>
      new Promise((resolve) => {
        for (const res of hanging) res.destroy();
        hanging.clear();
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
