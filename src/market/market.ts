/**
 * The public model market: quality per dollar from public evidence, computed
 * locally from a bundled dated snapshot plus any per-source refresh the
 * operator has explicitly fetched.
 *
 * Three claims live here and are never merged: a public benchmark result, a
 * public list price, and (optionally, beside them) the operator's own realized
 * value. Only the Aider board publishes what its runs actually cost, so only it
 * gets a cost-per-solved-task figure. Arena ratings are Elo-style, not a ratio
 * scale, so dividing them by dollars would be meaningless; those boards get a
 * price-vs-rating frontier instead, and a model counts as dominated only when a
 * no-dearer model's whole rating interval sits above its own.
 */
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { segreantHome, type FeaturesConfig } from '../config.ts';
import { buildConsensus, canonicalModel, ratingToScore, RELIABILITY, type ConsensusObservation, type ConsensusResult, type ConsensusRow } from './consensus.ts';
import {
  MARKET_SOURCES, MARKET_SOURCE_IDS, matchPrice,
  type AiderData, type ArenaData, type EpochData, type ListPrice, type LiteLLMData, type MarketSourceId, type MatchMethod, type SourceData,
} from './sources.ts';

export interface SourceSnapshot<D extends SourceData = SourceData> {
  id: MarketSourceId;
  /** ISO instant the payload was fetched. */
  fetchedAt: string;
  /** The date the source itself says it published, when it says one. */
  publishedAt: string | null;
  sha256: string;
  data: D;
}
export interface MarketSnapshot {
  schemaVersion: 2;
  sources: Partial<Record<MarketSourceId, SourceSnapshot>>;
}

const bundlePath = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'market', 'snapshot.json');
export const marketCacheDir = (): string => join(segreantHome(), 'market');
export const marketCachePath = (id: MarketSourceId): string => join(marketCacheDir(), `${id}.json`);

const ISO = /^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;

/** Structural check on one source section; a malformed section is rejected whole. */
export function validateSourceSnapshot(id: MarketSourceId, value: unknown): asserts value is SourceSnapshot {
  const v = value as Partial<SourceSnapshot> | null;
  if (!v || typeof v !== 'object' || v.id !== id || typeof v.fetchedAt !== 'string' || !ISO.test(v.fetchedAt)
    || !(v.publishedAt === null || (typeof v.publishedAt === 'string' && DAY.test(v.publishedAt)))
    || typeof v.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(v.sha256) || !v.data || typeof v.data !== 'object') {
    throw new Error(`invalid market source section: ${id}`);
  }
  const d = v.data as unknown as Record<string, unknown>;
  const ok = id === 'litellm' ? typeof d.tokenPrices === 'object' && typeof d.imagePrices === 'object'
    : id === 'epoch' ? Array.isArray(d.results)
    : Array.isArray(d.entries) && (id === 'aider' || (typeof d.publishedAt === 'string' && DAY.test(d.publishedAt)));
  if (!ok) throw new Error(`invalid market source data: ${id}`);
}

export function validateMarketSnapshot(value: unknown): asserts value is MarketSnapshot {
  const v = value as Partial<MarketSnapshot> | null;
  if (!v || typeof v !== 'object' || v.schemaVersion !== 2 || !v.sources || typeof v.sources !== 'object') throw new Error('invalid market snapshot envelope');
  for (const [id, section] of Object.entries(v.sources)) {
    if (!MARKET_SOURCE_IDS.includes(id as MarketSourceId)) throw new Error(`unknown market source: ${id}`);
    validateSourceSnapshot(id as MarketSourceId, section);
  }
}

export type SectionOrigin = 'bundled' | 'refreshed';
export interface LoadedMarket { snapshot: MarketSnapshot; origin: Partial<Record<MarketSourceId, SectionOrigin>>; cacheErrors: string[] }

/**
 * The bundled snapshot, with any valid per-source refresh laid over it. A
 * corrupt refresh file is reported and ignored, never half-used. Reading never
 * opens the ledger or a socket.
 */
export function loadMarket(): LoadedMarket {
  const bundled: unknown = JSON.parse(readFileSync(bundlePath, 'utf8'));
  validateMarketSnapshot(bundled);
  const snapshot: MarketSnapshot = { schemaVersion: 2, sources: { ...bundled.sources } };
  const origin: LoadedMarket['origin'] = {};
  for (const id of Object.keys(snapshot.sources) as MarketSourceId[]) origin[id] = 'bundled';
  const cacheErrors: string[] = [];
  for (const id of MARKET_SOURCE_IDS) {
    const path = marketCachePath(id);
    if (!existsSync(path)) continue;
    try {
      const section: unknown = JSON.parse(readFileSync(path, 'utf8'));
      validateSourceSnapshot(id, section);
      snapshot.sources[id] = section;
      origin[id] = 'refreshed';
    } catch (error) {
      cacheErrors.push(`${id}: ${error instanceof Error ? error.message : String(error)} — using the bundled copy`);
    }
  }
  return { snapshot, origin, cacheErrors };
}

// ---- report ------------------------------------------------------------------

export type MarketCategoryId = 'coding' | 'general-chat' | 'image';

/** The operator's own realized value for a model, from their ledger. Kept apart. */
export interface PersonalMarketValue {
  model: string;
  units: number;
  /** Share of your units of work that realized (git-verified). */
  realizationRate: number;
  /** Your metered spend on this model / your realized units; null when none realized. */
  costPerRealizedUnitUsd: number | null;
  basis: 'operator_realized_value';
}

export interface PriceBasis {
  basis: 'public_list_price';
  source: 'litellm';
  asOf: string;
  pricedAs: string;
  match: MatchMethod;
  /** Per 1M tokens, or per image on the image board. */
  inputUsdPerMillion?: number;
  outputUsdPerMillion?: number;
  /** 3 input : 1 output tokens, per 1M — the ordering price for the frontier. */
  blendedUsdPerMillion?: number;
  usdPerImage?: number;
}

export interface BenchmarkRow {
  kind: 'benchmark_run';
  model: string;
  passRatePercent: number;
  cases: number;
  runCostUsd: number | null;
  /** Published run cost / solved exercises. Null when the run cost was not published. */
  costPerSolvedTaskUsd: number | null;
  date: string;
  basis: 'public_benchmark_run_cost';
  frontier: boolean | null;
  personal: PersonalMarketValue | null;
}

export interface RatingRow {
  kind: 'rating';
  model: string;
  rating: number;
  ratingLower: number;
  ratingUpper: number;
  votes: number;
  basis: 'public_preference_rating';
  price: PriceBasis | null;
  /** Ratings are not a ratio scale, so no per-dollar quotient is formed. */
  perDollar: null;
  frontier: boolean | null;
  personal: PersonalMarketValue | null;
}

export interface MarketBoard {
  sourceId: MarketSourceId;
  label: string;
  homepage: string;
  licence: string;
  status: 'available' | 'disabled' | 'missing';
  origin: SectionOrigin | null;
  fetchedAt: string | null;
  publishedAt: string | null;
  /** Newest date carried by any row, for sources that date rows rather than the file. */
  newestRowDate: string | null;
  rows: Array<BenchmarkRow | RatingRow>;
  frontier: string[];
  priceSource: { status: 'available' | 'disabled' | 'missing'; asOf: string | null } | null;
  notes: string[];
}

export interface ConsensusBoardRow extends ConsensusRow {
  price: PriceBasis | null;
  /** On the price/score Pareto frontier (point estimates). Null without a price. */
  frontier: boolean | null;
  /** For a model off the frontier: the cheapest model that scores higher for no more money. */
  beatenBy: { model: string; label: string; clear: boolean } | null;
  personal: PersonalMarketValue | null;
}

export interface ConsensusBoard {
  status: 'available' | 'disabled' | 'missing';
  /** Which market sources fed this fit. */
  inputs: MarketSourceId[];
  rows: ConsensusBoardRow[];
  frontier: string[];
  weights: ConsensusResult['weights'];
  singleSource: number;
  priceSource: { status: 'available' | 'disabled' | 'missing'; asOf: string | null };
  basis: 'public_benchmark_consensus';
  notes: string[];
}

export interface MarketReport {
  status: 'available' | 'disabled';
  categories: Array<{ id: MarketCategoryId; label: string; consensus: ConsensusBoard | null; boards: MarketBoard[] }>;
  boundary: string[];
  cacheErrors: string[];
}

const CATEGORIES: ReadonlyArray<{ id: MarketCategoryId; label: string; sources: MarketSourceId[] }> = [
  { id: 'coding', label: 'Coding', sources: ['aider', 'arena-webdev'] },
  { id: 'general-chat', label: 'General chat', sources: ['arena-text'] },
  { id: 'image', label: 'Image generation', sources: ['arena-image'] },
];

export const CONSENSUS_BOUNDARY =
  'The consensus score combines public benchmarks by fitting each benchmark\'s difficulty and each model\'s ability together (the method behind Epoch AI\'s Capabilities Index), weighted by a published reliability rubric. It is the expected score on a typical benchmark of the category, 0-100; its range is how far it moves if any one benchmark is dropped. A model needs two benchmarks to get one.';

export const MARKET_BOUNDARY: readonly string[] = [
  'Public benchmark results measure a published test, not the value of your own work. Your realized value, when shown, sits beside them and never enters their figures or frontier.',
  'Cost per solved task uses the dollar cost Aider published for each run: its harness, its prompts, and the prices on the run date. It is not a forecast of your cost.',
  'Arena ratings are relative preference ratings, not percentages; no per-dollar ratio is formed from them. A model is off the frontier only when a model that costs no more has a whole rating interval above its own.',
  'List prices are per token. Higher-effort variants spend more tokens per answer, which a per-token price does not show.',
  'A price joined by normalized name (for example an effort suffix removed) says which price-list entry it used.',
];

function dominatesBenchmark(a: BenchmarkRow, b: BenchmarkRow): boolean {
  return a.runCostUsd! <= b.runCostUsd! && a.passRatePercent >= b.passRatePercent
    && (a.runCostUsd! < b.runCostUsd! || a.passRatePercent > b.passRatePercent);
}
function dominatesRating(a: RatingRow, b: RatingRow): boolean {
  const pa = a.price!.blendedUsdPerMillion ?? a.price!.usdPerImage!;
  const pb = b.price!.blendedUsdPerMillion ?? b.price!.usdPerImage!;
  return pa <= pb && a.ratingLower > b.ratingUpper;
}

function markFrontier<R extends BenchmarkRow | RatingRow>(rows: R[], eligible: (r: R) => boolean, dominates: (a: R, b: R) => boolean): string[] {
  const pool = rows.filter(eligible);
  for (const row of pool) row.frontier = !pool.some((other) => other !== row && dominates(other, row));
  return pool.filter((r) => r.frontier).map((r) => r.model);
}

export function buildMarketReport(
  loaded: LoadedMarket,
  features: FeaturesConfig,
  personal: readonly PersonalMarketValue[] = [],
): MarketReport {
  if (!features.market) return { status: 'disabled', categories: [], boundary: [...MARKET_BOUNDARY], cacheErrors: [] };
  const { snapshot, origin } = loaded;
  const litellm = features.marketLiteLLM ? snapshot.sources.litellm as SourceSnapshot<LiteLLMData> | undefined : undefined;
  const priceStatus = features.marketLiteLLM ? (litellm ? 'available' : 'missing') : 'disabled';
  const priceAsOf = litellm ? litellm.fetchedAt.slice(0, 10) : null;
  const mine = (model: string) => personal.find((p) => p.model.toLowerCase() === model.toLowerCase()) ?? null;

  const board = (id: MarketSourceId): MarketBoard => {
    const def = MARKET_SOURCES[id];
    const section = snapshot.sources[id];
    const enabled = features[def.feature];
    const base: MarketBoard = {
      sourceId: id, label: def.label, homepage: def.homepage, licence: def.licence,
      status: !enabled ? 'disabled' : section ? 'available' : 'missing',
      origin: section ? origin[id] ?? null : null,
      fetchedAt: section?.fetchedAt ?? null, publishedAt: section?.publishedAt ?? null, newestRowDate: null,
      rows: [], frontier: [], priceSource: id === 'aider' ? null : { status: priceStatus, asOf: priceAsOf }, notes: [],
    };
    if (!enabled || !section) return base;

    if (id === 'aider') {
      const rows: BenchmarkRow[] = (section.data as AiderData).entries.map((e) => {
        const solved = Math.round((e.passRatePercent / 100) * e.cases);
        return {
          kind: 'benchmark_run', model: e.model, passRatePercent: e.passRatePercent, cases: e.cases, runCostUsd: e.runCostUsd,
          costPerSolvedTaskUsd: e.runCostUsd !== null && solved > 0 ? e.runCostUsd / solved : null,
          date: e.date, basis: 'public_benchmark_run_cost', frontier: null, personal: mine(e.model),
        };
      });
      rows.sort((a, b) => b.passRatePercent - a.passRatePercent || a.model.localeCompare(b.model));
      base.rows = rows;
      base.frontier = markFrontier(rows, (r) => r.runCostUsd !== null, dominatesBenchmark);
      base.newestRowDate = rows.reduce<string | null>((m, r) => (m && m > r.date ? m : r.date), null);
      const unpriced = rows.filter((r) => r.runCostUsd === null).length;
      if (unpriced) base.notes.push(`${unpriced} run(s) have no published cost; they show a pass rate but no cost per solved task and no frontier position.`);
      return base;
    }

    const arena = section.data as ArenaData;
    const image = id === 'arena-image';
    const rows: RatingRow[] = arena.entries.map((e) => {
      let price: PriceBasis | null = null;
      if (litellm) {
        if (image) {
          const hit = matchPrice(e.model, litellm.data.imagePrices);
          if (hit) price = { basis: 'public_list_price', source: 'litellm', asOf: priceAsOf!, pricedAs: hit.key, match: hit.method, usdPerImage: hit.value };
        } else {
          const hit = matchPrice(e.model, litellm.data.tokenPrices);
          if (hit) price = {
            basis: 'public_list_price', source: 'litellm', asOf: priceAsOf!, pricedAs: hit.key, match: hit.method,
            inputUsdPerMillion: hit.value.inputUsdPerMillion, outputUsdPerMillion: hit.value.outputUsdPerMillion,
            blendedUsdPerMillion: (3 * hit.value.inputUsdPerMillion + hit.value.outputUsdPerMillion) / 4,
          };
        }
      }
      return {
        kind: 'rating', model: e.model, rating: e.rating, ratingLower: e.ratingLower, ratingUpper: e.ratingUpper, votes: e.votes,
        basis: 'public_preference_rating', price, perDollar: null, frontier: null, personal: mine(e.model),
      };
    });
    rows.sort((a, b) => b.rating - a.rating || a.model.localeCompare(b.model));
    base.rows = rows;
    base.frontier = markFrontier(rows, (r) => r.price !== null, dominatesRating);
    base.newestRowDate = arena.publishedAt;
    const unpriced = rows.filter((r) => r.price === null).length;
    if (priceStatus !== 'available') base.notes.push(`Prices are ${priceStatus}; ratings are shown without a price or frontier.`);
    else if (unpriced) base.notes.push(`${unpriced} of ${rows.length} model(s) have no public ${image ? 'per-image ' : ''}list price in this market; they show a rating but no frontier position.`);
    return base;
  };

  return {
    status: 'available',
    categories: CATEGORIES.map((c) => ({ id: c.id, label: c.label, consensus: c.id === 'image' ? null : consensusBoard(c.id, loaded, features, personal, litellm), boards: c.sources.map(board) })),
    boundary: [...MARKET_BOUNDARY, CONSENSUS_BOUNDARY],
    cacheErrors: loaded.cacheErrors,
  };
}

// ---- consensus ------------------------------------------------------------------

const ARENA_FOR: Record<'coding' | 'general-chat', { id: 'arena-webdev' | 'arena-text'; benchmark: string }> = {
  coding: { id: 'arena-webdev', benchmark: 'LMArena WebDev' },
  'general-chat': { id: 'arena-text', benchmark: 'LMArena text' },
};

const consensusCache = new Map<string, ConsensusResult>();
/** Bump when the fitting method changes, so no stored fit is reused across methods. */
export const CONSENSUS_VERSION = 1;
const bundledFitsPath = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'market', 'consensus-fits.json');
const homeFitPath = (key: string) => join(marketCacheDir(), `consensus-${key.slice(0, 16)}.json`);

/** A stored fit is used only when its key (method version + exact input hashes) matches. */
function readFittedConsensus(key: string): ConsensusResult | null {
  for (const path of [homeFitPath(key), bundledFitsPath]) {
    try {
      if (!existsSync(path)) continue;
      const stored = JSON.parse(readFileSync(path, 'utf8')) as Record<string, ConsensusResult>;
      const hit = stored[key];
      if (hit && Array.isArray(hit.rows) && Array.isArray(hit.weights)) return hit;
    } catch { /* an unreadable stored fit is refitted, never trusted */ }
  }
  return null;
}

function writeFittedConsensus(key: string, result: ConsensusResult): void {
  try {
    mkdirSync(marketCacheDir(), { recursive: true });
    const temp = `${homeFitPath(key)}.tmp-${randomUUID()}`;
    writeFileSync(temp, JSON.stringify({ [key]: result }));
    renameSync(temp, homeFitPath(key));
  } catch { /* caching is an optimisation; the result stands without it */ }
}

/** Every fit the bundled snapshot implies, for scripts/build-market-snapshot.mjs to ship. */
export function bundledConsensusFits(loaded: LoadedMarket, features: FeaturesConfig): Record<string, ConsensusResult> {
  const out: Record<string, ConsensusResult> = {};
  for (const category of ['coding', 'general-chat'] as const) {
    const { obs, inputs, today } = consensusObservations(category, loaded, features);
    if (!obs.length) continue;
    const key = createHash('sha256').update(JSON.stringify([CONSENSUS_VERSION, category, inputs, inputs.map((id) => loaded.snapshot.sources[id]?.sha256)])).digest('hex');
    out[key] = buildConsensus(category, obs, today);
  }
  return out;
}

/** The observations the fit sees, from every enabled source that feeds it. */
export function consensusObservations(category: 'coding' | 'general-chat', loaded: LoadedMarket, features: FeaturesConfig): { obs: ConsensusObservation[]; inputs: MarketSourceId[]; today: string } {
  const obs: ConsensusObservation[] = [];
  const inputs: MarketSourceId[] = [];
  let today = '1970-01-01';
  const epoch = loaded.snapshot.sources.epoch as SourceSnapshot<EpochData> | undefined;
  if (features.marketEpoch && epoch) {
    inputs.push('epoch');
    today = epoch.fetchedAt.slice(0, 10) > today ? epoch.fetchedAt.slice(0, 10) : today;
    const wanted = new Set(RELIABILITY.filter((r) => r.category === category).map((r) => r.benchmark));
    for (const r of epoch.data.results) {
      if (wanted.has(r.benchmark)) obs.push({ model: canonicalModel(r.model), label: r.model, benchmark: r.benchmark, score: r.score, date: r.date });
    }
  }
  const arenaSrc = ARENA_FOR[category];
  const arena = loaded.snapshot.sources[arenaSrc.id] as SourceSnapshot<ArenaData> | undefined;
  if (features.marketArena && arena && arena.data.entries.length) {
    inputs.push(arenaSrc.id);
    today = arena.fetchedAt.slice(0, 10) > today ? arena.fetchedAt.slice(0, 10) : today;
    const ratings = arena.data.entries.map((e) => e.rating).sort((a, b) => a - b);
    const reference = ratings[Math.floor(ratings.length / 2)]!;
    for (const e of arena.data.entries) {
      obs.push({ model: canonicalModel(e.model), label: e.model, benchmark: arenaSrc.benchmark, score: Math.round(ratingToScore(e.rating, reference) * 1e4) / 1e4, date: arena.data.publishedAt });
    }
  }
  return { obs, inputs, today };
}

function canonicalPriceIndex(table: Record<string, ListPrice>): Map<string, { key: string; price: ListPrice }> {
  const index = new Map<string, { key: string; price: ListPrice }>();
  // Exact canonical keys first, so `gpt-5` wins over `gpt-5-2025-08-07` for the key `gpt-5`.
  const keys = Object.keys(table).sort((a, b) => Number(canonicalModel(a) !== a) - Number(canonicalModel(b) !== b) || a.length - b.length || a.localeCompare(b));
  for (const key of keys) {
    const c = canonicalModel(key);
    if (!index.has(c)) index.set(c, { key, price: table[key]! });
  }
  return index;
}

function consensusBoard(
  category: 'coding' | 'general-chat',
  loaded: LoadedMarket,
  features: FeaturesConfig,
  personal: readonly PersonalMarketValue[],
  litellm: SourceSnapshot<LiteLLMData> | undefined,
): ConsensusBoard {
  const priceSource = { status: (features.marketLiteLLM ? (litellm ? 'available' : 'missing') : 'disabled') as ConsensusBoard['priceSource']['status'], asOf: litellm ? litellm.fetchedAt.slice(0, 10) : null };
  const empty = (status: ConsensusBoard['status'], note: string): ConsensusBoard => ({
    status, inputs: [], rows: [], frontier: [], weights: [], singleSource: 0, priceSource, basis: 'public_benchmark_consensus', notes: [note],
  });
  if (!features.marketEpoch && !features.marketArena) return empty('disabled', 'Its sources (Epoch AI and LMArena) are switched off in Features; not computed.');
  const { obs, inputs, today } = consensusObservations(category, loaded, features);
  if (!obs.length) return empty('missing', 'No benchmark data for this category in the snapshot; run segreant market --refresh epoch.');

  const key = createHash('sha256').update(JSON.stringify([CONSENSUS_VERSION, category, inputs, inputs.map((id) => loaded.snapshot.sources[id]?.sha256)])).digest('hex');
  let result = consensusCache.get(key) ?? readFittedConsensus(key);
  if (!result) {
    result = buildConsensus(category, obs, today);
    writeFittedConsensus(key, result);
  }
  consensusCache.set(key, result);

  const index = litellm ? canonicalPriceIndex(litellm.data.tokenPrices) : null;
  const mine = (model: string) => personal.find((p) => canonicalModel(p.model) === model) ?? null;
  const rows: ConsensusBoardRow[] = result.rows.map((r) => {
    const hit = index?.get(r.model);
    const price: PriceBasis | null = hit ? {
      basis: 'public_list_price', source: 'litellm', asOf: priceSource.asOf!, pricedAs: hit.key, match: hit.key === r.model ? 'exact' : 'normalized',
      inputUsdPerMillion: hit.price.inputUsdPerMillion, outputUsdPerMillion: hit.price.outputUsdPerMillion,
      blendedUsdPerMillion: (3 * hit.price.inputUsdPerMillion + hit.price.outputUsdPerMillion) / 4,
    } : null;
    return { ...r, price, frontier: null, beatenBy: null, personal: mine(r.model) };
  });
  const pool = rows.filter((r) => r.price !== null);
  const cost = (r: ConsensusBoardRow) => r.price!.blendedUsdPerMillion!;
  for (const row of pool) {
    // Pareto on point estimates; a win inside the leave-one-out range is labelled, not hidden.
    const better = pool.filter((o) => o !== row && cost(o) <= cost(row) && o.score > row.score && (cost(o) < cost(row) || o.score > row.score));
    row.frontier = better.length === 0;
    const cheapest = better.sort((a, b) => cost(a) - cost(b) || b.score - a.score)[0];
    row.beatenBy = cheapest ? { model: cheapest.model, label: cheapest.label, clear: cheapest.low > row.high } : null;
  }
  const notes: string[] = [];
  if (!inputs.includes('epoch')) notes.push('Epoch AI results are switched off or missing, so this rests on LMArena alone and few models reach two benchmarks.');
  if (result.singleSource) notes.push(`${result.singleSource} model(s) appear on only one benchmark and get no consensus score; see the source boards below.`);
  const unpriced = rows.length - pool.length;
  if (priceSource.status !== 'available') notes.push(`Prices are ${priceSource.status}; scores are shown without a price or frontier.`);
  else if (unpriced) notes.push(`${unpriced} scored model(s) have no public list price in this market and no frontier position.`);
  return { status: 'available', inputs, rows, frontier: pool.filter((r) => r.frontier).map((r) => r.label), weights: result.weights, singleSource: result.singleSource, priceSource, basis: 'public_benchmark_consensus', notes };
}
