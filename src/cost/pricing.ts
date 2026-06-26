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
 * `aegisflow pricing --refresh` writes a freshly-pulled manifest, so prices can
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
 * Validate a pricing manifest (raw JSON text) and, if it passes, write it to the
 * local cache so it overrides the bundled table. Network-free, so it is
 * unit-testable on its own; `refreshPricing` adds the fetch around it. On any
 * failure the existing cache is left untouched — a bad refresh never downgrades
 * you to worse pricing data.
 */
export function applyPricingManifest(rawText: string): RefreshResult {
  let obj: unknown;
  try {
    obj = JSON.parse(rawText);
  } catch (e) {
    return { ok: false, error: `not valid JSON: ${String(e)}` };
  }
  if (!isValidPricing(obj)) {
    return { ok: false, error: 'manifest failed shape check (schema_version / providers / fallbacks.unknown)' };
  }
  try {
    const dir = join(aegisHome(), 'pricing');
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(cachePath(), JSON.stringify(obj, null, 2) + '\n', 'utf8');
  } catch (e) {
    return { ok: false, error: `could not write cache: ${String(e)}` };
  }
  cached = null; // invalidate the memo so the next load picks up the new table
  return { ok: true, updated: obj.updated, modelCount: countModels(obj) };
}

/**
 * Pull a fresh pricing manifest from `url` and apply it. Sends ONLY a GET for a
 * public pricing file — no prompts, no usage, nothing about the user — so it
 * preserves the zero-content-egress invariant. Degrades gracefully: any network
 * or HTTP error returns `{ ok: false }` and keeps the current table.
 */
export async function refreshPricing(url: string | null, timeoutMs = 8000): Promise<RefreshResult> {
  if (!url) return { ok: false, error: 'no pricing.manifestUrl configured' };
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), headers: { accept: 'application/json' } });
    if (!res.ok) return { ok: false, error: `HTTP ${res.status} from ${url}` };
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
