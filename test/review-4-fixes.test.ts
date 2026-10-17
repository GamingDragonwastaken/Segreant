/**
 * Findings from the fourth independent review (Codex, PRs #125-#132), each
 * checked against the code and pinned here.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { Store, type RequestRow } from '../src/store/db.ts';
import { buildSessions } from '../src/dashboard/sessions.ts';
import { BudgetGuard, capBasisSpend } from '../src/budget/guard.ts';
import { buildGuide, type GuideFacts } from '../src/guide.ts';
import { DEFAULT_CONFIG } from '../src/config.ts';

const DAY = 24 * 60 * 60 * 1000;
const NOW = new Date(2026, 9, 16, 15).getTime();
let seq = 0;
function req(over: Partial<RequestRow>): RequestRow {
  seq += 1;
  return {
    requestId: `q${seq}`, sessionId: `s${seq}`, tsEpochMs: NOW - DAY, provider: 'openai', model: 'gpt-4.1-mini',
    project: 'app', taskWeight: 1, inputTokens: 1234, outputTokens: 567, cacheWriteTokens: 0, cacheReadTokens: 0,
    reasoningTokens: 0, costUsd: 0.0014008, estimated: false, streamed: false, statusCode: 200, durationMs: 1,
    ...over,
  };
}

test('F1: the outcome breakdown adds back to the spend it partitions', () => {
  const store = new Store(':memory:');
  try {
    for (let i = 0; i < 1000; i++) store.insertRequest(req({}));
    const p = buildSessions(store, '7d', { startMs: NOW - 7 * DAY, endMs: NOW + 1000, bucketMs: DAY }, { now: NOW });
    // Every row is in a session; the payload lists at most `sessionLimit` rows, the totals cover all.
    assert.equal(p.totals.unsessionedRequests, 0);
    const sessionsMicros = Math.round(p.totals.costUsd * 1e6);
    const o = p.outcomes;
    const outcomeMicros = Math.round((o.noCommit.costUsd + o.kept.costUsd + o.notKept.costUsd + o.contested.costUsd
      + o.unknown.costUsd + o.maturing.costUsd + o.unmeasured.costUsd) * 1e6);
    assert.equal(outcomeMicros, sessionsMicros, `${outcomeMicros} µ$ of outcomes for ${sessionsMicros} µ$ of sessions`);
    assert.equal(sessionsMicros, 1_400_800);
  } finally {
    store.close();
  }
});

test('F2: a ledger whose requests were pruned is not reported as never having spent', () => {
  const home = mkdtempSync(join(tmpdir(), 'segreant-pruned-'));
  try {
    const store = new Store(join(home, 'segreant.db'));
    store.insertRequest(req({ tsEpochMs: NOW - 400 * DAY }));
    assert.ok(store.prune(NOW - 300 * DAY) >= 1);
    assert.equal(store.earliestRequestMs(), null);
    store.close();
    const out = execFileSync(process.execPath, ['bin/segreant.mjs', 'realize', '--repo', '.', '--json', '--limit', '1'], {
      cwd: process.cwd(), encoding: 'utf8', env: { ...process.env, SEGREANT_HOME: home, NO_COLOR: '1' }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    assert.doesNotMatch(out, /no_spend_recorded/, 'pruned history is not "nothing spent"');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('F3: the cap basis the guide and advisor read is the spend the guard enforces', () => {
  const store = new Store(':memory:');
  try {
    const dayStart = new Date(NOW); dayStart.setHours(0, 0, 0, 0);
    const t = dayStart.getTime() + 60_000;
    store.insertRequest(req({ tsEpochMs: t, costUsd: 2, via: 'proxy' }));      // legacy proxy row, no exact event
    store.insertRequest(req({ tsEpochMs: t + 1, costUsd: 0, via: 'proxy' }));  // a proxied request that cost nothing
    store.insertRequest(req({ tsEpochMs: t + 2, costUsd: 5, via: 'import' })); // imported, outside the cap
    const budget = { ...structuredClone(DEFAULT_CONFIG.budget), dailyUsd: 1 };
    const basis = capBasisSpend(store, budget, dayStart.getTime(), dayStart.getTime() + DAY);
    const decision = new BudgetGuard(store, budget).evaluate({ nowMs: t + 10 });
    assert.equal(basis.basis, 'live_proxy');
    assert.equal(basis.usd, 2);
    assert.equal(decision.daySpendUsd, basis.usd, 'the guard enforces that same $2');
    assert.notEqual(decision.action, 'allow', 'and a $1 cap blocks on it');
    assert.equal(basis.requests, 2, 'a proxied request counts as one even at $0');
  } finally {
    store.close();
  }
});

test('F4: with imported spend counted toward the cap, the guide says so', () => {
  const facts: GuideFacts = {
    demo: false, port: 8090, dashboardPort: 8091, proxyUp: false, requestsAllTime: 40, spend30dUsd: 5,
    capBasisSpend30dUsd: 5, capBasis: 'all_observed', dailyCapUsd: null, outcomeSignals: 0, realizationUnits: 0, laborRateSet: false,
  };
  const g = buildGuide(facts);
  assert.equal(g.next.id, 'cap');
  assert.match(g.next.notice ?? '', /all observed spend, imported included/);
  assert.doesNotMatch(g.next.notice ?? '', /through the proxy/);
});
