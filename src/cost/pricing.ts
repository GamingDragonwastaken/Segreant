/**
 * Cost engine.
 *
 * Loads the pricing table and turns a NormalizedUsage into a USD figure.
 *
 * Design note: the cost model is deliberately the *real* one — four rate
 * dimensions (input, output, cache-write, cache-read). The source research
 * proposed a separate "reasoning multiplier", but neither Anthropic nor OpenAI
 * bills reasoning/thinking tokens at a special rate: Anthropic counts them as
 * output tokens, OpenAI counts them inside completion_tokens. We keep a
 * reasoningTokens field for reporting only — it never changes the price.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { aegisHome } from '../config.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));

/** The rate card shipped inside the package — always present, works offline. */
const BUNDLED_PRICING_PATH = join(__dirname, '..', '..', 'pricing', 'models.json');

/**
 * A user-writable copy under ~/.aegisflow/pricing/models.json that, when present
 * and structurally valid, OVERRIDES the bundled table. This is where
 * `fiscus pricing --refresh` writes a freshly-pulled manifest, so prices can
 * be updated without reinstalling — pricing is a core dependability, and
 * provider rates drift.
 */
function cachePath(): string {
  return join(aegisHome(), 'pricing', 'models.json');
}

export type Provider = 'anthropic' | 'openai';

export interface ModelRate {
  /** USD per 1M uncached input tokens. */
  input: number;
  /** USD per 1M output tokens (includes reasoning/thinking tokens). */
  output: number;
  /** USD per 1M tokens written to the 5-minute prompt cache. */
  cache_write_5m?: number;
  /** USD per 1M tokens written to the 1-hour prompt cache. */
  cache_write_1h?: number;
  /** USD per 1M tokens read from the prompt cache. */
  cache_read?: number;
}

interface PricingFile {
  schema_version: number;
  updated: string;
  unit: string;
  providers: Record<string, { verified: boolean; models: Record<string, ModelRate> }>;
  fallbacks: { unknown: ModelRate };
}

/** Tokens for one request, normalized across providers. */
export interface NormalizedUsage {
  /** Uncached input tokens (full price). */
  inputTokens: number;
  /** Output tokens, including any reasoning/thinking tokens. */
  outputTokens: number;
  /** Tokens written to cache this request (Anthropic cache_creation_*). */
  cacheWriteTokens: number;
  /** Tokens served from cache this request. */
  cacheReadTokens: number;
  /** TTL of the cache write, if known. Affects the write rate. */
  cacheWriteTtl?: '5m' | '1h';
  /** Reasoning tokens — reporting only, billed inside outputTokens. */
  reasoningTokens?: number;
}

export interface CostBreakdown {
  costUsd: number;
  /** True when no exact model rate matched and a fallback was used. */
  estimated: boolean;
  rate: ModelRate;
  components: {
    input: number;
    output: number;
    cacheWrite: number;
    cacheRead: number;
  };
}

let cached: PricingFile | null = null;
let cachedSource: 'cache' | 'bundled' = 'bundled';

/** Structural check before we trust a pricing table — a refresh must never let a
 *  truncated download or a wrong-shaped file silently corrupt every cost. */
function isValidPricing(obj: unknown): obj is PricingFile {
  if (!obj || typeof obj !== 'object') return false;
  const o = obj as Record<string, unknown>;
  if (typeof o['schema_version'] !== 'number') return false;
  if (!o['providers'] || typeof o['providers'] !== 'object') return false;
  const unk = (o['fallbacks'] as { unknown?: Record<string, unknown> } | undefined)?.unknown;
  if (!unk || typeof unk['input'] !== 'number' || typeof unk['output'] !== 'number') return false;
  const provs = Object.values(o['providers'] as Record<string, { models?: Record<string, unknown> }>);
  return provs.some((p) => p && p.models && Object.keys(p.models).length > 0);
}

function readValidPricing(path: string): PricingFile | null {
  try {
    const obj: unknown = JSON.parse(readFileSync(path, 'utf8'));
    return isValidPricing(obj) ? obj : null;
  } catch {
    return null;
  }
}

function countModels(file: PricingFile): number {
  return Object.values(file.providers).reduce((n, p) => n + Object.keys(p.models).length, 0);
}

export function loadPricing(force = false): PricingFile {
  if (cached && !force) return cached;
  // Prefer the refreshed cache when present AND structurally valid; otherwise
  // fall back to the bundled table. A corrupt cache degrades to bundled rather
  // than breaking pricing — and `pricingStatus()` always reports which won, so
  // the fallback is visible, never silent.
  const fromCache = readValidPricing(cachePath());
  if (fromCache) {
    cached = fromCache;
    cachedSource = 'cache';
    return cached;
  }
  cached = JSON.parse(readFileSync(BUNDLED_PRICING_PATH, 'utf8')) as PricingFile;
  cachedSource = 'bundled';
  return cached;
}

export interface RefreshResult {
  ok: boolean;
  updated?: string;
  modelCount?: number;
  error?: string;
}

/**
 * The default live pricing source: LiteLLM's community-maintained price file.
 * Hundreds of contributors update it within days of every model release, so
 * consuming this machine-readable feed keeps the rate card current without
 * scraping provider pricing pages (brittle HTML that needs a parser which
 * itself rots). The GET fetches a public file and sends nothing about the user.
 */
export const DEFAULT_MANIFEST_URL =
  'https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json';

/** LiteLLM providers we carry, mapped onto our table's provider keys. */
const LITELLM_PROVIDER_MAP: Record<string, string> = {
  anthropic: 'anthropic',
  openai: 'openai',
  gemini: 'google',
};

/** Fewer matched models than this means the feed shape changed — refuse, keep the current table. */
const MIN_TRANSFORMED_MODELS = 10;

interface LiteLLMEntry {
  litellm_provider?: string;
  mode?: string;
  input_cost_per_token?: number;
  output_cost_per_token?: number;
  cache_creation_input_token_cost?: number;
  cache_read_input_token_cost?: number;
}

/** Per-token → per-1M, trimmed of float noise (3e-6/token → 3 $/1M exactly). */
function perMillion(perToken: number): number {
  return Number((perToken * 1e6).toPrecision(10));
}

/**
 * Convert a LiteLLM price file into our manifest schema. Pure and total: bad
 * input yields `{ ok: false }`, never a throw. Only chat-capable entries from
 * providers we meter are carried; `verified` is false because the rates are
 * community-maintained; the conservative `unknown` fallback comes from the
 * CURRENT table, so a feed can never weaken it.
 */
export function transformLiteLLMManifest(rawText: string): { ok: boolean; file?: PricingFile; error?: string } {
  let obj: unknown;
  try {
    obj = JSON.parse(rawText);
  } catch (e) {
    return { ok: false, error: `not valid JSON: ${String(e)}` };
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return { ok: false, error: 'not an object map of models' };

  const providers: Record<string, { verified: boolean; models: Record<string, ModelRate> }> = {};
  for (const [rawKey, rawEntry] of Object.entries(obj as Record<string, unknown>)) {
    if (rawKey === 'sample_spec' || !rawEntry || typeof rawEntry !== 'object') continue;
    const e = rawEntry as LiteLLMEntry;
    const provider = LITELLM_PROVIDER_MAP[e.litellm_provider ?? ''];
    if (!provider) continue;
    // Chat/responses models only — embedding, audio, image rates don't belong in a token rate card.
    if (e.mode !== undefined && e.mode !== 'chat' && e.mode !== 'responses') continue;
    if (typeof e.input_cost_per_token !== 'number' || typeof e.output_cost_per_token !== 'number') continue;
    if (e.input_cost_per_token <= 0 || e.output_cost_per_token <= 0) continue;

    // LiteLLM keys may carry a route prefix ("gemini/gemini-2.5-pro"); our
    // tables key by bare model name — what the wire protocol carries.
    const name = rawKey.includes('/') ? rawKey.slice(rawKey.lastIndexOf('/') + 1) : rawKey;
    const bucket = (providers[provider] ??= { verified: false, models: {} });
    if (bucket.models[name]) continue; // first entry wins — deterministic on duplicate routes
    const rate: ModelRate = {
      input: perMillion(e.input_cost_per_token),
      output: perMillion(e.output_cost_per_token),
    };
    if (typeof e.cache_creation_input_token_cost === 'number' && e.cache_creation_input_token_cost > 0) {
      rate.cache_write_5m = perMillion(e.cache_creation_input_token_cost);
    }
    if (typeof e.cache_read_input_token_cost === 'number' && e.cache_read_input_token_cost > 0) {
      rate.cache_read = perMillion(e.cache_read_input_token_cost);
    }
    bucket.models[name] = rate;
  }

  const total = Object.values(providers).reduce((n, p) => n + Object.keys(p.models).length, 0);
  if (total < MIN_TRANSFORMED_MODELS) {
    return { ok: false, error: `feed shape not recognized (only ${total} usable models found) — keeping the current table` };
  }

  const file: PricingFile = {
    schema_version: 1,
    updated: new Date().toISOString().slice(0, 10),
    unit: 'per_million_tokens',
    providers,
    fallbacks: loadPricing().fallbacks,
  };
  return { ok: true, file };
}

/**
 * Validate a pricing manifest (raw JSON text) and, if it passes, write it to the
 * local cache so it overrides the bundled table. Accepts either our native
 * schema or a LiteLLM price file (auto-detected and transformed). Network-free,
 * so it is unit-testable on its own; `refreshPricing` adds the fetch around it.
 * On any failure the existing cache is left untouched — a bad refresh never
 * downgrades you to worse pricing data.
 */
export function applyPricingManifest(rawText: string): RefreshResult {
  let obj: unknown;
  try {
    obj = JSON.parse(rawText);
  } catch (e) {
    return { ok: false, error: `not valid JSON: ${String(e)}` };
  }
  let file: PricingFile;
  if (isValidPricing(obj)) {
    file = obj;
  } else {
    const t = transformLiteLLMManifest(rawText);
    if (!t.ok || !t.file || !isValidPricing(t.file)) {
      return { ok: false, error: t.error ?? 'manifest failed shape check (schema_version / providers / fallbacks.unknown)' };
    }
    file = t.file;
  }
  try {
    const dir = join(aegisHome(), 'pricing');
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(cachePath(), JSON.stringify(file, null, 2) + '\n', 'utf8');
  } catch (e) {
    return { ok: false, error: `could not write cache: ${String(e)}` };
  }
  cached = null; // invalidate the memo so the next load picks up the new table
  return { ok: true, updated: file.updated, modelCount: countModels(file) };
}

/**
 * Pull a fresh pricing manifest and apply it. `url` null → the default feed.
 * Sends ONLY a GET for a public pricing file — no prompts, no usage, nothing
 * about the user — so it preserves the zero-content-egress invariant. Degrades
 * gracefully: any network or HTTP error returns `{ ok: false }` and keeps the
 * current table.
 */
export async function refreshPricing(url: string | null, timeoutMs = 20_000): Promise<RefreshResult> {
  const target = url ?? DEFAULT_MANIFEST_URL;
  try {
    const res = await fetch(target, { signal: AbortSignal.timeout(timeoutMs), headers: { accept: 'application/json' } });
    if (!res.ok) return { ok: false, error: `HTTP ${res.status} from ${target}` };
    return applyPricingManifest(await res.text());
  } catch (e) {
    return { ok: false, error: `fetch failed: ${String(e)}` };
  }
}

export interface PricingStatus {
  source: 'cache' | 'bundled';
  updated: string;
  ageDays: number | null;
  stale: boolean;
  modelCount: number;
  providers: string[];
}

/** Where the active table came from, how old it is, and whether it's stale. */
export function pricingStatus(maxAgeDays = 30): PricingStatus {
  const file = loadPricing(true); // fresh read so `source` reflects current disk
  const updated = file.updated ?? 'unknown';
  const t = Date.parse(updated);
  const ageDays = Number.isNaN(t) ? null : Math.floor((Date.now() - t) / 86_400_000);
  return {
    source: cachedSource,
    updated,
    ageDays,
    stale: ageDays !== null && ageDays > maxAgeDays,
    modelCount: countModels(file),
    providers: Object.keys(file.providers),
  };
}

/**
 * Best-effort substring match for model families within one provider's table.
 * Prefers the longest matching key so "gemini-2.5-flash-lite" wins over
 * "gemini-2.5-flash", and "claude-opus-4-8" wins over a bare "claude".
 */
function heuristicMatch(models: Record<string, ModelRate> | undefined, model: string): ModelRate | null {
  if (!models) return null;
  const m = model.toLowerCase();
  const keys = Object.keys(models).sort((a, b) => b.length - a.length);
  for (const key of keys) {
    if (m.includes(key.toLowerCase())) return models[key]!;
  }
  return null;
}

export interface ResolvedRate {
  rate: ModelRate;
  estimated: boolean;
}

export function rateFor(provider: Provider, model: string): ResolvedRate {
  const pricing = loadPricing();
  const here = pricing.providers[provider]?.models;

  // 1) Exact id in the named provider — the price we're surest about.
  const exact = here?.[model];
  if (exact) return { rate: exact, estimated: false };

  // 2) Exact id in ANY provider — an EXACT price always beats a fuzzy family
  //    guess, so this is tried before any substring match. An OpenAI-compatible
  //    endpoint can legitimately carry a non-OpenAI model (Gemini via Google's
  //    .../v1beta/openai/ base, a Claude model via OpenRouter): the transport is
  //    OpenAI-shaped but the price follows the MODEL. Exact anywhere ⟹ exact rate,
  //    so `estimated` stays false; only the path differed, not the rate.
  for (const p of Object.keys(pricing.providers)) {
    const r = pricing.providers[p]?.models[model];
    if (r) return { rate: r, estimated: false };
  }

  // 3) Family (substring) match within the named provider.
  const family = heuristicMatch(here, model);
  if (family) return { rate: family, estimated: true };

  // 4) Family match in ANY provider (e.g. a dated gemini id on the OpenAI path).
  for (const p of Object.keys(pricing.providers)) {
    const r = heuristicMatch(pricing.providers[p]?.models, model);
    if (r) return { rate: r, estimated: true };
  }

  // 5) Nothing matched — conservative mid-tier rate, flagged estimated.
  return { rate: pricing.fallbacks.unknown, estimated: true };
}

function per(tokens: number, rate: number | undefined): number {
  if (!tokens || !rate) return 0;
  return (tokens / 1_000_000) * rate;
}

export function computeCost(provider: Provider, model: string, usage: NormalizedUsage): CostBreakdown {
  const { rate, estimated } = rateFor(provider, model);

  // Cache-write rate: prefer the TTL-specific rate, else default to 1.25x input
  // (the standard Anthropic 5-minute write premium) so we never silently bill $0.
  const writeRate =
    usage.cacheWriteTtl === '1h'
      ? rate.cache_write_1h ?? rate.input * 2
      : rate.cache_write_5m ?? rate.input * 1.25;

  // Cache-read rate: default to 0.1x input if unspecified (Anthropic norm).
  const readRate = rate.cache_read ?? rate.input * 0.1;

  const components = {
    input: per(usage.inputTokens, rate.input),
    output: per(usage.outputTokens, rate.output),
    cacheWrite: per(usage.cacheWriteTokens, writeRate),
    cacheRead: per(usage.cacheReadTokens, readRate),
  };

  const costUsd =
    components.input + components.output + components.cacheWrite + components.cacheRead;

  return { costUsd, estimated, rate, components };
}
