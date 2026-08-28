import assert from 'node:assert/strict';
import test from 'node:test';
import type { ServerResponse } from 'node:http';
import { json as writeDashboardJson } from '../src/dashboard/routes.ts';
import { stringifyJson } from '../src/util/json.ts';

test('wire JSON rounds numeric USD fields to microdollar precision', () => {
  const raw = stringifyJson({
    costUsd: 38.780311499999996,
    nested: { realizedValueUsd: 0.30000000000000004 },
    spend30dUsd: 12.3456789,
    requests: 3,
    generatedAtMs: 1_787_931_529_765,
    probability: 0.123456789,
  });

  assert.deepEqual(JSON.parse(raw), {
    costUsd: 38.780311,
    nested: { realizedValueUsd: 0.3 },
    spend30dUsd: 12.345679,
    requests: 3,
    generatedAtMs: 1_787_931_529_765,
    probability: 0.123456789,
  });
});

test('wire JSON leaves unsafe monetary magnitudes unchanged rather than inventing precision', () => {
  const amount = Number.MAX_SAFE_INTEGER / 1_000_000 + 1;
  const parsed = JSON.parse(stringifyJson({ costUsd: amount }));
  assert.equal(parsed.costUsd, amount);
});

test('dashboard JSON boundary uses the money-safe serializer', () => {
  let body = '';
  let status = 0;
  const response = {
    writeHead(nextStatus: number) { status = nextStatus; },
    end(nextBody: string) { body = nextBody; },
  } as unknown as ServerResponse;

  writeDashboardJson(response, 200, {
    costUsd: 38.780311499999996,
    requestCount: 3,
  });

  assert.equal(status, 200);
  assert.deepEqual(JSON.parse(body), { costUsd: 38.780311, requestCount: 3 });
});
