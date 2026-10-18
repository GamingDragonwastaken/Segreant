import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

// A cap counts a free model's requests as $0, so `--free` on a model the rate
// card prices would let real cloud spend through uncounted (owner decision,
// 2026-10-18): refused unless --force, and never from the dashboard.
const home = mkdtempSync(join(tmpdir(), 'segreant-free-guard-'));
process.env.SEGREANT_HOME = home; delete process.env.SEGREANT_DB; delete process.env.SEGREANT_DEMO;
const { declarePrice } = await import('../src/cost/declarations.ts');
const { PriceOverridesError, priceOverrideFor } = await import('../src/cost/overrides.ts');
const { loadPricing } = await import('../src/cost/pricing.ts');

const cardModel = Object.keys(loadPricing().providers['anthropic']!.models)[0]!;

function run(...args: string[]) {
  return spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', '--experimental-strip-types', 'src/cli.ts', 'pricing', 'set', ...args], {
    encoding: 'utf8', env: { ...process.env, SEGREANT_HOME: home },
  });
}

test.after(() => rmSync(home, { recursive: true, force: true }));

test('free is refused for a model the rate card prices, naming the rate', () => {
  assert.throws(() => declarePrice(cardModel, { kind: 'free' }), (error: unknown) =>
    error instanceof PriceOverridesError && error.message.includes(cardModel) && /rate card prices \(\w+: \$[\d.]+ in \/ \$[\d.]+ out/.test(error.message) && /--free --force/.test(error.message));
  assert.equal(priceOverrideFor(cardModel), null, 'nothing stored');
});

test('free stays allowed for a model the card does not know', () => {
  assert.equal(declarePrice('acme-local-llm', { kind: 'free' }).kind, 'free');
});

test('force stores free for a card model, and only free takes force', () => {
  const blocked = run(cardModel, '--free');
  assert.equal(blocked.status, 2, blocked.stdout + blocked.stderr);
  assert.match(blocked.stderr, /cap count its spend as \$0/);
  const forced = run(cardModel, '--free', '--force');
  assert.equal(forced.status, 0, forced.stderr);
  assert.match(forced.stdout, /free \(\$0 per request\)/);
  const misuse = run('acme-other', '--input', '1', '--output', '2', '--force');
  assert.equal(misuse.status, 2);
  assert.match(misuse.stderr, /--force only applies to --free/);
});
