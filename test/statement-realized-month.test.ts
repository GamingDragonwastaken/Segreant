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
      const counted = r.kept.units + r.notKept.units + r.unknown.units;
      assert.equal(counted, inMonth.length, 'kept + not kept + no signal is every unit judged in the month');
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
    assert.equal(r.kept.units + r.notKept.units + r.unknown.units + r.tooEarly.units, 0);
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
