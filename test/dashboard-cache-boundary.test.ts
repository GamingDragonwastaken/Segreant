import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ServerResponse } from 'node:http';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { json as writeDashboardJson } from '../src/dashboard/routes.ts';

test('dashboard JSON responses are not cached', () => {
  let headers: Record<string, string> = {};
  const response = {
    writeHead(_status: number, nextHeaders: Record<string, string>) { headers = nextHeaders; },
    end(_body: string) { /* captured by the route boundary only */ },
  } as unknown as ServerResponse;

  writeDashboardJson(response, 200, { ok: true });
  assert.equal(headers['cache-control'], 'no-store');
});

test('CSV evidence downloads carry the same no-store contract', () => {
  const routes = readFileSync(join(import.meta.dirname, '..', 'src', 'dashboard', 'routes.ts'), 'utf8');
  assert.match(routes, /'content-type': 'text\/csv; charset=utf-8'[\s\S]{0,180}'cache-control': 'no-store'/);
});
