/**
 * The interception proxy.
 *
 * Flow per request:
 *   client → [read body] → [budget pre-flight] → forward upstream
 *          → [tee response through usage accumulator] → client
 *          → [compute cost, log to SQLite]
 *
 * Design choices that differ from the source research:
 *  - Base-URL reverse proxy, NOT a MITM CA daemon. The client is explicitly
 *    pointed here via ANTHROPIC_BASE_URL / OPENAI_BASE_URL, so there is no TLS
 *    to intercept and no root certificate to install. Safer and honest.
 *  - We force `Accept-Encoding: identity` upstream so the SSE stream is plain
 *    text we can both forward verbatim and parse for usage.
 *  - Cost headers (X-Aegis-Cost-USD) are added for non-streaming responses. For
 *    streaming, headers are already flushed before usage is known, so we emit
 *    remaining-budget headers up front and record the final cost server-side.
 *  - Any internal failure falls through to a transparent passthrough: tracking
 *    must never break a developer's session.
 */

import http from 'node:http';
import { randomUUID } from 'node:crypto';
import type { Store, RequestRow } from '../store/db.ts';
import type { AegisConfig } from '../config.ts';
import { BudgetGuard, type GuardDecision } from '../budget/guard.ts';
import { computeCost, type NormalizedUsage, type Provider } from '../cost/pricing.ts';
import {
  StreamUsageAccumulator,
  normalizeAnthropicUsage,
  normalizeOpenAIUsage,
  emptyUsage,
} from './usage.ts';
import { extractProposals, type ProposedFile } from '../value/proposals.ts';
import { StreamProposalAccumulator } from './stream-proposals.ts';

const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'host',
  'content-length',
  'accept-encoding',
]);

interface RouteInfo {
  provider: Provider;
  upstreamBase: string;
}

function detectRoute(req: http.IncomingMessage, cfg: AegisConfig): RouteInfo | null {
  const url = req.url ?? '';
  const headers = req.headers;

  // Path-based detection first (most reliable).
  if (url.startsWith('/v1/messages') || url.includes('/anthropic/')) {
    return { provider: 'anthropic', upstreamBase: cfg.upstreams.anthropic };
  }
  if (
    url.includes('/chat/completions') ||
    url.includes('/responses') ||
    url.includes('/completions') ||
    url.includes('/embeddings') ||
    url.includes('/openai/')
  ) {
    return { provider: 'openai', upstreamBase: cfg.upstreams.openai };
  }
  // Header-based fallback.
  if (headers['x-api-key'] || headers['anthropic-version']) {
    return { provider: 'anthropic', upstreamBase: cfg.upstreams.anthropic };
  }
  if (typeof headers['authorization'] === 'string') {
    return { provider: 'openai', upstreamBase: cfg.upstreams.openai };
  }
  return null;
}

function readBody(req: http.IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function buildUpstreamHeaders(req: http.IncomingMessage): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(req.headers)) {
    const key = k.toLowerCase();
    if (HOP_BY_HOP.has(key)) continue;
    if (key.startsWith('x-aegis-')) continue; // our metadata, not the provider's
    if (v === undefined) continue;
    out[k] = Array.isArray(v) ? v.join(', ') : v;
  }
  out['accept-encoding'] = 'identity'; // keep SSE/text uncompressed for parsing
  return out;
}

function copyDownstreamHeaders(upstream: Response): Record<string, string> {
  const out: Record<string, string> = {};
  upstream.headers.forEach((value, key) => {
    const k = key.toLowerCase();
    if (HOP_BY_HOP.has(k)) return;
    if (k === 'content-encoding') return; // we requested identity
    out[key] = value;
  });
  return out;
}

interface ParsedRequest {
  model: string;
  stream: boolean;
  approxInputTokens: number;
}

function parseRequestBody(provider: Provider, body: Buffer): ParsedRequest {
  let model = 'unknown';
  let stream = false;
  let approxInputTokens = 0;
  try {
    const json = JSON.parse(body.toString('utf8')) as Record<string, unknown>;
    if (typeof json.model === 'string') model = json.model;
    if (json.stream === true) stream = true;
    // Cheap input-size proxy: ~4 chars/token on the serialized messages.
    const messages = json.messages ?? json.input ?? json.prompt;
    if (messages) approxInputTokens = Math.ceil(JSON.stringify(messages).length / 4);
  } catch {
    /* non-JSON body (embeddings binary, etc.) — leave defaults */
  }
  return { model, stream, approxInputTokens };
}

/** For OpenAI streaming, ensure the usage chunk is emitted by the API. */
function ensureOpenAIUsage(provider: Provider, stream: boolean, body: Buffer): Buffer {
  if (provider !== 'openai' || !stream) return body;
  try {
    const json = JSON.parse(body.toString('utf8')) as Record<string, unknown>;
    const so = (json.stream_options ?? {}) as Record<string, unknown>;
    if (so.include_usage === true) return body;
    json.stream_options = { ...so, include_usage: true };
    return Buffer.from(JSON.stringify(json), 'utf8');
  } catch {
    return body;
  }
}

function providerErrorBody(provider: Provider, message: string): string {
  if (provider === 'anthropic') {
    return JSON.stringify({ type: 'error', error: { type: 'aegis_budget_block', message } });
  }
  return JSON.stringify({ error: { message, type: 'aegis_budget_block', code: 'budget_exceeded' } });
}

export interface ProxyDeps {
  store: Store;
  config: AegisConfig;
  onLog?: (row: RequestRow, decision: GuardDecision) => void;
}

export function createProxyServer(deps: ProxyDeps): http.Server {
  const { store, config } = deps;
  const guard = new BudgetGuard(store, config.budget);

  const server = http.createServer((req, res) => {
    handle(req, res, deps, guard).catch((err) => {
      // Last-resort guard: never leak a 500 that kills the agent session.
      if (!res.headersSent) {
        res.writeHead(502, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: `aegis proxy error: ${String(err)}` } }));
      } else {
        res.end();
      }
    });
  });

  return server;
}

async function handle(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  deps: ProxyDeps,
  guard: BudgetGuard,
): Promise<void> {
  const { store, config } = deps;
  const startedAt = Date.now();

  // Lightweight health endpoint for the dashboard / readiness checks.
  if (req.url === '/__aegis/health') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, service: 'aegisflow-proxy', port: config.port }));
    return;
  }

  const route = detectRoute(req, config);
  const body = await readBody(req);

  if (!route) {
    res.writeHead(400, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({
        error: {
          message:
            'AegisFlow could not detect the provider. Point Anthropic clients at ANTHROPIC_BASE_URL=http://localhost:' +
            config.port +
            ' and OpenAI clients at OPENAI_BASE_URL=http://localhost:' +
            config.port +
            '/v1',
        },
      }),
    );
    return;
  }

  const { provider, upstreamBase } = route;
  const parsed = parseRequestBody(provider, body);

  // --- Metadata from custom headers (attribution) ---
  const project = headerStr(req, 'x-aegis-project') ?? 'default';
  const sessionId = headerStr(req, 'x-aegis-session-id') ?? null;
  const user = headerStr(req, 'x-aegis-user') ?? null;
  const taskWeight = Number(headerStr(req, 'x-aegis-task-weight') ?? '1') || 1;
  const requestId = randomUUID();
  if (sessionId) store.upsertSession(sessionId, project, headerStr(req, 'user-agent') ?? 'unknown', startedAt);

  // --- Budget pre-flight ---
  let decision: GuardDecision;
  try {
    decision = guard.evaluate({ sessionId });
  } catch {
    decision = {
      action: 'allow',
      reason: null,
      daySpendUsd: 0,
      dailyLimitUsd: null,
      remainingDailyUsd: null,
      sessionSpendUsd: null,
      softTripped: false,
      runaway: { tripped: false, windowCostUsd: 0, windowSec: config.budget.runawayWindowSec },
    };
  }

  if (decision.action === 'block') {
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      'x-aegis-blocked': '1',
      'x-aegis-reason': sanitizeHeader(decision.reason ?? 'budget'),
    };
    res.writeHead(429, headers);
    res.end(providerErrorBody(provider, decision.reason ?? 'Budget limit reached.'));
    // Log the blocked attempt at zero cost for the audit trail.
    safeLog(deps, {
      requestId: randomUUID(),
      sessionId,
      tsEpochMs: startedAt,
      provider,
      model: parsed.model,
      project,
      user,
      taskWeight,
      inputTokens: 0,
      outputTokens: 0,
      cacheWriteTokens: 0,
      cacheReadTokens: 0,
      reasoningTokens: 0,
      costUsd: 0,
      estimated: false,
      streamed: parsed.stream,
      statusCode: 429,
      durationMs: 0,
    }, decision);
    return;
  }

  // --- Forward upstream ---
  const outboundBody = ensureOpenAIUsage(provider, parsed.stream, body);
  const targetUrl = upstreamBase.replace(/\/$/, '') + (req.url ?? '');
  const upstream = await fetch(targetUrl, {
    method: req.method,
    headers: buildUpstreamHeaders(req),
    body: req.method === 'GET' || req.method === 'HEAD' ? undefined : outboundBody,
  });

  const downHeaders = copyDownstreamHeaders(upstream);
  // Up-front budget context (final cost not yet known for streams).
  if (decision.remainingDailyUsd !== null) {
    downHeaders['x-aegis-daily-remaining-usd'] = decision.remainingDailyUsd.toFixed(4);
  }
  if (decision.action === 'warn' && decision.reason) {
    downHeaders['x-aegis-warning'] = sanitizeHeader(decision.reason);
  }

  const contentType = upstream.headers.get('content-type') ?? '';
  const isStream = parsed.stream || contentType.includes('text/event-stream');

  let usage: NormalizedUsage = emptyUsage();
  let resolvedModel = parsed.model;

  if (isStream && upstream.body) {
    // Stream through, teeing into the usage accumulator AND the proposal
    // accumulator. The client gets every byte first (latency); both accumulators
    // see the same decoded text, so proposal capture costs nothing on the wire.
    res.writeHead(upstream.status, downHeaders);
    const acc = new StreamUsageAccumulator(provider);
    const propAcc = new StreamProposalAccumulator(provider);
    const decoder = new TextDecoder();
    const reader = upstream.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        res.write(Buffer.from(value));
        const textChunk = decoder.decode(value, { stream: true });
        acc.push(textChunk);
        propAcc.push(textChunk);
      }
    }
    acc.end();
    propAcc.end();
    res.end();
    usage = acc.usage;
    if (acc.model) resolvedModel = acc.model;
    // Capture proposed edits reassembled from the SSE tool-call fragments — the
    // in-path Accepted-gate signal for streamed agent traffic.
    persistProposals(deps, { requestId, sessionId, tsEpochMs: startedAt, provider, model: resolvedModel, project }, propAcc.proposals());
  } else {
    // Buffer the full response, parse usage, add cost headers, then send.
    const text = await upstream.text();
    try {
      const json = JSON.parse(text) as Record<string, unknown>;
      if (typeof json.model === 'string') resolvedModel = json.model;
      const rawUsage = json.usage as Record<string, unknown> | undefined;
      if (rawUsage) {
        usage = provider === 'anthropic' ? normalizeAnthropicUsage(rawUsage) : normalizeOpenAIUsage(rawUsage);
      }
      // Capture proposed edits — the in-path signal for the Accepted gate.
      // Same extraction as the streaming path; what can't be parsed stays
      // `unknown`, never a false signal.
      persistProposals(deps, { requestId, sessionId, tsEpochMs: startedAt, provider, model: resolvedModel, project }, extractProposals(provider, json));
    } catch {
      /* non-JSON (e.g. error HTML) — usage stays empty */
    }
    const cost = computeCost(provider, resolvedModel, usage);
    downHeaders['x-aegis-cost-usd'] = cost.costUsd.toFixed(6);
    if (decision.sessionSpendUsd !== null && config.budget.sessionUsd !== null) {
      const remaining = Math.max(0, config.budget.sessionUsd - decision.sessionSpendUsd - cost.costUsd);
      downHeaders['x-aegis-session-remaining-usd'] = remaining.toFixed(4);
    }
    res.writeHead(upstream.status, downHeaders);
    res.end(text);
  }

  // --- Cost + log (after the client has its bytes) ---
  const cost = computeCost(provider, resolvedModel, usage);
  safeLog(deps, {
    requestId,
    sessionId,
    tsEpochMs: startedAt,
    provider,
    model: resolvedModel,
    project,
    user,
    taskWeight,
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    cacheWriteTokens: usage.cacheWriteTokens,
    cacheReadTokens: usage.cacheReadTokens,
    reasoningTokens: usage.reasoningTokens ?? 0,
    costUsd: cost.costUsd,
    estimated: cost.estimated,
    streamed: isStream,
    statusCode: upstream.status,
    durationMs: Date.now() - startedAt,
  }, decision);
}

function headerStr(req: http.IncomingMessage, name: string): string | undefined {
  const v = req.headers[name];
  return Array.isArray(v) ? v[0] : v;
}

function sanitizeHeader(value: string): string {
  return value.replace(/[\r\n]+/g, ' ').slice(0, 400);
}

function persistProposals(
  deps: ProxyDeps,
  meta: { requestId: string; sessionId: string | null; tsEpochMs: number; provider: Provider; model: string; project: string },
  files: ProposedFile[],
): void {
  try {
    if (files.length === 0) return;
    deps.store.insertProposal({
      proposalId: meta.requestId,
      requestId: meta.requestId,
      sessionId: meta.sessionId,
      tsEpochMs: meta.tsEpochMs,
      provider: meta.provider,
      model: meta.model,
      project: meta.project,
      files,
    });
  } catch {
    // Proposal capture is best-effort; never let it affect the response path.
  }
}

function safeLog(deps: ProxyDeps, row: RequestRow, decision: GuardDecision): void {
  try {
    deps.store.insertRequest(row);
    deps.onLog?.(row, decision);
  } catch {
    // Storage failure must not affect the response that already went out.
  }
}
