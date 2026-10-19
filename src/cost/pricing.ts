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

import { readFileSync, statSync, writeFileSync, mkdirSync, existsSync, renameSync, unlinkSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { egressFetch, EgressError } from '../egress/transport.ts';
import { DEFAULT_PRICE_LIST_URL } from '../egress/policy.ts';
import { dirname, join } from 'node:path';
import { segreantHome } from '../config.ts';
import { computeExactCost, validateExactModelRate, type ExactCostBreakdown, type ExactModelRate } from './exactPricing.ts';
import { activePriceOverrides, priceOverrideFor, type PriceOverride } from './overrides.ts';
import { money } from '../economics/money.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));

/** The rate card shipped inside the package — always present, works offline. */
const BUNDLED_PRICING_PATH = join(__dirname, '..', '..', 'pricing', 'models.json');

/**
 * A user-writable copy under ~/.segreant/pricing/models.json that, when present
 * and structurally valid, OVERRIDES the bundled table. This is where
 * `segreant pricing --refresh` writes a freshly-pulled manifest, so prices can
 * be updated without reinstalling — pricing is a core dependability, and
 * provider rates drift.
 */
function cachePath(): string {
  return join(segreantHome(), 'pricing', 'models.json');
}

/** Sidecar for verifiable local cache provenance. It intentionally stores only
 * a redacted source identity, never a URL query string or credentials. */
function provenancePath(): string {
  return join(segreantHome(), 'pricing', 'provenance.json');
}

function archivePath(cardSha256: string): string {
  return join(segreantHome(), 'pricing', 'cards', `${cardSha256}.json`);
}

function archiveProvenancePath(cardSha256: string): string {
  return join(segreantHome(), 'pricing', 'cards', `${cardSha256}.provenance.json`);
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
  /** Optional canonical decimal companion used by the exact accounting path. */
  exact?: ExactModelRate;
}

interface PricingFile {
  schema_version: number;
  updated: string;
  currency: 'USD';
  unit: string;
  providers: Record<string, { verified: boolean; models: Record<string, ModelRate> }>;
  fallbacks: { unknown: ModelRate };
}

export type PricingSourceKind = 'manual' | 'native_manifest' | 'litellm_transformed';

/**
 * What kind of number a ledger row contains. These are evidence labels, not
 * billing states: Segreant does not receive provider invoices, discounts, taxes,
 * credits, or reconciliation data.
 */
export const COST_BASES = [
  'local_list_price',
  'fallback_estimate',
  'tool_reported_unverified',
  'synthetic_demo',
  'unpriced',
  'not_sent',
  'user_declared_price',
  'legacy_unknown',
] as const;
export type CostBasis = (typeof COST_BASES)[number];

/** Source of an attached rate-card hash. `none` is deliberately explicit for
 * tool-reported and unpriced rows, so a null hash is never mistaken for a lost
 * local rate card. */
export const RATE_CARD_SOURCE_KINDS = ['manual', 'native_manifest', 'litellm_transformed', 'bundled', 'legacy_unknown', 'none', 'user_declaration'] as const;
export type RateCardSourceKind = (typeof RATE_CARD_SOURCE_KINDS)[number];

/** How the observed model was resolved against a local rate card, if any. */
export const RATE_MATCH_KINDS = [
  'exact_provider',
  'exact_cross_provider',
  'family_provider',
  'family_cross_provider',
  'fallback',
  'reported',
  'unpriced',
  'not_sent',
  'user_declared',
  'user_declared_free',
  'legacy_unknown',
] as const;
export type RateMatchKind = (typeof RATE_MATCH_KINDS)[number];

/**
 * Request-level pricing lineage. It is captured at calculation time so a later
 * price-card refresh cannot reinterpret a historical ledger amount.
 */
export interface RequestPricingEvidence {
  costBasis: CostBasis;
  rateCardSha256: string | null;
  rateCardSourceKind: RateCardSourceKind;
  rateMatchKind: RateMatchKind;
  rateMatchProvider: string | null;
  rateMatchModel: string | null;
}

export interface PricingCardProvenance {
  schemaVersion: 1;
  /** Safe URL identity: origin + pathname only, without credentials/query/hash. */
  sourceUrl: string | null;
  /** Hash of the full fetch target, used only locally for conditional requests. */
  sourceUrlSha256: string | null;
  sourceKind: PricingSourceKind;
  /** When Segreant accepted this immutable card content. */
  fetchedAt: string;
  /** A declared native-manifest date, never inferred for a transformed feed. */
  upstreamDeclaredUpdated: string | null;
  /** SHA-256 of the normalized cached rate card. */
  cardSha256: string;
  modelCount: number;
  etag: string | null;
  lastModified: string | null;
}

interface PricingProvenance extends PricingCardProvenance {
  schemaVersion: 1;
  /** Last successful conditional or full check of this source. */
  lastCheckedAt: string;
}

export const MAX_PRICING_MANIFEST_BYTES = 5 * 1024 * 1024;

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
  /** TTL the cache write is priced at, if known. Affects the write rate. */
  cacheWriteTtl?: '5m' | '1h';
  /**
   * True when the source reported a 5-minute / 1-hour breakdown, so the
   * duration above is the one the request was priced with, which the ledger
   * keeps. False when it did not say: priced at the standard rate, recorded as
   * not recorded.
   */
  cacheWriteTtlObserved?: boolean;
  /** Reasoning tokens — reporting only, billed inside outputTokens. */
  reasoningTokens?: number;
}

export interface CostBreakdown {
  costUsd: number;
  /** True when no exact model rate matched and a fallback was used. */
  estimated: boolean;
  /** Rate-card and matching evidence for this calculation, never an invoice. */
  pricing: RequestPricingEvidence;
  rate: ModelRate;
  components: {
    input: number;
    output: number;
    cacheWrite: number;
    cacheRead: number;
  };
  /** Present only when the active rate card carries canonical decimal rates. */
  exact?: ExactCostBreakdown;
}

let cached: PricingFile | null = null;
let cachedSource: 'cache' | 'bundled' = 'bundled';

function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

// Every priced request carries its card's hash, and an import prices tens of
// thousands of them against one card. A loaded card is replaced, never mutated,
// when pricing is refreshed, so the hash is remembered per card object.
const cardHashes = new WeakMap<PricingFile, string>();

function pricingCardHash(file: PricingFile): string {
  let hash = cardHashes.get(file);
  if (hash === undefined) {
    hash = sha256(JSON.stringify(file));
    cardHashes.set(file, hash);
  }
  return hash;
}

function redactedUrl(raw: string): string | null {
  try {
    const url = new URL(raw);
    return `${url.protocol}//${url.host}${url.pathname}`;
  } catch {
    return null;
  }
}

function validTimestamp(value: unknown, allowFuture = false): value is string {
  if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) return false;
  return allowFuture || Date.parse(value) <= Date.now() + 86_400_000;
}

function validRate(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

/** Structural check before we trust a pricing table — a refresh must never let a
 *  truncated download or a wrong-shaped file silently corrupt every cost. */
function pricingValidationError(obj: unknown): string | null {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return 'manifest is not an object';
  const o = obj as Record<string, unknown>;
  if (o['schema_version'] !== 1) return 'unsupported schema_version (expected 1)';
  if (!validTimestamp(o['updated'])) return 'updated must be a valid non-future timestamp';
  if (o['currency'] !== 'USD') return 'currency must be USD';
  if (o['unit'] !== 'per_million_tokens') return 'unit must be per_million_tokens';
  const unknown = (o['fallbacks'] as { unknown?: unknown } | undefined)?.unknown;
  if (!unknown || typeof unknown !== 'object') return 'fallbacks.unknown is required';
  const unknownRate = unknown as Record<string, unknown>;
  if (!validRate(unknownRate['input']) || !validRate(unknownRate['output'])) return 'fallback rates must be finite positive numbers';
  const providers = o['providers'];
  if (!providers || typeof providers !== 'object' || Array.isArray(providers)) return 'providers must be an object';

  let modelCount = 0;
  for (const [provider, rawProvider] of Object.entries(providers as Record<string, unknown>)) {
    if (!provider || !rawProvider || typeof rawProvider !== 'object' || Array.isArray(rawProvider)) return 'each provider must be an object';
    const p = rawProvider as Record<string, unknown>;
    if (typeof p['verified'] !== 'boolean') return `provider ${provider} is missing boolean verified`;
    const models = p['models'];
    if (!models || typeof models !== 'object' || Array.isArray(models)) return `provider ${provider} is missing models`;
    for (const [model, rawRate] of Object.entries(models as Record<string, unknown>)) {
      if (!model || !rawRate || typeof rawRate !== 'object' || Array.isArray(rawRate)) return `provider ${provider} has an invalid model entry`;
      const rate = rawRate as Record<string, unknown>;
      if (!validRate(rate['input']) || !validRate(rate['output'])) return `model ${model} must have finite positive input/output rates`;
      for (const key of ['cache_write_5m', 'cache_write_1h', 'cache_read']) {
        if (rate[key] !== undefined && !validRate(rate[key])) return `model ${model} has an invalid ${key} rate`;
      }
      if (rate['exact'] !== undefined) {
        try {
          validateExactModelRate(rate['exact'] as ExactModelRate);
        } catch (error) {
          return `model ${model} has an invalid exact rate: ${error instanceof Error ? error.message : String(error)}`;
        }
      }
      modelCount += 1;
    }
  }
  return modelCount > 0 ? null : 'manifest contains no models';
}

function isValidPricing(obj: unknown): obj is PricingFile {
  return pricingValidationError(obj) === null;
}

function isValidProvenance(obj: unknown): obj is PricingProvenance {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return false;
  const p = obj as Record<string, unknown>;
  return (
    p['schemaVersion'] === 1 &&
    (p['sourceUrl'] === null || typeof p['sourceUrl'] === 'string') &&
    (p['sourceUrlSha256'] === null || typeof p['sourceUrlSha256'] === 'string') &&
    (p['sourceKind'] === 'manual' || p['sourceKind'] === 'native_manifest' || p['sourceKind'] === 'litellm_transformed') &&
    validTimestamp(p['fetchedAt']) &&
    validTimestamp(p['lastCheckedAt']) &&
    (p['upstreamDeclaredUpdated'] === null || validTimestamp(p['upstreamDeclaredUpdated'])) &&
    typeof p['cardSha256'] === 'string' &&
    typeof p['modelCount'] === 'number' && Number.isInteger(p['modelCount']) && p['modelCount'] > 0 &&
    (p['etag'] === null || typeof p['etag'] === 'string') &&
    (p['lastModified'] === null || typeof p['lastModified'] === 'string')
  );
}

function isSha256(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
}

function isValidCardProvenance(obj: unknown, expectedCardSha256: string): obj is PricingCardProvenance {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj) || !isSha256(expectedCardSha256)) return false;
  const p = obj as Record<string, unknown>;
  const keys = new Set([
    'schemaVersion', 'sourceUrl', 'sourceUrlSha256', 'sourceKind', 'fetchedAt',
    'upstreamDeclaredUpdated', 'cardSha256', 'modelCount', 'etag', 'lastModified',
  ]);
  if (Object.keys(p).some((key) => !keys.has(key))) return false;
  const sourceUrl = p['sourceUrl'];
  const sourceUrlSha256 = p['sourceUrlSha256'];
  return (
    p['schemaVersion'] === 1 &&
    p['cardSha256'] === expectedCardSha256 &&
    (sourceUrl === null || typeof sourceUrl === 'string') &&
    (sourceUrlSha256 === null || isSha256(sourceUrlSha256)) &&
    (sourceUrl !== null || sourceUrlSha256 === null) &&
    (p['sourceKind'] === 'manual' || p['sourceKind'] === 'native_manifest' || p['sourceKind'] === 'litellm_transformed') &&
    validTimestamp(p['fetchedAt']) &&
    (p['upstreamDeclaredUpdated'] === null || validTimestamp(p['upstreamDeclaredUpdated'])) &&
    typeof p['modelCount'] === 'number' && Number.isSafeInteger(p['modelCount']) && p['modelCount'] > 0 &&
    (p['etag'] === null || typeof p['etag'] === 'string') &&
    (p['lastModified'] === null || typeof p['lastModified'] === 'string')
  );
}

function readProvenance(): PricingProvenance | null {
  try {
    const value: unknown = JSON.parse(readFileSync(provenancePath(), 'utf8'));
    return isValidProvenance(value) ? value : null;
  } catch {
    return null;
  }
}

function readValidPricing(path: string): PricingFile | null {
  try {
    const obj: unknown = JSON.parse(readFileSync(path, 'utf8'));
    return isValidPricing(obj) ? obj : null;
  } catch {
    return null;
  }
}

function readCardProvenance(cardSha256: string): PricingCardProvenance | null {
  if (!isSha256(cardSha256)) return null;
  try {
    const value: unknown = JSON.parse(readFileSync(archiveProvenancePath(cardSha256), 'utf8'));
    if (!isValidCardProvenance(value, cardSha256)) return null;
    const archived = readValidPricing(archivePath(cardSha256));
    if (!archived || pricingCardHash(archived) !== cardSha256 || countModels(archived) !== value.modelCount) return null;
    return Object.freeze({ ...value });
  } catch {
    return null;
  }
}

/** Read immutable provenance for a hash-addressed archived pricing card. */
export function pricingCardProvenance(cardSha256: string): PricingCardProvenance | null {
  return readCardProvenance(cardSha256);
}

function countModels(file: PricingFile): number {
  return Object.values(file.providers).reduce((n, p) => n + Object.keys(p.models).length, 0);
}

type CacheIntegrity = 'verified' | 'legacy_unknown' | 'archive_recovered' | 'mismatch' | 'bundled';

let cachedProvenance: PricingProvenance | null = null;
let cachedIntegrity: CacheIntegrity = 'bundled';

function writeAtomically(path: string, text: string): void {
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(temporary, text, 'utf8');
  try {
    renameSync(temporary, path);
  } catch (error) {
    try { unlinkSync(temporary); } catch { /* best-effort cleanup */ }
    throw error;
  }
}

function loadVerifiedCache(): { file: PricingFile; provenance: PricingProvenance | null; integrity: CacheIntegrity } | null {
  const active = readValidPricing(cachePath());
  const provenance = readProvenance();
  if (!active) return null;
  if (!provenance) return { file: active, provenance: null, integrity: 'legacy_unknown' };
  if (pricingCardHash(active) === provenance.cardSha256) return { file: active, provenance, integrity: 'verified' };

  // A crash or interrupted external edit must not make a partial active file look
  // current. Recover only the immutable card whose hash the prior state names.
  const archived = readValidPricing(archivePath(provenance.cardSha256));
  if (archived && pricingCardHash(archived) === provenance.cardSha256) {
    return { file: archived, provenance, integrity: 'archive_recovered' };
  }
  return null;
}

/**
 * A refresh in another process (`segreant pricing --refresh`, or another
 * Segreant running alongside) replaces the card on disk without telling this
 * one, so a long-running proxy or dashboard kept pricing with the old card
 * until restart. At most once a second, loadPricing compares the card on disk
 * with the one it loaded and reloads when it changed.
 *
 * The comparison is by the card hash its provenance records (written last by
 * a refresh, so a refresh in progress or one that failed changes nothing),
 * plus the active file's size and timestamp for a card that has no provenance
 * record. Inside withPricingSnapshot the card is pinned, so one reprice plan
 * never mixes two cards.
 */
const FRESHNESS_INTERVAL_MS = 1000;
let loadedIdentity: string | null = null;
// A monotonic clock: a wall clock set back (a manual correction, a resumed VM)
// would otherwise hold the loaded card until wall time caught up (PR #154 review).
let lastFreshnessCheckMs = Number.NEGATIVE_INFINITY;
let pinnedDepth = 0;

function diskIdentity(): string {
  let file: [number, number] | null = null;
  try { const st = statSync(cachePath()); file = [st.size, st.mtimeMs]; } catch { /* no active card on disk */ }
  return JSON.stringify([segreantHome(), readProvenance()?.cardSha256 ?? null, file]);
}

/** Tests only: run the next freshness check now instead of waiting out the interval. */
export function resetPricingFreshnessForTests(): void {
  lastFreshnessCheckMs = Number.NEGATIVE_INFINITY;
}

export function loadPricing(force = false): PricingFile {
  if (cached && !force) {
    const now = performance.now();
    if (pinnedDepth > 0 || now - lastFreshnessCheckMs < FRESHNESS_INTERVAL_MS) return cached;
    lastFreshnessCheckMs = now;
    if (diskIdentity() === loadedIdentity) return cached;
  }
  // A running process, forced or not, switches only to a committed card: an
  // active card with no provenance that appears after startup is a refresh in
  // progress or one that failed, and the loaded card stands. A process that
  // started on a legacy card (no provenance) keeps following that file's edits.
  // A legacy card that first appears after startup is read at the next start
  // (PR #154 review).
  const runningOnLegacy = cachedSource === 'cache' && cachedProvenance === null;
  if (cached && !runningOnLegacy && existsSync(cachePath()) && readProvenance() === null) return cached;
  lastFreshnessCheckMs = performance.now();
  loadedIdentity = diskIdentity();
  // Prefer the refreshed cache when present AND structurally valid; otherwise
  // fall back to the bundled table. A corrupt cache degrades to bundled rather
  // than breaking pricing — and `pricingStatus()` always reports which won, so
  // the fallback is visible, never silent.
  const fromCache = loadVerifiedCache();
  if (fromCache) {
    cached = fromCache.file;
    cachedSource = 'cache';
    cachedProvenance = fromCache.provenance;
    cachedIntegrity = fromCache.integrity;
    return cached;
  }
  cached = JSON.parse(readFileSync(BUNDLED_PRICING_PATH, 'utf8')) as PricingFile;
  cachedSource = 'bundled';
  cachedProvenance = null;
  cachedIntegrity = existsSync(cachePath()) && readProvenance() !== null ? 'mismatch' : 'bundled';
  return cached;
}

/** One card's entry for exactly this model name. */
export interface CardEntry {
  provider: string;
  input: number;
  output: number;
  rate: ModelRate;
  card: PricingFile;
  /** Which card matched: the card this process prices with, or the verified card on disk. */
  source: 'loaded' | 'disk';
}

function entryIn(card: PricingFile, model: string, source: CardEntry['source']): CardEntry | null {
  for (const [provider, p] of Object.entries(card.providers)) {
    const rate = Object.hasOwn(p.models, model) ? p.models[model] : undefined;
    if (rate) return { provider, input: rate.input, output: rate.output, rate, card, source };
  }
  return null;
}

/**
 * For refusing `--free` when a price is declared: the card this process prices
 * with, or the verified card on disk (a refresh another process made). A
 * one-off user action, so it errs towards refusing; --force overrides it.
 */
export function cardEntryAnywhere(model: string): CardEntry | null {
  const loaded = entryIn(loadPricing(), model, 'loaded');
  if (loaded) return loaded;
  const verified = loadVerifiedCache();
  return verified ? entryIn(verified.file, model, 'disk') : null;
}

/**
 * For pricing a request: whether the card this process prices with lists this
 * model, so a free price that was not forced does not apply to it. The same
 * card every other price in this process uses, so a reprice plan cannot change
 * its mind midway; noticing a refresh another process made is the card
 * loader's job, for every model alike (PR #153 review).
 */
export function cardPricesModel(model: string): boolean {
  return entryIn(loadPricing(), model, 'loaded') !== null;
}

export interface RefreshResult {
  ok: boolean;
  updated?: string;
  modelCount?: number;
  sourceUrl?: string | null;
  sourceKind?: PricingSourceKind;
  fetchedAt?: string;
  cardSha256?: string;
  unchanged?: boolean;
  error?: string;
  /** Stable distinction between a Segreant boundary refusal and an ordinary fetch failure. */
  failureCode?: PricingRefreshFailureCode;
}

export type PricingRefreshFailureCode =
  | 'egress_policy_denied'
  | 'egress_dns_denied'
  | 'egress_receipt_integrity_failed'
  | 'egress_receipt_persistence_failed'
  | 'egress_transport_failed'
  | 'network_error';

/**
 * The default live pricing source: LiteLLM's community-maintained price file.
 * Hundreds of contributors update it within days of every model release, so
 * consuming this machine-readable feed keeps the rate card current without
 * scraping provider pricing pages (brittle HTML that needs a parser which
 * itself rots). The GET fetches a public file and sends nothing about the user.
 */
export const DEFAULT_MANIFEST_URL = DEFAULT_PRICE_LIST_URL;

/**
 * First-party model makers, mapped onto our table's provider keys. Hosts and
 * resellers are excluded: their rates price the host's route, which a bare
 * model name cannot identify.
 */
const LITELLM_PROVIDER_MAP: Record<string, string> = {
  anthropic: 'anthropic',
  openai: 'openai',
  gemini: 'google',
  cohere_chat: 'cohere',
  dashscope: 'dashscope',
  deepseek: 'deepseek',
  mistral: 'mistral',
  perplexity: 'perplexity',
  xai: 'xai',
  zai: 'zai',
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

/** A per-1M rate as a plain decimal string, never exponent notation (1e-7 is "0.0000001"). */
function plainDecimal(n: number): string {
  const s = String(n);
  if (!/e/i.test(s)) return s;
  return n.toFixed(20).replace(/0+$/, '').replace(/\.$/, '');
}

/** Per-token → per-1M, trimmed of float noise (3e-6/token → 3 $/1M exactly). */
function perMillion(perToken: number): number {
  return Number((perToken * 1e6).toPrecision(10));
}

/**
 * Convert a LiteLLM price file into our manifest schema. Pure and total: bad
 * input yields `{ ok: false }`, never a throw. Only chat-capable entries from
 * first-party makers are carried; `verified` is false because the rates are
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
    // The decimal companion, so a model learned from the feed reprices to an
    // exact amount: without it `reprice --apply` refused a first-sight model
    // that had been recorded against the bundled card's exact fallback (PR #146 review).
    const exact: { input: string; output: string; cache_write_5m?: string; cache_read?: string } = {
      input: plainDecimal(rate.input),
      output: plainDecimal(rate.output),
    };
    if (rate.cache_write_5m !== undefined) exact.cache_write_5m = plainDecimal(rate.cache_write_5m);
    if (rate.cache_read !== undefined) exact.cache_read = plainDecimal(rate.cache_read);
    rate.exact = exact;
    bucket.models[name] = rate;
  }

  const total = Object.values(providers).reduce((n, p) => n + Object.keys(p.models).length, 0);
  if (total < MIN_TRANSFORMED_MODELS) {
    return { ok: false, error: `feed shape not recognized (only ${total} usable models found) — keeping the current table` };
  }

  // Cross-provider lookups use insertion order: keep the big three ahead of
  // other makers on name collisions, regardless of the upstream key order.
  const primaryProviders = ['anthropic', 'openai', 'google'];
  const providerOrder = [
    ...primaryProviders,
    ...Object.keys(providers).filter((provider) => !primaryProviders.includes(provider)).sort(),
  ];
  const file: PricingFile = {
    schema_version: 1,
    updated: new Date().toISOString().slice(0, 10),
    currency: 'USD',
    unit: 'per_million_tokens',
    providers: Object.fromEntries(providerOrder
      .filter((provider) => providers[provider] !== undefined)
      .map((provider) => [provider, providers[provider]!])),
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
interface ApplyPricingOptions {
  sourceUrl?: string | null;
  sourceKind?: PricingSourceKind;
  fetchedAt?: string;
  etag?: string | null;
  lastModified?: string | null;
}

/** Apply a local or fetched card after complete validation and archive it under
 * its normalized-card hash. Historical request rows are never changed here. */
export function applyPricingManifest(rawText: string, options: ApplyPricingOptions = {}): RefreshResult {
  if (Buffer.byteLength(rawText, 'utf8') > MAX_PRICING_MANIFEST_BYTES) {
    return { ok: false, error: `manifest exceeds ${MAX_PRICING_MANIFEST_BYTES} byte limit` };
  }
  let obj: unknown;
  try {
    obj = JSON.parse(rawText);
  } catch (e) {
    return { ok: false, error: `not valid JSON: ${String(e)}` };
  }

  let file: PricingFile;
  let sourceKind = options.sourceKind ?? 'manual';
  if (isValidPricing(obj)) {
    file = obj;
  } else if (obj && typeof obj === 'object' && !Array.isArray(obj) && 'schema_version' in obj) {
    return { ok: false, error: pricingValidationError(obj) ?? 'manifest failed validation' };
  } else {
    const transformed = transformLiteLLMManifest(rawText);
    if (!transformed.ok || !transformed.file || !isValidPricing(transformed.file)) {
      return { ok: false, error: transformed.error ?? 'manifest failed validation' };
    }
    file = transformed.file;
    sourceKind = 'litellm_transformed';
  }

  const fetchedAt = options.fetchedAt ?? new Date().toISOString();
  const cardSha256 = pricingCardHash(file);
  const sourceUrl = options.sourceUrl ?? null;
  const provenance: PricingProvenance = {
    schemaVersion: 1,
    sourceUrl: sourceUrl === null ? null : redactedUrl(sourceUrl),
    sourceUrlSha256: sourceUrl === null ? null : sha256(sourceUrl),
    sourceKind,
    fetchedAt,
    lastCheckedAt: fetchedAt,
    upstreamDeclaredUpdated: sourceKind === 'litellm_transformed' ? null : file.updated,
    cardSha256,
    modelCount: countModels(file),
    etag: options.etag ?? null,
    lastModified: options.lastModified ?? null,
  };

  // A failed activation leaves the active card as it found it: the card it
  // replaced is put back, or removed if there was none. Without that, a first
  // activation or one over a legacy card (neither has provenance to recover
  // from) would leave a card that was never committed for the next load.
  let priorActiveText: string | null = null;
  try { priorActiveText = readFileSync(cachePath(), 'utf8'); } catch { /* no active card */ }
  const priorProvenanceSha = readProvenance()?.cardSha256 ?? null;
  try {
    const dir = join(segreantHome(), 'pricing');
    const archiveDir = join(dir, 'cards');
    if (!existsSync(archiveDir)) mkdirSync(archiveDir, { recursive: true });
    const cardText = JSON.stringify(file, null, 2) + '\n';
    const archivedCardPath = archivePath(cardSha256);
    const archivedCardExists = existsSync(archivedCardPath);
    if (archivedCardExists) {
      const archived = readValidPricing(archivedCardPath);
      if (!archived || pricingCardHash(archived) !== cardSha256) {
        return { ok: false, error: 'existing pricing-card archive failed integrity; refusing overwrite' };
      }
    }
    // Archive first: a later interrupted active-cache write still has a named,
    // immutable last-valid card. All files are individually temp+rename writes.
    if (!archivedCardExists) {
      writeAtomically(archivedCardPath, cardText);
      const cardProvenance: PricingCardProvenance = {
        schemaVersion: 1,
        sourceUrl: provenance.sourceUrl,
        sourceUrlSha256: provenance.sourceUrlSha256,
        sourceKind: provenance.sourceKind,
        fetchedAt: provenance.fetchedAt,
        upstreamDeclaredUpdated: provenance.upstreamDeclaredUpdated,
        cardSha256: provenance.cardSha256,
        modelCount: provenance.modelCount,
        etag: provenance.etag,
        lastModified: provenance.lastModified,
      };
      writeAtomically(archiveProvenancePath(cardSha256), JSON.stringify(cardProvenance, null, 2) + '\n');
    }
    writeAtomically(cachePath(), cardText);
    writeAtomically(provenancePath(), JSON.stringify(provenance, null, 2) + '\n');
  } catch (e) {
    // Only this attempt's own uncommitted card is rolled back, and only while
    // no other provenance has been committed: another process may have
    // committed its card meanwhile (PR #154 review).
    const active = readValidPricing(cachePath());
    if ((readProvenance()?.cardSha256 ?? null) === priorProvenanceSha && active && pricingCardHash(active) === cardSha256) {
      try {
        if (priorActiveText === null) unlinkSync(cachePath());
        else writeAtomically(cachePath(), priorActiveText);
      } catch { /* the next load reports what it finds */ }
    }
    return { ok: false, error: `could not write verified pricing cache: ${String(e)}` };
  }
  cached = null;
  return {
    ok: true,
    updated: file.updated,
    modelCount: provenance.modelCount,
    sourceUrl: provenance.sourceUrl,
    sourceKind,
    fetchedAt,
    cardSha256,
  };
}

/**
 * Pull a fresh pricing manifest and apply it. `url` null → the default feed.
 * Sends ONLY a GET for a public pricing file — no prompts, no usage, nothing
 * about the user — so it preserves the zero-content-egress invariant. Degrades
 * gracefully: any network or HTTP error returns `{ ok: false }` and keeps the
 * current table.
 */
function safeRemoteTarget(raw: string): { url?: URL; error?: string } {
  try {
    const url = new URL(raw);
    if (url.protocol !== 'https:') return { error: 'pricing refresh requires an https URL' };
    if (url.username || url.password) return { error: 'pricing refresh refuses URLs with embedded credentials' };
    return { url };
  } catch {
    return { error: 'pricing refresh requires an absolute https URL' };
  }
}

async function readPricingResponse(res: Response): Promise<string> {
  const declaredLength = res.headers.get('content-length');
  if (declaredLength !== null && Number(declaredLength) > MAX_PRICING_MANIFEST_BYTES) {
    throw new Error(`manifest exceeds ${MAX_PRICING_MANIFEST_BYTES} byte limit`);
  }
  if (!res.body) return '';
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      total += next.value.byteLength;
      if (total > MAX_PRICING_MANIFEST_BYTES) throw new Error(`manifest exceeds ${MAX_PRICING_MANIFEST_BYTES} byte limit`);
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

type PricingRefreshTransport = (url: URL, init: Parameters<typeof egressFetch>[1]) => Promise<Response>;

function pricingFailureCode(error: unknown): PricingRefreshFailureCode {
  if (error instanceof EgressError) return `egress_${error.code}` as PricingRefreshFailureCode;
  return 'network_error';
}

function pricingFailureMessage(error: unknown, failureCode: PricingRefreshFailureCode): string {
  const boundary = failureCode.startsWith('egress_');
  const repair = failureCode === 'egress_receipt_integrity_failed' || failureCode === 'egress_receipt_persistence_failed'
    ? '; repair/restore the local receipt history before retrying'
    : '';
  return boundary
    ? `Segreant egress boundary refused the pricing refresh (${failureCode.slice('egress_'.length)}): ${String(error)}${repair}`
    : `fetch failed: ${String(error)}`;
}

async function refreshPricingWithTransport(
  url: string | null,
  timeoutMs: number,
  transport: PricingRefreshTransport,
): Promise<RefreshResult> {
  const target = url ?? DEFAULT_MANIFEST_URL;
  const parsed = safeRemoteTarget(target);
  if (!parsed.url) return { ok: false, error: parsed.error, failureCode: 'network_error' };

  const prior = readProvenance();
  const sameSource = prior?.sourceUrlSha256 === sha256(target);
  const headers: Record<string, string> = { accept: 'application/json' };
  if (sameSource && prior?.etag) headers['if-none-match'] = prior.etag;
  if (sameSource && prior?.lastModified) headers['if-modified-since'] = prior.lastModified;
  try {
    const res = await transport(parsed.url, {
      purpose: 'pricing_refresh',
      dataClass: 'pricing_manifest',
      signal: AbortSignal.timeout(timeoutMs),
      stallTimeoutMs: 20_000,
      headers,
    });
    if (res.status === 304) {
      const active = loadVerifiedCache();
      if (!prior || !sameSource || !active || (active.integrity !== 'verified' && active.integrity !== 'archive_recovered') || active.provenance?.cardSha256 !== prior.cardSha256) {
        return { ok: false, error: 'source returned 304 but no matching verified local card exists', failureCode: 'network_error' };
      }
      const checkedAt = new Date().toISOString();
      const checked: PricingProvenance = { ...prior, lastCheckedAt: checkedAt };
      try {
        writeAtomically(provenancePath(), JSON.stringify(checked, null, 2) + '\n');
        cached = null;
      } catch (e) {
        return { ok: false, error: `could not record successful pricing check: ${String(e)}`, failureCode: 'network_error' };
      }
      return {
        ok: true,
        unchanged: true,
        updated: active.file.updated,
        modelCount: prior.modelCount,
        sourceUrl: prior.sourceUrl,
        sourceKind: prior.sourceKind,
        fetchedAt: prior.fetchedAt,
        cardSha256: prior.cardSha256,
      };
    }
    if (!res.ok) return { ok: false, error: `HTTP ${res.status} from ${redactedUrl(target) ?? 'pricing source'}`, failureCode: 'network_error' };
    const body = await readPricingResponse(res);
    return applyPricingManifest(body, {
      sourceUrl: target,
      sourceKind: 'native_manifest',
      fetchedAt: new Date().toISOString(),
      etag: res.headers.get('etag'),
      lastModified: res.headers.get('last-modified'),
    });
  } catch (e) {
    const failureCode = pricingFailureCode(e);
    return { ok: false, error: pricingFailureMessage(e, failureCode), failureCode };
  }
}

/**
 * Pull a fresh pricing manifest only from a secure explicit/default endpoint.
 * Conditional requests identify an unchanged *local card*; they never claim a
 * provider invoice or silently mutate historical measured rows.
 */
export async function refreshPricing(url: string | null, timeoutMs = 20_000): Promise<RefreshResult> {
  return refreshPricingWithTransport(url, timeoutMs, egressFetch);
}

/**
 * Network-free response fixture seam. Production refreshes have no public
 * transport override and always use egressFetch, so parser tests cannot bypass
 * policy, DNS validation, pinning, redirect refusal, or receipt validation.
 */
export async function refreshPricingFromResponses(input: {
  url: string | null;
  responses: readonly Response[];
  timeoutMs?: number;
  /** Optional read-only assertion hook for request-shape tests; it cannot provide a transport. */
  onRequest?: (url: URL, init: Parameters<typeof egressFetch>[1]) => void;
}): Promise<RefreshResult> {
  let index = 0;
  return refreshPricingWithTransport(input.url, input.timeoutMs ?? 20_000, async (url, init) => {
    input.onRequest?.(url, init);
    const response = input.responses[index++];
    if (!response) throw new Error('fixture_response_sequence_exhausted');
    return response;
  });
}

export interface PricingStatus {
  source: 'cache' | 'bundled';
  /** Declared rate-card date (not necessarily the time Segreant retrieved it). */
  updated: string;
  ageDays: number | null;
  stale: boolean;
  modelCount: number;
  providers: string[];
  cacheIntegrity: CacheIntegrity;
  /** The clock used for freshness: accepted-cache time when verified, otherwise declared card date. */
  freshnessBasis: 'local_fetch' | 'declared_card_date';
  fetchedAt: string | null;
  lastCheckedAt: string | null;
  upstreamDeclaredUpdated: string | null;
  sourceUrl: string | null;
  sourceKind: PricingSourceKind | 'bundled' | 'legacy_unknown';
  cardSha256: string;
  /** Immutable provenance sidecar for the active hash-addressed card, if present. */
  cardProvenance: PricingCardProvenance | null;
}

/** Where the active table came from, how old it is, and whether it's stale. */
export function pricingStatus(maxAgeDays = 30): PricingStatus {
  const file = loadPricing(true); // fresh read so `source` reflects current disk
  const updated = file.updated ?? 'unknown';
  const provenance = cachedProvenance;
  const verified = cachedSource === 'cache' && (cachedIntegrity === 'verified' || cachedIntegrity === 'archive_recovered') && provenance !== null;
  const freshnessAt = verified ? provenance.fetchedAt : updated;
  const t = Date.parse(freshnessAt);
  const ageDays = Number.isNaN(t) ? null : Math.floor((Date.now() - t) / 86_400_000);
  return {
    source: cachedSource,
    updated,
    ageDays,
    stale: ageDays === null || ageDays < 0 || ageDays > maxAgeDays,
    modelCount: countModels(file),
    providers: Object.keys(file.providers),
    cacheIntegrity: cachedIntegrity,
    freshnessBasis: verified ? 'local_fetch' : 'declared_card_date',
    fetchedAt: cachedProvenance?.fetchedAt ?? null,
    lastCheckedAt: cachedProvenance?.lastCheckedAt ?? null,
    upstreamDeclaredUpdated: cachedProvenance?.upstreamDeclaredUpdated ?? (cachedSource === 'bundled' ? updated : null),
    sourceUrl: cachedProvenance?.sourceUrl ?? null,
    sourceKind: cachedSource === 'bundled' ? 'bundled' : cachedProvenance?.sourceKind ?? 'legacy_unknown',
    cardSha256: pricingCardHash(file),
    cardProvenance: verified && provenance !== null ? readCardProvenance(provenance.cardSha256) : null,
  };
}

/**
 * Best-effort substring match for model families within one provider's table.
 * Prefers the longest matching key so "gemini-2.5-flash-lite" wins over
 * "gemini-2.5-flash", and "claude-opus-4-8" wins over a bare "claude".
 */
function heuristicMatch(models: Record<string, ModelRate> | undefined, model: string): { model: string; rate: ModelRate } | null {
  if (!models) return null;
  const m = model.toLowerCase();
  const keys = Object.keys(models).sort((a, b) => b.length - a.length);
  for (const key of keys) {
    if (m.includes(key.toLowerCase())) return { model: key, rate: models[key]! };
  }
  return null;
}

export interface ResolvedRate {
  rate: ModelRate;
  estimated: boolean;
  pricing: RequestPricingEvidence;
}

function activeRateCardSourceKind(): Exclude<RateCardSourceKind, 'none'> {
  return cachedSource === 'bundled' ? 'bundled' : cachedProvenance?.sourceKind ?? 'legacy_unknown';
}

function resolved(
  rate: ModelRate,
  rateMatchKind: Extract<RateMatchKind, 'exact_provider' | 'exact_cross_provider' | 'family_provider' | 'family_cross_provider' | 'fallback' | 'user_declared' | 'user_declared_free'>,
  rateMatchProvider: string | null,
  rateMatchModel: string | null,
  declarationSha256: string | null = null,
): ResolvedRate {
  // rateFor always loads the active card first, so the card identity and source
  // describe this exact local computation rather than a later refresh.
  const card = loadPricing();
  const declared = rateMatchKind === 'user_declared' || rateMatchKind === 'user_declared_free';
  // A rate or free declaration is priced by the declaration alone: stamping it
  // with the active card's hash made a card refresh look like a price change
  // for requests whose price had not moved (PR #146 review). Only `like`
  // depends on the card, and it names the card model it follows.
  const fromCard = !declared || rateMatchProvider !== null;
  return {
    rate,
    // A declared price is resolved, not guessed: it is the price the user said
    // this model costs. It keeps its own basis so it is never shown as list price.
    estimated: rateMatchKind !== 'exact_provider' && rateMatchKind !== 'exact_cross_provider' && !declared,
    pricing: {
      costBasis: rateMatchKind === 'fallback' ? 'fallback_estimate' : declared ? 'user_declared_price' : 'local_list_price',
      // A rate or free declaration carries a revision of the declaration itself,
      // labelled as the user's, never the card's: a changed price is then a new
      // revision that value comparisons see, and a card refresh is not
      // (PR #146 review).
      rateCardSha256: fromCard ? pricingCardHash(card) : declarationSha256,
      rateCardSourceKind: fromCard ? activeRateCardSourceKind() : declarationSha256 ? 'user_declaration' : 'none',
      rateMatchKind,
      rateMatchProvider,
      rateMatchModel,
    },
  };
}

/** Use when a connected tool supplies a nonzero amount that Segreant did not calculate. */
export function toolReportedPricingEvidence(): RequestPricingEvidence {
  return {
    costBasis: 'tool_reported_unverified',
    rateCardSha256: null,
    rateCardSourceKind: 'none',
    rateMatchKind: 'reported',
    rateMatchProvider: null,
    rateMatchModel: null,
  };
}

/** Use for a zero-cost audit event where no provider response was priced. */
export function unpricedPricingEvidence(): RequestPricingEvidence {
  return {
    costBasis: 'unpriced',
    rateCardSha256: null,
    rateCardSourceKind: 'none',
    rateMatchKind: 'unpriced',
    rateMatchProvider: null,
    rateMatchModel: null,
  };
}

/**
 * A request Segreant refused before it reached the provider (a budget block, an
 * egress refusal). Its cost is not unknown: nothing was sent, so nothing was
 * charged. Recording it as `unpriced` made every cap refusal read as a missing
 * price ("1 of 835 requests in this window are unpriced").
 */
export function notSentPricingEvidence(): RequestPricingEvidence {
  return {
    costBasis: 'not_sent',
    rateCardSha256: null,
    rateCardSourceKind: 'none',
    rateMatchKind: 'not_sent',
    rateMatchProvider: null,
    rateMatchModel: null,
  };
}

/** The only default for records created before per-request pricing lineage existed. */
export function legacyPricingEvidence(): RequestPricingEvidence {
  return {
    costBasis: 'legacy_unknown',
    rateCardSha256: null,
    rateCardSourceKind: 'legacy_unknown',
    rateMatchKind: 'legacy_unknown',
    rateMatchProvider: null,
    rateMatchModel: null,
  };
}

/** Preserve the rate-card details used by a synthetic demo while keeping it unmistakably synthetic. */
export function syntheticPricingEvidence(cost: CostBreakdown): RequestPricingEvidence {
  return { ...cost.pricing, costBasis: 'synthetic_demo' };
}

/** The rate-card rate a `like` declaration points at: exact matches only, never another guess. */
function exactCardRate(pricing: PricingFile, model: string): { provider: string; rate: ModelRate } | null {
  for (const p of Object.keys(pricing.providers)) {
    const r = pricing.providers[p]?.models[model];
    if (r) return { provider: p, rate: r };
  }
  return null;
}

/** USD per 1M tokens as a decimal string, back to the card's number form. */
function declaredRate(o: Extract<PriceOverride, { kind: 'rate' }>): ModelRate {
  const exact: ExactModelRate = {
    input: o.input,
    output: o.output,
    ...(o.cacheRead === undefined ? {} : { cache_read: o.cacheRead }),
    // cacheWrite prices both TTLs unless cacheWrite1h names the 1-hour price
    // (the engine and the usage record already tell the two apart).
    ...(o.cacheWrite === undefined ? {} : { cache_write_5m: o.cacheWrite, cache_write_1h: o.cacheWrite }),
    ...(o.cacheWrite1h === undefined ? {} : { cache_write_1h: o.cacheWrite1h }),
  };
  return {
    input: Number(o.input),
    output: Number(o.output),
    ...(o.cacheRead === undefined ? {} : { cache_read: Number(o.cacheRead) }),
    ...(o.cacheWrite === undefined ? {} : { cache_write_5m: Number(o.cacheWrite), cache_write_1h: Number(o.cacheWrite) }),
    ...(o.cacheWrite1h === undefined ? {} : { cache_write_1h: Number(o.cacheWrite1h) }),
    exact,
  };
}

/** A stable revision of what was declared (the prices, not when): the same price declared again is the same revision. */
function declarationRevision(o: PriceOverride): string {
  const { declaredAt: _when, ...price } = o;
  const canonical = JSON.stringify(Object.keys(price).sort().map((k) => [k, (price as Record<string, unknown>)[k]]));
  return createHash('sha256').update('segreant-declaration:v1\n' + canonical).digest('hex');
}

/** The rate with decimal companions for any it lacks, written from its own numbers. */
function withExactCompanion(rate: ModelRate): ModelRate {
  if (rate.exact !== undefined) return rate;
  const exact: { input: string; output: string; cache_write_5m?: string; cache_write_1h?: string; cache_read?: string } = {
    input: plainDecimal(rate.input),
    output: plainDecimal(rate.output),
  };
  if (rate.cache_write_5m !== undefined) exact.cache_write_5m = plainDecimal(rate.cache_write_5m);
  if (rate.cache_write_1h !== undefined) exact.cache_write_1h = plainDecimal(rate.cache_write_1h);
  if (rate.cache_read !== undefined) exact.cache_read = plainDecimal(rate.cache_read);
  return { ...rate, exact };
}

/** A free (local) model: every rate is zero, cache rates included. */
/** Where rateFor reads declarations; null reads the file (re-read when it changes). */
let declarationSource: ((model: string) => PriceOverride | null) | null = null;

function withDeclarationSource<T>(source: (model: string) => PriceOverride | null, fn: () => T): T {
  const previous = declarationSource;
  declarationSource = source;
  try {
    return fn();
  } finally {
    declarationSource = previous;
  }
}

/**
 * Run `fn` pricing from the card alone. The demo is fixed sample data: a real
 * declaration (say, gpt-4o marked free) must not change its spend, evidence or
 * comparisons (PR #146 review).
 */
export function withoutDeclaredPrices<T>(fn: () => T): T {
  return withDeclarationSource(() => null, fn);
}

/**
 * Run `fn` against one read of the declarations. A plan priced row by row
 * re-read the file at each row, so a `pricing set` from another process midway
 * gave earlier and later rows of the same model different prices in one
 * correction (PR #146 review). The card is pinned for the same span, since a
 * refresh in another process is now picked up by a running one (loadPricing).
 */
/** Run `fn` against declarations read earlier (a proxied request keeps the ones it was checked against). */
export function withDeclarations<T>(models: Record<string, PriceOverride>, fn: () => T): T {
  return withDeclarationSource((model) => models[model] ?? null, fn);
}

export function withPricingSnapshot<T>(fn: () => T): T {
  // The card is pinned for the whole plan as well: a refresh in another
  // process is picked up after it, never midway (see loadPricing).
  loadPricing();
  pinnedDepth++;
  try {
    if (declarationSource !== null) return fn();
    const models = activePriceOverrides();
    return withDeclarationSource((model) => models[model] ?? null, fn);
  } finally {
    pinnedDepth--;
  }
}

const FREE_RATE: ModelRate = Object.freeze({ input: 0, output: 0, cache_read: 0, cache_write_5m: 0, cache_write_1h: 0 }) as ModelRate;

export function rateFor(provider: Provider, model: string): ResolvedRate {
  // One resolution reads one card: the card is pinned for the whole lookup, so a
  // refresh that lands midway cannot price the free check, the rate and its
  // evidence from two different cards (PR #154 review).
  const pricing = loadPricing();
  pinnedDepth++;
  try {
    return rateFromCard(pricing, provider, model);
  } finally {
    pinnedDepth--;
  }
}

function rateFromCard(pricing: PricingFile, provider: Provider, model: string): ResolvedRate {
  const here = pricing.providers[provider]?.models;

  // 0) A price the user declared for this exact model name wins: it is the one
  //    place a private, fine-tuned or local model can get a real price. A `like`
  //    that no longer resolves exactly on the card is ignored, so the request
  //    falls to the ordinary ladder rather than to a guess built on a guess.
  const declared = declarationSource ? declarationSource(model) : priceOverrideFor(model);
  // A free price counts a model as $0. Unless it was forced, it never applies
  // to a model the card this process prices with lists: that card's price
  // counts instead, whenever the free price was declared (PR #153 review).
  if (declared?.kind === 'free' && (declared.force === true || !cardPricesModel(model))) {
    return resolved(FREE_RATE, 'user_declared_free', null, model, declarationRevision(declared));
  }
  if (declared?.kind === 'rate') return resolved(declaredRate(declared), 'user_declared', null, model, declarationRevision(declared));
  if (declared?.kind === 'like') {
    const target = exactCardRate(pricing, declared.like);
    // A card entry without decimal companions (a hand-written manifest may omit
    // them) would leave a reprice with no exact replacement and roll it back
    // (PR #146 review); the companion is the card's own stated numbers.
    if (target) return resolved(withExactCompanion(target.rate), 'user_declared', target.provider, declared.like);
  }

  // 1) Exact id in the named provider — the price we're surest about.
  const exact = here?.[model];
  if (exact) return resolved(exact, 'exact_provider', provider, model);

  // 2) Exact id in ANY provider — an EXACT price always beats a fuzzy family
  //    guess, so this is tried before any substring match. An OpenAI-compatible
  //    endpoint can legitimately carry a non-OpenAI model (Gemini via Google's
  //    .../v1beta/openai/ base, a Claude model via OpenRouter): the transport is
  //    OpenAI-shaped but the price follows the MODEL. Exact anywhere ⟹ exact rate,
  //    so `estimated` stays false; only the path differed, not the rate.
  for (const p of Object.keys(pricing.providers)) {
    const r = pricing.providers[p]?.models[model];
    if (r) return resolved(r, 'exact_cross_provider', p, model);
  }

  // 3) Family (substring) match within the named provider.
  const family = heuristicMatch(here, model);
  if (family) return resolved(family.rate, 'family_provider', provider, family.model);

  // 4) Family match in ANY provider (e.g. a dated gemini id on the OpenAI path).
  for (const p of Object.keys(pricing.providers)) {
    const r = heuristicMatch(pricing.providers[p]?.models, model);
    if (r) return resolved(r.rate, 'family_cross_provider', p, r.model);
  }

  // 5) Nothing matched — conservative mid-tier rate, flagged estimated.
  return resolved(pricing.fallbacks.unknown, 'fallback', null, null);
}

/** Return the explicit decimal companion, if this rate card provides one. */
export function exactRateFromModelRate(rate: ModelRate): ExactModelRate | null {
  return rate.exact === undefined ? null : validateExactModelRate(rate.exact);
}

function zeroExactCost(): ExactCostBreakdown {
  const zero = money('0', 'USD', 'estimated');
  return Object.freeze({ total: zero, components: Object.freeze({ input: zero, output: zero, cacheWrite: zero, cacheRead: zero }) });
}

function per(tokens: number, rate: number | undefined): number {
  if (!tokens || !rate) return 0;
  return (tokens / 1_000_000) * rate;
}

/**
 * The duration a cache write is priced at, and whether the source reported a
 * breakdown. No breakdown: no duration (priced at the standard 5-minute rate,
 * recorded as not recorded). One duration only: that one. Both: the larger
 * share, which is what the request is priced with, and the ledger records it
 * so a later reprice prices it the same way (PR #150 review). A missing
 * breakdown used to be stored as '1h' by the Claude Code import and '5m' by
 * the proxy, each as if it were seen (independent review, 2026-10-18).
 */
export function cacheWriteDuration(ephemeral5m: number, ephemeral1h: number): { ttl?: '5m' | '1h'; observed: boolean } {
  if (ephemeral5m <= 0 && ephemeral1h <= 0) return { observed: false };
  return { ttl: ephemeral1h > ephemeral5m ? '1h' : '5m', observed: true };
}

export function computeCost(provider: Provider, model: string, usage: NormalizedUsage): CostBreakdown {
  const { rate, estimated, pricing } = rateFor(provider, model);

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

  const declared = pricing.rateMatchKind === 'user_declared' || pricing.rateMatchKind === 'user_declared_free';
  const exactRate = rate === FREE_RATE ? null : exactRateFromModelRate(rate);
  const exact = rate === FREE_RATE
    ? zeroExactCost()
    : exactRate === null
      ? undefined
      : computeExactCost(exactRate, usage, estimated || declared ? 'estimated' : 'list');
  return { costUsd, estimated, pricing, rate, components, ...(exact === undefined ? {} : { exact }) };
}
