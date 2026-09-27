/**
 * Opt-in refresh of one public market source. Every request goes through the
 * egress transport under the `market_refresh` purpose, so a fresh install
 * (local_locked) refuses it and the operator is shown the exact grant.
 * A refresh writes one per-source file atomically; a failure leaves the
 * previous copy (refreshed or bundled) untouched.
 */
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { egressFetch, EgressError, type EgressErrorCode } from '../egress/transport.ts';
import { marketCacheDir, marketCachePath, validateSourceSnapshot, type SourceSnapshot } from './market.ts';
import {
  ARENA_MAX_PAGES, grantCommand, parseAider, parseArenaPage, parseLiteLLM, sourceUrl,
  type ArenaEntry, type MarketSourceId, type SourceData,
} from './sources.ts';

const MAX_BODY_BYTES = 16 * 1024 * 1024;

export type MarketRefreshResult =
  | { ok: true; sourceId: MarketSourceId; fetchedAt: string; publishedAt: string | null; rows: number; requests: number }
  | { ok: false; sourceId: MarketSourceId; code: `egress_${EgressErrorCode}` | 'policy_denied' | 'http_error' | 'parse_error' | 'network_error'; error: string; grantCommand: string | null };

type Transport = typeof egressFetch;

async function readBounded(res: Response): Promise<string> {
  if (!res.body) return '';
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_BODY_BYTES) { await reader.cancel(); throw new Error(`response exceeds ${MAX_BODY_BYTES} bytes`); }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/** The LiteLLM list is ~3 MB; the others are small pages. */
const TIMEOUT_MS: Record<MarketSourceId, number> = { litellm: 300_000, aider: 60_000, 'arena-text': 60_000, 'arena-webdev': 60_000, 'arena-image': 60_000 };

async function get(id: MarketSourceId, url: string, transport: Transport): Promise<string> {
  const res = await transport(url, {
    purpose: 'market_refresh', dataClass: 'market_manifest', method: 'GET',
    headers: { accept: 'application/json, text/yaml, text/plain' },
    signal: AbortSignal.timeout(TIMEOUT_MS[id]),
  });
  if (!res.ok) { await res.body?.cancel(); throw Object.assign(new Error(`HTTP ${res.status}`), { http: true }); }
  return readBounded(res);
}

function writeAtomically(path: string, text: string): void {
  mkdirSync(marketCacheDir(), { recursive: true });
  const temp = `${path}.tmp-${randomUUID()}`;
  try { writeFileSync(temp, text, { mode: 0o600 }); renameSync(temp, path); } finally { rmSync(temp, { force: true }); }
}

async function refreshWith(id: MarketSourceId, transport: Transport): Promise<MarketRefreshResult> {
  const hash = createHash('sha256');
  let data: SourceData;
  let publishedAt: string | null = null;
  let requests = 0;
  try {
    if (id === 'litellm' || id === 'aider') {
      const text = await get(id, sourceUrl(id), transport);
      requests++;
      hash.update(text);
      data = id === 'litellm' ? parseLiteLLM(text) : parseAider(text);
    } else {
      const entries: ArenaEntry[] = [];
      for (let page = 0; page < ARENA_MAX_PAGES; page++) {
        const text = await get(id, sourceUrl(id, page), transport);
        requests++;
        hash.update(text);
        const parsed = parseArenaPage(text);
        entries.push(...parsed.entries);
        if (parsed.publishedAt && (!publishedAt || parsed.publishedAt > publishedAt)) publishedAt = parsed.publishedAt;
        if (parsed.done) break;
      }
      if (entries.length < 5 || !publishedAt) throw Object.assign(new Error('arena board returned too few rows or no publish date'), { parse: true });
      data = { publishedAt, entries };
    }
  } catch (error) {
    if (error instanceof EgressError) {
      return { ok: false, sourceId: id, code: error.code === 'policy_denied' ? 'policy_denied' : `egress_${error.code}`, error: error.message, grantCommand: error.code === 'policy_denied' ? grantCommand(id) : null };
    }
    const e = error as Error & { http?: boolean; parse?: boolean };
    if (e.name === 'TimeoutError' || e.name === 'AbortError') {
      return { ok: false, sourceId: id, code: 'network_error', error: `timed out after ${TIMEOUT_MS[id] / 1000}s`, grantCommand: null };
    }
    const code = e.http ? 'http_error' : e.parse || e instanceof SyntaxError || /trust|shape|rows|object/.test(e.message) ? 'parse_error' : 'network_error';
    return { ok: false, sourceId: id, code, error: e.message, grantCommand: null };
  }
  const section: SourceSnapshot = { id, fetchedAt: new Date().toISOString(), publishedAt, sha256: hash.digest('hex'), data };
  validateSourceSnapshot(id, section);
  writeAtomically(marketCachePath(id), JSON.stringify(section) + '\n');
  const rows = 'entries' in data ? data.entries.length : Object.keys(data.tokenPrices).length;
  return { ok: true, sourceId: id, fetchedAt: section.fetchedAt, publishedAt, rows, requests };
}

export function refreshMarketSource(id: MarketSourceId): Promise<MarketRefreshResult> {
  return refreshWith(id, egressFetch);
}

/** Network-free seam for tests: the same parse-and-write path over canned responses. */
export function refreshMarketSourceFrom(id: MarketSourceId, respond: (url: string) => Response): Promise<MarketRefreshResult> {
  return refreshWith(id, async (url) => respond(String(url)));
}
