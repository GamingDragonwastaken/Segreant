import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store/db.ts';
import { seedDemo } from '../src/demo/seed.ts';
import { realizationFromStore } from '../src/value/realization.ts';
import { GATE_LADDER } from '../src/value/gates.ts';

// The Value page listed `instrumentation` under "How far work got" with words
// like "was merged" and "survived in production". That count is how many
// matured units had ANY verdict at a gate, pass or fail, so on the sample data
// the list read merged 10, shipped 10, survived 13: more work "surviving" than
// shipped. The rollup now also says how many PASSED each gate.

test('gatePasses counts the matured units that passed each gate, and never exceeds the units checked there', () => {
  const store = new Store(':memory:');
  try {
    seedDemo(store);
    const report = realizationFromStore(store, { windowDays: 14 });
    const m = report.matured;
    const mature = report.units.filter((u) => !u.maturing);
    for (const gate of GATE_LADDER) {
      const expected = mature.filter((u) => u.funnel.results.some((r) => r.gate === gate && r.verdict === 'pass' && r.polarity !== 'conflicted')).length;
      assert.equal(m.gatePasses[gate], expected, `${gate}: passes`);
      assert.ok(m.gatePasses[gate] <= m.instrumentation[gate], `${gate}: more passes than units checked`);
    }
    // The sample data is the case the page got wrong: more units checked for
    // survival than checked for shipping. Reading "checked" as "reached" made
    // the list grow.
    assert.ok(m.instrumentation.survived > m.instrumentation.shipped, 'the fixture no longer reproduces the defect');
  } finally { store.close(); }
});
