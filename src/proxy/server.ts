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
 *  - Cost headers (X-Fiscus-Cost-USD) are added for non-streaming responses. For
 *    streaming, headers are already flushed before usage is known, so we emit
 *    remaining-budget headers up front and record the final cost server-side.
 *  - Ordinary upstream transport failures are returned in a provider-shaped
 *    upstream-error body, while budget blocks and Fiscus egress-boundary
 *    refusals use distinct stable types. Corrupt or unextendable receipt
 *    history refuses the outbound request before DNS/dial.
 */

import http from 'node:http';
import { randomUUID } from 'node:crypto';
import type { Store, RequestRow } from '../store/db.ts';
import type { AttributionBasis } from '../value/characterization.ts';
import type { FiscusConfig } from '../config.ts';
import { BudgetGuard, type GuardDecision } from '../budget/guard.ts';
import { computeCost, unpricedPricingEvidence, type NormalizedUsage, type Provider } from '../cost/pricing.ts';
import {
  StreamUsageAccumulator,
  normalizeAnthropicUsage,
  normalizeOpenAIUsage,
  emptyUsage,
} from './usage.ts';
import { extractProposals, type ProposedFile } from '../value/proposals.ts';
import { StreamProposalAccumulator } from './stream-proposals.ts';
import { EgressError, egressFetchWithConfig } from '../egress/transport.ts';

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

/**
 * The URL prefix that lets a header-less client declare its project.
 *
 * Some tools expose a base-URL field and nothing else — Antigravity's
 * custom-provider form is the clearest case: no custom-headers field at all, so
 * `x-fiscus-project` is simply unavailable and its traffic could only ever meter
 * as `unattributed`. But a base URL is configurable, and one provider entry per
 * project gives the operator a place to say which project this is:
 *
 *     http://localhost:8090/fiscus/backend-api/v1
 *
 * The prefix is stripped before routing and before forwarding, so the upstream
 * sees exactly the path it would have seen without it. `/fiscus/` is not a path
 * any supported provider API uses, so it cannot shadow a real endpoint.
 *
 * This is the SAME trust level as the header: an operator declaration, recorded
 * as `client_declared`, never a verified identity.
 */
const PROJECT_PATH_PREFIX = /^\/fiscus\/([A-Za-z0-9._-]{1,64})(\/.*)$/;

/** Split a declared-project path prefix off a request URL. */
export function splitProjectPath(url: string): { project: string | null; path: string } {
  const m = PROJECT_PATH_PREFIX.exec(url);
  if (!m) return { project: null, path: url };
  const project = m[1]!;
  // `.` and `..` are valid under the character class but are not project names.
  // Refuse rather than strip: an unrecognized prefix reaches the upstream and
  // fails visibly, which beats silently metering under a nonsense label.
  if (project === '.' || project === '..') return { project: null, path: url };
  return { project, path: m[2]! };
}

export function detectRoute(req: http.IncomingMessage, cfg: FiscusConfig): RouteInfo | null {
  const url = splitProjectPath(req.url ?? '').path;
  const headers = req.headers;

  // Per-request OpenAI-compatible upstream override (OpenRouter — which itself
  // fronts Gemini/Claude/Llama/Mistral/DeepSeek — plus Ollama, DeepSeek, Mistral,
  // or a local model server). OFF by default: honoring it forwards the provider
  // auth header to the named URL, so it must be explicitly enabled
  // (config.allowOpenAIBaseOverride). For the common case, set config.upstreams.openai
  // instead — no flag, no per-request key-exfil risk. Must be absolute http(s).
  // Deliberately ignore x-fiscus-openai-base. This proxy forwards Authorization
  // to its upstream, so a request-controlled destination would make it a
  // credential-forwarding primitive. Set the one trusted destination in config.
  const openaiBase = cfg.upstreams.openai;

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
    return { provider: 'openai', upstreamBase: openaiBase };
  }
  // Header-based fallback.
  if (headers['x-api-key'] || headers['anthropic-version']) {
    return { provider: 'anthropic', upstreamBase: cfg.upstreams.anthropic };
  }
  if (typeof headers['authorization'] === 'string') {
    return { provider: 'openai', upstreamBase: openaiBase };
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
    if (key.startsWith('x-fiscus-')) continue; // our metadata, not the provider's
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
    // Fiscus deliberately does not follow upstream redirects. Forwarding a
    // Location header would let a client SDK follow one on its own, potentially
    // sending the prompt/body/credential to a destination outside this process
    // boundary. Leave the redirect status visible, but remove the escape route.
    if (k === 'location') return;
    out[key] = value;
  });
  return out;
}

interface ParsedRequest {
  model: string;
  stream: boolean;
}

function parseRequestBody(body: Buffer): ParsedRequest {
  let model = 'unknown';
  let stream = false;
  try {
    const json = JSON.parse(body.toString('utf8')) as Record<string, unknown>;
    if (typeof json.model === 'string') model = json.model;
    if (json.stream === true) stream = true;
  } catch {
    /* non-JSON body (embeddings binary, etc.) — leave defaults */
  }
  return { model, stream };
}

/** For OpenAI streaming, ensure the usage chunk is emitted by the API. */
function ensureOpenAIUsage(provider: Provider, stream: boolean, url: string, body: Buffer): Buffer {
  // Chat Completions needs stream_options.include_usage opted in explicitly.
  // The Responses API always reports usage on its `response.completed` event
  // with no opt-in — and unlike Chat Completions, it rejects an unrecognized
  // stream_options param outright (400 unknown_parameter), so injecting it
  // here would break every streaming /responses request.
  if (provider !== 'openai' || !stream || url.includes('/responses')) return body;
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
    return JSON.stringify({ type: 'error', error: { type: 'fiscus_budget_block', message } });
  }
  return JSON.stringify({ error: { message, type: 'fiscus_budget_block', code: 'budget_exceeded' } });
}

function providerBudgetUnavailableBody(provider: Provider, message: string): string {
  if (provider === 'anthropic') {
    return JSON.stringify({ type: 'error', error: { type: 'fiscus_budget_unavailable', code: 'budget_enforcement_unavailable', message } });
  }
  return JSON.stringify({ error: { message, type: 'fiscus_budget_unavailable', code: 'budget_enforcement_unavailable' } });
}

function providerEgressRefusalBody(provider: Provider, error: EgressError): string {
  const repair = error.code === 'receipt_integrity_failed' || error.code === 'receipt_persistence_failed'
    ? ' Repair or restore the local receipt history before retrying.'
    : '';
  const message = `Fiscus refused this outbound request at its egress boundary: ${error.message}.${repair}`;
  if (provider === 'anthropic') {
    return JSON.stringify({ type: 'error', error: { type: 'fiscus_egress_refusal', code: 'egress_refused', subcode: error.code, message } });
  }
  return JSON.stringify({ error: { message, type: 'fiscus_egress_refusal', code: 'egress_refused', subcode: error.code } });
}

function providerUpstreamErrorBody(provider: Provider, message: string, code: 'upstream_timeout' | 'upstream_unreachable'): string {
  if (provider === 'anthropic') {
    return JSON.stringify({ type: 'error', error: { type: 'fiscus_upstream_error', code, message } });
  }
  return JSON.stringify({ error: { message, type: 'fiscus_upstream_error', code } });
}

export interface ProxyDeps {
  store: Store;
  config: FiscusConfig;
  onLog?: (row: RequestRow, decision: GuardDecision) => void;
}

interface ProxyRuntimeState {
  /** Set after any local accounting failure; future requests fail closed. */
  accountingFailure: boolean;
}

export function createProxyServer(deps: ProxyDeps): http.Server {
  const { store, config } = deps;
  // Dashboard Settings mutates the shared config object after persisting it.
  // Resolve budget at each pre-flight check so a newly chosen cap actually
  // governs the already-running proxy, rather than merely looking saved in UI.
  const guard = new BudgetGuard(store, () => config.budget);
  const state: ProxyRuntimeState = { accountingFailure: false };

  const server = http.createServer((req, res) => {
    handle(req, res, deps, guard, state).catch((err) => {
      // Last-resort guard: never leak a 500 that kills the agent session.
      if (!res.headersSent) {
        res.writeHead(502, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: `fiscus proxy error: ${String(err)}` } }));
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
  state: ProxyRuntimeState,
): Promise<void> {
  const { store, config } = deps;
  const startedAt = Date.now();

  // Lightweight health endpoint for the dashboard / readiness checks.
  if (req.url === '/__fiscus/health') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, service: 'fiscus-proxy', port: config.port }));
    return;
  }

  const route = detectRoute(req, config);
  if (state.accountingFailure) {
    const message = 'Fiscus cannot verify local budget/accounting state; the request was not sent. Repair the local ledger or configuration, then restart Fiscus.';
    res.writeHead(503, {
      'content-type': 'application/json',
      'x-fiscus-blocked': '1',
      'x-fiscus-reason': 'budget_enforcement_unavailable',
    });
    res.end(route
      ? providerBudgetUnavailableBody(route.provider, message)
      : JSON.stringify({ error: { type: 'fiscus_budget_unavailable', code: 'budget_enforcement_unavailable', message } }));
    return;
  }
  const body = await readBody(req);

  if (!route) {
    res.writeHead(400, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({
        error: {
          message:
            'Fiscus could not detect the provider. Point Anthropic clients at ANTHROPIC_BASE_URL=http://localhost:' +
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
  // This is a local, operator-declared routing statement only. Capture it
  // before budget blocking/forwarding so normal, blocked, and failed attempts
  // all receive the same immutable snapshot. A mismatch or store error must
  // never interrupt proxy traffic or manufacture a provider-account claim.
  let scopeCapture: Pick<RequestRow, 'scopeCaptureStatus' | 'providerScopeDeclarationId'> = {
    scopeCaptureStatus: 'unscoped',
    providerScopeDeclarationId: null,
  };
  if (provider === 'openai') {
    try {
      const declaration = store.matchingOpenAiScope(upstreamBase);
      if (declaration) {
        scopeCapture = {
          scopeCaptureStatus: 'declared_unverified',
          providerScopeDeclarationId: declaration.declarationId,
        };
      }
    } catch {
      // Local provenance is best-effort; unscoped is the conservative result.
    }
  }
  const parsed = parseRequestBody(body);

  // --- Metadata from custom headers (attribution) ---
  // The declared label and WHY we have it are captured together. An absent header
  // still stores the `default` label so no rollup moves, but the basis records
  // that nothing was declared — otherwise untagged traffic is indistinguishable
  // from a project someone genuinely named `default`. A present header is a
  // self-assertion by the calling process, never a verified identity.
  // A client that cannot set headers can still declare its project in the base
  // URL (see splitProjectPath). The header wins when both are present: it is the
  // documented primary and is set per request, where the path is baked into one
  // configured endpoint. Both are operator declarations, so both record the same
  // basis — the mechanism differs, the trust does not.
  const pathProject = splitProjectPath(req.url ?? '').project;
  const declaredProject = headerStr(req, 'x-fiscus-project') ?? pathProject;
  const project = declaredProject ?? 'default';
  const attributionBasis: AttributionBasis = declaredProject ? 'client_declared' : 'unattributed';
  const sessionId = headerStr(req, 'x-fiscus-session-id') ?? null;
  const user = headerStr(req, 'x-fiscus-user') ?? null;
  // The connected source/feed (set by `fiscus connect <tool>`). Like every
  // x-fiscus-* header it is stripped in buildUpstreamHeaders, so it tags our local
  // ledger without ever being forwarded to the provider.
  const source = headerStr(req, 'x-fiscus-source') ?? null;
  // Optional full working-directory path (also an x-fiscus-* header, so stripped
  // before the request leaves the machine). Lets proxied traffic be repo-correlated
  // for per-project RoI the same way imported traffic is, when a tool sends it.
  const cwd = headerStr(req, 'x-fiscus-cwd') ?? null;
  const rawTaskWeight = Number(headerStr(req, 'x-fiscus-task-weight') ?? '1');
  const taskWeight = Number.isFinite(rawTaskWeight) && rawTaskWeight > 0 ? rawTaskWeight : 1;
  const requestId = randomUUID();
  if (sessionId) store.upsertSession(sessionId, project, headerStr(req, 'user-agent') ?? 'unknown', startedAt);

  // --- Budget pre-flight ---
  let decision: GuardDecision;
  let budgetFailure = false;
  try {
    decision = guard.evaluate({ sessionId });
  } catch {
    budgetFailure = true;
    state.accountingFailure = true;
    decision = {
      action: 'block',
      reason: 'budget_enforcement_unavailable',
      daySpendUsd: 0,
      dailyLimitUsd: null,
      remainingDailyUsd: null,
      sessionSpendUsd: null,
      softTripped: false,
      runaway: { tripped: false, windowCostUsd: 0, windowSec: config.budget.runawayWindowSec },
    };
  }

  if (decision.action === 'block') {
    const unavailable = budgetFailure;
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      'x-fiscus-blocked': '1',
      'x-fiscus-reason': sanitizeHeader(unavailable ? 'budget_enforcement_unavailable' : decision.reason ?? 'budget'),
    };
    res.writeHead(unavailable ? 503 : 429, headers);
    const message = unavailable
      ? 'Fiscus cannot verify local budget/accounting state; the request was not sent. Repair the local ledger or configuration, then restart Fiscus.'
      : decision.reason ?? 'Budget limit reached.';
    res.end(unavailable ? providerBudgetUnavailableBody(provider, message) : providerErrorBody(provider, message));
    // Log the blocked attempt at zero cost for the audit trail.
    safeLog(deps, {
      requestId: randomUUID(),
      sessionId,
      tsEpochMs: startedAt,
      provider,
      model: parsed.model,
      project,
      attributionBasis,
      user,
      source,
      cwd,
      taskWeight,
      inputTokens: 0,
      outputTokens: 0,
      cacheWriteTokens: 0,
      cacheReadTokens: 0,
      reasoningTokens: 0,
      costUsd: 0,
      estimated: false,
      pricing: unpricedPricingEvidence(),
      streamed: parsed.stream,
      statusCode: unavailable ? 503 : 429,
      durationMs: 0,
      ...scopeCapture,
    }, decision, () => { state.accountingFailure = true; });
    return;
  }

  // --- Forward upstream ---
  // The declared-project prefix is a local addressing convention, so it is
  // stripped here: the provider receives exactly the path it would have received
  // had the operator pointed the client straight at the proxy root.
  const upstreamPath = splitProjectPath(req.url ?? '').path;
  const outboundBody = ensureOpenAIUsage(provider, parsed.stream, upstreamPath, body);
  const targetUrl = upstreamBase.replace(/\/$/, '') + upstreamPath;
  let upstream: Response;
  // Connect/TTFB timeout ONLY: abort if the upstream never starts responding.
  // Cleared the instant headers arrive (right after the await), so a long
  // streaming BODY is never cut — only a hung or unreachable provider trips it.
  const controller = new AbortController();
  const timeoutTimer = setTimeout(() => controller.abort(), config.upstreamTimeoutMs);
  try {
    upstream = await egressFetchWithConfig(config.egress, targetUrl, {
      purpose: 'provider_inference',
      dataClass: 'provider_request',
      method: req.method ?? 'POST',
      headers: buildUpstreamHeaders(req),
      body: req.method === 'GET' || req.method === 'HEAD' ? undefined : outboundBody,
      signal: controller.signal,
    });
    clearTimeout(timeoutTimer);
  } catch (err) {
    clearTimeout(timeoutTimer);
    // Either the upstream is unreachable (DNS/refused/network drop), it never
    // started responding within upstreamTimeoutMs, or Fiscus refused its own
    // policy/receipt boundary. Keep these categories distinct: a local
    // boundary refusal is not a provider budget decision or a remote failure.
    const timedOut = controller.signal.aborted;
    const egressRefusal = err instanceof EgressError && err.code !== 'transport_failed' ? err : null;
    const status = timedOut ? 504 : egressRefusal ? 403 : 502;
    const detail = timedOut
      ? `upstream timed out after ${config.upstreamTimeoutMs}ms (no response headers)`
      : egressRefusal
        ? 'Fiscus egress boundary refused this upstream request: ' + egressRefusal.message
      : `upstream unreachable: ${String(err)}`;
    const headers: Record<string, string> = { 'content-type': 'application/json', 'x-fiscus-upstream-error': '1' };
    if (egressRefusal) headers['x-fiscus-egress-refusal'] = egressRefusal.code;
    res.writeHead(status, headers);
    res.end(egressRefusal
      ? providerEgressRefusalBody(provider, egressRefusal)
      : providerUpstreamErrorBody(provider, detail, timedOut ? 'upstream_timeout' : 'upstream_unreachable'));
    safeLog(deps, {
      requestId,
      sessionId,
      tsEpochMs: startedAt,
      provider,
      model: parsed.model,
      project,
      attributionBasis,
      user,
      source,
      cwd,
      taskWeight,
      inputTokens: 0,
      outputTokens: 0,
      cacheWriteTokens: 0,
      cacheReadTokens: 0,
      reasoningTokens: 0,
      costUsd: 0,
      estimated: false,
      pricing: unpricedPricingEvidence(),
      streamed: parsed.stream,
      statusCode: status,
      durationMs: Date.now() - startedAt,
      ...scopeCapture,
    }, decision, () => { state.accountingFailure = true; });
    return;
  }

  const downHeaders = copyDownstreamHeaders(upstream);
  // Up-front budget context (final cost not yet known for streams).
  if (decision.remainingDailyUsd !== null) {
    downHeaders['x-fiscus-daily-remaining-usd'] = decision.remainingDailyUsd.toFixed(4);
  }
  if (decision.action === 'warn' && decision.reason) {
    downHeaders['x-fiscus-warning'] = sanitizeHeader(decision.reason);
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
    downHeaders['x-fiscus-cost-usd'] = cost.costUsd.toFixed(6);
    if (decision.sessionSpendUsd !== null && config.budget.sessionUsd !== null) {
      const remaining = Math.max(0, config.budget.sessionUsd - decision.sessionSpendUsd - cost.costUsd);
      downHeaders['x-fiscus-session-remaining-usd'] = remaining.toFixed(4);
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
    attributionBasis,
    user,
    source,
    cwd,
    taskWeight,
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    cacheWriteTokens: usage.cacheWriteTokens,
    cacheReadTokens: usage.cacheReadTokens,
    reasoningTokens: usage.reasoningTokens ?? 0,
    costUsd: cost.costUsd,
    economicAmount: cost.exact?.total,
    estimated: cost.estimated,
    pricing: cost.pricing,
    streamed: isStream,
    statusCode: upstream.status,
    durationMs: Date.now() - startedAt,
    ...scopeCapture,
  }, decision, () => { state.accountingFailure = true; });
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
    // Honor metadataOnly: when set, the local store keeps only token/cost metadata,
    // so the AI's proposed code lines are never persisted (this turns off First-Pass
    // Acceptance, by the user's choice).
    if (deps.config.metadataOnly) return;
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

function safeLog(deps: ProxyDeps, row: RequestRow, decision: GuardDecision, onFailure?: () => void): boolean {
  try {
    deps.store.insertRequest(row);
    deps.onLog?.(row, decision);
    return true;
  } catch {
    // The current response may already be out, but future requests must stop
    // rather than silently continue without a trustworthy accounting record.
    onFailure?.();
    return false;
  }
}
