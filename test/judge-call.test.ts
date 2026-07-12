/**
 * The outbound judge HTTP call (src/judge/call.ts): strict-parsing and
 * adversarial coverage. This is the one place Fiscus itself acts as an LLM
 * API CLIENT (everywhere else it's a transparent metering proxy), so it gets
 * the same "assume nothing, verify everything" treatment as the receipt
 * signing code — a malformed or hostile response must never propagate an
 * unbounded number into Lift math, and must never crash the caller.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { callJudgeApi, JudgeCallError, JUDGE_MULTIPLIER_FLOOR, JUDGE_MULTIPLIER_CAP } from '../src/judge/call.ts';
import type { StructuralSessionSummary } from '../src/judge/payload.ts';

const summary: StructuralSessionSummary = {
  sessionId: 's1',
  requestCount: 4,
  proposalCount: 2,
  interTurnGapsSec: [30, 45, 20],
  requestSizeTrend: [500, 400, 300, 250],
  totalCostUsd: 0.42,
  spanMinutes: 5,
};

type Handler = (req: http.IncomingMessage, body: string) => { status: number; body: unknown } | Promise<{ status: number; body: unknown }>;

function startMockJudge(handler: Handler): Promise<{ url: string; close: () => Promise<void>; lastHeaders: () => http.IncomingHttpHeaders }> {
  let lastHeaders: http.IncomingHttpHeaders = {};
  const server = http.createServer(async (req, res) => {
    lastHeaders = req.headers;
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const body = Buffer.concat(chunks).toString('utf8');
    const { status, body: respBody } = await handler(req, body);
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(typeof respBody === 'string' ? respBody : JSON.stringify(respBody));
  });
  return new Promise((resolve) => {
    server.listen(0, () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      resolve({
        url: `http://127.0.0.1:${port}`,
        close: () => new Promise((r) => server.close(() => r())),
        lastHeaders: () => lastHeaders,
      });
    });
  });
}

function chatCompletion(content: unknown): unknown {
  return { choices: [{ message: { content: typeof content === 'string' ? content : JSON.stringify(content) } }] };
}

test('callJudgeApi: happy path returns a validated SessionJudgment', async () => {
  const mock = await startMockJudge(() => ({
    status: 200,
    body: chatCompletion({ efficiencyMultiplier: 1.2, rationale: 'Tight, convergent session.' }),
  }));
  try {
    const j = await callJudgeApi(mock.url, 'test-model', null, summary, 'local-llm');
    assert.equal(j.sessionId, 's1');
    assert.equal(j.efficiencyMultiplier, 1.2);
    assert.equal(j.confidence, 'local-llm');
    assert.equal(j.rationale, 'Tight, convergent session.');
  } finally {
    await mock.close();
  }
});

test('callJudgeApi: a multiplier outside the bound is clamped, never passed through raw', async () => {
  const mock = await startMockJudge(() => ({ status: 200, body: chatCompletion({ efficiencyMultiplier: 999, rationale: 'x' }) }));
  try {
    const j = await callJudgeApi(mock.url, 'test-model', null, summary, 'local-llm');
    assert.equal(j.efficiencyMultiplier, JUDGE_MULTIPLIER_CAP);
  } finally {
    await mock.close();
  }
  const mock2 = await startMockJudge(() => ({ status: 200, body: chatCompletion({ efficiencyMultiplier: -50, rationale: 'x' }) }));
  try {
    const j = await callJudgeApi(mock2.url, 'test-model', null, summary, 'local-llm');
    assert.equal(j.efficiencyMultiplier, JUDGE_MULTIPLIER_FLOOR);
  } finally {
    await mock2.close();
  }
});

test('callJudgeApi: a non-finite multiplier (NaN/Infinity smuggled through JSON as strings) throws malformed-response', async () => {
  const mock = await startMockJudge(() => ({ status: 200, body: chatCompletion({ efficiencyMultiplier: 'not-a-number', rationale: 'x' }) }));
  try {
    await assert.rejects(
      () => callJudgeApi(mock.url, 'test-model', null, summary, 'local-llm'),
      (err: unknown) => err instanceof JudgeCallError && err.reason === 'malformed-response',
    );
  } finally {
    await mock.close();
  }
});

test('callJudgeApi: missing rationale defaults to a placeholder rather than throwing', async () => {
  const mock = await startMockJudge(() => ({ status: 200, body: chatCompletion({ efficiencyMultiplier: 1.0 }) }));
  try {
    const j = await callJudgeApi(mock.url, 'test-model', null, summary, 'local-llm');
    assert.equal(j.rationale, '(judge gave no rationale)');
  } finally {
    await mock.close();
  }
});

test('callJudgeApi: a non-JSON outer HTTP body throws malformed-response', async () => {
  const mock = await startMockJudge(() => ({ status: 200, body: '<html>not json</html>' }));
  try {
    await assert.rejects(
      () => callJudgeApi(mock.url, 'test-model', null, summary, 'local-llm'),
      (err: unknown) => err instanceof JudgeCallError && err.reason === 'malformed-response',
    );
  } finally {
    await mock.close();
  }
});

test('callJudgeApi: a well-formed envelope missing choices[0].message.content throws malformed-response', async () => {
  const mock = await startMockJudge(() => ({ status: 200, body: { choices: [] } }));
  try {
    await assert.rejects(
      () => callJudgeApi(mock.url, 'test-model', null, summary, 'local-llm'),
      (err: unknown) => err instanceof JudgeCallError && err.reason === 'malformed-response',
    );
  } finally {
    await mock.close();
  }
});

test('callJudgeApi: model content that is not valid JSON throws malformed-response', async () => {
  const mock = await startMockJudge(() => ({ status: 200, body: chatCompletion('I think this session was pretty good, multiplier 1.2') }));
  try {
    await assert.rejects(
      () => callJudgeApi(mock.url, 'test-model', null, summary, 'local-llm'),
      (err: unknown) => err instanceof JudgeCallError && err.reason === 'malformed-response',
    );
  } finally {
    await mock.close();
  }
});

test('callJudgeApi: a non-2xx HTTP status throws http-status, not a generic error', async () => {
  const mock = await startMockJudge(() => ({ status: 500, body: { error: 'internal' } }));
  try {
    await assert.rejects(
      () => callJudgeApi(mock.url, 'test-model', null, summary, 'local-llm'),
      (err: unknown) => err instanceof JudgeCallError && err.reason === 'http-status',
    );
  } finally {
    await mock.close();
  }
});

test('callJudgeApi: an unreachable endpoint throws network, not a crash', async () => {
  // Port 1 is a reserved, essentially-guaranteed-closed TCP port.
  await assert.rejects(
    () => callJudgeApi('http://127.0.0.1:1', 'test-model', null, summary, 'local-llm'),
    (err: unknown) => err instanceof JudgeCallError && err.reason === 'network',
  );
});

test('callJudgeApi: a hung endpoint is aborted at the timeout and throws JudgeCallError(timeout)', async () => {
  const mock = await startMockJudge(async () => {
    await new Promise((r) => setTimeout(r, 2000));
    return { status: 200, body: chatCompletion({ efficiencyMultiplier: 1, rationale: 'too late' }) };
  });
  try {
    await assert.rejects(
      () => callJudgeApi(mock.url, 'test-model', null, summary, 'local-llm', 150),
      (err: unknown) => err instanceof JudgeCallError && err.reason === 'timeout',
    );
  } finally {
    await mock.close();
  }
});

test('callJudgeApi: sends a Bearer Authorization header when an API key is given', async () => {
  const mock = await startMockJudge(() => ({ status: 200, body: chatCompletion({ efficiencyMultiplier: 1, rationale: 'ok' }) }));
  try {
    await callJudgeApi(mock.url, 'test-model', 'sk-secret-123', summary, 'hosted-llm-structural');
    assert.equal(mock.lastHeaders().authorization, 'Bearer sk-secret-123');
  } finally {
    await mock.close();
  }
});

test('callJudgeApi: sends NO Authorization header at all when apiKey is null (the local-call case)', async () => {
  const mock = await startMockJudge(() => ({ status: 200, body: chatCompletion({ efficiencyMultiplier: 1, rationale: 'ok' }) }));
  try {
    await callJudgeApi(mock.url, 'test-model', null, summary, 'local-llm');
    assert.equal(mock.lastHeaders().authorization, undefined, 'a stray auth header on a local call would be a real leak');
  } finally {
    await mock.close();
  }
});

test('callJudgeApi: the request body carries only the structural summary fields, never raw code content', async () => {
  let capturedBody = '';
  const mock = await startMockJudge((_req, body) => {
    capturedBody = body;
    return { status: 200, body: chatCompletion({ efficiencyMultiplier: 1, rationale: 'ok' }) };
  });
  try {
    await callJudgeApi(mock.url, 'test-model', null, summary, 'local-llm');
    const parsed = JSON.parse(capturedBody);
    assert.equal(parsed.model, 'test-model');
    assert.equal(parsed.response_format.type, 'json_object');
    const promptText = parsed.messages[0].content as string;
    assert.ok(promptText.includes('"requestCount": 4'));
    assert.ok(promptText.includes('"proposalCount": 2'));
    assert.ok(!/function|const |import |=>/i.test(promptText), 'no code-shaped content should ever appear in a structural-tier prompt');
  } finally {
    await mock.close();
  }
});
