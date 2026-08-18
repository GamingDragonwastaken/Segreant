import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DEFAULT_CONFIG } from '../src/config.ts';
import { ENFORCEABILITY_STATES, describeBudgetEnforcement } from '../src/budget/enforceability.ts';

const cfg = () => structuredClone(DEFAULT_CONFIG).budget;

test('enforceability vocabulary is closed and includes in-path, provider, observed, proposed, and unknown states', () => {
  assert.deepEqual(ENFORCEABILITY_STATES, ['enforced_in_path', 'provider_native', 'observed_only', 'proposed', 'unknown']);
});

test('budget enforcement descriptor distinguishes capability, active controls, off-path spend, and uninspected provider controls', () => {
  const empty = describeBudgetEnforcement(cfg());
  assert.equal(empty.localProxy.state, 'enforced_in_path');
  assert.equal(empty.localProxy.hardControlActive, false, 'capability exists even when no hard threshold is configured');
  assert.equal(empty.localProxy.liveConfig, true);
  assert.equal(empty.localProxy.spendScope, 'live_proxy');
  assert.deepEqual(empty.importedSpend, { state: 'observed_only', blockable: false, countsTowardInPathCap: false });
  assert.deepEqual(empty.providerNative, { state: 'unknown', inspected: false });
  assert.deepEqual(empty.recommendation, { state: 'proposed', automaticallyApplied: false });

  const governed = cfg();
  governed.dailyUsd = 25;
  governed.dailySoftUsd = 20;
  governed.capIncludesImported = true;
  const d = describeBudgetEnforcement(governed);
  assert.equal(d.localProxy.hardControlActive, true);
  assert.equal(d.localProxy.warningActive, true);
  assert.equal(d.localProxy.spendScope, 'all_observed');
  assert.equal(d.importedSpend.blockable, false, 'including sunk spend in the decision does not make sunk spend blockable');
  assert.equal(d.importedSpend.countsTowardInPathCap, true);
});

test('Control UI no longer tells operators a live budget change requires a restart', () => {
  const source = readFileSync(new URL('../src/dashboard/web/app/views/control.ts', import.meta.url), 'utf8');
  assert.ok(!source.includes('Applies at proxy restart'));
  assert.ok(!source.includes('Changes need a restart'));
  assert.ok(!source.includes('share the same restart caveat'));
  assert.ok(source.includes('enforced in path'));
  assert.ok(source.includes('Provider-native limits'));
});
