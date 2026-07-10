/**
 * HTTP-level tests for the team server (src/server.ts), run against a real
 * http.Server on an ephemeral port with a FakeRollupStore injected instead of
 * Postgres — proves the auth/verification/routing logic without a live
 * database. Real Postgres integration (schema.sql applying cleanly, actual
 * SQL round-tripping) is not covered here; see team-server/README.md for how
 * to verify that against a real instance.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type http from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadOrCreateKeyPair, type KeyPair } from '../../src/value/receipt.ts';
import { buildRollupBody, signRollup, type SignedRollup } from '../../src/team/rollup.ts';
import type { ProjectValue } from '../../src/value/realization.ts';
import { createTeamServer, type TeamServerDeps } from '../src/server.ts';
import { FakeRollupStore } from './fakeStore.ts';
import { startFakeIdp } from './fakeIdp.ts';

function projects(): ProjectValue[] {
  return [
    {
      project: 'aegisflow',
      units: 12,
      costUsd: 41.5,
      realizationRate: 0.8,
      realizedValueUsd: 300,
      netRealizedValueUsd: 258.5,
      roiIndex: 3.2,
      sources: ['claude-code'],
    },
  ];
}

const period = { from: '2026-06-01T00:00:00.000Z', to: '2026-07-01T00:00:00.000Z' };

/** Developer breakdown off by default (opt-in), matching production's fail-closed default. Tests that need it override explicitly. */
const DEFAULT_TEST_AGGREGATE_CONFIG = { minCohort: 5, exposeDeveloperBreakdown: false };

function startTeamServer(deps: TeamServerDeps): Promise<{ url: string; close: () => Promise<void> }> {
  const server: http.Server = createTeamServer(deps);
  return new Promise((resolve) => {
    server.listen(0, () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      resolve({ url: `http://127.0.0.1:${port}`, close: () => new Promise((r) => server.close(() => r())) });
    });
  });
}

/** Registers `keys` directly against the store (bypassing the admin HTTP route, matching the existing tests' convention) and pushes a signed rollup for real over HTTP. Asserts the push itself succeeded so a broken fixture fails at its source, not at a confusing downstream assertion. */
async function pushRollup(
  srv: { url: string },
  store: FakeRollupStore,
  keys: KeyPair,
  proj: ProjectValue[],
  rollupPeriod: { from: string; to: string },
): Promise<void> {
  await store.registerDeveloper(keys.keyId, keys.publicPem, null);
  const signed: SignedRollup = signRollup(buildRollupBody(keys, proj, rollupPeriod), keys);
  const res = await fetch(`${srv.url}/rollups`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(signed),
  });
  assert.equal(res.status, 201, `fixture setup: push for ${keys.keyId} must succeed`);
}

test('team-server: GET /health reports ok', async () => {
  const srv = await startTeamServer({ store: new FakeRollupStore(), adminToken: null, oidc: null, aggregate: DEFAULT_TEST_AGGREGATE_CONFIG });
  try {
    const res = await fetch(`${srv.url}/health`);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true, service: 'aegisflow-team-server' });
  } finally {
    await srv.close();
  }
});

test('team-server: POST /developers is disabled (503) when no admin token is configured', async () => {
  const srv = await startTeamServer({ store: new FakeRollupStore(), adminToken: null, oidc: null, aggregate: DEFAULT_TEST_AGGREGATE_CONFIG });
  try {
    const res = await fetch(`${srv.url}/developers`, { method: 'POST', body: '{}' });
    assert.equal(res.status, 503);
  } finally {
    await srv.close();
  }
});

test('team-server: POST /developers rejects a missing or wrong admin bearer token', async () => {
  const store = new FakeRollupStore();
  const srv = await startTeamServer({ store, adminToken: 'the-real-admin-token', oidc: null, aggregate: DEFAULT_TEST_AGGREGATE_CONFIG });
  try {
    const noAuth = await fetch(`${srv.url}/developers`, { method: 'POST', body: '{}' });
    assert.equal(noAuth.status, 401);

    const wrongAuth = await fetch(`${srv.url}/developers`, {
      method: 'POST',
      headers: { authorization: 'Bearer nope' },
      body: '{}',
    });
    assert.equal(wrongAuth.status, 401);
  } finally {
    await srv.close();
  }
});

test('team-server: POST /developers registers a developer given the correct admin token, and rejects a lying keyId', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'aegis-team-server-'));
  try {
    const dev: KeyPair = loadOrCreateKeyPair(join(dir, 'dev.json'));
    const store = new FakeRollupStore();
    const srv = await startTeamServer({ store, adminToken: 'admin-secret', oidc: null, aggregate: DEFAULT_TEST_AGGREGATE_CONFIG });
    try {
      const ok = await fetch(`${srv.url}/developers`, {
        method: 'POST',
        headers: { authorization: 'Bearer admin-secret', 'content-type': 'application/json' },
        body: JSON.stringify({ keyId: dev.keyId, publicKey: dev.publicPem, label: 'alice-laptop' }),
      });
      assert.equal(ok.status, 201);
      const found = await store.findDeveloper(dev.keyId);
      assert.equal(found?.publicKey, dev.publicPem);

      // A claimed keyId that doesn't match the given publicKey's own fingerprint
      // — never trust the claim, recompute it, same discipline as verifyRollup.
      const lying = await fetch(`${srv.url}/developers`, {
        method: 'POST',
        headers: { authorization: 'Bearer admin-secret', 'content-type': 'application/json' },
        body: JSON.stringify({ keyId: 'deadbeefdeadbeef', publicKey: dev.publicPem }),
      });
      assert.equal(lying.status, 400);
    } finally {
      await srv.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('team-server: POST /rollups from an unregistered key is rejected (403) — the Sybil-resistance property', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'aegis-team-server-'));
  try {
    const attacker: KeyPair = loadOrCreateKeyPair(join(dir, 'attacker.json'));
    const body = buildRollupBody(attacker, projects(), period);
    const signed: SignedRollup = signRollup(body, attacker);

    const srv = await startTeamServer({ store: new FakeRollupStore(), adminToken: null, oidc: null, aggregate: DEFAULT_TEST_AGGREGATE_CONFIG });
    try {
      const res = await fetch(`${srv.url}/rollups`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(signed),
      });
      assert.equal(res.status, 403);
      const payload = (await res.json()) as { ok: boolean; error: string };
      assert.match(payload.error, /unregistered key/);
    } finally {
      await srv.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('team-server: POST /rollups from a registered key with a valid signature is accepted (201) and stored', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'aegis-team-server-'));
  try {
    const dev: KeyPair = loadOrCreateKeyPair(join(dir, 'dev.json'));
    const body = buildRollupBody(dev, projects(), period);
    const signed: SignedRollup = signRollup(body, dev);

    const store = new FakeRollupStore();
    await store.registerDeveloper(dev.keyId, dev.publicPem, null);
    const srv = await startTeamServer({ store, adminToken: null, oidc: null, aggregate: DEFAULT_TEST_AGGREGATE_CONFIG });
    try {
      const res = await fetch(`${srv.url}/rollups`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(signed),
      });
      assert.equal(res.status, 201);
      const payload = (await res.json()) as { ok: boolean; projects: number };
      assert.equal(payload.ok, true);
      assert.equal(payload.projects, 1);

      const stored = await store.listRollups({ keyId: dev.keyId });
      assert.equal(stored.length, 1);
      assert.equal(stored[0]!.body.projects[0]!.project, 'aegisflow');
    } finally {
      await srv.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('team-server: POST /rollups rejects a registered developer\'s rollup once its numbers are tampered', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'aegis-team-server-'));
  try {
    const dev: KeyPair = loadOrCreateKeyPair(join(dir, 'dev.json'));
    const body = buildRollupBody(dev, projects(), period);
    const signed: SignedRollup = signRollup(body, dev);
    const tampered = { ...signed, body: { ...signed.body, projects: [{ ...signed.body.projects[0]!, costUsd: 999_999 }] } };

    const store = new FakeRollupStore();
    await store.registerDeveloper(dev.keyId, dev.publicPem, null);
    const srv = await startTeamServer({ store, adminToken: null, oidc: null, aggregate: DEFAULT_TEST_AGGREGATE_CONFIG });
    try {
      const res = await fetch(`${srv.url}/rollups`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(tampered),
      });
      assert.equal(res.status, 401);
      const payload = (await res.json()) as { ok: boolean; error: string };
      assert.match(payload.error, /body hash mismatch/);
      assert.equal((await store.listRollups()).length, 0);
    } finally {
      await srv.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('team-server: POST /rollups rejects malformed JSON and well-formed-but-wrong-shaped bodies (400)', async () => {
  const srv = await startTeamServer({ store: new FakeRollupStore(), adminToken: null, oidc: null, aggregate: DEFAULT_TEST_AGGREGATE_CONFIG });
  try {
    const garbage = await fetch(`${srv.url}/rollups`, { method: 'POST', body: 'not json at all {{{' });
    assert.equal(garbage.status, 400);

    const wrongShape = await fetch(`${srv.url}/rollups`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ hello: 'world' }),
    });
    assert.equal(wrongShape.status, 400);
  } finally {
    await srv.close();
  }
});

test('team-server: GET /rollups is method-not-allowed (405, Allow: POST); unknown routes are 404', async () => {
  const srv = await startTeamServer({ store: new FakeRollupStore(), adminToken: null, oidc: null, aggregate: DEFAULT_TEST_AGGREGATE_CONFIG });
  try {
    const wrongMethod = await fetch(`${srv.url}/rollups`, { method: 'GET' });
    assert.equal(wrongMethod.status, 405);
    assert.equal(wrongMethod.headers.get('allow'), 'POST');

    const notFound = await fetch(`${srv.url}/nope`);
    assert.equal(notFound.status, 404);
  } finally {
    await srv.close();
  }
});

test('team-server: GET /me is disabled (503) when OIDC is not configured', async () => {
  const srv = await startTeamServer({ store: new FakeRollupStore(), adminToken: null, oidc: null, aggregate: DEFAULT_TEST_AGGREGATE_CONFIG });
  try {
    const res = await fetch(`${srv.url}/me`);
    assert.equal(res.status, 503);
  } finally {
    await srv.close();
  }
});

test('team-server: GET /me requires a bearer token and rejects an invalid one', async () => {
  const idp = await startFakeIdp();
  try {
    const srv = await startTeamServer({
      store: new FakeRollupStore(),
      adminToken: null,
      oidc: { issuerUrl: idp.issuer, clientId: 'team-dashboard', jwksUrl: idp.jwksUrl },
      aggregate: DEFAULT_TEST_AGGREGATE_CONFIG,
    });
    try {
      const noAuth = await fetch(`${srv.url}/me`);
      assert.equal(noAuth.status, 401);

      const now = Math.floor(Date.now() / 1000);
      const expired = idp.sign({ iss: idp.issuer, aud: 'team-dashboard', sub: 'bob@example.com', iat: now - 7200, exp: now - 3600 });
      const badToken = await fetch(`${srv.url}/me`, { headers: { authorization: `Bearer ${expired}` } });
      assert.equal(badToken.status, 401);
    } finally {
      await srv.close();
    }
  } finally {
    await idp.close();
  }
});

test('team-server: GET /me accepts a genuine OIDC token and returns the verified subject', async () => {
  const idp = await startFakeIdp();
  try {
    const srv = await startTeamServer({
      store: new FakeRollupStore(),
      adminToken: null,
      oidc: { issuerUrl: idp.issuer, clientId: 'team-dashboard', jwksUrl: idp.jwksUrl },
      aggregate: DEFAULT_TEST_AGGREGATE_CONFIG,
    });
    try {
      const now = Math.floor(Date.now() / 1000);
      const token = idp.sign({ iss: idp.issuer, aud: 'team-dashboard', sub: 'carol@example.com', iat: now, exp: now + 3600 });
      const res = await fetch(`${srv.url}/me`, { headers: { authorization: `Bearer ${token}` } });
      assert.equal(res.status, 200);
      const payload = (await res.json()) as { ok: boolean; subject: string };
      assert.equal(payload.ok, true);
      assert.equal(payload.subject, 'carol@example.com');
    } finally {
      await srv.close();
    }
  } finally {
    await idp.close();
  }
});

test('team-server: GET /dashboard/projects and /dashboard/developers are disabled (503) without OIDC, and require a bearer token', async () => {
  const noOidc = await startTeamServer({ store: new FakeRollupStore(), adminToken: null, oidc: null, aggregate: DEFAULT_TEST_AGGREGATE_CONFIG });
  try {
    assert.equal((await fetch(`${noOidc.url}/dashboard/projects`)).status, 503);
    assert.equal((await fetch(`${noOidc.url}/dashboard/developers`)).status, 503);
  } finally {
    await noOidc.close();
  }

  const idp = await startFakeIdp();
  try {
    const srv = await startTeamServer({
      store: new FakeRollupStore(),
      adminToken: null,
      oidc: { issuerUrl: idp.issuer, clientId: 'team-dashboard', jwksUrl: idp.jwksUrl },
      aggregate: DEFAULT_TEST_AGGREGATE_CONFIG,
    });
    try {
      assert.equal((await fetch(`${srv.url}/dashboard/projects`)).status, 401);
      assert.equal((await fetch(`${srv.url}/dashboard/developers`)).status, 401);
    } finally {
      await srv.close();
    }
  } finally {
    await idp.close();
  }
});

test('team-server: GET /dashboard/projects weights realizationRate by units and avgRoiIndex by cost — not naive averages, and excludes a null roiIndex from both', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'aegis-team-server-'));
  const idp = await startFakeIdp();
  try {
    const a: KeyPair = loadOrCreateKeyPair(join(dir, 'a.json'));
    const b: KeyPair = loadOrCreateKeyPair(join(dir, 'b.json'));
    const c: KeyPair = loadOrCreateKeyPair(join(dir, 'c.json'));
    const store = new FakeRollupStore();
    const srv = await startTeamServer({
      store,
      adminToken: null,
      oidc: { issuerUrl: idp.issuer, clientId: 'team-dashboard', jwksUrl: idp.jwksUrl },
      aggregate: { minCohort: 3, exposeDeveloperBreakdown: false },
    });
    try {
      // A: 10 units @ 50% realized (5 realized), $100, RoI 2.0
      await pushRollup(
        srv,
        store,
        a,
        [{ project: 'shared', units: 10, costUsd: 100, realizationRate: 0.5, realizedValueUsd: 50, netRealizedValueUsd: 45, roiIndex: 2.0, sources: [] }],
        period,
      );
      // B: 20 units @ 90% realized (18 realized), $300, RoI 4.0
      await pushRollup(
        srv,
        store,
        b,
        [{ project: 'shared', units: 20, costUsd: 300, realizationRate: 0.9, realizedValueUsd: 270, netRealizedValueUsd: 260, roiIndex: 4.0, sources: [] }],
        period,
      );
      // C: 5 units @ 100% realized (5 realized), $50, RoI untested (null) — must not dilute avgRoiIndex's denominator.
      await pushRollup(
        srv,
        store,
        c,
        [{ project: 'shared', units: 5, costUsd: 50, realizationRate: 1.0, realizedValueUsd: 50, netRealizedValueUsd: 50, roiIndex: null, sources: [] }],
        period,
      );

      const now = Math.floor(Date.now() / 1000);
      const token = idp.sign({ iss: idp.issuer, aud: 'team-dashboard', sub: 'lead@example.com', iat: now, exp: now + 3600 });
      const res = await fetch(`${srv.url}/dashboard/projects`, { headers: { authorization: `Bearer ${token}` } });
      assert.equal(res.status, 200);
      const payload = (await res.json()) as { ok: boolean; projects: Array<Record<string, unknown>> };
      assert.equal(payload.projects.length, 1);
      const row = payload.projects[0]!;
      assert.equal(row['suppressed'], false);
      assert.equal(row['developerCount'], 3);
      assert.equal(row['rollupCount'], 3);
      assert.equal(row['totalUnits'], 35);
      assert.equal(row['totalCostUsd'], 450);
      assert.equal(row['totalRealizedValueUsd'], 370);
      assert.equal(row['totalNetRealizedValueUsd'], 355);
      // SUM(realizedUnits)/SUM(units) = (5+18+5)/35 = 28/35 = 0.8 — NOT the naive
      // average of the three rates (0.5+0.9+1.0)/3 = 0.8 too by coincidence here,
      // so this alone wouldn't catch a naive-average bug — the assertion below does.
      assert.ok(Math.abs((row['realizationRate'] as number) - 28 / 35) < 1e-9);
      // Dollar-weighted realizedValueRate (370/450 ≈ 0.822) deliberately differs from
      // realizationRate (0.8) — proves the two metrics aren't accidentally the same field.
      assert.ok(Math.abs((row['realizedValueRate'] as number) - 370 / 450) < 1e-9);
      assert.notEqual(row['realizationRate'], row['realizedValueRate']);
      // Cost-weighted average over A and B only: (2.0*100 + 4.0*300)/(100+300) = 3.5.
      // A naive unweighted average of all three (treating null as 0, or as 0-weight-but-counted)
      // would land on 2.0, 3.0, or 2.33 — none of which is 3.5.
      assert.ok(Math.abs((row['avgRoiIndex'] as number) - 3.5) < 1e-9);
    } finally {
      await srv.close();
    }
  } finally {
    await idp.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('team-server: GET /dashboard/projects suppresses a project below the k-anonymity floor and leaks no dollar figures', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'aegis-team-server-'));
  const idp = await startFakeIdp();
  try {
    const dev: KeyPair = loadOrCreateKeyPair(join(dir, 'dev.json'));
    const store = new FakeRollupStore();
    const srv = await startTeamServer({
      store,
      adminToken: null,
      oidc: { issuerUrl: idp.issuer, clientId: 'team-dashboard', jwksUrl: idp.jwksUrl },
      aggregate: DEFAULT_TEST_AGGREGATE_CONFIG, // minCohort 5, only one developer pushes below
    });
    try {
      await pushRollup(
        srv,
        store,
        dev,
        [{ project: 'solo-project', units: 10, costUsd: 12345, realizationRate: 1, realizedValueUsd: 12345, netRealizedValueUsd: 12345, roiIndex: 9, sources: [] }],
        period,
      );

      const now = Math.floor(Date.now() / 1000);
      const token = idp.sign({ iss: idp.issuer, aud: 'team-dashboard', sub: 'lead@example.com', iat: now, exp: now + 3600 });
      const res = await fetch(`${srv.url}/dashboard/projects`, { headers: { authorization: `Bearer ${token}` } });
      assert.equal(res.status, 200);
      const raw = await res.text();
      assert.equal(raw.includes('12345'), false);
      const payload = JSON.parse(raw) as { ok: boolean; projects: Array<Record<string, unknown>> };
      assert.equal(payload.projects.length, 1);
      assert.equal(payload.projects[0]!['suppressed'], true);
      assert.equal(payload.projects[0]!['developerCount'], 1);
      assert.match(payload.projects[0]!['reason'] as string, /fewer than 5 distinct developers/);
    } finally {
      await srv.close();
    }
  } finally {
    await idp.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('team-server: GET /dashboard/projects treats periodFrom/periodTo as an interval-overlap filter', async () => {
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
      const januaryPeriod = { from: '2026-01-01T00:00:00.000Z', to: '2026-02-01T00:00:00.000Z' };
      await pushRollup(
        srv,
        store,
        dev,
        [{ project: 'january-project', units: 1, costUsd: 10, realizationRate: 1, realizedValueUsd: 10, netRealizedValueUsd: 10, roiIndex: 1, sources: [] }],
        januaryPeriod,
      );
      await pushRollup(
        srv,
        store,
        dev,
        [{ project: 'june-project', units: 1, costUsd: 20, realizationRate: 1, realizedValueUsd: 20, netRealizedValueUsd: 20, roiIndex: 1, sources: [] }],
        period, // June, per the module-level `period` const
      );

      const now = Math.floor(Date.now() / 1000);
      const token = idp.sign({ iss: idp.issuer, aud: 'team-dashboard', sub: 'lead@example.com', iat: now, exp: now + 3600 });
      const res = await fetch(`${srv.url}/dashboard/projects?periodFrom=2026-05-01T00:00:00.000Z&periodTo=2026-08-01T00:00:00.000Z`, {
        headers: { authorization: `Bearer ${token}` },
      });
      assert.equal(res.status, 200);
      const payload = (await res.json()) as { ok: boolean; projects: Array<{ project: string }> };
      assert.deepEqual(
        payload.projects.map((p) => p.project),
        ['june-project'],
      );

      const invalid = await fetch(`${srv.url}/dashboard/projects?periodFrom=not-a-real-date`, { headers: { authorization: `Bearer ${token}` } });
      assert.equal(invalid.status, 400);
    } finally {
      await srv.close();
    }
  } finally {
    await idp.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('team-server: GET /dashboard/developers reports itself disabled (200, enabled:false) when the opt-in is off', async () => {
  const idp = await startFakeIdp();
  try {
    const srv = await startTeamServer({
      store: new FakeRollupStore(),
      adminToken: null,
      oidc: { issuerUrl: idp.issuer, clientId: 'team-dashboard', jwksUrl: idp.jwksUrl },
      aggregate: DEFAULT_TEST_AGGREGATE_CONFIG, // exposeDeveloperBreakdown: false
    });
    try {
      const now = Math.floor(Date.now() / 1000);
      const token = idp.sign({ iss: idp.issuer, aud: 'team-dashboard', sub: 'lead@example.com', iat: now, exp: now + 3600 });
      const res = await fetch(`${srv.url}/dashboard/developers`, { headers: { authorization: `Bearer ${token}` } });
      assert.equal(res.status, 200);
      const payload = (await res.json()) as { ok: boolean; report: { enabled: boolean; suppressed: boolean; distribution: unknown } };
      assert.equal(payload.report.enabled, false);
      assert.equal(payload.report.suppressed, true);
      assert.equal(payload.report.distribution, null);
    } finally {
      await srv.close();
    }
  } finally {
    await idp.close();
  }
});

test('team-server: GET /dashboard/developers returns a k-anonymized distribution when enabled and the floor is met — never a named list', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'aegis-team-server-'));
  const idp = await startFakeIdp();
  try {
    const a: KeyPair = loadOrCreateKeyPair(join(dir, 'a.json'));
    const b: KeyPair = loadOrCreateKeyPair(join(dir, 'b.json'));
    const c: KeyPair = loadOrCreateKeyPair(join(dir, 'c.json'));
    const store = new FakeRollupStore();
    const srv = await startTeamServer({
      store,
      adminToken: null,
      oidc: { issuerUrl: idp.issuer, clientId: 'team-dashboard', jwksUrl: idp.jwksUrl },
      aggregate: { minCohort: 3, exposeDeveloperBreakdown: true },
    });
    try {
      await pushRollup(srv, store, a, [{ project: 'p', units: 1, costUsd: 100, realizationRate: 1, realizedValueUsd: 90, netRealizedValueUsd: 90, roiIndex: 1, sources: [] }], period);
      await pushRollup(srv, store, b, [{ project: 'p', units: 1, costUsd: 200, realizationRate: 1, realizedValueUsd: 100, netRealizedValueUsd: 100, roiIndex: 1, sources: [] }], period);
      await pushRollup(srv, store, c, [{ project: 'p', units: 1, costUsd: 300, realizationRate: 1, realizedValueUsd: 300, netRealizedValueUsd: 300, roiIndex: 1, sources: [] }], period);

      const now = Math.floor(Date.now() / 1000);
      const token = idp.sign({ iss: idp.issuer, aud: 'team-dashboard', sub: 'lead@example.com', iat: now, exp: now + 3600 });
      const res = await fetch(`${srv.url}/dashboard/developers`, { headers: { authorization: `Bearer ${token}` } });
      assert.equal(res.status, 200);
      const raw = await res.text();
      // The actual privacy contract: no keyId anywhere in the payload, named or otherwise.
      assert.equal(raw.includes(a.keyId), false);
      assert.equal(raw.includes(b.keyId), false);
      assert.equal(raw.includes(c.keyId), false);
      assert.equal(raw.includes('keyId'), false);
      const payload = JSON.parse(raw) as {
        ok: boolean;
        report: { enabled: boolean; suppressed: boolean; distribution: { cohortSize: number; medianCostUsd: number; totalCostUsd: number; totalRealizedValueUsd: number } };
      };
      assert.equal(payload.report.enabled, true);
      assert.equal(payload.report.suppressed, false);
      assert.equal(payload.report.distribution.cohortSize, 3);
      assert.equal(payload.report.distribution.medianCostUsd, 200);
      assert.equal(payload.report.distribution.totalCostUsd, 600);
      assert.equal(payload.report.distribution.totalRealizedValueUsd, 490);
    } finally {
      await srv.close();
    }
  } finally {
    await idp.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
