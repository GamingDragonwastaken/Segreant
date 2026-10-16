/**
 * GET /api/statement.csv: the month a finance reader takes away.
 *
 * Pins that the file is the Statement in another form: four labelled sections,
 * each row with its own basis and dates, no row that adds the claims together,
 * every project and model (the page shows ten), exact microdollar amounts for
 * provider and allocation figures, and labels that cannot run as formulas.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type http from 'node:http';
import type { AddressInfo } from 'node:net';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Store, type RequestRow } from '../src/store/db.ts';
import { DEFAULT_CONFIG } from '../src/config.ts';
import { createDashboardServer } from '../src/dashboard/server.ts';
import { STATEMENT_CSV_COLUMNS } from '../src/export/statementCsv.ts';

const DAY = 24 * 60 * 60 * 1000;
const JULY_START = new Date(2026, 6, 1).getTime();
const JULY_END = new Date(2026, 7, 1).getTime();

function row(id: string, tsEpochMs: number, costUsd: number, project: string, model = 'gpt-4o'): RequestRow {
  return {
    requestId: id, sessionId: null, tsEpochMs, provider: 'openai', model, project, taskWeight: 1,
    inputTokens: 10, outputTokens: 10, cacheWriteTokens: 0, cacheReadTokens: 0, reasoningTokens: 0, costUsd,
    estimated: false, streamed: false, statusCode: 200, durationMs: 1,
  };
}

async function withServer(store: Store, body: (base: string) => Promise<void>): Promise<void> {
  const saved = { home: process.env.SEGREANT_HOME, demo: process.env.SEGREANT_DEMO };
  const home = mkdtempSync(join(tmpdir(), 'segreant-statement-csv-'));
  process.env.SEGREANT_HOME = home;
  delete process.env.SEGREANT_DEMO;
  const server: http.Server = createDashboardServer({ store, config: structuredClone(DEFAULT_CONFIG), version: 'test' });
  try {
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    await body(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    if (saved.home === undefined) delete process.env.SEGREANT_HOME; else process.env.SEGREANT_HOME = saved.home;
    if (saved.demo !== undefined) process.env.SEGREANT_DEMO = saved.demo;
    rmSync(home, { recursive: true, force: true });
  }
}

/** Minimal RFC 4180 reader for the test: quoted cells, doubled quotes, CRLF rows. */
function parse(csv: string): string[][] {
  const rows: string[][] = [];
  let cell = ''; let cells: string[] = []; let quoted = false;
  for (let i = 0; i < csv.length; i++) {
    const ch = csv[i]!;
    if (quoted) {
      if (ch === '"' && csv[i + 1] === '"') { cell += '"'; i++; }
      else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') { cells.push(cell); cell = ''; }
    else if (ch === '\r' && csv[i + 1] === '\n') { cells.push(cell); rows.push(cells); cells = []; cell = ''; i++; }
    else cell += ch;
  }
  return rows;
}

function populated(): Store {
  const store = new Store(':memory:');
  store.upsertCostCentre({ costCentreId: 'eng', name: 'Engineering', createdAtMs: JULY_START });
  store.saveAllocationRule({
    ruleId: 'backend', method: 'direct', match: { project: 'backend-api' }, targets: [{ costCentreId: 'eng', ratio: 1 }],
    priority: 10, effectiveFromMs: 0, effectiveToMs: null, revokedAtMs: null, owner: null, note: null,
  });
  store.insertRequest(row('in-backend', JULY_START + DAY, 4, 'backend-api'));
  // Twelve more projects: the page shows ten, the file must show all of them.
  for (let i = 0; i < 12; i++) store.insertRequest(row(`p-${i}`, JULY_START + 2 * DAY + i, 0.5, `project-${String(i).padStart(2, '0')}`));
  // A label that would run as a formula in a spreadsheet.
  store.insertRequest(row('hostile', JULY_START + 3 * DAY, 0.25, '=HYPERLINK("http://example.invalid","open")'));
  store.insertRequest(row('outside', JULY_END + DAY, 100, 'backend-api'));
  store.saveAllocationRun(store.allocatePeriod(JULY_START, JULY_END));
  return store;
}

test('the statement CSV keeps four sections with their own basis and no total', async () => {
  const store = populated();
  await withServer(store, async (base) => {
    const res = await fetch(`${base}/api/statement.csv?month=2026-07`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type') ?? '', /^text\/csv/);
    assert.equal(res.headers.get('content-disposition'), 'attachment; filename="segreant-statement-2026-07.csv"');
    const rows = parse(await res.text());
    assert.deepEqual(rows[0], [...STATEMENT_CSV_COLUMNS]);
    const body = rows.slice(1);
    const claims = new Set(body.map((r) => r[0]));
    assert.deepEqual([...claims], ['statement', 'metered', 'billed', 'allocated', 'realized', 'close']);
    assert.match(body[0]![11]!, /Do not add the sections together/);
    assert.ok(!body.some((r) => /total/i.test(r[1]!) && r[0] !== 'metered'), 'no cross-claim total row');

    const total = body.find((r) => r[0] === 'metered' && r[1] === 'total')!;
    assert.equal(total[2], '10.250000', 'the month only: the August row stays out');
    assert.equal(total[4], '14');
    assert.match(total[5]!, /^local estimate: /);

    const projects = body.filter((r) => r[0] === 'metered' && r[1]!.startsWith('project: '));
    assert.equal(projects.length, 14, 'every project, not the page\'s top ten');
    const sum = projects.reduce((s, r) => s + Number(r[2]), 0);
    assert.equal(sum.toFixed(6), total[2], 'the project rows add up to the metered total');
    const hostile = projects.find((r) => r[1]!.includes('HYPERLINK'))!;
    assert.ok(hostile[1]!.startsWith('project: ='), 'the label is kept, after its prefix');

    const billed = body.filter((r) => r[0] === 'billed');
    assert.deepEqual(billed.map((r) => r[1]), ['not established']);
    assert.equal(billed[0]![8], 'no');

    const split = body.filter((r) => r[0] === 'allocated');
    const eng = split.find((r) => r[1] === 'cost centre: Engineering')!;
    assert.equal(eng[2], '4.000000');
    assert.equal(eng[3], '4000000');
    assert.equal(eng[5], 'showback split of the local estimate');
    assert.equal(eng[8], 'yes');
    const rest = split.find((r) => r[1] === 'not allocated')!;
    assert.equal(rest[2], '6.250000', 'spend no rule claimed is shown, not dropped');

    const realized = body.find((r) => r[0] === 'realized')!;
    assert.equal(realized[2], '', 'realized value carries no amount for a calendar month');
    const realizedRows = body.filter((r) => r[0] === 'realized');
    assert.deepEqual(realizedRows.map((r) => r[1]), ['kept', 'not kept', 'results disagree', 'no signal', 'too early to tell'], 'work judged in the month, by outcome');
    for (const r of realizedRows) assert.equal(r[2], '', 'no realized row carries an amount a reader could sum as value');
  });
  store.close();
});

test('no cell in the statement CSV starts a spreadsheet formula', async () => {
  const store = populated();
  await withServer(store, async (base) => {
    const raw = await (await fetch(`${base}/api/statement.csv?month=2026-07`)).text();
    for (const r of parse(raw)) {
      for (const cell of r) assert.doesNotMatch(cell, /^[=+@\t\r]/, `formula starter in ${JSON.stringify(cell)}`);
    }
  });
  store.close();
});

test('the CSV refuses the months the statement refuses', async () => {
  const store = new Store(':memory:');
  await withServer(store, async (base) => {
    for (const month of ['2026-7', '2026-13', '2999-01']) {
      const res = await fetch(`${base}/api/statement.csv?month=${month}`);
      assert.equal(res.status, 400, month);
      assert.match(res.headers.get('content-type') ?? '', /json/);
    }
  });
  store.close();
});
