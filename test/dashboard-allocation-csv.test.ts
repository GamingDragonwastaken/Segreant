/**
 * GET /api/allocation/run.csv?id=: one recorded split a budget owner hands on.
 *
 * The amount column must add up to the run's total to the microdollar, with
 * no total row to double a column sum, and every money row must say it is
 * showback of the local estimate rather than a bill.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store/db.ts';
import { DEFAULT_CONFIG } from '../src/config.ts';
import { createDashboardServer } from '../src/dashboard/server.ts';
import { ALLOCATION_CSV_COLUMNS, microsToUsd } from '../src/export/allocationCsv.ts';

const START = Date.UTC(2026, 6, 1);
const DAY = 86_400_000;

/** Enough CSV parsing for quoted cells with commas and doubled quotes. */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = []; let cell = ''; let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') { cell += '"'; i++; } else if (ch === '"') quoted = false; else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') { row.push(cell); cell = ''; } else if (ch === '\r') continue;
    else if (ch === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; } else cell += ch;
  }
  return rows;
}

function request(id: string, project: string, costUsd: number, offsetMs: number) {
  return {
    requestId: id, sessionId: null, tsEpochMs: START + offsetMs, provider: 'openai', model: 'gpt-5', project, taskWeight: 1,
    inputTokens: 1, outputTokens: 1, cacheWriteTokens: 0, cacheReadTokens: 0, reasoningTokens: 0, costUsd,
    estimated: true, streamed: false, statusCode: 200, durationMs: 1,
  };
}

async function fixture(run: (ctx: { base: string; store: Store; post: (body: unknown) => Promise<any> }) => Promise<void>): Promise<void> {
  const home = mkdtempSync(join(tmpdir(), 'segreant-allocation-csv-'));
  const saved = Object.fromEntries(['SEGREANT_HOME', 'SEGREANT_DB', 'SEGREANT_DEMO'].map((k) => [k, process.env[k]]));
  process.env.SEGREANT_HOME = home; delete process.env.SEGREANT_DB; delete process.env.SEGREANT_DEMO;
  const store = new Store(':memory:');
  const server = createDashboardServer({ store, config: structuredClone(DEFAULT_CONFIG), version: 'allocation-csv' });
  try {
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const post = async (body: unknown) => {
      const res = await fetch(`${base}/api/allocation/write`, { method: 'POST', headers: { 'x-segreant-local': '1', 'content-type': 'application/json' }, body: JSON.stringify(body) });
      const payload = await res.json();
      assert.equal(res.status, 200, JSON.stringify(payload));
      return payload;
    };
    await run({ base, store, post });
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    store.close();
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    rmSync(home, { recursive: true, force: true });
  }
}

test('a $10.00 three-way split and an unmatched 7 cents export to the microdollar, as showback, with no total row', async () => {
  await fixture(async ({ base, store, post }) => {
    store.insertRequest(request('ten', 'app', 10, DAY / 2));
    store.insertRequest(request('seven-cents', 'side, "quoted" project', 0.07, DAY));
    for (const [id, name] of [['eng', 'Engineering'], ['ops', 'Operations'], ['res', '=Research']]) await post({ op: 'centre', id, name });
    await post({ op: 'rule', id: 'thirds', method: 'fixed_split', match: { project: 'app' },
      targets: [{ costCentreId: 'eng', ratio: 0.333333 }, { costCentreId: 'ops', ratio: 0.333333 }, { costCentreId: 'res', ratio: 0.333334 }] });
    const recorded = await post({ op: 'run', from: new Date(START).toISOString(), to: new Date(START + 2 * DAY).toISOString(), apply: true });
    const runId = store.allocationRuns(1)[0]!.allocationRunId;
    assert.ok(recorded.applied);

    const res = await fetch(`${base}/api/allocation/run.csv?id=${encodeURIComponent(runId)}`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type') ?? '', /^text\/csv/);
    assert.match(res.headers.get('content-disposition') ?? '', /attachment; filename="segreant-allocation-2026-07-01\.csv"/);
    const rows = parseCsv(await res.text());
    assert.deepEqual(rows[0], [...ALLOCATION_CSV_COLUMNS]);
    const col = (name: string) => ALLOCATION_CSV_COLUMNS.indexOf(name as (typeof ALLOCATION_CSV_COLUMNS)[number]);
    const body = rows.slice(1);

    // The first row describes the run and carries the total in words, not as an amount.
    assert.equal(body[0]![col('section')], 'run');
    assert.equal(body[0]![col('amountMicros')], '');
    assert.match(body[0]![col('note')]!, /Total estimated spend in the period: \$10\.070000\. The rows below add up to it exactly\./);
    assert.match(body[0]![col('note')]!, /not a provider bill/);

    const money = body.filter((r) => r[col('section')] !== 'run');
    assert.deepEqual(money.map((r) => r[col('section')]).sort(), ['allocated', 'allocated', 'allocated', 'unallocated']);
    const sum = money.reduce((s, r) => s + Number(r[col('amountMicros')]), 0);
    assert.equal(sum, 10_070_000, 'the amount column adds up to the total exactly');
    for (const r of money) {
      assert.match(r[col('basis')]!, /^showback split of the local estimate/);
      assert.equal(r[col('amountUsd')], microsToUsd(Number(r[col('amountMicros')])), 'dollars and microdollars agree');
    }
    const thirds = money.filter((r) => r[col('section')] === 'allocated').map((r) => Number(r[col('amountMicros')]));
    assert.equal(thirds.reduce((a, b) => a + b, 0), 10_000_000, 'the three shares of $10.00 add up to $10.00');
    assert.deepEqual(money.filter((r) => r[col('section')] === 'allocated').map((r) => r[col('shareOfRule')]).sort(), ['0.333333', '0.333333', '0.333334']);

    const unallocated = money.find((r) => r[col('section')] === 'unallocated')!;
    assert.equal(unallocated[col('amountUsd')], '0.070000');
    assert.match(unallocated[col('note')]!, /not allocated: no rule claimed it; mostly side, "quoted" project \(\$0\.070000\)/);
    // A centre name that starts like a formula is defused, not executed.
    assert.ok(money.some((r) => r[col('costCentre')] === "'=Research"));
  });
});

test('segreant alloc export writes the same file the dashboard serves', async () => {
  const home = mkdtempSync(join(tmpdir(), 'segreant-allocation-csv-cli-'));
  const saved = Object.fromEntries(['SEGREANT_HOME', 'SEGREANT_DB', 'SEGREANT_DEMO'].map((k) => [k, process.env[k]]));
  process.env.SEGREANT_HOME = home; delete process.env.SEGREANT_DB; delete process.env.SEGREANT_DEMO;
  const root = join(import.meta.dirname, '..');
  const env = { ...process.env, SEGREANT_HOME: home };
  const cli = (...args: string[]) => spawnSync(process.execPath, [join(root, 'dist/cli.js'), ...args], { env, encoding: 'utf8', timeout: 30_000 });
  try {
    const store = new Store(join(home, 'segreant.db'));
    store.insertRequest(request('ten', 'app', 10, DAY / 2));
    store.close();
    assert.equal(cli('alloc', 'centre', 'eng', '--name', 'Engineering').status, 0);
    assert.equal(cli('alloc', 'rule', 'all', '--method', 'direct', '--centre', 'eng').status, 0);
    assert.equal(cli('alloc', 'run', '--from', new Date(START).toISOString(), '--to', new Date(START + DAY).toISOString(), '--apply').status, 0);

    const listed = cli('alloc', 'runs', '--json');
    assert.equal(listed.status, 0, listed.stderr);
    const runs = JSON.parse(listed.stdout).runs as Array<{ allocationRunId: string; totalMicros: number }>;
    assert.equal(runs.length, 1);
    assert.equal(runs[0]!.totalMicros, 10_000_000);

    const exported = cli('alloc', 'export', runs[0]!.allocationRunId);
    assert.equal(exported.status, 0, exported.stderr);
    const served = new Store(join(home, 'segreant.db'));
    const server = createDashboardServer({ store: served, config: structuredClone(DEFAULT_CONFIG), version: 'allocation-csv' });
    try {
      server.listen(0, '127.0.0.1'); await once(server, 'listening');
      const body = await (await fetch(`http://127.0.0.1:${(server.address() as { port: number }).port}/api/allocation/run.csv?id=${encodeURIComponent(runs[0]!.allocationRunId)}`)).text();
      assert.equal(exported.stdout, body);
    } finally {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
      served.close();
    }

    const unknown = cli('alloc', 'export', 'no-such-run');
    assert.equal(unknown.status, 1);
    assert.match(unknown.stderr, /No recorded allocation run has the id "no-such-run"/);
    assert.equal(cli('alloc', 'export').status, 2);
  } finally {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    rmSync(home, { recursive: true, force: true });
  }
});

test('the run CSV needs an id that exists, and serves HEAD', async () => {
  await fixture(async ({ base, store, post }) => {
    store.insertRequest(request('one', 'app', 1, DAY / 2));
    await post({ op: 'centre', id: 'eng', name: 'Engineering' });
    await post({ op: 'rule', id: 'all', method: 'direct', match: {}, targets: [{ costCentreId: 'eng', ratio: 1 }] });
    await post({ op: 'run', from: new Date(START).toISOString(), to: new Date(START + DAY).toISOString(), apply: true });
    const runId = store.allocationRuns(1)[0]!.allocationRunId;

    const missing = await fetch(`${base}/api/allocation/run.csv`);
    assert.equal(missing.status, 400);
    assert.match(((await missing.json()) as { error: string }).error, /id is required/);
    const unknown = await fetch(`${base}/api/allocation/run.csv?id=no-such-run`);
    assert.equal(unknown.status, 404);
    assert.match(((await unknown.json()) as { error: string }).error, /no recorded allocation run/);
    const head = await fetch(`${base}/api/allocation/run.csv?id=${encodeURIComponent(runId)}`, { method: 'HEAD' });
    assert.equal(head.status, 200);
    assert.match(head.headers.get('content-type') ?? '', /^text\/csv/);
  });
});
