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
    // Pricing a request: an unforced free price stored in the race is set
    // aside, the stale loaded card is reloaded from the verified one, and the
    // request is charged at its rate under its own source (PR #153 review).
    const { rateFor } = await import('../src/cost/pricing.ts');
    const { overridesPath } = await import('../src/cost/overrides.ts');
    mkdirSync(dirname(overridesPath()), { recursive: true });
    writeFileSync(overridesPath(), JSON.stringify({ version: 1, models: { 'acme-cloud-added': { kind: 'free', declaredAt: now } } }));
    try {
      const charged = rateFor('openai', 'acme-cloud-added');
      assert.equal(charged.pricing.rateMatchKind, 'exact_provider');
      assert.equal(charged.rate.input, 2);
      assert.equal(charged.pricing.rateCardSourceKind, 'manual');
    } finally { rmSync(overridesPath(), { force: true }); }
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
    // The active card written before its provenance (none at all here) is the current card.
    void sha;
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
    // ...and the request is charged at that card's rate, not the generic fallback (PR #153 review).
    assert.equal(later.pricing.rateMatchKind, 'exact_provider');
    assert.equal(later.rate.input, 5);
    assert.equal(later.rate.output, 20);
    assert.equal(later.pricing.rateCardSourceKind, 'legacy_unknown', 'an unverified card is labelled as unknown, never guessed');
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

test('an archived card is history: it neither refuses nor overrides a free price the current card allows (PR #153 review)', async () => {
  const { mkdirSync, writeFileSync } = await import('node:fs');
  const { createHash } = await import('node:crypto');
  const { cardEntryAnywhere, rateFor } = await import('../src/cost/pricing.ts');
  const { overridesPath } = await import('../src/cost/overrides.ts');
  // An old card priced a model a later card removed.
  const old = structuredClone(loadPricing());
  old.providers['openai']!.models['acme-retired'] = { input: 7, output: 28 };
  const text = JSON.stringify(old);
  const sha = createHash('sha256').update(text, 'utf8').digest('hex');
  mkdirSync(join(home, 'pricing', 'cards'), { recursive: true });
  writeFileSync(join(home, 'pricing', 'cards', `${sha}.json`), text);
  mkdirSync(dirname(overridesPath()), { recursive: true });
  try {
    assert.equal(cardEntryAnywhere('acme-retired'), null);
    assert.equal(declarePrice('acme-retired', { kind: 'free' }).kind, 'free');
    assert.equal(rateFor('openai', 'acme-retired').pricing.rateMatchKind, 'user_declared_free');
  } finally {
    rmSync(overridesPath(), { force: true });
    rmSync(join(home, 'pricing'), { recursive: true, force: true });
  }
});

test('a new card on disk beats a stale loaded rate (PR #153 review)', async () => {
  const { mkdirSync, writeFileSync } = await import('node:fs');
  const { rateFor } = await import('../src/cost/pricing.ts');
  const { overridesPath } = await import('../src/cost/overrides.ts');
  const loadedRate = loadPricing().providers['anthropic']!.models[cardModel]!;
  const card = structuredClone(loadPricing());
  card.providers['anthropic']!.models[cardModel] = { ...loadedRate, input: loadedRate.input * 7, output: loadedRate.output * 7 };
  mkdirSync(join(home, 'pricing'), { recursive: true });
  // A new card on disk with no provenance record is what the loader loads.
  writeFileSync(join(home, 'pricing', 'models.json'), JSON.stringify(card));
  mkdirSync(dirname(overridesPath()), { recursive: true });
  writeFileSync(overridesPath(), JSON.stringify({ version: 1, models: { [cardModel]: { kind: 'free', declaredAt: new Date().toISOString() } } }));
  try {
    const charged = rateFor('anthropic', cardModel);
    assert.equal(charged.rate.input, loadedRate.input * 7);
    assert.equal(charged.pricing.rateCardSourceKind, 'legacy_unknown');
  } finally {
    rmSync(overridesPath(), { force: true });
    rmSync(join(home, 'pricing'), { recursive: true, force: true });
  }
});

test('a refresh that changes the rate of a model the loaded card already has is charged at the new rate (PR #153 review)', async () => {
  const { mkdirSync, writeFileSync } = await import('node:fs');
  const { createHash } = await import('node:crypto');
  const { rateFor } = await import('../src/cost/pricing.ts');
  const { overridesPath } = await import('../src/cost/overrides.ts');
  const loadedRate = loadPricing().providers['anthropic']!.models[cardModel]!;
  const card = structuredClone(loadPricing());
  card.providers['anthropic']!.models[cardModel] = { ...loadedRate, input: loadedRate.input * 10, output: loadedRate.output * 10 };
  const text = JSON.stringify(card);
  const now = new Date().toISOString();
  mkdirSync(join(home, 'pricing'), { recursive: true });
  writeFileSync(join(home, 'pricing', 'models.json'), text);
  writeFileSync(join(home, 'pricing', 'provenance.json'), JSON.stringify({
    schemaVersion: 1, sourceUrl: null, sourceUrlSha256: null, sourceKind: 'manual', fetchedAt: now, lastCheckedAt: now,
    upstreamDeclaredUpdated: null, cardSha256: createHash('sha256').update(text, 'utf8').digest('hex'),
    modelCount: Object.values(card.providers).reduce((n, p) => n + Object.keys(p.models).length, 0), etag: null, lastModified: null,
  }));
  mkdirSync(dirname(overridesPath()), { recursive: true });
  writeFileSync(overridesPath(), JSON.stringify({ version: 1, models: { [cardModel]: { kind: 'free', declaredAt: now } } }));
  try {
    const charged = rateFor('anthropic', cardModel);
    assert.equal(charged.pricing.rateMatchKind, 'exact_provider');
    assert.equal(charged.rate.input, loadedRate.input * 10, 'the refreshed rate, not the stale loaded one');
    assert.equal(charged.pricing.rateCardSourceKind, 'manual');
  } finally {
    rmSync(overridesPath(), { force: true });
    rmSync(join(home, 'pricing'), { recursive: true, force: true });
  }
});

test('a failed activation is not current: the previous verified card still decides (PR #153 review)', async () => {
  const { mkdirSync, writeFileSync } = await import('node:fs');
  const { createHash } = await import('node:crypto');
  const { cardEntryAnywhere, rateFor } = await import('../src/cost/pricing.ts');
  const { overridesPath } = await import('../src/cost/overrides.ts');
  const sha = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');
  const count = (c: ReturnType<typeof loadPricing>) => Object.values(c.providers).reduce((n, p) => n + Object.keys(p.models).length, 0);
  const now = new Date().toISOString();
  // The previous card, committed: archive, archive provenance, active provenance.
  const previous = structuredClone(loadPricing());
  previous.providers['openai']!.models['acme-failed-refresh'] = { input: 6, output: 24 };
  const prevText = JSON.stringify(previous);
  const prevSha = sha(prevText);
  mkdirSync(join(home, 'pricing', 'cards'), { recursive: true });
  writeFileSync(join(home, 'pricing', 'cards', `${prevSha}.json`), prevText);
  const prov = { schemaVersion: 1, sourceUrl: null, sourceUrlSha256: null, sourceKind: 'manual', fetchedAt: now,
    upstreamDeclaredUpdated: null, cardSha256: prevSha, modelCount: count(previous), etag: null, lastModified: null };
  writeFileSync(join(home, 'pricing', 'cards', `${prevSha}.provenance.json`), JSON.stringify(prov));
  writeFileSync(join(home, 'pricing', 'provenance.json'), JSON.stringify({ ...prov, lastCheckedAt: now }));
  // A failed refresh: the new active card (dropping the model) was written, its provenance never was.
  const failed = structuredClone(previous);
  delete failed.providers['openai']!.models['acme-failed-refresh'];
  writeFileSync(join(home, 'pricing', 'models.json'), JSON.stringify(failed));
  mkdirSync(dirname(overridesPath()), { recursive: true });
  writeFileSync(overridesPath(), JSON.stringify({ version: 1, models: { 'acme-failed-refresh': { kind: 'free', declaredAt: now } } }));
  try {
    assert.equal(cardEntryAnywhere('acme-failed-refresh')?.input, 6, 'the recovered previous card is current');
    const charged = rateFor('openai', 'acme-failed-refresh');
    assert.equal(charged.pricing.rateMatchKind, 'exact_provider', 'not $0 from the failed card');
    assert.equal(charged.rate.input, 6);
  } finally {
    rmSync(overridesPath(), { force: true });
    rmSync(join(home, 'pricing'), { recursive: true, force: true });
  }
});
