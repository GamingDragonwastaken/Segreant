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

import { readFileSync, writeFileSync, mkdirSync, existsSync, renameSync, unlinkSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { egressFetch, EgressError } from '../egress/transport.ts';
import { dirname, join } from 'node:path';
import { fiscusHome } from '../config.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));

/** The rate card shipped inside the package — always present, works offline. */
const BUNDLED_PRICING_PATH = join(__dirname, '..', '..', 'pricing', 'models.json');

/**
 * A user-writable copy under ~/.fiscus/pricing/models.json that, when present
 * and structurally valid, OVERRIDES the bundled table. This is where
 * `fiscus pricing --refresh` writes a freshly-pulled manifest, so prices can
 * be updated without reinstalling — pricing is a core dependability, and
 * provider rates drift.
 */
function cachePath(): string {
  return join(fiscusHome(), 'pricing', 'models.json');
}

/** Sidecar for verifiable local cache provenance. It intentionally stores only
 * a redacted source identity, never a URL query string or credentials. */
function provenancePath(): string {
  return join(fiscusHome(), 'pricing', 'provenance.json');
}

function archivePath(cardSha256: string): string {
  return join(fiscusHome(), 'pricing', 'cards', `${cardSha256}.json`);
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
  currency: 'USD';
  unit: string;
  providers: Record<string, { verified: boolean; models: Record<string, ModelRate> }>;
  fallbacks: { unknown: ModelRate };
}

export type PricingSourceKind = 'manual' | 'native_manifest' | 'litellm_transformed';

/**
 * What kind of number a ledger row contains. These are evidence labels, not
 * billing states: Fiscus does not receive provider invoices, discounts, taxes,
 * credits, or reconciliation data.
 */
export type CostBasis =
  | 'local_list_price'
  | 'fallback_estimate'
  | 'tool_reported_unverified'
  | 'synthetic_demo'
  | 'unpriced'
  | 'legacy_unknown';

/** Source of an attached rate-card hash. `none` is deliberately explicit for
 * tool-reported and unpriced rows, so a null hash is never mistaken for a lost
 * local rate card. */
export type RateCardSourceKind = PricingSourceKind | 'bundled' | 'legacy_unknown' | 'none';

/** How the observed model was resolved against a local rate card, if any. */
export type RateMatchKind =
  | 'exact_provider'
  | 'exact_cross_provider'
  | 'family_provider'
  | 'family_cross_provider'
  | 'fallback'
  | 'reported'
  | 'unpriced'
  | 'legacy_unknown';

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

interface PricingProvenance {
  schemaVersion: 1;
  /** Safe URL identity: origin + pathname only, without credentials/query/hash. */
  sourceUrl: string | null;
  /** Hash of the full fetch target, used only locally for conditional requests. */
  sourceUrlSha256: string | null;
  sourceKind: PricingSourceKind;
  /** When Fiscus actually accepted this rate-card content, not a provider claim. */
  fetchedAt: string;
  /** Last successful conditional or full check of this source. */
  lastCheckedAt: string;
  /** A declared native-manifest date, never inferred for a transformed feed. */
  upstreamDeclaredUpdated: string | null;
  /** SHA-256 of the normalized cached rate card. */
  cardSha256: string;
  modelCount: number;
  etag: string | null;
  lastModified: string | null;
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
  /** TTL of the cache write, if known. Affects the write rate. */
  cacheWriteTtl?: '5m' | '1h';
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
}

let cached: PricingFile | null = null;
let cachedSource: 'cache' | 'bundled' = 'bundled';

function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

function pricingCardHash(file: PricingFile): string {
  return sha256(JSON.stringify(file));
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

export function loadPricing(force = false): PricingFile {
  if (cached && !force) return cached;
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
  /** Stable distinction between a Fiscus boundary refusal and an ordinary fetch failure. */
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
    currency: 'USD',
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

  try {
    const dir = join(fiscusHome(), 'pricing');
    const archiveDir = join(dir, 'cards');
    if (!existsSync(archiveDir)) mkdirSync(archiveDir, { recursive: true });
    const cardText = JSON.stringify(file, null, 2) + '\n';
    // Archive first: a later interrupted active-cache write still has a named,
    // immutable last-valid card. All files are individually temp+rename writes.
    if (!existsSync(archivePath(cardSha256))) writeAtomically(archivePath(cardSha256), cardText);
    writeAtomically(cachePath(), cardText);
    writeAtomically(provenancePath(), JSON.stringify(provenance, null, 2) + '\n');
  } catch (e) {
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
    ? `Fiscus egress boundary refused the pricing refresh (${failureCode.slice('egress_'.length)}): ${String(error)}${repair}`
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
  /** Declared rate-card date (not necessarily the time Fiscus retrieved it). */
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
  rateMatchKind: Extract<RateMatchKind, 'exact_provider' | 'exact_cross_provider' | 'family_provider' | 'family_cross_provider' | 'fallback'>,
  rateMatchProvider: string | null,
  rateMatchModel: string | null,
): ResolvedRate {
  // rateFor always loads the active card first, so the card identity and source
  // describe this exact local computation rather than a later refresh.
  const card = loadPricing();
  return {
    rate,
    estimated: rateMatchKind !== 'exact_provider' && rateMatchKind !== 'exact_cross_provider',
    pricing: {
      costBasis: rateMatchKind === 'fallback' ? 'fallback_estimate' : 'local_list_price',
      rateCardSha256: pricingCardHash(card),
      rateCardSourceKind: activeRateCardSourceKind(),
      rateMatchKind,
      rateMatchProvider,
      rateMatchModel,
    },
  };
}

/** Use when a connected tool supplies a nonzero amount that Fiscus did not calculate. */
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

export function rateFor(provider: Provider, model: string): ResolvedRate {
  const pricing = loadPricing();
  const here = pricing.providers[provider]?.models;

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

function per(tokens: number, rate: number | undefined): number {
  if (!tokens || !rate) return 0;
  return (tokens / 1_000_000) * rate;
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

  return { costUsd, estimated, pricing, rate, components };
}
