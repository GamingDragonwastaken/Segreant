/**
 * F5: the Statement's fourth card counts work in the month its survival check
 * falls, read from the stored measurement. Every judged unit lands in exactly one
 * month, the counts match an independent count, and no value figure appears.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store/db.ts';
import { seedDemo } from '../src/demo/seed.ts';
import { realizationFromStore } from '../src/value/realization.ts';
import { realizedForMonth } from '../src/dashboard/routes.ts';

const DAY = 24 * 60 * 60 * 1000;

function monthBounds(ms: number): [number, number] {
  const d = new Date(ms);
  return [new Date(d.getFullYear(), d.getMonth(), 1).getTime(), new Date(d.getFullYear(), d.getMonth() + 1, 1).getTime()];
}

test('each judged unit is counted once, in the month its check falls', () => {
  const store = new Store(':memory:');
  try {
    seedDemo(store);
    const report = realizationFromStore(store);
    const windowMs = report.windowDays * DAY;
    const judged = report.units.filter((u) => !u.maturing);
    assert.ok(judged.length > 0, 'the sample data has judged work');

    const months = new Map<number, [number, number]>();
    for (const u of judged) { const b = monthBounds(u.tsEpochMs + windowMs); months.set(b[0], b); }
    let total = 0;
    for (const [start, end] of months.values()) {
      const r = realizedForMonth(store, start, end);
      const inMonth = judged.filter((u) => u.tsEpochMs + windowMs >= start && u.tsEpochMs + windowMs < end);
      const counted = r.kept.units + r.notKept.units + r.contested.units + r.unknown.units;
      assert.equal(counted, inMonth.length, 'kept + not kept + disputed + no signal is every unit judged in the month');
      assert.equal(r.standing, 'judged_in_month');
      assert.equal(r.windowDays, report.windowDays);
      assert.ok(r.measuredAt !== null);
      assert.match(r.reason, /not its value/);
      total += counted;
    }
    assert.equal(total, judged.length, 'no judged unit is counted in two months, and none is lost');
  } finally { store.close(); }
});

test('a month before any work has nothing judged and says so', () => {
  const store = new Store(':memory:');
  try {
    seedDemo(store);
    const r = realizedForMonth(store, new Date(2001, 0, 1).getTime(), new Date(2001, 1, 1).getTime());
    assert.equal(r.standing, 'none_judged');
    assert.equal(r.kept.units + r.notKept.units + r.contested.units + r.unknown.units + r.tooEarly.units, 0);
  } finally { store.close(); }
});

test('an empty ledger reports that nothing has been measured', () => {
  const store = new Store(':memory:');
  try {
    const r = realizedForMonth(store, 0, Date.now());
    assert.equal(r.measuredAt, null);
    assert.match(r.reason, /No outcomes have been measured/);
  } finally { store.close(); }
});

// Codex review 2026-10-16, findings 2 and 3.

/** One stored unit, built from a sample unit so every required field is real. */
function storeUnit(store: Store, base: Record<string, unknown>, over: Record<string, unknown>): void {
  const unit = { ...base, ...over };
  store.saveRealizationUnits([{
    commitHash: String(unit['commitHash']), project: String(unit['project'] ?? 'p'), tsEpochMs: Number(unit['tsEpochMs']),
    computedAtMs: Date.now(), attributedCostUsd: Number(unit['attributedCostUsd'] ?? 1), maturing: Boolean(unit['maturing']),
    realized: false, unitJson: JSON.stringify(unit), costScope: 'window',
  }]);
}

function sampleUnit(): Record<string, unknown> {
  const seeded = new Store(':memory:');
  try {
    seedDemo(seeded);
    const u = realizationFromStore(seeded).units.find((x) => !x.maturing && x.funnel.conflicts.length === 0 && !x.reverted);
    assert.ok(u, 'the sample data has a settled unit to copy');
    return JSON.parse(JSON.stringify(u)) as Record<string, unknown>;
  } finally { seeded.close(); }
}

test('a unit is placed by the window it was measured with; one that never recorded it says it assumed the default', () => {
  const store = new Store(':memory:');
  try {
    const base = sampleUnit();
    const aug10 = new Date(2026, 7, 10, 12).getTime();
    storeUnit(store, base, { commitHash: 'w30', tsEpochMs: aug10, maturing: false, checkWindowDays: 30 });
    const aug = realizedForMonth(store, new Date(2026, 7, 1).getTime(), new Date(2026, 8, 1).getTime());
    const sep = realizedForMonth(store, new Date(2026, 8, 1).getTime(), new Date(2026, 9, 1).getTime());
    const n = (r: ReturnType<typeof realizedForMonth>): number => r.kept.units + r.notKept.units + r.contested.units + r.unknown.units;
    assert.equal(n(aug), 0, 'a 30-day check on 10 August does not fall in August');
    assert.equal(n(sep), 1, 'it falls on 9 September');
    assert.equal(sep.assumedWindowUnits, 0);

    const { checkWindowDays: _drop, ...legacy } = base as Record<string, unknown> & { checkWindowDays?: number };
    storeUnit(store, legacy, { commitHash: 'legacy', tsEpochMs: aug10, maturing: false });
    const augAgain = realizedForMonth(store, new Date(2026, 7, 1).getTime(), new Date(2026, 8, 1).getTime());
    assert.equal(augAgain.assumedWindowUnits, 1, 'the unit with no recorded window is counted as assumed');
    assert.match(augAgain.reason, /placed by the 14-day default/);
  } finally { store.close(); }
});

test('evidence that disagrees is "disputed", never "not kept"', () => {
  const store = new Store(':memory:');
  try {
    const base = sampleUnit();
    const funnel = base['funnel'] as { results: Array<Record<string, unknown>>; conflicts: string[] };
    const gate = String(funnel.results[0]?.['gate']);
    const conflicted = {
      ...funnel,
      conflicts: [gate],
      results: funnel.results.map((r, i) => (i === 0 ? { ...r, verdict: 'fail', polarity: 'conflicted' } : r)),
    };
    const day = new Date(2026, 7, 10, 12).getTime();
    storeUnit(store, base, { commitHash: 'disputed', tsEpochMs: day, maturing: false, reverted: false, checkWindowDays: 14, funnel: conflicted });
    const r = realizedForMonth(store, new Date(2026, 7, 1).getTime(), new Date(2026, 8, 1).getTime());
    assert.equal(r.notKept.units, 0, 'a contradiction is not a refutation');
    assert.equal(r.contested.units, 1);
  } finally { store.close(); }
});
