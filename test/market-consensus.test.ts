/**
 * The consensus quality score: a difficulty-adjusted, reliability-weighted fit
 * over many public benchmarks. These tests pin the properties that make it
 * better than a plain mean, and the ones that keep it honest.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deflateRawSync } from 'node:zlib';
import { buildConsensus, canonicalModel, ratingToScore, type ConsensusObservation } from '../src/market/consensus.ts';
import { parseCsv, readZipEntries } from '../src/market/zip.ts';
import { parseEpoch } from '../src/market/sources.ts';
import { buildMarketReport, type LoadedMarket } from '../src/market/market.ts';
import { FEATURE_DEFAULTS } from '../src/config.ts';

const sig = (x: number) => 1 / (1 + Math.exp(-x));
const DIFFICULTY: Record<string, number> = { 'SWE-Bench verified': 0.5, 'Terminal Bench': -1.2, DeepSWE: 1.6, 'GSO-Bench': 0 };

/** Scores generated from known abilities, so the fit can be checked against the truth. */
function synthetic(abilities: Record<string, number>, benches: Record<string, string[]>): ConsensusObservation[] {
  const out: ConsensusObservation[] = [];
  for (const [model, list] of Object.entries(benches)) {
    for (const b of list) out.push({ model, label: model, benchmark: b, score: sig(1.5 * (abilities[model]! - DIFFICULTY[b]!)), date: '2026-09-01' });
  }
  return out;
}

test('one key for the same model across sources', () => {
  for (const name of ['Claude Opus 4.6', 'claude-opus-4-6-high', 'claude-opus-4.6 (thinking)', 'anthropic/claude-opus-4-6-20260205', 'claude_opus_4_6_max']) {
    assert.equal(canonicalModel(name), 'claude-opus-4-6', name);
  }
  assert.notEqual(canonicalModel('gpt-5.5'), canonicalModel('gpt-5.5-pro'));
});

test('an arena rating becomes a bounded win probability, 0.5 at the reference', () => {
  assert.equal(ratingToScore(1400, 1400), 0.5);
  assert.ok(ratingToScore(1600, 1400) > 0.75 && ratingToScore(1600, 1400) < 1);
  assert.ok(ratingToScore(1200, 1400) < 0.25);
});

test('difficulty is adjusted: a stronger model tested only on hard benchmarks outranks a weaker one tested on easy ones', () => {
  const abilities = { strong: 1.4, weak: 0.2, a: 0.9, b: 0.5, c: -0.3, d: 1.1, e: 0.0 };
  const all = ['SWE-Bench verified', 'Terminal Bench', 'DeepSWE', 'GSO-Bench'];
  const obs = synthetic(abilities, {
    strong: ['DeepSWE', 'SWE-Bench verified'],
    weak: ['Terminal Bench', 'GSO-Bench'],
    a: all, b: all, c: all, d: all, e: all,
  });
  const mean = (m: string) => { const s = obs.filter((o) => o.model === m); return s.reduce((t, o) => t + o.score, 0) / s.length; };
  assert.ok(mean('weak') > mean('strong'), 'the naive mean gets this backwards');
  const res = buildConsensus('coding', obs, '2026-09-28');
  const score = (m: string) => res.rows.find((r) => r.model === m)!.score;
  assert.ok(score('strong') > score('weak'), `consensus should rank strong above weak (${score('strong')} vs ${score('weak')})`);
  const order = res.rows.map((r) => r.model);
  assert.deepEqual(order.filter((m) => ['d', 'a', 'b', 'e', 'c'].includes(m)), ['d', 'a', 'b', 'e', 'c']);
});

test('one benchmark is not a consensus: single-source models get no score and are counted', () => {
  const obs = synthetic({ a: 1, b: 0, lone: 2 }, { a: ['DeepSWE', 'GSO-Bench'], b: ['DeepSWE', 'GSO-Bench'], lone: ['DeepSWE'] });
  const res = buildConsensus('coding', obs, '2026-09-28');
  assert.equal(res.rows.some((r) => r.model === 'lone'), false);
  assert.equal(res.singleSource, 1);
});

test('the range is leave-one-benchmark-out and always contains the score', () => {
  const all = ['SWE-Bench verified', 'Terminal Bench', 'DeepSWE', 'GSO-Bench'];
  const res = buildConsensus('coding', synthetic({ a: 1, b: 0.3, c: -0.5 }, { a: all, b: all, c: all }), '2026-09-28');
  for (const r of res.rows) assert.ok(r.low <= r.score && r.score <= r.high && r.basis === 'public_benchmark_consensus');
});

test('weights follow the published rubric, and a benchmark with no result in 180 days counts half', () => {
  const obs = synthetic({ a: 1, b: 0 }, { a: ['SWE-Bench verified', 'DeepSWE'], b: ['SWE-Bench verified', 'DeepSWE'] });
  for (const o of obs) if (o.benchmark === 'SWE-Bench verified') o.date = '2025-01-01';
  const w = new Map(buildConsensus('coding', obs, '2026-09-28').weights.map((x) => [x.benchmark, x]));
  assert.equal(w.get('SWE-Bench verified')!.currency, 0.5);
  assert.equal(w.get('SWE-Bench verified')!.weight, 1.0 * 0.6 * 0.5);
  assert.equal(w.get('DeepSWE')!.weight, 0.8 * 0.9);
});

/** A minimal zip writer (stored and deflated entries), enough to exercise the reader. */
function zip(entries: Record<string, string>, deflate: boolean): Buffer {
  const locals: Buffer[] = []; const centrals: Buffer[] = []; let offset = 0;
  for (const [name, text] of Object.entries(entries)) {
    const raw = Buffer.from(text); const body = deflate ? deflateRawSync(raw) : raw; const n = Buffer.from(name);
    const lh = Buffer.alloc(30); lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(deflate ? 8 : 0, 8); lh.writeUInt32LE(body.length, 18); lh.writeUInt32LE(raw.length, 22); lh.writeUInt16LE(n.length, 26);
    const ch = Buffer.alloc(46); ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(deflate ? 8 : 0, 10); ch.writeUInt32LE(body.length, 20); ch.writeUInt32LE(raw.length, 24); ch.writeUInt16LE(n.length, 28); ch.writeUInt32LE(offset, 42);
    locals.push(lh, n, body); centrals.push(ch, n); offset += 30 + n.length + body.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(Object.keys(entries).length, 10); end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}

test('the zip reader handles stored and deflated entries and refuses a non-zip', () => {
  for (const deflate of [false, true]) {
    const files = readZipEntries(zip({ 'a.csv': 'x,y\n1,"2,3"\n', 'skip.txt': 'no' }, deflate), new Set(['a.csv']));
    assert.deepEqual([...files.keys()], ['a.csv']);
    assert.deepEqual(parseCsv(files.get('a.csv')!.toString()), [{ x: '1', y: '2,3' }]);
  }
  assert.throws(() => readZipEntries(Buffer.from('not a zip at all, definitely not'), new Set()), /not a zip/);
});

test('Epoch results are chance-corrected with the published baseline and ceiling', () => {
  const meta = 'benchmark,random_baseline,score_ceiling\nGPQA diamond,0.25,1.0\nSWE-Bench verified,0,1.0\n';
  const rows = ['model_id,benchmark_id,performance,benchmark,benchmark_release_date,model,model_version,Model,date,source'];
  for (let i = 0; i < 60; i++) rows.push(`m${i},b1,0.625,GPQA diamond,2023-11-20,x,x,Model ${i},2026-09-01,`);
  rows.push('mx,b2,0.4,SWE-Bench verified,2024-08-13,y,y,Model X,2026-06-01,Some Leaderboard');
  const data = parseEpoch(zip({ 'benchmark_metadata.csv': meta, 'epoch_capabilities_index/processed_data_for_eci.csv': rows.join('\n') }, true), new Set(['GPQA diamond', 'SWE-Bench verified']));
  const gpqa = data.results.find((r) => r.benchmark === 'GPQA diamond')!;
  assert.equal(gpqa.score, 0.5);
  assert.equal(gpqa.epochRun, true);
  assert.equal(data.results.find((r) => r.benchmark === 'SWE-Bench verified')!.epochRun, false);
});

test('the market consensus board: Pareto frontier with honest "beaten by", and off when its sources are off', () => {
  const all = ['SWE-Bench verified', 'Terminal Bench', 'DeepSWE', 'GSO-Bench'];
  const abilities = { 'model-cheap': 1.0, 'model-dear': 0.9, 'model-top': 2.0 };
  const results = synthetic(abilities, { 'model-cheap': all, 'model-dear': all, 'model-top': all }).map((o) => ({ model: o.model, benchmark: o.benchmark, score: o.score, date: o.date, epochRun: true }));
  const sha = 'b'.repeat(64);
  const loaded: LoadedMarket = {
    origin: {}, cacheErrors: [],
    snapshot: { schemaVersion: 2, sources: {
      epoch: { id: 'epoch', fetchedAt: '2026-09-28T00:00:00.000Z', publishedAt: null, sha256: sha, data: { results } },
      litellm: { id: 'litellm', fetchedAt: '2026-09-28T00:00:00.000Z', publishedAt: null, sha256: sha, data: { tokenPrices: {
        'model-cheap': { inputUsdPerMillion: 1, outputUsdPerMillion: 1 }, 'model-dear': { inputUsdPerMillion: 9, outputUsdPerMillion: 9 }, 'model-top': { inputUsdPerMillion: 20, outputUsdPerMillion: 20 },
      }, imagePrices: {} } },
    } },
  };
  const coding = buildMarketReport(loaded, { ...FEATURE_DEFAULTS }).categories.find((c) => c.id === 'coding')!.consensus!;
  assert.equal(coding.status, 'available');
  const dear = coding.rows.find((r) => r.model === 'model-dear')!;
  assert.equal(dear.frontier, false);
  assert.equal(dear.beatenBy?.model, 'model-cheap');
  assert.deepEqual([...coding.frontier].sort(), ['model-cheap', 'model-top']);
  const off = buildMarketReport(loaded, { ...FEATURE_DEFAULTS, marketEpoch: false, marketArena: false }).categories[0]!.consensus!;
  assert.equal(off.status, 'disabled');
  assert.deepEqual(off.rows, []);
});
