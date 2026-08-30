import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store, type RequestRow } from '../src/store/db.ts';
import { attributeCommits, projectName } from '../src/git/correlate.ts';
import { computeRealization } from '../src/value/realization.ts';
import { money } from '../src/economics/money.ts';
import { economicEvent } from '../src/economics/events.ts';
import { instant } from '../src/epistemic/time.ts';
import { requestEconomicEventId } from '../src/economics/request.ts';

function git(cwd: string, args: string[], env: Record<string, string> = {}): void {
  execFileSync('git', args, { cwd, env: { ...process.env, ...env }, stdio: 'ignore' });
}

function repo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'fiscus-value-economic-'));
  git(dir, ['init', '-q']);
  git(dir, ['config', 'user.email', 'value@fiscus.test']);
  git(dir, ['config', 'user.name', 'fiscus-test']);
  return dir;
}

function commit(dir: string, contents: string, subject: string, iso: string): void {
  writeFileSync(join(dir, 'work.txt'), contents);
  git(dir, ['add', 'work.txt']);
  git(dir, ['commit', '-qm', subject, `--date=${iso}`], { GIT_COMMITTER_DATE: iso });
}

function request(project: string, id: string, economicAmount?: RequestRow['economicAmount'], costUsd?: number): RequestRow {
  return {
    requestId: id,
    sessionId: null,
    tsEpochMs: Date.parse('2026-06-01T10:30:00Z'),
    provider: 'anthropic',
    model: 'claude-opus-4-8',
    project,
    taskWeight: 1,
    inputTokens: 10,
    outputTokens: 10,
    cacheWriteTokens: 0,
    cacheReadTokens: 0,
    reasoningTokens: 0,
    costUsd: costUsd ?? (economicAmount ? 1.234567 : 2),
    economicAmount,
    estimated: false,
    streamed: false,
    statusCode: 200,
    durationMs: 1,
    via: 'import',
  };
}

test('commit attribution carries complete effective Money lineage without a float authority', async () => {
  const dir = repo();
  const store = new Store(':memory:');
  try {
    commit(dir, 'base\n', 'feat: base', '2026-06-01T10:00:00+00:00');
    commit(dir, 'base\nmore\n', 'feat: exact', '2026-06-01T11:00:00+00:00');
    const project = await projectName(dir);
    store.insertRequest(request(project, 'exact', money('1.234567', 'USD', 'list')));

    const rows = await attributeCommits(store, dir, { limit: 5, scopeProject: project });
    const exact = rows.find((row) => row.subject === 'feat: exact');
    assert.ok(exact);
    assert.deepEqual(exact.economic, {
      amount: { coefficient: '1234567', scale: 6, currency: 'USD', basis: 'effective' },
      amountText: '1.234567',
      eventIds: ['economic:request:exact:charge'],
      sourceBases: ['list'],
      requestCount: 1,
      unresolvedRequests: 0,
      complete: true,
    });
    assert.equal(JSON.stringify(exact).includes('BigInt'), false);
    assert.equal(exact.attributedCostUsd, 1.234567, 'numeric field remains a labelled compatibility projection');
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('commit attribution marks a mixed exact/legacy window incomplete instead of promoting numeric spend', async () => {
  const dir = repo();
  const store = new Store(':memory:');
  try {
    commit(dir, 'base\n', 'feat: base', '2026-06-01T10:00:00+00:00');
    commit(dir, 'base\nmore\n', 'feat: mixed', '2026-06-01T11:00:00+00:00');
    const project = await projectName(dir);
    store.insertRequest(request(project, 'exact', money('1.234567', 'USD', 'list')));
    store.insertRequest(request(project, 'legacy'));

    const rows = await attributeCommits(store, dir, { limit: 5, scopeProject: project });
    const mixed = rows.find((row) => row.subject === 'feat: mixed');
    if (mixed === undefined || mixed.economic === undefined) throw new Error('mixed attribution is missing economic coverage');
    assert.equal(mixed.economic.unresolvedRequests, 1);
    assert.equal(mixed.economic.requestCount, 2);
    assert.equal(mixed.economic.complete, false);
    assert.equal(mixed.economic.amountText, '1.234567', 'partial exact amount is disclosed, not treated as the full numeric attribution');
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the effective request read model preserves dimensions, alias scope, and correction lineage', () => {
  const store = new Store(':memory:');
  try {
    store.setProjectAlias('fiscus-alias', 'fiscus');
    store.insertRequest({ ...request('fiscus-alias', 'exact', money('1.234567', 'USD', 'list')), sessionId: 's1', source: 'codex', user: 'ada' });
    store.insertRequest(request('other', 'other', money('9', 'USD', 'list'), 9));

    const rows = store.economicRequestRowsInRange(
      Date.parse('2026-06-01T10:00:00Z'),
      Date.parse('2026-06-01T11:00:00Z'),
      { project: 'fiscus' },
    );
    assert.equal(rows.length, 1);
    const row = rows[0]!;
    assert.equal(row.requestId, 'exact');
    assert.equal(row.project, 'fiscus-alias');
    assert.equal(row.projectCanonical, 'fiscus');
    assert.equal(row.sessionId, 's1');
    assert.equal(row.provider, 'anthropic');
    assert.equal(row.model, 'claude-opus-4-8');
    assert.equal(row.via, 'import');
    assert.equal(row.effectiveAmount?.coefficient, 1234567n);
    assert.equal(row.effectiveAmount?.basis, 'effective');
    assert.deepEqual(row.sourceBases, ['list']);
    assert.deepEqual(row.sourceEventIds, ['economic:request:exact:charge']);
    assert.equal(row.unresolvedReason, null);
  } finally {
    store.close();
  }
});

test('value attribution refuses an exact event whose dimensions drift from the request row', async () => {
  const dir = repo();
  const store = new Store(':memory:');
  try {
    commit(dir, 'base\n', 'feat: base', '2026-06-01T10:00:00+00:00');
    commit(dir, 'base\nmore\n', 'feat: drift', '2026-06-01T11:00:00+00:00');
    const project = await projectName(dir);
    store.insertRequest(request(project, 'drift'));
    store.economic().append(economicEvent({
      id: requestEconomicEventId('drift'),
      kind: 'charge_estimated',
      subject: 'request:drift',
      occurredAt: instant('2026-06-01T10:30:00.000Z'),
      recordedAt: instant('2026-06-01T10:31:00.000Z'),
      amount: money('2', 'USD', 'list'),
      sourceEventIds: [],
      reversalOf: null,
      metadata: {
        requestId: 'drift', provider: 'different-provider', model: 'claude-opus-4-8',
        project, via: 'import',
      },
      schemaVersion: 1,
    }));

    await assert.rejects(
      attributeCommits(store, dir, { limit: 5, scopeProject: project }),
      /metadata disagrees with request drift/,
    );
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('realization rollup exposes exact effective spend coverage separately from numeric compatibility fields', async () => {
  const dir = repo();
  const store = new Store(':memory:');
  try {
    commit(dir, 'base\n', 'feat: base', '2026-06-01T10:00:00+00:00');
    commit(dir, 'base\nmore\n', 'feat: exact', '2026-06-01T11:00:00+00:00');
    const project = await projectName(dir);
    store.insertRequest(request(project, 'exact', money('1.234567', 'USD', 'list')));

    const report = await computeRealization(store, dir, { limit: 5, windowDays: 14 });
    if (report.matured.economic === undefined) throw new Error('realization report is missing economic coverage');
    if (report.matured.economic.total === null || report.matured.economic.realized === null) {
      throw new Error('exact realization rollup is missing total or realized amount');
    }
    assert.equal(report.matured.economic.coverage, 'exact');
    assert.equal(report.matured.economic.total.amountText, '1.234567');
    assert.equal(report.matured.economic.total.amount.basis, 'effective');
    assert.deepEqual(report.matured.economic.total.sourceBases, ['list']);
    assert.equal(report.matured.economic.total.unresolvedRequests, 0);
    assert.equal(report.matured.economic.realized.amountText, '0');
    assert.equal(report.matured.totalCostUsd, 1.234567, 'legacy numeric field remains a compatibility projection');
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
