import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applyPricingManifest, loadPricing, pricingStatus, rateFor } from '../src/cost/pricing.ts';

// These exercise the refresh/override path against an isolated AEGIS_HOME so the
// real ~/.aegisflow is never touched. node's test runner isolates each FILE in
// its own process, so the module-level pricing memo here can't leak elsewhere.
const origHome = process.env.AEGIS_HOME;

function freshHome(): string {
  const dir = mkdtempSync(join(tmpdir(), 'aegis-pricing-'));
  process.env.AEGIS_HOME = dir;
  return dir;
}

function manifest(opusInput: number, updated = '2099-01-01'): string {
  return JSON.stringify({
    schema_version: 1,
    updated,
    unit: 'per_million_tokens',
    providers: {
      anthropic: { verified: true, models: { 'claude-opus-4-8': { input: opusInput, output: 25 } } },
    },
    fallbacks: { unknown: { input: 3, output: 15 } },
  });
}

test('a valid manifest is cached and then OVERRIDES the bundled table', () => {
  freshHome();
  const res = applyPricingManifest(manifest(999));
  assert.equal(res.ok, true);
  assert.equal(res.modelCount, 1);
  // The cache must now win: opus reads the cache's sentinel 999, not bundled $5.
  const { rate, estimated } = rateFor('anthropic', 'claude-opus-4-8');
  assert.equal(rate.input, 999);
  assert.equal(estimated, false);
  assert.equal(pricingStatus().source, 'cache');
});

test('a bad refresh never downgrades a good cache', () => {
  freshHome();
  assert.equal(applyPricingManifest(manifest(111)).ok, true);
  // Garbage JSON and valid-but-wrong-shape are both rejected...
  assert.equal(applyPricingManifest('{not json').ok, false);
  assert.equal(applyPricingManifest(JSON.stringify({ schema_version: 1, foo: 'bar' })).ok, false);
  // ...and the previously-good cache is still intact.
  assert.equal(rateFor('anthropic', 'claude-opus-4-8').rate.input, 111);
});

test('with no cache, loadPricing falls back to the bundled table', () => {
  freshHome(); // empty temp home → no cache file present
  loadPricing(true);
  assert.equal(pricingStatus().source, 'bundled');
  assert.equal(rateFor('anthropic', 'claude-opus-4-8').rate.input, 5); // the real bundled rate
});

test('pricingStatus flags a stale table by its updated date', () => {
  freshHome();
  applyPricingManifest(manifest(5, '2000-01-01'));
  const st = pricingStatus(30);
  assert.equal(st.stale, true);
  assert.ok((st.ageDays ?? 0) > 1000);
});

test.after(() => {
  if (origHome === undefined) delete process.env.AEGIS_HOME;
  else process.env.AEGIS_HOME = origHome;
});
