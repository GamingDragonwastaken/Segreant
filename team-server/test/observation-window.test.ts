/**
 * A sum across unequal windows must say so (WP-C06).
 *
 * THE DEFECT. Every rollup declares its own observation window, chosen by
 * whoever pushed it — `fiscus team push --window D` defaults to 30 and accepts
 * anything. `aggregateProjects` sums one rollup per developer regardless of how
 * long each of their windows is, and `/dashboard/projects` returned
 * `{ ok: true, projects: [...] }`: a total with no period attached at all. A
 * seven-day machine and a ninety-day machine add up to one `totalCostUsd`, and
 * nothing on the response says which period, if any, it describes.
 *
 * THE SERVER HAD ALREADY MADE THE ARGUMENT, ONE FUNCTION OVER. `parsePeriodFilter`
 * refuses `periodFrom`/`periodTo` outright, and states why: filtering a snapshot
 * by an overlapping window "would present its *whole* total as though it
 * belonged to that partial window". That is the same error in the other
 * direction — there it is the query's window that misdescribes the data, here it
 * is the data's own windows that misdescribe each other — and only one of the
 * two was guarded. The missing-sibling shape again.
 *
 * WHAT THIS DOES AND DOES NOT DO. It does not refuse the sum, and it does not
 * reweight it: normalising unequal windows to a common period would invent a
 * rate the rollups do not carry, and refusing would delete the core FinOps view
 * over a difference that is often harmless. It attaches the coverage — how many
 * distinct windows fed the total, their span, their shortest and longest length
 * — so a reader can see that the figure is not one period. That is this
 * project's first rule applied to a shared figure: it carries its basis.
 *
 * Recorded at D-102.
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

function startTeamServer(deps: TeamServerDeps): Promise<{ url: string; close: () => Promise<void> }> {
  const server: http.Server = createTeamServer({
    ...deps,
    dashboardAllowedSubjects: deps.dashboardAllowedSubjects === undefined
      ? new Set(['lead@example.com'])
      : deps.dashboardAllowedSubjects,
  });
  return new Promise((resolve) => {
    server.listen(0, () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      resolve({ url: `http://127.0.0.1:${port}`, close: () => new Promise((r) => server.close(() => r())) });
    });
  });
}

function project(name: string): ProjectValue[] {
  return [{
    project: name,
    units: 10,
    costUsd: 100,
    realizationRate: 0.5,
    spendOnRealizedUnitsUsd: 50,
    acceptanceWeightedSpendUsd: 40,
    roiIndex: 2,
    sources: [],
  } as unknown as ProjectValue];
}

async function push(
  srv: { url: string },
  store: FakeRollupStore,
  keys: KeyPair,
  window: { from: string; to: string },
): Promise<void> {
  await store.registerDeveloper(keys.keyId, keys.publicPem, null);
  const signed: SignedRollup = signRollup(buildRollupBody(keys, project('shared'), window), keys);
  const res = await fetch(`${srv.url}/rollups`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(signed),
  });
  assert.equal(res.status, 201, `fixture setup: push for ${keys.keyId} must succeed`);
}

interface CoverageResponse {
  ok: boolean;
  projects: Array<Record<string, unknown>>;
  coverage?: {
    distinctWindows: number;
    contributingDevelopers: number;
    uniform: boolean;
    earliestFrom: string | null;
    latestTo: string | null;
    shortestWindowDays: number | null;
    longestWindowDays: number | null;
    note: string;
  };
}

async function dashboardProjects(
  windows: { from: string; to: string }[],
): Promise<CoverageResponse> {
  const dir = mkdtempSync(join(tmpdir(), 'fiscus-team-window-'));
  const idp = await startFakeIdp();
  try {
    const store = new FakeRollupStore();
    const srv = await startTeamServer({
      store,
      adminToken: null,
      oidc: { issuerUrl: idp.issuer, clientId: 'team-dashboard', jwksUrl: idp.jwksUrl },
      aggregate: { minCohort: 1, exposeDeveloperBreakdown: false },
    });
    try {
      for (const [index, window] of windows.entries()) {
        const keys: KeyPair = loadOrCreateKeyPair(join(dir, `dev-${index}.json`));
        await push(srv, store, keys, window);
      }
      const now = Math.floor(Date.now() / 1000);
      const token = idp.sign({ iss: idp.issuer, aud: 'team-dashboard', sub: 'lead@example.com', iat: now, exp: now + 3600 });
      const res = await fetch(`${srv.url}/dashboard/projects`, { headers: { authorization: `Bearer ${token}` } });
      assert.equal(res.status, 200);
      return (await res.json()) as CoverageResponse;
    } finally {
      await srv.close();
    }
  } finally {
    await idp.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

test('a total summed across unequal observation windows says how many windows it summed', async () => {
  // Seven days beside ninety. The dollar total is the sum of both, and without
  // the coverage nothing on the response would say that the figure describes no
  // single period.
  const payload = await dashboardProjects([
    { from: '2026-06-24T00:00:00.000Z', to: '2026-07-01T00:00:00.000Z' },
    { from: '2026-04-02T00:00:00.000Z', to: '2026-07-01T00:00:00.000Z' },
  ]);

  assert.equal(payload.projects.length, 1);
  assert.equal(payload.projects[0]!['totalCostUsd'], 200);

  const coverage = payload.coverage;
  assert.ok(coverage !== undefined, 'a team total must carry the coverage of what it summed');
  assert.equal(coverage.uniform, false);
  assert.equal(coverage.distinctWindows, 2);
  assert.equal(coverage.contributingDevelopers, 2);
  assert.equal(coverage.earliestFrom, '2026-04-02T00:00:00.000Z');
  assert.equal(coverage.latestTo, '2026-07-01T00:00:00.000Z');
  assert.equal(coverage.shortestWindowDays, 7);
  assert.equal(coverage.longestWindowDays, 90);
  assert.match(coverage.note, /7|seven/);
  assert.match(coverage.note, /90|ninety/);
  assert.match(coverage.note, /not|does not|no single/i, 'the note must say what the total is NOT');
});

test('a total summed across one shared window says that too, rather than staying silent', async () => {
  // THE GUARD-RAIL. A note that only ever warned would be noise, and a reader
  // would learn nothing from its presence. The uniform case states the period
  // the totals actually cover.
  const payload = await dashboardProjects([
    { from: '2026-06-01T00:00:00.000Z', to: '2026-07-01T00:00:00.000Z' },
    { from: '2026-06-01T00:00:00.000Z', to: '2026-07-01T00:00:00.000Z' },
  ]);

  const coverage = payload.coverage;
  assert.ok(coverage !== undefined);
  assert.equal(coverage.uniform, true);
  assert.equal(coverage.distinctWindows, 1);
  assert.equal(coverage.contributingDevelopers, 2);
  assert.equal(coverage.shortestWindowDays, 30);
  assert.equal(coverage.longestWindowDays, 30);
  assert.equal(coverage.earliestFrom, '2026-06-01T00:00:00.000Z');
  assert.equal(coverage.latestTo, '2026-07-01T00:00:00.000Z');
  assert.doesNotMatch(coverage.note, /unequal|different lengths/i);
});

test('an empty team states that there is no window rather than inventing one', async () => {
  const payload = await dashboardProjects([]);
  const coverage = payload.coverage;
  assert.ok(coverage !== undefined);
  assert.equal(coverage.distinctWindows, 0);
  assert.equal(coverage.contributingDevelopers, 0);
  assert.equal(coverage.uniform, false, 'nothing is not uniform; it is nothing');
  assert.equal(coverage.earliestFrom, null);
  assert.equal(coverage.latestTo, null);
  assert.equal(coverage.shortestWindowDays, null);
  assert.match(coverage.note, /no rollup|nothing|no window/i);
});
