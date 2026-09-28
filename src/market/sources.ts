/**
 * Public market sources: what each one is, where it lives, its licence, and a
 * parser from the raw public payload to the snapshot's per-source section.
 *
 * Parsers are pure (text in, data out) so the bundled snapshot, a refresh, and
 * the tests all run the same code. Nothing here opens a socket; `refresh.ts`
 * fetches through the egress transport and hands the text to these parsers.
 */

export type MarketSourceId = 'litellm' | 'aider' | 'arena-text' | 'arena-webdev' | 'arena-image' | 'epoch';
export type MarketFeatureKey = 'marketLiteLLM' | 'marketAider' | 'marketArena' | 'marketEpoch';

export interface MarketSourceDef {
  id: MarketSourceId;
  label: string;
  /** Human-facing page for the source, shown beside every figure it supplies. */
  homepage: string;
  licence: string;
  feature: MarketFeatureKey;
  /** Exact origin and path prefix the egress rule for this source must grant. */
  origin: string;
  pathPrefix: string;
}

const ARENA_ORIGIN = 'https://datasets-server.huggingface.co';
const ARENA_DATASET = 'lmarena-ai/leaderboard-dataset';

export const MARKET_SOURCES: Readonly<Record<MarketSourceId, MarketSourceDef>> = Object.freeze({
  litellm: {
    id: 'litellm', label: 'LiteLLM model price list',
    homepage: 'https://github.com/BerriAI/litellm',
    licence: 'MIT (LiteLLM repository)', feature: 'marketLiteLLM',
    origin: 'https://raw.githubusercontent.com', pathPrefix: '/BerriAI/litellm/main/model_prices_and_context_window.json',
  },
  aider: {
    id: 'aider', label: 'Aider polyglot coding leaderboard',
    homepage: 'https://aider.chat/docs/leaderboards/',
    licence: 'Apache-2.0 (Aider repository)', feature: 'marketAider',
    origin: 'https://raw.githubusercontent.com', pathPrefix: '/Aider-AI/aider/main/aider/website/_data/polyglot_leaderboard.yml',
  },
  'arena-text': {
    id: 'arena-text', label: 'LMArena text leaderboard (style control)',
    homepage: 'https://huggingface.co/datasets/lmarena-ai/leaderboard-dataset',
    licence: 'CC BY 4.0 (LMArena leaderboard dataset)', feature: 'marketArena',
    origin: ARENA_ORIGIN, pathPrefix: '/rows',
  },
  'arena-webdev': {
    id: 'arena-webdev', label: 'LMArena WebDev leaderboard',
    homepage: 'https://huggingface.co/datasets/lmarena-ai/leaderboard-dataset',
    licence: 'CC BY 4.0 (LMArena leaderboard dataset)', feature: 'marketArena',
    origin: ARENA_ORIGIN, pathPrefix: '/rows',
  },
  epoch: {
    id: 'epoch', label: 'Epoch AI Benchmarking Hub',
    homepage: 'https://epoch.ai/benchmarks',
    licence: 'CC BY 4.0 (Epoch AI)', feature: 'marketEpoch',
    origin: 'https://epoch.ai', pathPrefix: '/data/benchmark_data.zip',
  },
  'arena-image': {
    id: 'arena-image', label: 'LMArena text-to-image leaderboard',
    homepage: 'https://huggingface.co/datasets/lmarena-ai/leaderboard-dataset',
    licence: 'CC BY 4.0 (LMArena leaderboard dataset)', feature: 'marketArena',
    origin: ARENA_ORIGIN, pathPrefix: '/rows',
  },
});

export const MARKET_SOURCE_IDS = Object.keys(MARKET_SOURCES) as MarketSourceId[];
import { parseCsv, readZipEntries } from './zip.ts';

const ARENA_CONFIG: Record<'arena-text' | 'arena-webdev' | 'arena-image', string> = {
  'arena-text': 'text_style_control',
  'arena-webdev': 'webdev',
  'arena-image': 'text_to_image',
};
export const ARENA_PAGE_ROWS = 100;
export const ARENA_MAX_PAGES = 10;

/** The exact URL for one fetch. Arena sources are paged; the others are one file. */
export function sourceUrl(id: MarketSourceId, page = 0): string {
  const def = MARKET_SOURCES[id];
  if (id === 'arena-text' || id === 'arena-webdev' || id === 'arena-image') {
    const q = new URLSearchParams({ dataset: ARENA_DATASET, config: ARENA_CONFIG[id], split: 'latest', offset: String(page * ARENA_PAGE_ROWS), length: String(ARENA_PAGE_ROWS) });
    return `${def.origin}${def.pathPrefix}?${q.toString()}`;
  }
  return `${def.origin}${def.pathPrefix}`;
}

/**
 * The rule id that authorizes a source. The three arena boards share one
 * origin and path, so they share one rule: separate identical rules would make
 * the egress policy refuse every arena request as ambiguous.
 */
export function grantRuleId(id: MarketSourceId): string {
  return id.startsWith('arena-') ? 'market-arena' : `market-${id}`;
}

/** The one command that grants this source, printed whenever egress refuses it. */
export function grantCommand(id: MarketSourceId): string {
  const def = MARKET_SOURCES[id];
  return `segreant egress apply --apply --mode controlled_cloud --id ${grantRuleId(id)} --purpose market_refresh --data-class market_manifest --method GET --origin ${def.origin} --path-prefix ${def.pathPrefix}`;
}

// ---- per-source data -------------------------------------------------------

export interface ListPrice { inputUsdPerMillion: number; outputUsdPerMillion: number }
export interface LiteLLMData { tokenPrices: Record<string, ListPrice>; imagePrices: Record<string, number> }

export interface AiderEntry {
  model: string;
  passRatePercent: number;
  cases: number;
  /** Published dollar cost of the whole benchmark run; null when Aider did not track it. */
  runCostUsd: number | null;
  date: string;
  editFormat: string | null;
}
export interface AiderData { entries: AiderEntry[] }

export interface ArenaEntry { model: string; rating: number; ratingLower: number; ratingUpper: number; votes: number }
export interface ArenaData { publishedAt: string; entries: ArenaEntry[] }

export interface EpochResult {
  /** Epoch's model group name, e.g. "Claude Opus 4.6"; effort variants are grouped under it. */
  model: string;
  benchmark: string;
  /** Chance-corrected onto [0, 1] with the benchmark's published baseline and ceiling. */
  score: number;
  date: string | null;
  /** True when Epoch AI ran the evaluation itself; false for a curated external leaderboard. */
  epochRun: boolean;
}
export interface EpochData { results: EpochResult[] }

export type SourceData = LiteLLMData | AiderData | ArenaData | EpochData;

/**
 * Epoch AI's benchmark bundle: the cleaned long table Epoch builds its own
 * Capabilities Index from, plus the benchmark metadata (chance baseline and
 * ceiling). Only the benchmarks in the consensus reliability table are kept.
 */
export function parseEpoch(zip: Buffer, keep: ReadonlySet<string>): EpochData {
  const files = readZipEntries(zip, new Set(['benchmark_metadata.csv', 'epoch_capabilities_index/processed_data_for_eci.csv']));
  const metaText = files.get('benchmark_metadata.csv');
  const dataText = files.get('epoch_capabilities_index/processed_data_for_eci.csv');
  if (!metaText || !dataText) throw new Error('Epoch bundle is missing its metadata or processed data file');
  const meta = new Map(parseCsv(metaText.toString('utf8')).map((r) => [r.benchmark ?? '', r]));
  const results: EpochResult[] = [];
  for (const r of parseCsv(dataText.toString('utf8'))) {
    const benchmark = r.benchmark ?? '';
    if (!keep.has(benchmark)) continue;
    const m = meta.get(benchmark);
    const base = Number(m?.random_baseline ?? 0);
    const ceil = Number(m?.score_ceiling ?? 1);
    const perf = Number(r.performance);
    const model = (r.Model ?? '').trim();
    if (!model || !Number.isFinite(perf) || !(ceil > base)) continue;
    const date = DAY.test(r.date ?? '') ? r.date! : null;
    results.push({ model, benchmark, score: Math.round(Math.min(1, Math.max(0, (perf - base) / (ceil - base))) * 1e4) / 1e4, date, epochRun: (r.source ?? '') === '' });
  }
  if (results.length < 50) throw new Error('Epoch bundle has too few usable results to trust');
  return { results };
}

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** Lower-case name with any provider prefix removed: `openai/gpt-5` -> `gpt-5`. */
export function baseName(model: string): string {
  return model.slice(model.lastIndexOf('/') + 1).trim().toLowerCase();
}

export function parseLiteLLM(text: string): LiteLLMData {
  const raw: unknown = JSON.parse(text);
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('LiteLLM price list is not an object');
  const tokenPrices: Record<string, ListPrice> = {};
  const imagePrices: Record<string, number> = {};
  // First-party keys (no provider prefix) win over reseller routes for the same name.
  const entries = Object.entries(raw as Record<string, unknown>).sort(([a], [b]) => Number(a.includes('/')) - Number(b.includes('/')) || a.localeCompare(b));
  for (const [key, value] of entries) {
    if (key === 'sample_spec' || value === null || typeof value !== 'object') continue;
    const v = value as Record<string, unknown>;
    const name = baseName(key);
    if (!name) continue;
    if ((v.mode === 'chat' || v.mode === 'responses') && finite(v.input_cost_per_token) && finite(v.output_cost_per_token)
      && v.input_cost_per_token > 0 && v.output_cost_per_token > 0 && !(name in tokenPrices)) {
      tokenPrices[name] = { inputUsdPerMillion: round6(v.input_cost_per_token * 1e6), outputUsdPerMillion: round6(v.output_cost_per_token * 1e6) };
    }
    if (v.mode === 'image_generation' && finite(v.output_cost_per_image) && v.output_cost_per_image > 0 && !key.includes('/') && !(name in imagePrices)) {
      imagePrices[name] = v.output_cost_per_image;
    }
  }
  if (Object.keys(tokenPrices).length < 50) throw new Error('LiteLLM price list has too few priced chat models to trust');
  return { tokenPrices, imagePrices };
}

function round6(n: number): number { return Math.round(n * 1e6) / 1e6; }

/**
 * Aider's leaderboard is a flat YAML list of maps. This reads exactly that
 * shape and nothing more general; an unexpected shape fails rather than guesses.
 * A `total_cost` of zero or with an inline comment means the run cost was not
 * tracked (Aider marks free or mis-recorded runs that way), so it becomes null.
 */
export function parseAider(text: string): AiderData {
  const records: Array<Record<string, string>> = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim() || line.trimStart().startsWith('#')) continue;
    const start = /^- (\w+):\s*(.*)$/.exec(line);
    const field = /^ {2}(\w+):\s*(.*)$/.exec(line);
    if (start) records.push({ [start[1]!]: start[2]! });
    else if (field && records.length) records.at(-1)![field[1]!] = field[2]!;
  }
  const unquote = (s: string) => s.replace(/^(['"])(.*)\1$/, '$2');
  const entries: AiderEntry[] = [];
  for (const r of records) {
    const model = unquote(r.model ?? '').trim();
    const pass = Number(r.pass_rate_2);
    const cases = Number(r.test_cases);
    const date = unquote(r.date ?? '');
    if (!model || !Number.isFinite(pass) || pass < 0 || pass > 100 || !Number.isInteger(cases) || cases <= 0 || !DAY.test(date)) continue;
    const costText = r.total_cost ?? '';
    const cost = Number(costText);
    entries.push({
      model, passRatePercent: pass, cases, date,
      runCostUsd: costText.includes('#') || !Number.isFinite(cost) || cost <= 0 ? null : cost,
      editFormat: r.edit_format ? unquote(r.edit_format) : null,
    });
  }
  if (entries.length < 10) throw new Error('Aider leaderboard has too few valid entries to trust');
  return { entries };
}

/**
 * One page of the Hugging Face datasets-server `rows` response. Returns the
 * `overall` rows and whether the category run has ended (the dataset lists the
 * overall board first, then per-category boards).
 */
export function parseArenaPage(text: string): { entries: ArenaEntry[]; publishedAt: string | null; done: boolean } {
  const raw = JSON.parse(text) as { rows?: Array<{ row?: Record<string, unknown> }> };
  if (!Array.isArray(raw.rows)) throw new Error('arena page has no rows array');
  const entries: ArenaEntry[] = [];
  let publishedAt = null as string | null;
  let done = raw.rows.length < ARENA_PAGE_ROWS;
  for (const item of raw.rows) {
    const r = item.row ?? {};
    if (r.category !== 'overall') { done = true; break; }
    const { model_name: model, rating, rating_lower: lo, rating_upper: hi, vote_count: votes, leaderboard_publish_date: day } = r;
    if (typeof model !== 'string' || !model.trim() || !finite(rating) || !finite(lo) || !finite(hi) || !finite(votes) || lo > rating || hi < rating) continue;
    if (typeof day === 'string' && DAY.test(day)) publishedAt = publishedAt && publishedAt > day ? publishedAt : day;
    entries.push({ model: model.trim(), rating: round1(rating), ratingLower: round1(lo), ratingUpper: round1(hi), votes: Math.round(votes) });
  }
  return { entries, publishedAt, done };
}

function round1(n: number): number { return Math.round(n * 10) / 10; }

// ---- name matching -----------------------------------------------------------

export type MatchMethod = 'exact' | 'normalized';

const EFFORT = /-(xhigh|high|medium|low|minimal|max|thinking(-\d+k)?|no-thinking|nothinking|reasoning|instant|latest|preview|exp)$/;
const DATED = /-(\d{8}|\d{4}-\d{2}-\d{2})$/;

/**
 * Join a leaderboard name to a price-list name. Exact first; otherwise strip
 * a parenthetical, a date suffix, and effort/reasoning suffixes one at a time,
 * accepting a candidate only when it resolves to exactly one price entry. The
 * method is returned so every joined price says how it was joined.
 */
export function matchPrice<T>(model: string, table: Record<string, T>): { key: string; value: T; method: MatchMethod } | null {
  const exact = baseName(model);
  if (Object.hasOwn(table, exact)) return { key: exact, value: table[exact]!, method: 'exact' };
  let name = exact.replace(/\s*[([].*$/, '').trim();
  const tried = new Set<string>();
  for (let i = 0; i < 6 && name; i++) {
    if (!tried.has(name) && Object.hasOwn(table, name)) return { key: name, value: table[name]!, method: 'normalized' };
    tried.add(name);
    const next = name.replace(DATED, '').replace(EFFORT, '');
    if (next === name) break;
    name = next;
  }
  return null;
}
