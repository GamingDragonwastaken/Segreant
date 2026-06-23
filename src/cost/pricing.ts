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

/** Best-effort substring match for model families when the exact id is unknown. */
function heuristicMatch(provider: Provider, model: string): ModelRate | null {
  const table = loadPricing().providers[provider];
  if (!table) return null;
  const m = model.toLowerCase();
  // Prefer the longest matching key so "claude-opus-4-8" wins over "claude".
  const keys = Object.keys(table.models).sort((a, b) => b.length - a.length);
  for (const key of keys) {
    if (m.includes(key.toLowerCase())) return table.models[key]!;
  }
  return null;
}

export interface ResolvedRate {
  rate: ModelRate;
  estimated: boolean;
}

export function rateFor(provider: Provider, model: string): ResolvedRate {
  const pricing = loadPricing();
  const exact = pricing.providers[provider]?.models[model];
  if (exact) return { rate: exact, estimated: false };

  const heuristic = heuristicMatch(provider, model);
  if (heuristic) return { rate: heuristic, estimated: true };

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
