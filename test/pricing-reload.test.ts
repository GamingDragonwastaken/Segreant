import { mock, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// A long-running Segreant picks up a price-card refresh another process made,
// without a restart, and never midway through a reprice plan.
const home = mkdtempSync(join(tmpdir(), 'segreant-pricing-reload-'));
process.env.SEGREANT_HOME = home; delete process.env.SEGREANT_DB; delete process.env.SEGREANT_DEMO;
const { loadPricing, rateFor, withPricingSnapshot, withDeclarations, resetPricingFreshnessForTests, applyPricingManifest } = await import('../src/cost/pricing.ts');

test.after(() => rmSync(home, { recursive: true, force: true }));

type Card = ReturnType<typeof loadPricing>;
const MODEL = 'acme-reload-model';
const bundled: Card = structuredClone(loadPricing(true));
const count = (c: Card) => Object.values(c.providers).reduce((n, p) => n + Object.keys(p.models).length, 0);

function cardAt(input: number): Card {
  const card = structuredClone(bundled);
  card.providers['openai']!.models[MODEL] = { input, output: input * 4 };
  return card;
}

/** The files a refresh writes, in its order: archive, archive provenance, active card, active provenance. */
function refreshOnDisk(card: Card, opts: { stopBeforeProvenance?: boolean } = {}): void {
  const text = JSON.stringify(card);
  const sha = createHash('sha256').update(text, 'utf8').digest('hex');
  const now = new Date().toISOString();
  const prov = { schemaVersion: 1, sourceUrl: null, sourceUrlSha256: null, sourceKind: 'manual', fetchedAt: now,
    upstreamDeclaredUpdated: null, cardSha256: sha, modelCount: count(card), etag: null, lastModified: null };
  mkdirSync(join(home, 'pricing', 'cards'), { recursive: true });
  writeFileSync(join(home, 'pricing', 'cards', `${sha}.json`), text);
  writeFileSync(join(home, 'pricing', 'cards', `${sha}.provenance.json`), JSON.stringify(prov));
  writeFileSync(join(home, 'pricing', 'models.json'), text);
  if (opts.stopBeforeProvenance) return;
  writeFileSync(join(home, 'pricing', 'provenance.json'), JSON.stringify({ ...prov, lastCheckedAt: now }));
}

/** This process starts with the model at `input`. */
function start(input: number): void {
  rmSync(join(home, 'pricing'), { recursive: true, force: true });
  refreshOnDisk(cardAt(input));
  loadPricing(true);
}

test('a refresh made by another process is priced without a restart', () => {
  rmSync(join(home, 'pricing'), { recursive: true, force: true });
  loadPricing(true);
  assert.equal(rateFor('openai', MODEL).pricing.rateMatchKind, 'fallback');
  refreshOnDisk(cardAt(2));
  resetPricingFreshnessForTests();
  const after = rateFor('openai', MODEL);
  assert.equal(after.pricing.rateMatchKind, 'exact_provider');
  assert.equal(after.rate.input, 2);
  assert.equal(after.pricing.rateCardSourceKind, 'manual');
});

test('a changed rate for a model already loaded is picked up', () => {
  start(2);
  refreshOnDisk(cardAt(20));
  resetPricingFreshnessForTests();
  assert.equal(rateFor('openai', MODEL).rate.input, 20);
});

test('a refresh stopped before its provenance (in progress, or failed) is not picked up', () => {
  start(2);
  refreshOnDisk(cardAt(99), { stopBeforeProvenance: true });
  resetPricingFreshnessForTests();
  assert.equal(rateFor('openai', MODEL).rate.input, 2, 'the committed card still prices');
});

test('a reprice plan never switches cards midway', () => {
  start(2);
  const rates = withPricingSnapshot(() => {
    const a = rateFor('openai', MODEL).rate.input;
    refreshOnDisk(cardAt(555));
    resetPricingFreshnessForTests();
    const b = rateFor('openai', MODEL).rate.input;
    return [a, b];
  });
  assert.deepEqual(rates, [2, 2]);
  resetPricingFreshnessForTests();
  assert.equal(rateFor('openai', MODEL).rate.input, 555, 'picked up once the plan is done');
});

test('between checks the loaded card is reused, so pricing does not read the disk per request', () => {
  start(2);
  refreshOnDisk(cardAt(7));
  // No reset: within the interval the loaded card stands.
  assert.equal(rateFor('openai', MODEL).rate.input, 2);
});

test('one rate lookup reads one card, even when a refresh lands during it', () => {
  // The old card does not list the model and a free price is declared for it,
  // so the free price applies. The refresh adds the model. A lookup that read
  // the new card for the free check and the old card for the rate would price
  // the request at neither: the generic fallback rate.
  rmSync(join(home, 'pricing'), { recursive: true, force: true });
  loadPricing(true);
  // Every clock read moves past the freshness interval, and the refresh is
  // written at the second one: after the lookup has read its card, before any
  // later read of the card inside the same lookup.
  let clock = performance.now();
  let reads = 0;
  const now = mock.method(performance, 'now', () => {
    if (++reads === 2) refreshOnDisk(cardAt(3));
    return (clock += 1500);
  });
  let kind: string;
  try {
    kind = withDeclarations({ [MODEL]: { kind: 'free', declaredAt: new Date(0).toISOString() } },
      () => rateFor('openai', MODEL).pricing.rateMatchKind);
  } finally {
    now.mock.restore();
  }
  assert.ok(reads >= 1, 'the lookup checked freshness');
  assert.equal(kind, 'user_declared_free', 'the card the lookup started with decided the price');
  resetPricingFreshnessForTests();
  if (reads < 2) refreshOnDisk(cardAt(3));
  assert.equal(rateFor('openai', MODEL).pricing.rateMatchKind, 'exact_provider', 'the next lookup prices with the refresh');
});

test('a first refresh that fails before its provenance leaves no card to load', () => {
  rmSync(join(home, 'pricing'), { recursive: true, force: true });
  loadPricing(true);
  // A directory where the provenance file goes makes its write fail after the
  // active card was written.
  mkdirSync(join(home, 'pricing', 'provenance.json'), { recursive: true });
  const result = applyPricingManifest(JSON.stringify(cardAt(4)));
  assert.equal(result.ok, false);
  assert.equal(existsSync(join(home, 'pricing', 'models.json')), false, 'the uncommitted card was removed');
  resetPricingFreshnessForTests();
  assert.equal(rateFor('openai', MODEL).pricing.rateMatchKind, 'fallback', 'pricing stays on the card it had');
  rmSync(join(home, 'pricing'), { recursive: true, force: true });
});

test('a wall clock set back does not stop the card being checked', () => {
  start(2);
  // The wall clock jumps an hour back after the check; the monotonic interval
  // still elapses, so the refresh is picked up.
  const wall = Date.now() - 3_600_000;
  const back = mock.method(Date, 'now', () => wall);
  let clock = performance.now();
  const mono = mock.method(performance, 'now', () => (clock += 1500));
  try {
    refreshOnDisk(cardAt(11));
    assert.equal(rateFor('openai', MODEL).rate.input, 11);
  } finally {
    back.mock.restore();
    mono.mock.restore();
  }
});
