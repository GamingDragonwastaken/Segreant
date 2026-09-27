import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_CONFIG, FEATURE_DEFAULTS, configPath, loadConfig, saveConfig, type FeaturesConfig } from '../src/config.ts';
import { cmdFeatures } from '../src/cli/featuresCmd.ts';
import {
  buildMarketReport, loadMarket, marketCachePath, type BenchmarkRow, type LoadedMarket, type MarketBoard, type RatingRow,
} from '../src/market/market.ts';
import { refreshMarketSource, refreshMarketSourceFrom } from '../src/market/refresh.ts';
import { matchPrice, parseAider, parseArenaPage, parseLiteLLM, grantCommand } from '../src/market/sources.ts';

function isolated<T>(fn: (home: string) => T): T {
  const previous = process.env.SEGREANT_HOME;
  const home = mkdtempSync(join(tmpdir(), 'segreant-market-'));
  process.env.SEGREANT_HOME = home;
  const restore = () => {
    if (previous === undefined) delete process.env.SEGREANT_HOME;
    else process.env.SEGREANT_HOME = previous;
    rmSync(home, { recursive: true, force: true });
  };
  let async = false;
  try {
    const out = fn(home);
    if (out instanceof Promise) { async = true; return out.finally(restore) as T; }
    return out;
  } finally { if (!async) restore(); }
}

const on: FeaturesConfig = { ...FEATURE_DEFAULTS };
const sha = 'a'.repeat(64);
const board = (loaded: LoadedMarket, features: FeaturesConfig, id: string, personal = []): MarketBoard =>
  buildMarketReport(loaded, features, personal).categories.flatMap((c) => c.boards).find((b) => b.sourceId === id)!;

const fixture: LoadedMarket = {
  origin: { litellm: 'bundled', aider: 'bundled', 'arena-text': 'bundled' },
  cacheErrors: [],
  snapshot: {
    schemaVersion: 2,
    sources: {
      litellm: { id: 'litellm', fetchedAt: '2026-09-27T00:00:00.000Z', publishedAt: null, sha256: sha, data: {
        tokenPrices: { cheap: { inputUsdPerMillion: 1, outputUsdPerMillion: 1 }, dear: { inputUsdPerMillion: 10, outputUsdPerMillion: 10 }, mid: { inputUsdPerMillion: 2, outputUsdPerMillion: 2 } },
        imagePrices: {},
      } },
      aider: { id: 'aider', fetchedAt: '2026-09-27T00:00:00.000Z', publishedAt: null, sha256: sha, data: { entries: [
        { model: 'cheap', passRatePercent: 60, cases: 200, runCostUsd: 6, date: '2025-10-01', editFormat: 'diff' },
        { model: 'dear', passRatePercent: 50, cases: 200, runCostUsd: 60, date: '2025-10-01', editFormat: 'diff' },
        { model: 'untracked', passRatePercent: 90, cases: 200, runCostUsd: null, date: '2025-10-01', editFormat: 'diff' },
      ] } },
      'arena-text': { id: 'arena-text', fetchedAt: '2026-09-27T00:00:00.000Z', publishedAt: '2026-09-25', sha256: sha, data: { publishedAt: '2026-09-25', entries: [
        { model: 'dear-high', rating: 1500, ratingLower: 1490, ratingUpper: 1510, votes: 9000 },
        { model: 'cheap', rating: 1480, ratingLower: 1470, ratingUpper: 1490, votes: 9000 },
        { model: 'mid', rating: 1485, ratingLower: 1450, ratingUpper: 1520, votes: 90 },
        { model: 'unpriced-model', rating: 1600, ratingLower: 1590, ratingUpper: 1610, votes: 9000 },
      ] } },
    },
  },
};

test('features rejects unknown keys and malformed values at load and save', () => isolated(() => {
  for (const features of [{ market: 'off' }, { marketIFBench: true }, [], null]) {
    writeFileSync(configPath(), JSON.stringify({ features }));
    assert.throws(() => loadConfig(), /CONFIG_INVALID.*features/);
  }
  assert.throws(() => saveConfig({ ...DEFAULT_CONFIG, features: { ...DEFAULT_CONFIG.features, market: 'off' } } as never), /CONFIG_INVALID.*features/);
}));

test('features never includes budget enforcement, and defaults survive a roundtrip without touching caps', () => isolated(() => {
  assert.ok(!Object.keys(FEATURE_DEFAULTS).some((k) => /budget|cap|enforce/i.test(k)));
  const defaults = loadConfig();
  saveConfig({ ...defaults, features: { ...defaults.features, market: false } });
  const loaded = loadConfig();
  assert.equal(loaded.features.market, false);
  assert.equal(loaded.features.marketAider, true);
  assert.deepEqual(loaded.budget, defaults.budget);
  assert.equal(JSON.parse(readFileSync(configPath(), 'utf8')).features.market, false);
}));

test('features off previews, then applies only with --apply', () => isolated(() => {
  const output: string[] = [];
  const original = console.log;
  console.log = (...parts: unknown[]) => { output.push(parts.join(' ')); };
  try {
    cmdFeatures({ _: ['off', 'market'] });
    assert.equal(loadConfig().features.market, true);
    assert.match(output.join(' '), /configuration unchanged/);
    cmdFeatures({ _: ['off', 'market'], apply: true });
    assert.equal(loadConfig().features.market, false);
    assert.match(output.join(' '), /Feature saved/);
  } finally { console.log = original; }
}));

test('a disabled market or source says disabled and computes nothing', () => {
  const off = buildMarketReport(fixture, { ...on, market: false });
  assert.equal(off.status, 'disabled');
  assert.deepEqual(off.categories, []);
  const aider = board(fixture, { ...on, marketAider: false }, 'aider');
  assert.equal(aider.status, 'disabled');
  assert.deepEqual(aider.rows, []);
  const noPrices = board(fixture, { ...on, marketLiteLLM: false }, 'arena-text');
  assert.equal(noPrices.priceSource?.status, 'disabled');
  assert.ok((noPrices.rows as RatingRow[]).every((r) => r.price === null && r.frontier === null));
});

test('cost per solved task comes only from the published run cost; an untracked run cost stays unknown, not zero', () => {
  const b = board(fixture, on, 'aider');
  const cheap = b.rows.find((r) => r.model === 'cheap') as BenchmarkRow;
  assert.equal(cheap.costPerSolvedTaskUsd, 6 / 120);
  const untracked = b.rows.find((r) => r.model === 'untracked') as BenchmarkRow;
  assert.equal(untracked.runCostUsd, null);
  assert.equal(untracked.costPerSolvedTaskUsd, null);
  assert.equal(untracked.frontier, null);
  assert.deepEqual(b.frontier, ['cheap']);
});

test('personal realized value sits beside public figures and never changes them', () => {
  const personal = [{ model: 'dear', units: 12, realizationRate: 0.9, costPerRealizedUnitUsd: 0.01, basis: 'operator_realized_value' as const }];
  const without = board(fixture, on, 'aider');
  const withMine = buildMarketReport(fixture, on, personal).categories[0]!.boards[0]!;
  const dear = withMine.rows.find((r) => r.model === 'dear') as BenchmarkRow;
  assert.deepEqual(dear.personal, personal[0]);
  assert.equal(dear.basis, 'public_benchmark_run_cost');
  assert.deepEqual(withMine.frontier, without.frontier);
  assert.deepEqual(withMine.rows.map((r) => (r as BenchmarkRow).costPerSolvedTaskUsd), without.rows.map((r) => (r as BenchmarkRow).costPerSolvedTaskUsd));
});

test('ratings get no per-dollar quotient, and dominance needs a cheaper model clearly above the whole interval', () => {
  const b = board(fixture, on, 'arena-text');
  const rows = b.rows as RatingRow[];
  assert.ok(rows.every((r) => r.perDollar === null && r.basis === 'public_preference_rating'));
  const unpriced = rows.find((r) => r.model === 'unpriced-model')!;
  assert.equal(unpriced.price, null);
  assert.equal(unpriced.frontier, null);
  const dear = rows.find((r) => r.model === 'dear-high')!;
  assert.equal(dear.price?.match, 'normalized');
  assert.equal(dear.price?.pricedAs, 'dear');
  // mid's wide interval overlaps cheap's, so cheap does not knock it off the frontier.
  assert.deepEqual([...b.frontier].sort(), ['cheap', 'dear-high', 'mid']);
  assert.match(b.notes.join(' '), /1 of 4 model\(s\) have no public list price/);
});

test('the bundled snapshot works offline, is dated, and covers coding, chat and image', () => isolated(() => {
  const loaded = loadMarket();
  const report = buildMarketReport(loaded, on);
  for (const cat of ['coding', 'general-chat', 'image']) {
    const boards = report.categories.find((c) => c.id === cat)!.boards;
    assert.ok(boards.length && boards.every((b) => b.status === 'available' && b.rows.length > 0 && b.origin === 'bundled' && /^\d{4}-\d{2}-\d{2}T/.test(b.fetchedAt ?? '')), cat);
  }
  const aider = report.categories[0]!.boards.find((b) => b.sourceId === 'aider')!;
  assert.ok(aider.frontier.length > 0);
  assert.ok((aider.rows as BenchmarkRow[]).some((r) => r.runCostUsd === null && r.costPerSolvedTaskUsd === null));
}));

test('a corrupt refresh file is reported and the bundled copy is used instead', () => isolated(() => {
  mkdirSync(join(process.env.SEGREANT_HOME!, 'market'), { recursive: true });
  writeFileSync(marketCachePath('aider'), '{"id":"aider","broken":true}');
  const loaded = loadMarket();
  assert.equal(loaded.origin.aider, 'bundled');
  assert.match(loaded.cacheErrors.join(' '), /aider/);
}));

test('a refresh refused by the default egress policy returns the exact grant command', () => isolated(async () => {
  const result = await refreshMarketSource('litellm');
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.code, 'policy_denied');
  assert.equal(result.grantCommand, grantCommand('litellm'));
  assert.match(result.grantCommand ?? '', /^segreant egress apply --apply --mode controlled_cloud --id market-litellm --purpose market_refresh --data-class market_manifest --method GET --origin https:\/\/raw\.githubusercontent\.com --path-prefix \/BerriAI\/litellm\/main\/model_prices_and_context_window\.json$/);
}));

const arenaPage = (rows: Array<Record<string, unknown>>) => JSON.stringify({ rows: rows.map((row) => ({ row })) });
const arenaRow = (model: string, rating: number, category = 'overall') => ({ model_name: model, rating, rating_lower: rating - 5, rating_upper: rating + 5, vote_count: 1000, rank: 1, category, leaderboard_publish_date: '2026-09-25' });

test('a refresh writes one dated source file that then overlays the bundled copy', () => isolated(async () => {
  const rows = Array.from({ length: 8 }, (_, i) => arenaRow(`model-${i}`, 1400 + i));
  const result = await refreshMarketSourceFrom('arena-text', () => new Response(arenaPage([...rows, arenaRow('x', 1, 'coding')])));
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.publishedAt, '2026-09-25');
  assert.equal(result.requests, 1);
  const loaded = loadMarket();
  assert.equal(loaded.origin['arena-text'], 'refreshed');
  assert.equal(board(loaded, on, 'arena-text').rows.length, 8);
}));

test('parsers read the real shapes and refuse to guess', () => {
  const yaml = [
    '- dirname: a', '  model: gpt-x', '  test_cases: 225', '  pass_rate_2: 80.0', '  total_cost: 12.5', '  date: 2025-08-25', '  edit_format: diff',
    '- dirname: b', '  model: free-run', '  test_cases: 225', '  pass_rate_2: 40.0', '  total_cost: 0.0000', '  date: 2025-04-01',
    '- dirname: c', '  model: misrecorded', '  test_cases: 225', '  pass_rate_2: 70.0', '  total_cost: 0 # incorrect: 6.3', '  date: 2025-04-12',
  ].join('\n');
  assert.throws(() => parseAider(yaml), /too few/);
  const many = Array.from({ length: 4 }, () => yaml).join('\n');
  const aider = parseAider(many);
  assert.equal(aider.entries[0]!.runCostUsd, 12.5);
  assert.equal(aider.entries[1]!.runCostUsd, null);
  assert.equal(aider.entries[2]!.runCostUsd, null);

  const page = parseArenaPage(arenaPage([arenaRow('a', 1500), arenaRow('b', 1490), arenaRow('c', 1400, 'coding'), arenaRow('d', 1300)]));
  assert.deepEqual(page.entries.map((e) => e.model), ['a', 'b']);
  assert.equal(page.done, true);

  const prices: Record<string, unknown> = { sample_spec: {}, 'reseller/gpt-x': { mode: 'chat', input_cost_per_token: 9e-6, output_cost_per_token: 9e-6 }, 'gpt-x': { mode: 'chat', input_cost_per_token: 1e-6, output_cost_per_token: 4e-6 } };
  for (let i = 0; i < 60; i++) prices[`m${i}`] = { mode: 'chat', input_cost_per_token: 1e-6, output_cost_per_token: 1e-6 };
  assert.deepEqual(parseLiteLLM(JSON.stringify(prices)).tokenPrices['gpt-x'], { inputUsdPerMillion: 1, outputUsdPerMillion: 4 });
});

test('price joins are exact, or normalized with the entry named, or absent', () => {
  const table = { 'gpt-5': 1, 'claude-opus-4-6': 2 };
  assert.deepEqual(matchPrice('openai/GPT-5', table), { key: 'gpt-5', value: 1, method: 'exact' });
  assert.deepEqual(matchPrice('claude-opus-4-6-high', table), { key: 'claude-opus-4-6', value: 2, method: 'normalized' });
  assert.deepEqual(matchPrice('gpt-5 (codex-harness)', table), { key: 'gpt-5', value: 1, method: 'normalized' });
  assert.equal(matchPrice('muse-spark-1.3-max', table), null);
});

test('the settings route accepts only known feature switches, as booleans, and never a budget key', async () => {
  const { applySettingsPatch, SettingsValidationError } = await import('../src/dashboard/settings.ts');
  const next = applySettingsPatch(DEFAULT_CONFIG, { features: { marketArena: false } });
  assert.equal(next.features.marketArena, false);
  assert.equal(DEFAULT_CONFIG.features.marketArena, true, 'the input config is not mutated');
  for (const features of [{ dailyUsd: false }, { market: 'off' }, [], { budget: true }]) {
    assert.throws(() => applySettingsPatch(DEFAULT_CONFIG, { features } as never), SettingsValidationError);
  }
});

test('switching off self-reported outcomes stops recording and marks the report disabled', async () => {
  const { Store } = await import('../src/store/db.ts');
  const { createDashboardServer } = await import('../src/dashboard/server.ts');
  const { valueReport } = await import('../src/value/report.ts');
  const store = new Store(':memory:');
  const config = structuredClone({ ...DEFAULT_CONFIG, features: { ...DEFAULT_CONFIG.features, selfReportedOutcomes: false } });
  const server = createDashboardServer({ store, config, version: 'test' });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as import('node:net').AddressInfo).port;
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/outcome/record`, {
      method: 'POST', headers: { 'x-segreant-local': '1' },
      body: JSON.stringify({ outcomeId: 'a', kind: 'chat', link: { type: 'session', sessionId: 's', basis: 'recorded' }, decision: 'accepted_as_is', apply: true }),
    });
    assert.equal(res.status, 409);
    assert.equal(store.selfReportedOutcomeSignals(0, Number.MAX_SAFE_INTEGER).length, 0);
    const report = await valueReport(store, config, { repo: '' });
    assert.equal(report.selfReported.status, 'disabled');
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    store.close();
  }
});
