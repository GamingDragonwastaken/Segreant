import { test } from 'node:test';
import assert from 'node:assert/strict';
import { verifyIdToken, type OidcConfig } from '../src/oidc.ts';
import { startFakeIdp, type FakeIdp } from './fakeIdp.ts';

const CLIENT_ID = 'team-dashboard';
const FIXED_NOW = 1_800_000_000;

function cfg(idp: FakeIdp): OidcConfig {
  return { issuerUrl: idp.issuer, clientId: CLIENT_ID, jwksUrl: idp.jwksUrl };
}

function payload(
  idp: FakeIdp,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    iss: idp.issuer,
    aud: CLIENT_ID,
    sub: 'alice@example.com',
    iat: FIXED_NOW,
    exp: FIXED_NOW + 3600,
    ...overrides,
  };
}

const fixedClock = { nowEpochSeconds: () => FIXED_NOW } as const;

test('OIDC temporal contract: iat exactly 60 seconds ahead is accepted', async () => {
  const idp = await startFakeIdp();
  try {
    const token = idp.sign(payload(idp, { iat: FIXED_NOW + 60 }));
    const result = await verifyIdToken(token, cfg(idp), fixedClock);
    assert.equal(result.valid, true);
  } finally {
    await idp.close();
  }
});

test('OIDC temporal contract: iat one second beyond tolerance is rejected', async () => {
  const idp = await startFakeIdp();
  try {
    const token = idp.sign(payload(idp, { iat: FIXED_NOW + 61 }));
    const result = await verifyIdToken(token, cfg(idp), fixedClock);
    assert.equal(result.valid, false);
    if (!result.valid) assert.match(result.reason, /issued in the future/);
  } finally {
    await idp.close();
  }
});

test('OIDC temporal contract: exp equal to verifier time is expired', async () => {
  const idp = await startFakeIdp();
  try {
    const token = idp.sign(payload(idp, { exp: FIXED_NOW }));
    const result = await verifyIdToken(token, cfg(idp), fixedClock);
    assert.equal(result.valid, false);
    if (!result.valid) assert.match(result.reason, /expired/);
  } finally {
    await idp.close();
  }
});

test('OIDC temporal contract: exp one second after verifier time is accepted', async () => {
  const idp = await startFakeIdp();
  try {
    const token = idp.sign(payload(idp, { exp: FIXED_NOW + 1 }));
    const result = await verifyIdToken(token, cfg(idp), fixedClock);
    assert.equal(result.valid, true);
  } finally {
    await idp.close();
  }
});

test('OIDC temporal contract: invalid injected clock fails closed', async () => {
  const idp = await startFakeIdp();
  try {
    const token = idp.sign(payload(idp));
    const result = await verifyIdToken(token, cfg(idp), { nowEpochSeconds: () => Number.NaN });
    assert.equal(result.valid, false);
    if (!result.valid) assert.match(result.reason, /verification clock returned invalid/);
  } finally {
    await idp.close();
  }
});
