import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store, type RequestRow } from '../src/store/db.ts';
import { attributeCommits, projectName } from '../src/git/correlate.ts';
import { computeRealization } from '../src/value/realization.ts';
import { computeUsageRoI } from '../src/value/usage.ts';
import { userValueRows } from '../src/value/cohort.ts';
import { budgetAdvice } from '../src/value/report.ts';
import { DEFAULT_CONFIG } from '../src/config.ts';
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

test('grouped session reads preserve exact effective coverage and legacy compatibility totals', () => {
  const store = new Store(':memory:');
  try {
    store.insertRequest({ ...request('fiscus', 's1-exact', money('1.25', 'USD', 'list'), 1.25), sessionId: 's1', user: 'ada' });
    store.insertRequest({ ...request('fiscus', 's1-legacy', undefined, 2), sessionId: 's1', user: 'ada' });
    store.insertRequest({ ...request('fiscus', 's2-exact', money('0.75', 'USD', 'list'), 0.75), sessionId: 's2', user: 'lin' });
    const start = Date.parse('2026-06-01T10:00:00Z');
    const end = Date.parse('2026-06-01T11:00:00Z');

    const sessions = store.economicSessionUnits(start, end);
    const s1 = sessions.find((row) => row.sessionId === 's1');
    if (s1 === undefined || s1.economic === undefined) throw new Error('s1 exact session row is missing');
    assert.equal(s1.costUsd, 3.25);
    assert.equal(s1.requests, 2);
    assert.equal(s1.economic.amountText, '1.25');
    assert.equal(s1.economic.unresolvedRequests, 1);
    assert.equal(s1.economic.complete, false);

    const users = store.economicSessionUnitsByUser(start, end);
    assert.deepEqual(users.map((row) => [row.sessionId, row.user]).sort(), [['s1', 'ada'], ['s2', 'lin']]);
    const ada = users.find((row) => row.user === 'ada');
    if (ada === undefined || ada.economic === undefined) throw new Error('ada exact user row is missing');
    assert.equal(ada.economic.unresolvedRequests, 1);
    assert.equal(ada.economic.amountText, '1.25');
  } finally {
    store.close();
  }
});

test('non-coding usage reports exact session economics without changing outcome classification', () => {
  const store = new Store(':memory:');
  try {
    store.insertRequest({ ...request('fiscus', 'usage-exact', money('0.333333', 'USD', 'list'), 0.333333), sessionId: 'usage-session', user: 'ada' });
    const report = computeUsageRoI(store, {
      startMs: Date.parse('2026-06-01T10:00:00Z'),
      endMs: Date.parse('2026-06-01T11:00:00Z'),
    });
    const unit = report.units.find((row) => row.sessionId === 'usage-session');
    if (unit === undefined || unit.economic === undefined) throw new Error('usage session is missing exact economic coverage');
    assert.equal(unit.economic.amountText, '0.333333');
    assert.equal(unit.economic.complete, true);
    assert.equal(unit.economic.amount.basis, 'effective');
    assert.equal(unit.realized, false, 'no outcome signal remains unknown and unrealized');
    if (report.economic === undefined || report.economic.total === null) throw new Error('usage report is missing economic rollup');
    assert.equal(report.economic.coverage, 'exact');
    assert.equal(report.economic.total.amountText, '0.333333');
  } finally {
    store.close();
  }
});

test('per-user value rows retain exact effective spend coverage under the existing privacy aggregation', () => {
  const store = new Store(':memory:');
  try {
    store.insertRequest({ ...request('fiscus', 'cohort-exact', money('0.125', 'USD', 'list'), 0.125), sessionId: 'cohort-session', user: 'ada' });
    const rows = userValueRows(store, {
      startMs: Date.parse('2026-06-01T10:00:00Z'),
      endMs: Date.parse('2026-06-01T11:00:00Z'),
    });
    const ada = rows.find((row) => row.user === 'ada');
    if (ada === undefined || ada.economic === undefined) throw new Error('user value row is missing exact economic coverage');
    assert.equal(ada.economic.amountText, '0.125');
    assert.equal(ada.economic.complete, true);
    assert.equal(ada.costUsd, 0.125, 'legacy cost remains a compatibility projection');
  } finally {
    store.close();
  }
});

test('model-grouped effective reads keep provider/model identity and exact own-spend coverage', () => {
  const store = new Store(':memory:');
  try {
    store.insertRequest({ ...request('fiscus', 'model-a', money('0.000001', 'USD', 'list'), 0.000001), sessionId: 'model-session', provider: 'anthropic', model: 'claude-opus-4-8' });
    store.insertRequest({ ...request('fiscus', 'model-b', money('2', 'USD', 'list'), 2), sessionId: 'model-session', provider: 'openai', model: 'gpt-4o' });
    const models = store.economicModelUnits(Date.parse('2026-06-01T10:00:00Z'), Date.parse('2026-06-01T11:00:00Z'));
    const anthropic = models.find((row) => row.provider === 'anthropic');
    if (anthropic === undefined || anthropic.economic === undefined) throw new Error('anthropic exact model row is missing');
    assert.equal(anthropic.economic.amountText, '0.000001');
    assert.equal(anthropic.costUsd, 0.000001);
    assert.equal(anthropic.economic.complete, true);
    assert.equal(anthropic.requests, 1);
  } finally {
    store.close();
  }
});

test('daily effective series preserves per-bucket exact coverage for budget advice', () => {
  const store = new Store(':memory:');
  try {
    const ts = Date.parse('2026-06-01T10:30:00Z');
    store.insertRequest({ ...request('fiscus', 'series-exact', money('1.5', 'USD', 'list'), 1.5), tsEpochMs: ts, via: 'proxy' });
    store.insertRequest({ ...request('fiscus', 'series-legacy', undefined, 2.5), tsEpochMs: ts + 1000, via: 'proxy' });
    const series = store.economicSeries(Date.parse('2026-06-01T00:00:00Z'), Date.parse('2026-06-02T00:00:00Z'), 86_400_000, true);
    assert.equal(series.length, 1);
    assert.equal(series[0]!.costUsd, 4);
    assert.equal(series[0]!.economic.amountText, '1.5');
    assert.equal(series[0]!.economic.unresolvedRequests, 1);
    assert.equal(series[0]!.economic.complete, false);
  } finally {
    store.close();
  }
});

test('budget advice consumes exact effective buckets and discloses unresolved legacy spend', () => {
  const store = new Store(':memory:');
  try {
    const now = Date.parse('2026-06-02T00:00:00Z');
    store.insertRequest({ ...request('fiscus', 'budget-exact', money('0.125', 'USD', 'list'), 0.125), tsEpochMs: now - 60_000, via: 'proxy' });
    store.insertRequest({ ...request('fiscus', 'budget-legacy', undefined, 4), tsEpochMs: now - 30_000, via: 'proxy' });
    const config = structuredClone(DEFAULT_CONFIG);
    const advice = budgetAdvice(store, config, { nowMs: now, windowDays: 2 });
    if (advice.economic === undefined) throw new Error('budget advice is missing economic coverage');
    assert.equal(advice.economic.coverage, 'partial');
    assert.equal(advice.economic.total?.amountText, '0.125');
    assert.equal(advice.economic.total?.unresolvedRequests, 1);
    assert.equal(advice.spendBasis, 'live_proxy');
  } finally {
    store.close();
  }
});
