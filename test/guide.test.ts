import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildGuide, type GuideFacts } from '../src/guide.ts';

/** A fresh install: nothing flowed, nothing set, nothing wired. */
function freshFacts(over: Partial<GuideFacts> = {}): GuideFacts {
  return {
    demo: false,
    port: 8090,
    dashboardPort: 8091,
    proxyUp: false,
    requestsAllTime: 0,
    spend30dUsd: 0,
    dailyCapUsd: null,
    outcomeSignals: 0,
    realizationUnits: 0,
    laborRateSet: false,
    ...over,
  };
}

test('guide: a fresh install starts at meter, tells you to start the proxy, and offers the demo', () => {
  const g = buildGuide(freshFacts());
  assert.equal(g.stage, 'meter');
  assert.equal(g.next.id, 'meter');
  assert.ok(g.next.commands.some((c) => c.includes('aegisflow start')), 'proxy down → the first command starts it');
  assert.ok(g.hint !== null && g.hint.includes('demo'), 'an empty install is offered the sandbox');
});

test('guide: proxy up but silent → commands switch from starting to pointing tools at it', () => {
  const g = buildGuide(freshFacts({ proxyUp: true }));
  assert.equal(g.stage, 'meter');
  assert.ok(!g.next.commands.some((c) => c.includes('aegisflow start')), 'no need to start what is running');
  assert.ok(g.next.commands.some((c) => c.includes('BASE_URL')), 'the missing piece is the env var');
});

test('guide: each verified fact flips exactly its own step, in journey order', () => {
  // The journey is cumulative: apply facts one at a time and watch the stage walk forward.
  const stages: Array<[Partial<GuideFacts>, string]> = [
    [{}, 'meter'],
    [{ requestsAllTime: 12 }, 'cap'],
    [{ requestsAllTime: 12, dailyCapUsd: 25 }, 'outcome'],
    [{ requestsAllTime: 12, dailyCapUsd: 25, outcomeSignals: 3 }, 'value'],
    [{ requestsAllTime: 12, dailyCapUsd: 25, outcomeSignals: 3, realizationUnits: 7 }, 'price'],
    [{ requestsAllTime: 12, dailyCapUsd: 25, outcomeSignals: 3, realizationUnits: 7, laborRateSet: true }, 'steward'],
  ];
  for (const [over, want] of stages) {
    const g = buildGuide(freshFacts(over));
    assert.equal(g.stage, want, `facts ${JSON.stringify(over)} → stage ${want}`);
    const doneCount = g.steps.filter((s) => s.done).length;
    assert.equal(doneCount, Object.keys(over).length, 'done-flags mirror the facts, one for one');
  }
});

test('guide: guidance never dead-ends — every state yields a next step with runnable commands', () => {
  // Sweep all 32 combinations of the five journey facts.
  for (let bits = 0; bits < 32; bits++) {
    const g = buildGuide(
      freshFacts({
        requestsAllTime: bits & 1 ? 10 : 0,
        dailyCapUsd: bits & 2 ? 25 : null,
        outcomeSignals: bits & 4 ? 1 : 0,
        realizationUnits: bits & 8 ? 1 : 0,
        laborRateSet: Boolean(bits & 16),
      }),
    );
    assert.ok(g.next, `combination ${bits}: there is always a next step`);
    assert.ok(g.next.commands.length > 0, `combination ${bits}: the next step has commands`);
    assert.ok(g.next.why.length > 0, `combination ${bits}: the next step explains itself`);
    assert.ok(g.headline.length > 0, `combination ${bits}: there is a headline`);
    assert.equal(g.steps.length, 6, 'the full journey is always visible');
  }
});

test('guide: the cap step recommends a data-driven cap only once there is data to drive it', () => {
  const noData = buildGuide(freshFacts({ requestsAllTime: 5, spend30dUsd: 0 }));
  assert.ok(!noData.next.commands.some((c) => c.includes('--recommend')), 'no spend → no basis for a recommendation');
  const withData = buildGuide(freshFacts({ requestsAllTime: 5, spend30dUsd: 12.5 }));
  assert.ok(withData.next.commands.some((c) => c.includes('--recommend')), 'spend history → recommend from it');
});

test('guide: demo data is named as such and the steward stage owns the four questions', () => {
  const demo = buildGuide(freshFacts({ demo: true }));
  assert.ok(demo.hint !== null && demo.hint.includes('demo'), 'demo mode is disclosed in the hint');

  const done = buildGuide(
    freshFacts({ requestsAllTime: 10, dailyCapUsd: 25, outcomeSignals: 2, realizationUnits: 4, laborRateSet: true }),
  );
  assert.equal(done.next.id, 'steward');
  assert.ok(done.next.state.includes('fully instrumented'));
  assert.ok(done.next.commands.some((c) => c.includes('frontier')), 'steward points at the decision surfaces');
});
