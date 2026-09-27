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
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { segreantHome, type FeaturesConfig } from '../config.ts';
import {
  MARKET_SOURCES, MARKET_SOURCE_IDS, matchPrice,
  type AiderData, type ArenaData, type LiteLLMData, type MarketSourceId, type MatchMethod, type SourceData,
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

export interface MarketReport {
  status: 'available' | 'disabled';
  categories: Array<{ id: MarketCategoryId; label: string; boards: MarketBoard[] }>;
  boundary: string[];
  cacheErrors: string[];
}

const CATEGORIES: ReadonlyArray<{ id: MarketCategoryId; label: string; sources: MarketSourceId[] }> = [
  { id: 'coding', label: 'Coding', sources: ['aider', 'arena-webdev'] },
  { id: 'general-chat', label: 'General chat', sources: ['arena-text'] },
  { id: 'image', label: 'Image generation', sources: ['arena-image'] },
];

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
    categories: CATEGORIES.map((c) => ({ id: c.id, label: c.label, boards: c.sources.map(board) })),
    boundary: [...MARKET_BOUNDARY],
    cacheErrors: loaded.cacheErrors,
  };
}
