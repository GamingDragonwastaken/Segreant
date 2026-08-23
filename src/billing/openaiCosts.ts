/**
 * Read-only OpenAI Organization Costs observation connector.
 *
 * This module intentionally knows nothing about Fiscus request metering, caps,
 * RoI, allocation, or recommendations. It collects a narrowly scoped provider
 * report and returns immutable observations for a separate store collection.
 * It never writes credentials, response bodies, or provider data by itself.
 */

import { createHash } from 'node:crypto';
import { egressFetch } from '../egress/transport.ts';
import type { ProviderScopeDeclaration } from './scope.ts';

const DAY_MS = 24 * 60 * 60 * 1000;
export const OPENAI_COSTS_ENDPOINT = 'https://api.openai.com/v1/organization/costs';
export const MAX_OPENAI_COST_DAYS = 180;
export const MAX_OPENAI_COST_PAGES = 64;
export const MAX_OPENAI_COST_PAGE_BYTES = 2 * 1024 * 1024;

export interface OpenAiCostsRange {
  from: string;
  to: string;
  startMs: number;
  endMs: number;
  bucketCount: number;
}

export interface OpenAiCostsPreview {
  declaredScopeId: string;
  projectRef: string;
  range: OpenAiCostsRange;
  endpoint: typeof OPENAI_COSTS_ENDPOINT;
  trust: 'provider_observation_unreconciled';
  providerFinality: 'undocumented';
  rawRetention: 'digest_only';
  requestLedgerIncluded: false;
  excludedFrom: readonly ['request_metered_spend', 'budget_enforcement', 'roi', 'model_recommendations'];
}

/** A single returned provider daily cost grouping. Amounts are never summed here. */
export interface OpenAiCostObservation {
  providerProjectRef: string;
  bucketStartMs: number;
  bucketEndMs: number;
  lineItem: string;
  currency: string;
  /** Canonical decimal text for the finite JSON numeric value reported by OpenAI. */
  amountDecimal: string;
}

export interface OpenAiCostsCollected {
  preview: OpenAiCostsPreview;
  fetchedAtMs: number;
  paginationComplete: true;
  pageCount: number;
  pageDigestChainSha256: string;
  observations: OpenAiCostObservation[];
}

export type OpenAiCostsFailureCode =
  | 'missing_credential'
  | 'timeout'
  | 'network_error'
  | 'response_too_large'
  | 'malformed_response'
  | 'pagination_loop'
  | 'partial_response'
  | `http_${number}`;

export interface OpenAiCostsFailedPull {
  preview: OpenAiCostsPreview;
  fetchedAtMs: number;
  paginationComplete: false;
  pageCount: number;
  pageDigestChainSha256: string | null;
  failureCode: OpenAiCostsFailureCode;
}

export class OpenAiCostsPullError extends Error {
  readonly failure: OpenAiCostsFailedPull;

  constructor(failure: OpenAiCostsFailedPull) {
    super(`OpenAI Organization Costs observation failed (${failure.failureCode})`);
    this.name = 'OpenAiCostsPullError';
    this.failure = failure;
  }
}

function fail(message: string): never {
  throw new Error(message);
}

function utcMidnight(value: string, label: string): number {
  // Date-only input is deliberately used so a local machine timezone can never
  // quietly shift a provider daily bucket. A date-time is rejected rather than
  // coerced: callers must make the requested [from,to) boundary explicit.
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) fail(`${label} must be a UTC calendar date in YYYY-MM-DD form`);
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const ms = Date.UTC(year, month - 1, day);
  const parsed = new Date(ms);
  if (parsed.getUTCFullYear() !== year || parsed.getUTCMonth() !== month - 1 || parsed.getUTCDate() !== day) {
    fail(`${label} must be a real UTC calendar date`);
  }
  return ms;
}

/** Parse a UTC day-aligned [from,to) interval accepted by the Costs API. */
export function parseOpenAiCostsRange(from: string, to: string): OpenAiCostsRange {
  const startMs = utcMidnight(from, 'from');
  const endMs = utcMidnight(to, 'to');
  if (endMs <= startMs) fail('to must be after from for the UTC [from,to) interval');
  const bucketCount = (endMs - startMs) / DAY_MS;
  if (!Number.isInteger(bucketCount)) fail('from/to must define whole UTC daily buckets');
  if (bucketCount > MAX_OPENAI_COST_DAYS) {
    fail(`OpenAI Costs observation is limited to ${MAX_OPENAI_COST_DAYS} daily buckets per pull`);
  }
  return { from, to, startMs, endMs, bucketCount };
}

/**
 * Verify that a local route declaration is eligible for this one fixed OpenAI
 * endpoint. This proves neither provider authentication nor invoice ownership.
 */
export function previewOpenAiCosts(scope: ProviderScopeDeclaration | null, from: string, to: string): OpenAiCostsPreview {
  if (!scope) fail('an active local OpenAI scope is required before observing Organization Costs');
  if (scope.upstreamDisplay !== 'https://api.openai.com') {
    fail('OpenAI Costs observation requires an active scope for exactly https://api.openai.com');
  }
  if (!scope.providerProjectRef || !/^proj_[A-Za-z0-9_-]+$/.test(scope.providerProjectRef)) {
    fail('OpenAI Costs observation requires the active scope to contain an exact proj_... project reference');
  }
  return {
    declaredScopeId: scope.declarationId,
    projectRef: scope.providerProjectRef,
    range: parseOpenAiCostsRange(from, to),
    endpoint: OPENAI_COSTS_ENDPOINT,
    trust: 'provider_observation_unreconciled',
    providerFinality: 'undocumented',
    rawRetention: 'digest_only',
    requestLedgerIncluded: false,
    excludedFrom: ['request_metered_spend', 'budget_enforcement', 'roi', 'model_recommendations'],
  };
}

function asObject(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function nonEmptyText(value: unknown, label: string, max = 500): string {
  if (typeof value !== 'string') fail(`${label} must be a string`);
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > max || /[\u0000-\u001F\u007F]/.test(trimmed)) {
    fail(`${label} must be a short, single-line string`);
  }
  return trimmed;
}

function unixSeconds(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) fail(`${label} must be a non-negative integer Unix timestamp`);
  const ms = value * 1000;
  if (!Number.isSafeInteger(ms)) fail(`${label} is outside the supported timestamp range`);
  return ms;
}

/**
 * The documented API returns a JSON number. We do no arithmetic on it: instead
 * we retain the finite JavaScript numeric value as a canonical decimal string.
 * Exponent notation is expanded so SQLite/CSV users do not need float parsing.
 */
export function canonicalApiDecimal(value: unknown, label = 'amount.value'): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) fail(`${label} must be a finite JSON number`);
  if (Object.is(value, -0) || value === 0) return '0';
  const text = String(value);
  if (!/[eE]/.test(text)) return text;
  const [coefficient, exponentText] = text.toLowerCase().split('e');
  const exponent = Number(exponentText);
  if (!coefficient || !Number.isSafeInteger(exponent)) fail(`${label} could not be canonicalized`);
  const negative = coefficient.startsWith('-');
  const unsigned = negative ? coefficient.slice(1) : coefficient;
  const [whole = '0', fraction = ''] = unsigned.split('.');
  const digits = `${whole}${fraction}`.replace(/^0+/, '') || '0';
  const decimalIndex = whole.length + exponent;
  let output: string;
  if (decimalIndex <= 0) output = `0.${'0'.repeat(-decimalIndex)}${digits}`;
  else if (decimalIndex >= digits.length) output = `${digits}${'0'.repeat(decimalIndex - digits.length)}`;
  else output = `${digits.slice(0, decimalIndex)}.${digits.slice(decimalIndex)}`;
  output = output.replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '');
  return negative ? `-${output}` : output;
}

interface ParsedCostsPage {
  hasMore: boolean;
  nextPage: string | null;
  observations: OpenAiCostObservation[];
}

/** Strictly parse only the documented daily Costs bucket/result fields we store. */
export function parseOpenAiCostsPage(value: unknown, preview: OpenAiCostsPreview): ParsedCostsPage {
  const page = asObject(value, 'Costs response');
  if (page.object !== 'page') fail('Costs response.object must be page');
  if (!Array.isArray(page.data)) fail('Costs response.data must be an array');
  if (typeof page.has_more !== 'boolean') fail('Costs response.has_more must be boolean');
  if (page.next_page !== null && typeof page.next_page !== 'string') fail('Costs response.next_page must be string or null');
  const nextPage = page.next_page === null ? null : nonEmptyText(page.next_page, 'Costs response.next_page', 1000);
  if (page.has_more && !nextPage) fail('Costs response has_more requires next_page');
  if (!page.has_more && nextPage) fail('Costs response without has_more must have null next_page');

  const observations: OpenAiCostObservation[] = [];
  const seen = new Set<string>();
  for (let bucketIndex = 0; bucketIndex < page.data.length; bucketIndex++) {
    const bucket = asObject(page.data[bucketIndex], `Costs bucket ${bucketIndex}`);
    if (bucket.object !== 'bucket') fail(`Costs bucket ${bucketIndex}.object must be bucket`);
    const bucketStartMs = unixSeconds(bucket.start_time, `Costs bucket ${bucketIndex}.start_time`);
    const bucketEndMs = unixSeconds(bucket.end_time, `Costs bucket ${bucketIndex}.end_time`);
    if (bucketEndMs - bucketStartMs !== DAY_MS || bucketStartMs < preview.range.startMs || bucketEndMs > preview.range.endMs) {
      fail(`Costs bucket ${bucketIndex} is not an in-range UTC daily bucket`);
    }
    if (!Array.isArray(bucket.results)) fail(`Costs bucket ${bucketIndex}.results must be an array`);
    for (let resultIndex = 0; resultIndex < bucket.results.length; resultIndex++) {
      const result = asObject(bucket.results[resultIndex], `Costs result ${bucketIndex}/${resultIndex}`);
      if (result.object !== 'organization.costs.result') fail(`Costs result ${bucketIndex}/${resultIndex}.object is invalid`);
      if (result.project_id !== preview.projectRef) {
        fail(`Costs result ${bucketIndex}/${resultIndex}.project_id must match the declared project scope`);
      }
      const lineItem = nonEmptyText(result.line_item, `Costs result ${bucketIndex}/${resultIndex}.line_item`);
      const amount = asObject(result.amount, `Costs result ${bucketIndex}/${resultIndex}.amount`);
      const currency = nonEmptyText(amount.currency, `Costs result ${bucketIndex}/${resultIndex}.amount.currency`, 3);
      if (!/^[a-z]{3}$/.test(currency)) fail(`Costs result ${bucketIndex}/${resultIndex}.amount.currency must be lowercase ISO-4217`);
      const amountDecimal = canonicalApiDecimal(amount.value, `Costs result ${bucketIndex}/${resultIndex}.amount.value`);
      const key = `${bucketStartMs}\u0000${bucketEndMs}\u0000${preview.projectRef}\u0000${lineItem}\u0000${currency}`;
      if (seen.has(key)) fail(`Costs response repeats one daily project/line-item/currency grouping`);
      seen.add(key);
      observations.push({
        providerProjectRef: preview.projectRef,
        bucketStartMs,
        bucketEndMs,
        lineItem,
        currency: currency.toUpperCase(),
        amountDecimal,
      });
    }
  }
  return { hasMore: page.has_more, nextPage, observations };
}

function requestUrl(preview: OpenAiCostsPreview, page: string | null): URL {
  const url = new URL(OPENAI_COSTS_ENDPOINT);
  url.searchParams.set('start_time', String(preview.range.startMs / 1000));
  url.searchParams.set('end_time', String(preview.range.endMs / 1000));
  url.searchParams.set('bucket_width', '1d');
  url.searchParams.set('limit', String(preview.range.bucketCount));
  url.searchParams.append('group_by', 'project_id');
  url.searchParams.append('group_by', 'line_item');
  url.searchParams.append('project_ids', preview.projectRef);
  if (page) url.searchParams.set('page', page);
  // This assertion protects the narrow data boundary from a future refactor.
  if (url.origin !== 'https://api.openai.com' || url.pathname !== '/v1/organization/costs') {
    fail('internal error: Costs request target escaped the allowlist');
  }
  return url;
}

function digestChain(previous: string | null, body: Uint8Array): string {
  const pageDigest = createHash('sha256').update(body).digest('hex');
  return createHash('sha256').update(`${previous ?? ''}\n${pageDigest}`, 'utf8').digest('hex');
}

function failureCode(error: unknown): OpenAiCostsFailureCode {
  if (error instanceof OpenAiCostsPullError) return error.failure.failureCode;
  if (error instanceof Error && /^http_\d{3}$/.test(error.message)) return error.message as OpenAiCostsFailureCode;
  if (error instanceof Error && error.name === 'TimeoutError') return 'timeout';
  if (error instanceof Error && error.name === 'AbortError') return 'timeout';
  if (error instanceof Error && /^response_too_large$/.test(error.message)) return 'response_too_large';
  if (error instanceof Error && /^pagination_loop$/.test(error.message)) return 'pagination_loop';
  if (error instanceof Error && /^partial_response$/.test(error.message)) return 'partial_response';
  if (error instanceof Error && /^malformed_response$/.test(error.message)) return 'malformed_response';
  return 'network_error';
}

async function responseBytes(response: Response): Promise<Uint8Array> {
  const contentLength = response.headers.get('content-length');
  if (contentLength !== null && (!/^\d+$/.test(contentLength) || Number(contentLength) > MAX_OPENAI_COST_PAGE_BYTES)) {
    throw new Error('response_too_large');
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > MAX_OPENAI_COST_PAGE_BYTES) throw new Error('response_too_large');
  return bytes;
}

/**
 * Execute exactly one allowlisted GET-only Costs pull. The caller owns database
 * recording, which makes it possible to retain a failed run without ever
 * retaining a raw body or an API key.
 */
export async function pullOpenAiCosts(input: {
  preview: OpenAiCostsPreview;
  apiKey: string;
  fetchImpl?: typeof fetch;
  now?: () => number;
}): Promise<OpenAiCostsCollected> {
  const fetchedAtMs = (input.now ?? Date.now)();
  let pageCount = 0;
  let chain: string | null = null;
  const observations: OpenAiCostObservation[] = [];
  let page: string | null = null;
  const cursors = new Set<string>();
  try {
    while (true) {
      if (page !== null) {
        if (cursors.has(page)) throw new Error('pagination_loop');
        cursors.add(page);
      }
      if (pageCount >= MAX_OPENAI_COST_PAGES) throw new Error('partial_response');
      const url = requestUrl(input.preview, page);
      const response = input.fetchImpl
        ? await input.fetchImpl(url, {
            method: 'GET',
            headers: { Authorization: `Bearer ${input.apiKey}`, Accept: 'application/json' },
            redirect: 'error',
            signal: AbortSignal.timeout(30_000),
          })
        : await egressFetch(url, {
            purpose: 'provider_cost_observation',
            dataClass: 'provider_cost_aggregate',
            method: 'GET',
            headers: { Authorization: 'Bearer ' + input.apiKey, Accept: 'application/json' },
            signal: AbortSignal.timeout(30_000),
          });
      if (!response.ok) throw new Error(`http_${response.status}`);
      const bytes = await responseBytes(response);
      pageCount++;
      chain = digestChain(chain, bytes);
      let body: unknown;
      try {
        body = JSON.parse(new TextDecoder().decode(bytes));
      } catch {
        throw new Error('malformed_response');
      }
      let parsed: ParsedCostsPage;
      try {
        parsed = parseOpenAiCostsPage(body, input.preview);
      } catch {
        throw new Error('malformed_response');
      }
      observations.push(...parsed.observations);
      if (!parsed.hasMore) {
        return {
          preview: input.preview,
          fetchedAtMs,
          paginationComplete: true,
          pageCount,
          pageDigestChainSha256: chain,
          observations,
        };
      }
      page = parsed.nextPage;
    }
  } catch (error) {
    throw new OpenAiCostsPullError({
      preview: input.preview,
      fetchedAtMs,
      paginationComplete: false,
      pageCount,
      pageDigestChainSha256: chain,
      failureCode: failureCode(error),
    });
  }
}
