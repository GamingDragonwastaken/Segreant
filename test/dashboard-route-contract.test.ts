/**
 * The API route contract is generated once and consumed by both halves of the
 * dashboard. This test intentionally checks three independent surfaces:
 * the canonical descriptor, the server route table, and the browser client.
 * A route that exists in only two of those places is still a drift bug.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DASHBOARD_API_CONTRACTS, type DashboardApiContract } from '../src/dashboard/contracts.ts';
import { ROUTES } from '../src/dashboard/routes.ts';

const ROOT = join(import.meta.dirname, '..');
const API_SOURCE = readFileSync(join(ROOT, 'src', 'dashboard', 'web', 'app', 'core', 'api.ts'), 'utf8');
const CLASSIC_SOURCE = readFileSync(join(ROOT, 'src', 'dashboard', 'web', 'classic.html'), 'utf8');
const ACTIONS_SOURCE = readFileSync(join(ROOT, 'src', 'dashboard', 'web', 'app', 'core', 'actions.ts'), 'utf8');
const CANONICAL_SOURCE = readFileSync(join(ROOT, 'src', 'dashboard', 'contracts.ts'), 'utf8');
const GENERATED_SOURCE = readFileSync(join(ROOT, 'src', 'dashboard', 'web', 'app', 'core', 'generated-contract.ts'), 'utf8');

test('canonical dashboard route contract drives server methods, guards, and browser paths', () => {
  const ids = new Set<string>();
  const paths = new Set<string>();
  for (const contract of DASHBOARD_API_CONTRACTS) {
    assert.equal(ids.has(contract.id), false, `duplicate contract id: ${contract.id}`);
    ids.add(contract.id);
    assert.equal(paths.has(contract.path), false, `duplicate contract path: ${contract.path}`);
    paths.add(contract.path);
    assert.ok(contract.methods.length > 0, `${contract.id} must serve at least one method`);
    assert.ok(contract.methods.every((method) => ['GET', 'HEAD', 'POST'].includes(method)), `${contract.id} has an unsupported method`);
    assert.ok(contract.responseType.length > 0, `${contract.id} must declare its response binding`);

    const route = ROUTES.find((candidate) => candidate.path === contract.path);
    assert.ok(route, `${contract.id} is missing from the server route table`);
    assert.deepEqual([...route!.methods], [...contract.methods], `${contract.id} server methods drifted`);
    assert.deepEqual([...(route!.localOnly ?? [])], [...contract.localOnly], `${contract.id} CSRF methods drifted`);
    const typedContract = contract as DashboardApiContract;
    assert.equal(route!.allow ?? null, typedContract.allow ?? null, `${contract.id} Allow header drifted`);

    // A browser surface may add a query string, but it must begin from the
    // canonical route path rather than inventing a parallel endpoint. An empty
    // binding is intentional for API capabilities not currently rendered by
    // either dashboard (for example the standalone pricing endpoint).
    const browserSources = {
      'modern-api': API_SOURCE,
      classic: CLASSIC_SOURCE,
      actions: ACTIONS_SOURCE,
    } as const;
    for (const binding of contract.browserBinding) {
      assert.ok(browserSources[binding].includes(contract.path), `${contract.id} path is absent from the ${binding} browser surface`);
    }
  }

  const apiRoutes = ROUTES.filter((route) => route.path.startsWith('/api/'));
  assert.equal(apiRoutes.length, DASHBOARD_API_CONTRACTS.length, 'server API routes and canonical contracts disagree in cardinality');
  assert.equal(GENERATED_SOURCE, CANONICAL_SOURCE, 'browser generated contract is stale; run the shared-contract generator');
});
