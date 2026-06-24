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

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PRICING_PATH = join(__dirname, '..', '..', 'pricing', 'models.json');

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

export function loadPricing(force = false): PricingFile {
  if (cached && !force) return cached;
  const raw = readFileSync(PRICING_PATH, 'utf8');
  cached = JSON.parse(raw) as PricingFile;
  return cached;
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

  // 2) Family (substring) match within the named provider.
  const family = heuristicMatch(here, model);
  if (family) return { rate: family, estimated: true };

  // 3) Exact id in ANY provider. An OpenAI-compatible endpoint can legitimately
  //    carry a non-OpenAI model — Gemini via Google's .../v1beta/openai/ base, a
  //    Claude model via OpenRouter — so the transport is OpenAI-shaped but the
  //    price follows the MODEL. An exact id match anywhere is an exact price, so
  //    `estimated` stays false; only the path differs, not the rate.
  for (const p of Object.keys(pricing.providers)) {
    const r = pricing.providers[p]?.models[model];
    if (r) return { rate: r, estimated: false };
  }

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
