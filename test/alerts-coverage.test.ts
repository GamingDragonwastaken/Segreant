/**
 * "All clear" from detectors that could not have fired (WP-D06, WP-R04).
 *
 * THE DEFECT. `detectAlerts` returns an array. `fiscus ops` reads an empty one
 * as a finding and prints it in green:
 *
 *   ✓ Alerts      all clear
 *
 * Two entirely different situations produce that empty array. In one, six
 * detectors examined real observed traffic and none of them tripped — a weak
 * negative, but a negative. In the other, the detectors were structurally unable
 * to fire at all, and the empty array records that nothing was looked at.
 *
 * THE COUNTEREXAMPLE IS THE DEFAULT INSTALL, WHICH MAKES IT THE COMMON CASE.
 * Caps are opt-in, so `dailyUsd`, `dailySoftUsd` and `runawayMaxUsd` are all
 * null until an operator sets one. Follow that through the detectors:
 *
 *   budget-cap     both thresholds null    → the branch is unreachable
 *   runaway-loop   `runaway` is null        → the branch is unreachable
 *   throttling     nothing can block        → `blocked24h` cannot exceed zero
 *   spend-spike    no prior active day      → the p90 baseline is 0, and the
 *                                             detector requires `base > 0`
 *   value-crater   `realizedSpendShare` null → the branch is unreachable
 *   pricing-trust  no spend in the window   → the share is 0 by construction,
 *                                             not by observation
 *
 * Six channels, six dark, zero alerts, and a green tick. A new user is told
 * their setup is clear on the strength of no evidence whatsoever.
 *
 * THIS IS THE COMPLETENESS RULE, AND FISCUS ALREADY OWNS IT.
 * `assessCompleteness` exists so that "no incident was observed" may not become
 * "no incident occurred" without positive evidence that the source could have
 * seen one. This surface makes the same inference and asks for nothing. The
 * repair is the same shape as the witness: say which channels were watching.
 *
 * WHY THE DENOMINATOR HAD TO BE PASSED IN. `estimatedShare` arrives already
 * divided, so a share of zero is ambiguous between "none of $50 was estimated"
 * and "there was no spend to price". `AlertInputs` now carries the window total
 * as well, and a caller that does not supply it leaves the channel DARK rather
 * than live — unknown stays unknown, and the fail-closed direction here is to
 * claim less coverage rather than more. Recorded at D-141.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { detectAlerts, alertCoverage, type AlertInputs } from '../src/alerts/detect.ts';

/** Exactly the default install: caps off, no history, uninstrumented, no spend. */
function freshInstall(): AlertInputs {
  return {
    todaySpendUsd: 0,
    todayTotalSpendUsd: 0,
    capExcludesImported: true,
    dailyCapUsd: null,
    dailySoftUsd: null,
    baselineActiveDaySpends: [],
    blocked24h: 0,
    estimatedShare: 0,
    pricedWindowSpendUsd: 0,
    runaway: null,
    realizedSpendShare: null,
  };
}

/** An operator who has configured everything and has history to compare against. */
function fullyWatched(): AlertInputs {
  return {
    todaySpendUsd: 1,
    todayTotalSpendUsd: 1,
    capExcludesImported: true,
    dailyCapUsd: 25,
    dailySoftUsd: 20,
    baselineActiveDaySpends: [2, 3, 4, 5],
    blocked24h: 0,
    estimatedShare: 0,
    pricedWindowSpendUsd: 40,
    runaway: { tripped: false, windowCostUsd: 0, windowSec: 60 },
    realizedSpendShare: 0.8,
  };
}

test('the default install produces no alerts because nothing could fire', () => {
  // The counterexample itself, pinned. If a later change makes one of these
  // channels reachable on a fresh install, this test should be updated
  // deliberately rather than silently satisfied.
  const inputs = freshInstall();
  assert.deepEqual(detectAlerts(inputs), []);

  const coverage = alertCoverage(inputs);
  assert.equal(coverage.liveChannels, 0, 'not one detector could have produced an alert');
  assert.equal(coverage.complete, false);
  for (const channel of coverage.channels) {
    assert.equal(channel.live, false, `${channel.channel} must be reported dark`);
    assert.ok((channel.darkBecause ?? '').length > 0, `${channel.channel} must say why it is dark`);
  }
});

test('a dark channel names the setting that would light it', () => {
  // A coverage report that only said "dark" would be a second way of saying
  // nothing. The operator needs the action.
  const byId = new Map(alertCoverage(freshInstall()).channels.map((c) => [c.channel, c.darkBecause ?? '']));
  assert.match(byId.get('budget-cap') ?? '', /cap|threshold/i);
  assert.match(byId.get('runaway-loop') ?? '', /runaway/i);
  assert.match(byId.get('spend-spike') ?? '', /baseline|prior|histor/i);
  assert.match(byId.get('value-crater') ?? '', /instrument|realiz/i);
  assert.match(byId.get('pricing-trust') ?? '', /spend|window/i);
});

test('a fully configured install with history reports every channel live', () => {
  // THE GUARD-RAIL. A coverage report that always said "dark" would satisfy the
  // assertions above and be exactly as uninformative as "all clear" was.
  const coverage = alertCoverage(fullyWatched());
  assert.equal(coverage.complete, true);
  assert.equal(coverage.liveChannels, coverage.channels.length);
  for (const channel of coverage.channels) {
    assert.equal(channel.darkBecause, null, `${channel.channel} is live and must give no dark reason`);
  }
});

test('channels light independently, so partial coverage is reported as partial', () => {
  // Configuring a cap must not light the value or pricing channels with it.
  const inputs = { ...freshInstall(), dailyCapUsd: 25, runaway: { tripped: false, windowCostUsd: 0, windowSec: 60 } };
  const coverage = alertCoverage(inputs);
  const live = new Set(coverage.channels.filter((c) => c.live).map((c) => c.channel));
  assert.ok(live.has('budget-cap'));
  assert.ok(live.has('runaway-loop'));
  assert.ok(live.has('throttling'), 'a cap exists, so a request can now be blocked and observed');
  assert.ok(!live.has('value-crater'), 'still uninstrumented');
  assert.ok(!live.has('spend-spike'), 'still no baseline');
  assert.equal(coverage.complete, false);
});

test('an unsupplied window denominator leaves the pricing channel dark rather than live', () => {
  // `estimatedShare` arrives already divided, so a zero share cannot distinguish
  // "none of the spend was estimated" from "there was no spend". A caller that
  // omits the denominator gets the conservative reading.
  const withDenominator = { ...fullyWatched() };
  const without: AlertInputs = { ...fullyWatched(), pricedWindowSpendUsd: undefined };
  const live = (i: AlertInputs) => alertCoverage(i).channels.find((c) => c.channel === 'pricing-trust')?.live;
  assert.equal(live(withDenominator), true);
  assert.equal(live(without), false);
});

test('the summary states coverage rather than asserting a clear result', () => {
  const dark = alertCoverage(freshInstall()).summary;
  assert.doesNotMatch(dark, /all clear|no (issues|problems)|nothing wrong|healthy/i);
  assert.match(dark, /0 of 6|cannot fire|not watching|dark/i);

  const lit = alertCoverage(fullyWatched()).summary;
  assert.match(lit, /6 of 6|all six|every channel/i);
});

test('fiscus ops no longer prints an unconditional all clear', () => {
  // A COPY REGRESSION PIN. The defect was one template string, and the cheapest
  // way for it to return is someone restoring the shorter line.
  const source = readFileSync(join(import.meta.dirname, '..', 'src', 'cli', 'opsCmd.ts'), 'utf8');
  assert.doesNotMatch(source, /'all clear'/);
  assert.match(source, /computeAlertCoverage/, 'the surface states coverage rather than composing its own verdict');
});
