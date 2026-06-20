import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { Store } from '../src/store/db.ts';
import { createProxyServer } from '../src/proxy/server.ts';
import { StreamProposalAccumulator } from '../src/proxy/stream-proposals.ts';
import { DEFAULT_CONFIG, type AegisConfig } from '../src/config.ts';

/** Format one object as an SSE `data:` frame, matching provider wire shape. */
function sse(obj: unknown): string {
  return `data: ${JSON.stringify(obj)}\n\n`;
}

/** A stand-in for api.anthropic.com / api.openai.com so tests cost nothing. */
function startMockUpstream(): Promise<{ url: string; close: () => Promise<void> }> {
  const server = http.createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const body = Buffer.concat(chunks).toString('utf8');
    const json = body ? (JSON.parse(body) as Record<string, unknown>) : {};
    const stream = json.stream === true;

    if ((req.url ?? '').includes('/v1/messages')) {
      if (!stream) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            id: 'msg_1',
            model: 'claude-opus-4-8',
            usage: { input_tokens: 2000, output_tokens: 100, cache_read_input_tokens: 0, cache_creation_input_tokens: 500 },
          }),
        );
        return;
      }
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('event: message_start\n');
      res.write(
        'data: {"type":"message_start","message":{"id":"msg_1","model":"claude-sonnet-4-6","usage":{"input_tokens":1000,"output_tokens":1,"cache_read_input_tokens":200,"cache_creation_input_tokens":0}}}\n\n',
      );
      res.write('event: content_block_delta\n');
      res.write('data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hi"}}\n\n');
      res.write('event: message_delta\n');
      res.write('data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":50}}\n\n');
      res.write('event: message_stop\n');
      res.write('data: {"type":"message_stop"}\n\n');
      res.end();
      return;
    }

    if ((req.url ?? '').includes('/chat/completions')) {
      // Only emit usage if the proxy injected stream_options.include_usage.
      const so = (json.stream_options ?? {}) as Record<string, unknown>;
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(
        'data: {"id":"x","object":"chat.completion.chunk","model":"gpt-4o","choices":[{"delta":{"content":"Hi"}}]}\n\n',
      );
      if (so.include_usage === true) {
        res.write(
          'data: {"id":"x","object":"chat.completion.chunk","model":"gpt-4o","choices":[],"usage":{"prompt_tokens":1000,"completion_tokens":50,"prompt_tokens_details":{"cached_tokens":200},"completion_tokens_details":{"reasoning_tokens":10}}}\n\n',
        );
      }
      res.write('data: [DONE]\n\n');
      res.end();
      return;
    }

    res.writeHead(404);
    res.end('not found');
  });
  server.listen(0);
  return once(server, 'listening').then(() => {
    const addr = server.address();
    const port = typeof addr === 'object' && addr ? addr.port : 0;
    return {
      url: `http://127.0.0.1:${port}`,
      close: () => new Promise<void>((r) => server.close(() => r())),
    };
  });
}

async function startProxy(store: Store, overrides: Partial<AegisConfig>, upstreamUrl: string) {
  const config: AegisConfig = {
    ...DEFAULT_CONFIG,
    ...overrides,
    upstreams: { anthropic: upstreamUrl, openai: upstreamUrl },
    budget: { ...DEFAULT_CONFIG.budget, ...(overrides.budget ?? {}) },
  };
  const server = createProxyServer({ store, config });
  server.listen(0);
  await once(server, 'listening');
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  return { base: `http://127.0.0.1:${port}`, close: () => new Promise<void>((r) => server.close(() => r())) };
}

/** Mock Anthropic upstream that streams a single tool_use whose input JSON is split across two deltas. */
function startToolUseUpstream(toolInputJson: string): Promise<{ url: string; close: () => Promise<void> }> {
  const server = http.createServer(async (req, res) => {
    await new Promise<void>((resolve) => {
      req.on('data', () => {});
      req.on('end', () => resolve());
    });
    const half = Math.floor(toolInputJson.length / 2);
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write(sse({ type: 'message_start', message: { id: 'm1', model: 'claude-opus-4-8', usage: { input_tokens: 10, output_tokens: 1 } } }));
    res.write(sse({ type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 't1', name: 'Write', input: {} } }));
    res.write(sse({ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: toolInputJson.slice(0, half) } }));
    res.write(sse({ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: toolInputJson.slice(half) } }));
    res.write(sse({ type: 'content_block_stop', index: 0 }));
    res.write(sse({ type: 'message_delta', delta: {}, usage: { output_tokens: 20 } }));
    res.write(sse({ type: 'message_stop' }));
    res.end();
  });
  server.listen(0);
  return once(server, 'listening').then(() => {
    const addr = server.address();
    const port = typeof addr === 'object' && addr ? addr.port : 0;
    return { url: `http://127.0.0.1:${port}`, close: () => new Promise<void>((r) => server.close(() => r())) };
  });
}

test('non-streaming Anthropic: forwards body, injects cost header, logs cost', async () => {
  const upstream = await startMockUpstream();
  const store = new Store(':memory:');
  const proxy = await startProxy(store, {}, upstream.url);

  const res = await fetch(`${proxy.base}/v1/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': 'sk-test', 'x-aegis-project': 'demo' },
    body: JSON.stringify({ model: 'claude-opus-4-8', messages: [{ role: 'user', content: 'hi' }] }),
  });
  const text = await res.text();
  const json = JSON.parse(text) as { model: string };

  assert.equal(res.status, 200);
  assert.equal(json.model, 'claude-opus-4-8');
  const header = res.headers.get('x-aegis-cost-usd');
  assert.ok(header, 'cost header present');
  assert.ok(Math.abs(Number(header) - 0.015625) < 1e-9, `header cost ${header}`);

  const today = store.summary(0, Date.now() + 1000);
  assert.equal(today.requests, 1);
  assert.ok(Math.abs(today.costUsd - 0.015625) < 1e-9, `db cost ${today.costUsd}`);

  await proxy.close();
  await upstream.close();
  store.close();
});

test('streaming Anthropic: tees SSE and accumulates usage', async () => {
  const upstream = await startMockUpstream();
  const store = new Store(':memory:');
  const proxy = await startProxy(store, {}, upstream.url);

  const res = await fetch(`${proxy.base}/v1/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': 'sk-test' },
    body: JSON.stringify({ model: 'claude-sonnet-4-6', stream: true, messages: [{ role: 'user', content: 'hi' }] }),
  });
  const body = await res.text();
  assert.ok(body.includes('content_block_delta'), 'client still gets the full SSE stream');

  // Cost is logged after the stream completes; give the microtask a tick.
  await new Promise((r) => setTimeout(r, 20));
  const today = store.summary(0, Date.now() + 1000);
  assert.equal(today.requests, 1);
  // 1000*3 + 50*15 + 200*0.3 per 1e6 = 0.00381
  assert.ok(Math.abs(today.costUsd - 0.00381) < 1e-9, `db cost ${today.costUsd}`);

  await proxy.close();
  await upstream.close();
  store.close();
});

test('streaming OpenAI: proxy injects stream_options so usage is captured', async () => {
  const upstream = await startMockUpstream();
  const store = new Store(':memory:');
  const proxy = await startProxy(store, {}, upstream.url);

  const res = await fetch(`${proxy.base}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer sk-test' },
    body: JSON.stringify({ model: 'gpt-4o', stream: true, messages: [{ role: 'user', content: 'hi' }] }),
  });
  await res.text();
  await new Promise((r) => setTimeout(r, 20));

  const today = store.summary(0, Date.now() + 1000);
  assert.equal(today.requests, 1);
  // 800*2.5 + 50*10 + 200*1.25 per 1e6 = 0.00275
  assert.ok(Math.abs(today.costUsd - 0.00275) < 1e-9, `db cost ${today.costUsd}`);

  await proxy.close();
  await upstream.close();
  store.close();
});

test('StreamProposalAccumulator: reassembles Anthropic tool_use input split across SSE chunks', () => {
  const toolInput = JSON.stringify({ file_path: 'a.ts', content: 'l1\nl2' });
  const stream =
    sse({ type: 'message_start', message: { model: 'claude-opus-4-8' } }) +
    sse({ type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 't1', name: 'Write', input: {} } }) +
    sse({ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: toolInput.slice(0, 9) } }) +
    sse({ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: toolInput.slice(9) } }) +
    sse({ type: 'content_block_stop', index: 0 }) +
    sse({ type: 'message_stop' });

  const acc = new StreamProposalAccumulator('anthropic');
  // Feed in awkward 7-byte chunks that split frames mid-way to exercise buffering.
  for (let i = 0; i < stream.length; i += 7) acc.push(stream.slice(i, i + 7));
  acc.end();

  assert.deepEqual(acc.proposals(), [{ path: 'a.ts', addedLines: ['l1', 'l2'] }]);
});

test('StreamProposalAccumulator: reassembles OpenAI tool_call arguments from fragments', () => {
  const args = JSON.stringify({ path: 'y.ts', content: 'a\nb' });
  const stream =
    sse({ choices: [{ delta: { role: 'assistant', content: '' } }] }) +
    sse({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'c1', type: 'function', function: { name: 'write_file', arguments: '' } }] } }] }) +
    sse({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: args.slice(0, 8) } }] } }] }) +
    sse({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: args.slice(8) } }] } }] }) +
    'data: [DONE]\n\n';

  const acc = new StreamProposalAccumulator('openai');
  for (let i = 0; i < stream.length; i += 5) acc.push(stream.slice(i, i + 5));
  acc.end();

  assert.deepEqual(acc.proposals(), [{ path: 'y.ts', addedLines: ['a', 'b'] }]);
});

test('StreamProposalAccumulator: a malformed tool input never manufactures a proposal', () => {
  const acc = new StreamProposalAccumulator('anthropic');
  acc.push(sse({ type: 'content_block_start', index: 0, content_block: { type: 'tool_use', name: 'Write', input: {} } }));
  acc.push(sse({ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"file_path":"a.ts"' } })); // truncated, never closes
  acc.push(sse({ type: 'content_block_stop', index: 0 }));
  acc.end();
  assert.deepEqual(acc.proposals(), []); // unparseable → no proposal, never a false signal
});

test('streaming proxy captures proposed edits from SSE tool_use (the First-Pass Acceptance signal)', async () => {
  const toolInput = JSON.stringify({ file_path: 'src/x.ts', content: 'export const x = 1;\nexport const y = 2;' });
  const upstream = await startToolUseUpstream(toolInput);
  const store = new Store(':memory:');
  const proxy = await startProxy(store, {}, upstream.url);

  const res = await fetch(`${proxy.base}/v1/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': 'sk-test', 'x-aegis-project': 'demo' },
    body: JSON.stringify({ model: 'claude-opus-4-8', stream: true, messages: [{ role: 'user', content: 'edit it' }] }),
  });
  const body = await res.text();
  assert.ok(body.includes('tool_use'), 'client still receives the full SSE stream verbatim');

  // Proposals are persisted after the stream completes; give the microtask a tick.
  await new Promise((r) => setTimeout(r, 30));
  const props = store.proposalsInWindow('demo', 0, Date.now() + 1000);
  assert.equal(props.length, 1, 'exactly one proposal captured from the streamed tool_use');
  assert.equal(props[0]!.files[0]!.path, 'src/x.ts');
  assert.deepEqual(props[0]!.files[0]!.addedLines, ['export const x = 1;', 'export const y = 2;']);

  await proxy.close();
  await upstream.close();
  store.close();
});

test('proxy attributes spend to the x-aegis-user header (per-developer FinOps)', async () => {
  const upstream = await startMockUpstream();
  const store = new Store(':memory:');
  const proxy = await startProxy(store, {}, upstream.url);

  await fetch(`${proxy.base}/v1/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': 'sk-test', 'x-aegis-user': 'alice@team', 'x-aegis-project': 'demo' },
    body: JSON.stringify({ model: 'claude-opus-4-8', messages: [{ role: 'user', content: 'hi' }] }),
  });
  await new Promise((r) => setTimeout(r, 20));

  const rows = store.byUser(0, Date.now() + 1000);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.label, 'alice@team');
  assert.ok(rows[0]!.costUsd > 0, 'spend attributed to the user');

  await proxy.close();
  await upstream.close();
  store.close();
});

test('budget: hard daily cap blocks with 429 once exceeded', async () => {
  const upstream = await startMockUpstream();
  const store = new Store(':memory:');
  // Pre-load today with spend above a $0.01 cap.
  store.insertRequest({
    requestId: 'seed',
    sessionId: null,
    tsEpochMs: Date.now(),
    provider: 'anthropic',
    model: 'claude-opus-4-8',
    project: 'default',
    taskWeight: 1,
    inputTokens: 0,
    outputTokens: 0,
    cacheWriteTokens: 0,
    cacheReadTokens: 0,
    reasoningTokens: 0,
    costUsd: 0.5,
    estimated: false,
    streamed: false,
    statusCode: 200,
    durationMs: 5,
  });
  const proxy = await startProxy(store, { budget: { ...DEFAULT_CONFIG.budget, dailyUsd: 0.01 } }, upstream.url);

  const res = await fetch(`${proxy.base}/v1/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': 'sk-test' },
    body: JSON.stringify({ model: 'claude-opus-4-8', messages: [{ role: 'user', content: 'hi' }] }),
  });
  assert.equal(res.status, 429);
  assert.equal(res.headers.get('x-aegis-blocked'), '1');
  const json = (await res.json()) as { error?: { type?: string }; type?: string };
  assert.ok(json.type === 'error' || json.error, 'returns provider-shaped error');

  await proxy.close();
  await upstream.close();
  store.close();
});
