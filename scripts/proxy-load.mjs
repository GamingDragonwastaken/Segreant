#!/usr/bin/env node
/**
 * Proxy load observation for the release gate.
 *
 * Drives concurrent traffic through the real proxy into a file-backed ledger,
 * against a loopback mock provider, and reports two things:
 *
 *   1. Integrity (pass/fail): every request the proxy answered 200 has exactly
 *      one ledger row, and the ledger's token totals equal what the mock
 *      provider reported. Metering that drops or doubles a row under load is
 *      the failure this product cannot have.
 *   2. Overhead (observation): the latency the proxy adds over calling the mock
 *      directly, and sustained throughput. These depend on the machine, so they
 *      are reported, not asserted.
 *
 * Both wire shapes are exercised: OpenAI chat completions (JSON) and Anthropic
 * messages (server-sent events). Nothing leaves loopback; no credential or
 * Segreant home of the user is read.
 *
 *   node scripts/proxy-load.mjs [--requests 2000] [--concurrency 50] [--sessions 8] [--json]
 */
import http from 'node:http';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { DatabaseSync } from 'node:sqlite';

const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? fallback : Number(args[i + 1]);
};
const REQUESTS = opt('requests', 2000);
const CONCURRENCY = opt('concurrency', 50);
const JSON_OUT = args.includes('--json');
// Requests are spread over this many sessions (x-segreant-session-id), as a
// team proxy sees them; 0 sends no session header. The per-session budget check
// only runs for requests that name a session.
const SESSIONS = opt('sessions', 8);

const home = mkdtempSync(join(tmpdir(), 'segreant-proxy-load-'));
process.env.SEGREANT_HOME = home;
const { Store } = await import('../src/store/db.ts');
const { DEFAULT_CONFIG } = await import('../src/config.ts');
const { createProxyServer } = await import('../src/proxy/server.ts');

// Token counts vary per request so a dropped or duplicated row changes the totals.
const tokensFor = (i) => ({ input: 900 + (i % 97), output: 40 + (i % 31) });

const upstream = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    const parsed = JSON.parse(body);
    const i = Number(parsed.metadata?.i ?? parsed.user ?? 0);
    const t = tokensFor(i);
    if (req.url.startsWith('/v1/messages')) {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      send('message_start', { type: 'message_start', message: { id: `msg_${i}`, model: parsed.model, usage: { input_tokens: t.input, output_tokens: 1 } } });
      send('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
      send('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'ok' } });
      send('content_block_stop', { type: 'content_block_stop', index: 0 });
      send('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: t.output } });
      send('message_stop', { type: 'message_stop' });
      res.end();
    } else {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ id: `cmpl_${i}`, model: parsed.model, usage: { prompt_tokens: t.input, completion_tokens: t.output }, choices: [{ message: { role: 'assistant', content: 'ok' } }] }));
    }
  });
});

async function listen(server) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return `http://127.0.0.1:${server.address().port}`;
}

const upstreamBase = await listen(upstream);
const store = new Store(join(home, 'load.db'));
const config = structuredClone(DEFAULT_CONFIG);
config.upstreams.openai = upstreamBase;
config.upstreams.anthropic = upstreamBase;
const proxy = createProxyServer({ store, config });
const proxyBase = await listen(proxy);

function request(base, i) {
  const anthropic = i % 2 === 1;
  const url = anthropic ? `${base}/v1/messages` : `${base}/v1/chat/completions`;
  const body = anthropic
    ? { model: 'claude-sonnet-5-5', max_tokens: 64, stream: true, metadata: { i: String(i) }, messages: [{ role: 'user', content: 'hi' }] }
    : { model: 'gpt-6-luna', user: String(i), messages: [{ role: 'user', content: 'hi' }] };
  const headers = anthropic
    ? { 'content-type': 'application/json', 'x-api-key': 'load-test', 'anthropic-version': '2023-06-01' }
    : { 'content-type': 'application/json', authorization: 'Bearer load-test' };
  if (SESSIONS > 0 && base === proxyBase) headers['x-segreant-session-id'] = `load-session-${i % SESSIONS}`;
  const t0 = performance.now();
  return fetch(url, { method: 'POST', headers, body: JSON.stringify(body) })
    .then(async (r) => { await r.text(); return { ok: r.status === 200, status: r.status, ms: performance.now() - t0, i }; })
    .catch((e) => ({ ok: false, status: String(e.code ?? e.message), ms: performance.now() - t0, i }));
}

async function run(base, count, offset) {
  const results = [];
  let next = 0;
  const start = performance.now();
  await Promise.all(Array.from({ length: CONCURRENCY }, async () => {
    while (next < count) {
      const i = offset + next++;
      results.push(await request(base, i));
    }
  }));
  return { results, seconds: (performance.now() - start) / 1000 };
}

const pct = (xs, p) => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
};
const summary = ({ results, seconds }) => {
  const ms = results.filter((r) => r.ok).map((r) => r.ms);
  return { ok: ms.length, failed: results.length - ms.length, rps: Math.round(results.length / seconds), p50: +pct(ms, 50).toFixed(2), p95: +pct(ms, 95).toFixed(2), p99: +pct(ms, 99).toFixed(2) };
};

// Warm both paths, then measure direct and proxied with the same shape and size.
await run(upstreamBase, 100, 10_000_000);
const direct = summary(await run(upstreamBase, REQUESTS, 20_000_000));
// Integrity is read through a second connection: what reached the file, not
// what the writer's own handle believes it wrote.
const reader = new DatabaseSync(join(home, 'load.db'), { readOnly: true });
const before = reader.prepare('SELECT COUNT(*) AS n FROM requests').get().n;
const proxiedRun = await run(proxyBase, REQUESTS, 0);
const proxied = summary(proxiedRun);

// Integrity: rows, and token totals, match exactly what succeeded.
const okIds = proxiedRun.results.filter((r) => r.ok).map((r) => r.i);
const expected = okIds.reduce((a, i) => { const t = tokensFor(i); a.input += t.input; a.output += t.output; return a; }, { input: 0, output: 0 });
const ledger = reader.prepare('SELECT COUNT(*) AS n, COALESCE(SUM(input_tokens),0) AS input, COALESCE(SUM(output_tokens),0) AS output FROM requests').get();
const rows = ledger.n - before;
const failures = [];
if (rows !== okIds.length) failures.push(`ledger has ${rows} new rows for ${okIds.length} successful requests`);
if (ledger.input !== expected.input) failures.push(`ledger input tokens ${ledger.input} != provider-reported ${expected.input}`);
if (ledger.output !== expected.output) failures.push(`ledger output tokens ${ledger.output} != provider-reported ${expected.output}`);
if (proxied.failed > 0) failures.push(`${proxied.failed} proxied requests failed: ${[...new Set(proxiedRun.results.filter((r) => !r.ok).map((r) => r.status))].join(', ')}`);

const report = {
  requests: REQUESTS, concurrency: CONCURRENCY, sessions: SESSIONS, node: process.version, platform: `${process.platform}-${process.arch}`,
  direct, proxied,
  addedLatencyMs: { p50: +(proxied.p50 - direct.p50).toFixed(2), p95: +(proxied.p95 - direct.p95).toFixed(2), p99: +(proxied.p99 - direct.p99).toFixed(2) },
  integrity: { rows, successful: okIds.length, inputTokens: ledger.input, outputTokens: ledger.output, ok: failures.length === 0, failures },
};

reader.close(); proxy.close(); upstream.close(); store.close();
rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });

if (JSON_OUT) console.log(JSON.stringify(report, null, 2));
else {
  console.log(`\n  Proxy load — ${REQUESTS} requests, ${CONCURRENCY} concurrent, half OpenAI JSON, half Anthropic SSE, ${SESSIONS} sessions (${report.platform}, Node ${report.node})`);
  console.log(`    direct   ${String(direct.rps).padStart(6)} req/s   p50 ${direct.p50} ms   p95 ${direct.p95} ms   p99 ${direct.p99} ms`);
  console.log(`    proxied  ${String(proxied.rps).padStart(6)} req/s   p50 ${proxied.p50} ms   p95 ${proxied.p95} ms   p99 ${proxied.p99} ms`);
  console.log(`    added    p50 ${report.addedLatencyMs.p50} ms   p95 ${report.addedLatencyMs.p95} ms   p99 ${report.addedLatencyMs.p99} ms`);
  console.log(`    ledger   ${rows} rows for ${okIds.length} successful requests; tokens ${ledger.input} in / ${ledger.output} out`);
  console.log(failures.length ? `  INTEGRITY FAILED\n    ${failures.join('\n    ')}` : '  Integrity: every successful request metered exactly once, token totals exact.');
}
process.exit(failures.length ? 1 : 0);
