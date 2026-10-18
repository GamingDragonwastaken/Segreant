import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
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

test('a card refreshed on disk by another process counts, without replacing the loaded card (PR #153 review)', async () => {
  const { mkdirSync, writeFileSync, readFileSync } = await import('node:fs');
  const { createHash } = await import('node:crypto');
  const before = loadPricing();
  const card = structuredClone(before);
  card.providers['openai']!.models['acme-cloud-added'] = { input: 2, output: 8 };
  const text = JSON.stringify(card);
  mkdirSync(join(home, 'pricing'), { recursive: true });
  writeFileSync(join(home, 'pricing', 'models.json'), text);
  const now = new Date().toISOString();
  writeFileSync(join(home, 'pricing', 'provenance.json'), JSON.stringify({
    schemaVersion: 1, sourceUrl: null, sourceUrlSha256: null, sourceKind: 'manual', fetchedAt: now, lastCheckedAt: now,
    upstreamDeclaredUpdated: null, cardSha256: createHash('sha256').update(text, 'utf8').digest('hex'),
    modelCount: Object.values(card.providers).reduce((n, p) => n + Object.keys(p.models).length, 0), etag: null, lastModified: null,
  }));
  try {
    assert.throws(() => declarePrice('acme-cloud-added', { kind: 'free' }), /cloud model the rate card prices \(openai: \$2 in/);
    assert.equal(loadPricing(), before, 'the loaded card is not replaced by the check');
    assert.equal(readFileSync(join(home, 'pricing', 'models.json'), 'utf8'), text);
  } finally {
    rmSync(join(home, 'pricing'), { recursive: true, force: true });
  }
});

test('a refresh caught mid-activation still counts (PR #153 review)', async () => {
  const { mkdirSync, writeFileSync } = await import('node:fs');
  const { createHash } = await import('node:crypto');
  const card = structuredClone(loadPricing());
  card.providers['openai']!.models['acme-mid-refresh'] = { input: 4, output: 16 };
  const text = JSON.stringify(card);
  const sha = createHash('sha256').update(text, 'utf8').digest('hex');
  mkdirSync(join(home, 'pricing', 'cards'), { recursive: true });
  try {
    // Step 1 of activation: only the archived card exists.
    writeFileSync(join(home, 'pricing', 'cards', `${sha}.json`), text);
    assert.throws(() => declarePrice('acme-mid-refresh', { kind: 'free' }), /cloud model the rate card prices/);
    // Step 3: the active card is written, its provenance not yet (no provenance file at all here).
    rmSync(join(home, 'pricing', 'cards'), { recursive: true, force: true });
    writeFileSync(join(home, 'pricing', 'models.json'), text);
    assert.throws(() => declarePrice('acme-mid-refresh', { kind: 'free' }), /cloud model the rate card prices/);
  } finally {
    rmSync(join(home, 'pricing'), { recursive: true, force: true });
  }
});

test('a free price that was not forced never zeroes a model a card prices, whatever the order (PR #153 review)', async () => {
  const { writeFileSync, mkdirSync } = await import('node:fs');
  const { rateFor } = await import('../src/cost/pricing.ts');
  const { overridesPath } = await import('../src/cost/overrides.ts');
  const now = new Date().toISOString();
  mkdirSync(dirname(overridesPath()), { recursive: true });
  // The race's end state: a free declaration stored for a model the card prices.
  writeFileSync(overridesPath(), JSON.stringify({ version: 1, models: { [cardModel]: { kind: 'free', declaredAt: now } } }));
  try {
    const plain = rateFor('anthropic', cardModel);
    assert.equal(plain.pricing.rateMatchKind, 'exact_provider', 'the card price counts');
    assert.ok(plain.rate.input > 0);
    writeFileSync(overridesPath(), JSON.stringify({ version: 1, models: { [cardModel]: { kind: 'free', force: true, declaredAt: now } } }));
    assert.equal(rateFor('anthropic', cardModel).pricing.rateMatchKind, 'user_declared_free', 'a forced free price applies');
    // A local model stays free until a card starts pricing it.
    writeFileSync(overridesPath(), JSON.stringify({ version: 1, models: { 'acme-later-cloud': { kind: 'free', declaredAt: now } } }));
    assert.equal(rateFor('openai', 'acme-later-cloud').pricing.rateMatchKind, 'user_declared_free');
    const card = structuredClone(loadPricing());
    card.providers['openai']!.models['acme-later-cloud'] = { input: 5, output: 20 };
    mkdirSync(join(home, 'pricing', 'cards'), { recursive: true });
    writeFileSync(join(home, 'pricing', 'models.json'), JSON.stringify(card));
    const later = rateFor('openai', 'acme-later-cloud');
    assert.notEqual(later.pricing.rateMatchKind, 'user_declared_free', 'a refreshed card on disk ends the free price');
  } finally {
    rmSync(overridesPath(), { force: true });
    rmSync(join(home, 'pricing'), { recursive: true, force: true });
  }
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
