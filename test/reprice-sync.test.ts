/**
 * Reprice ↔ realized-value consistency.
 *
 * A reprice rewrites what the request ledger says a window cost. Persisted work
 * units were built from that same spend, so unless they move too, `fiscus spend`
 * and `fiscus value` answer "what did this cost" with two different prices and
 * neither says so. These tests pin the money, the refusals, and — most
 * importantly — that a price change can never alter an OUTCOME.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Isolate from any real ~/.fiscus pricing override.
process.env.FISCUS_HOME = mkdtempSync(join(tmpdir(), 'aegis-home-'));

import { DatabaseSync } from 'node:sqlite';
import { Store, type RequestRow, type RepriceUpdate, type CostScope } from '../src/store/db.ts';
import { computeCost, type Provider } from '../src/cost/pricing.ts';
import { realizationFromStore } from '../src/value/realization.ts';
import { computeFrontier } from '../src/value/frontier.ts';

const WINDOW_START = 1_000;
const WINDOW_END = 5_000;

function req(over: Partial<RequestRow>): RequestRow {
  return {
    requestId: 'r1', sessionId: null, tsEpochMs: 2_000, provider: 'anthropic',
    model: 'claude-opus-4-8', project: 'p', taskWeight: 1, inputTokens: 1_000_000, outputTokens: 0,
    cacheWriteTokens: 0, cacheReadTokens: 0, reasoningTokens: 0, costUsd: 3, estimated: true,
    streamed: false, statusCode: 200, durationMs: 1, ...over,
  };
}

/** The exact price the current card gives the fixture row — never hard-coded. */
function exactCost(model = 'claude-opus-4-8'): number {
  return computeCost('anthropic' as Provider, model, {
    inputTokens: 1_000_000, outputTokens: 0, cacheWriteTokens: 0, cacheReadTokens: 0,
  }).costUsd;
}

function unitJson(over: Record<string, unknown> = {}): string {
  return JSON.stringify({
    hash: 'c1', tsEpochMs: WINDOW_END, subject: 'feat: thing', linesAdded: 100, linesDeleted: 0, filesChanged: 1,
    windowStartMs: WINDOW_START, windowEndMs: WINDOW_END,
    attributedCostUsd: 3, attributedRequests: 1, attributedOutputTokens: 0, costPerHundredLines: 3,
    ageDays: 30, maturing: false, survivalRatio: 1, reverted: false, hadProposal: false, acceptance: null,
    taskType: 'feature', dominantModel: 'claude-opus-4-8', dominantModelCostUsd: 3, dominantModelCostShare: 1,
    costStale: false,
    funnel: {
      realized: true,
      // The full ladder: the rollup walks every gate in order, so a short results
      // array would be a fixture artefact rather than a realistic unit.
      results: ['proposed', 'accepted', 'committed', 'tested', 'merged', 'shipped', 'survived', 'clean']
        .map((gate) => ({ gate, verdict: 'pass', detail: 'fixture' })),
      reachedIndex: 7, reached: 'clean', diedAt: null, diedAtIndex: null,
      passes: 8, fails: 0, unknowns: 0, instrumented: 8, realizationScore: 1,
    },
    ...over,
  });
}

function saveUnit(store: Store, costScope: CostScope, over: Record<string, unknown> = {}, project = 'p'): void {
  const json = unitJson(over);
  const u = JSON.parse(json) as { hash: string; tsEpochMs: number; attributedCostUsd: number; maturing: boolean };
  store.saveRealizationUnits([{
    commitHash: u.hash, project, tsEpochMs: u.tsEpochMs, computedAtMs: 0,
    attributedCostUsd: u.attributedCostUsd, maturing: u.maturing, realized: true, unitJson: json, costScope,
  }]);
}

/** Build the reprice updates the CLI would build for whatever is estimated. */
function updatesFor(store: Store): RepriceUpdate[] {
  const out: RepriceUpdate[] = [];
  for (const r of store.estimatedRequestRows()) {
    const c = computeCost(r.provider as Provider, r.model, {
      inputTokens: r.inputTokens, outputTokens: r.outputTokens,
      cacheWriteTokens: r.cacheWriteTokens, cacheReadTokens: r.cacheReadTokens,
    });
    if (!c.estimated) out.push({ requestId: r.requestId, costUsd: c.costUsd, pricing: c.pricing });
  }
  return out;
}

test('reprice: a snapshot whose window was repriced is re-attributed, not left on the old price', () => {
  const store = new Store(':memory:');
  store.insertRequest(req({}));
  saveUnit(store, 'project');

  const expected = exactCost();
  assert.notEqual(expected, 3, 'fixture must actually move the price, or this proves nothing');

  const sync = store.applyRepricedCosts(updatesFor(store));
  assert.equal(sync.markedStale, 1);
  assert.equal(sync.resynced, 1);
  assert.equal(sync.unresolvable, 0);
  assert.equal(sync.costUsdBefore, 3);
  assert.ok(Math.abs(sync.costUsdAfter - expected) < 1e-9);

  // The two surfaces now agree. Before this fix the ledger said `expected` while
  // the value report still said 3 — with nothing on either side disclosing it.
  const ledger = store.summary(0, 10_000).costUsd;
  const rep = realizationFromStore(store);
  assert.ok(Math.abs(ledger - expected) < 1e-9, 'request ledger carries the new price');
  assert.ok(Math.abs(rep.matured.totalCostUsd - expected) < 1e-9, 'realized value carries the SAME new price');
  assert.equal(rep.costStaleUnits, 0, 'a resynced unit is not stale');

  // Per-model attribution is re-derived too, or the model trial would keep
  // comparing prices that no longer exist.
  const unit = rep.units[0]!;
  assert.ok(Math.abs(unit.dominantModelCostUsd! - expected) < 1e-9);
  assert.equal(unit.dominantModelCostShare, 1);
  assert.ok(Math.abs(unit.costPerHundredLines! - (expected / 100) * 100) < 1e-9);
  store.close();
});

test('reprice: re-attribution moves money only — outcomes, maturity and gates are untouched', () => {
  const store = new Store(':memory:');
  store.insertRequest(req({}));
  saveUnit(store, 'project');
  const before = realizationFromStore(store).units[0]!;

  store.applyRepricedCosts(updatesFor(store));
  const after = realizationFromStore(store).units[0]!;

  assert.equal(after.funnel.realized, before.funnel.realized);
  assert.deepEqual(after.funnel, before.funnel, 'a price cannot change whether work realized');
  assert.equal(after.maturing, before.maturing);
  assert.equal(after.survivalRatio, before.survivalRatio);
  assert.equal(after.acceptance, before.acceptance);
  assert.equal(after.taskType, before.taskType);
  assert.equal(after.linesAdded, before.linesAdded);
  assert.notEqual(after.attributedCostUsd, before.attributedCostUsd, 'the money is the only thing that moved');
  store.close();
});

test('reprice: a snapshot predating the recorded cost basis is marked stale, never recomputed on a guess', () => {
  const store = new Store(':memory:');
  store.insertRequest(req({}));
  saveUnit(store, 'legacy_unknown');

  const sync = store.applyRepricedCosts(updatesFor(store));
  assert.equal(sync.markedStale, 1);
  assert.equal(sync.resynced, 0);
  assert.equal(sync.unresolvable, 1, 'the basis is unrecoverable, so the dollars stand as recorded');

  const rep = realizationFromStore(store);
  assert.equal(rep.matured.totalCostUsd, 3, 'the recorded observation is kept rather than re-derived wrongly');
  assert.equal(rep.costStaleUnits, 1);
  assert.equal(rep.units[0]!.costStale, true);
  assert.equal(store.countStaleRealizationUnits(), 1);
  store.close();
});

test('reprice: a unit whose window contains none of the repriced rows is untouched', () => {
  const store = new Store(':memory:');
  // Repriced request sits AFTER the unit's window.
  store.insertRequest(req({ tsEpochMs: 9_000 }));
  saveUnit(store, 'project');

  const sync = store.applyRepricedCosts(updatesFor(store));
  assert.equal(sync.markedStale, 0);
  assert.equal(sync.resynced, 0);
  const rep = realizationFromStore(store);
  assert.equal(rep.matured.totalCostUsd, 3, 'unrelated spend must not re-attribute this unit');
  assert.equal(rep.costStaleUnits, 0);
  store.close();
});

test('reprice: window membership is half-open — the same test summary() applies', () => {
  // A request exactly at windowEndMs belongs to the NEXT window, not this one, so
  // it must not trigger a resync here. Getting this wrong re-attributes a unit
  // from spend its own cost never included.
  const atEnd = new Store(':memory:');
  atEnd.insertRequest(req({ tsEpochMs: WINDOW_END }));
  saveUnit(atEnd, 'project');
  assert.equal(atEnd.applyRepricedCosts(updatesFor(atEnd)).markedStale, 0, 'windowEndMs is exclusive');
  atEnd.close();

  const atStart = new Store(':memory:');
  atStart.insertRequest(req({ tsEpochMs: WINDOW_START }));
  saveUnit(atStart, 'project');
  assert.equal(atStart.applyRepricedCosts(updatesFor(atStart)).markedStale, 1, 'windowStartMs is inclusive');
  atStart.close();
});

test('reprice: a project-scoped unit ignores another project\'s repriced spend; a window-scoped one does not', () => {
  const scoped = new Store(':memory:');
  scoped.insertRequest(req({ project: 'other' }));
  saveUnit(scoped, 'project', {}, 'p');
  assert.equal(scoped.applyRepricedCosts(updatesFor(scoped)).markedStale, 0, 'its cost never included that project');
  scoped.close();

  const blind = new Store(':memory:');
  blind.insertRequest(req({ project: 'other' }));
  saveUnit(blind, 'window', {}, 'p');
  const sync = blind.applyRepricedCosts(updatesFor(blind));
  assert.equal(sync.markedStale, 1, 'a project-blind window sum DID include it');
  assert.equal(sync.resynced, 1);
  blind.close();
});

test('reprice: project scoping follows the alias family, not the raw label', () => {
  const store = new Store(':memory:');
  store.insertRequest(req({ project: 'aegisflow-ts' }));
  store.setProjectAlias('aegisflow-ts', 'aegisflow');
  saveUnit(store, 'project', {}, 'aegisflow');
  // The unit and the request name the same project through different labels. If
  // scoping compared raw strings this would look like unrelated spend and the
  // snapshot would keep a price its own ledger rows no longer have.
  const sync = store.applyRepricedCosts(updatesFor(store));
  assert.equal(sync.markedStale, 1);
  assert.equal(sync.resynced, 1);
  store.close();
});

test('reprice: synthetic demo snapshots are neither staled nor rewritten by a ledger reprice', () => {
  const store = new Store(':memory:');
  store.insertRequest(req({}));
  saveUnit(store, 'synthetic_demo');
  const sync = store.applyRepricedCosts(updatesFor(store));
  // Their dollars are asserted by the seed, never summed from the ledger, so the
  // ledger changing cannot have staled them — and re-deriving would silently
  // replace the demo's numbers with whatever illustrative traffic happens to sit
  // in the window.
  assert.equal(sync.markedStale, 0);
  assert.equal(sync.resynced, 0);
  assert.equal(realizationFromStore(store).matured.totalCostUsd, 3);
  store.close();
});

test('reprice: stale units are excluded from model comparison and counted, never silently dropped', () => {
  const store = new Store(':memory:');
  // Two models, three units each, each in its own window so one can be staled
  // through the REAL path rather than a test-only hook.
  const roster = [
    { hash: 'o1', model: 'claude-opus-4-8', cost: 10, scope: 'project' as CostScope },
    { hash: 'o2', model: 'claude-opus-4-8', cost: 10, scope: 'project' as CostScope },
    { hash: 'o3', model: 'claude-opus-4-8', cost: 10, scope: 'project' as CostScope },
    { hash: 'h1', model: 'claude-haiku-4-5', cost: 2, scope: 'project' as CostScope },
    { hash: 'h2', model: 'claude-haiku-4-5', cost: 2, scope: 'project' as CostScope },
    // Pre-provenance snapshot: a reprice in its window can only mark it stale.
    { hash: 'h3', model: 'claude-haiku-4-5', cost: 2, scope: 'legacy_unknown' as CostScope },
    // A fourth keeps the candidate side at the 3-unit floor once h3 drops out, so
    // this test measures the exclusion rather than the minimum-sample refusal.
    { hash: 'h4', model: 'claude-haiku-4-5', cost: 2, scope: 'project' as CostScope },
  ];
  roster.forEach((u, i) => {
    const start = 100_000 + i * 10_000;
    const json = unitJson({
      hash: u.hash, tsEpochMs: start + 5_000, windowStartMs: start, windowEndMs: start + 5_000,
      dominantModel: u.model, dominantModelCostUsd: u.cost, attributedCostUsd: u.cost,
    });
    store.saveRealizationUnits([{
      commitHash: u.hash, project: 'p', tsEpochMs: start + 5_000, computedAtMs: 0,
      attributedCostUsd: u.cost, maturing: false, realized: true, unitJson: json, costScope: u.scope,
    }]);
  });
  // One estimated row inside h3's window only (index 5 → 150_000..155_000).
  store.insertRequest(req({ requestId: 'inH3', tsEpochMs: 152_000 }));
  const sync = store.applyRepricedCosts(updatesFor(store));
  assert.equal(sync.markedStale, 1);
  assert.equal(sync.unresolvable, 1);

  const rep = realizationFromStore(store);
  assert.equal(rep.costStaleUnits, 1);
  const rec = computeFrontier(rep.units).modelSwitches.find((m) => m.taskType === 'feature');
  assert.ok(rec, 'the remaining cohort still compares');
  assert.equal(rec!.unitsExcludedStalePricing, 1, 'the exclusion is reported, not hidden');
  assert.equal(rec!.candidateUnits, 3, 'the stale unit did not price a model');
  assert.equal(rec!.candidateModel, 'claude-haiku-4-5');
  store.close();
});

test('reprice: a pre-migration snapshot table gains the columns without inventing a basis or a staleness', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fiscus-migrate-'));
  const file = join(dir, 'legacy.db');
  // The realization_units shape from before cost provenance existed.
  const legacy = new DatabaseSync(file);
  legacy.exec(`CREATE TABLE realization_units (
    commit_hash TEXT PRIMARY KEY NOT NULL, project TEXT NOT NULL DEFAULT 'default',
    ts_epoch_ms INTEGER NOT NULL, computed_at_ms INTEGER NOT NULL,
    attributed_cost_usd REAL NOT NULL DEFAULT 0, maturing INTEGER NOT NULL DEFAULT 0,
    realized INTEGER NOT NULL DEFAULT 0, unit_json TEXT NOT NULL)`);
  legacy.prepare(`INSERT INTO realization_units VALUES (?,?,?,?,?,?,?,?)`)
    .run('old', 'p', WINDOW_END, 0, 3, 0, 1, unitJson());
  legacy.close();

  const store = new Store(file);
  const rep = realizationFromStore(store);
  assert.equal(rep.matured.totalCostUsd, 3, 'the legacy dollars are preserved exactly');
  assert.equal(rep.costStaleUnits, 0, 'a reprice we have no record of is not asserted to have happened');

  // …but its basis is honestly unknown, so a reprice can only disclose, not fix.
  store.insertRequest(req({}));
  const sync = store.applyRepricedCosts(updatesFor(store));
  assert.equal(sync.unresolvable, 1);
  assert.equal(sync.resynced, 0);
  assert.equal(realizationFromStore(store).costStaleUnits, 1);
  store.close();
});
