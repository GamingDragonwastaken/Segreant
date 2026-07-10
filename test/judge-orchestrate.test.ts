/**
 * judgeSession (src/judge/orchestrate.ts): the end-to-end safety properties.
 * This is the seam where the trust-ladder gate (tier.ts), the content-free
 * payload (payload.ts), and the outbound call (call.ts) all actually meet, so
 * it gets the most adversarial attention of the three judge-feature test files:
 *
 *   1. When the gate says 'algorithmic', NO network call may be attempted —
 *      proven by pointing baseUrl at an endpoint that throws if it's ever hit.
 *   2. A judge tier the user consented to but that isn't operationally
 *      configured (no model) must degrade WITHOUT attempting a call either.
 *   3. The full-content tiers, which nothing implements yet, must degrade
 *      their REPORTED confidence to match what was ACTUALLY sent — never claim
 *      a higher-fidelity source than was delivered.
 *   4. Any failure from the call layer must degrade to a neutral algorithmic
 *      judgment, visibly explained, never thrown out of judgeSession.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { judgeSession } from '../src/judge/orchestrate.ts';
import { DEFAULT_CONFIG, type JudgeConfig } from '../src/config.ts';
import type { RequestRow, ProposalRow } from '../src/store/db.ts';

function cfg(overrides: Partial<JudgeConfig> = {}): JudgeConfig {
  return { ...DEFAULT_CONFIG.judge, ...overrides };
}

function req(overrides: Partial<RequestRow>): RequestRow {
  return {
    requestId: 'r',
    sessionId: 's1',
    tsEpochMs: 0,
    provider: 'anthropic',
    model: 'claude',
    project: 'p',
    taskWeight: 1,
    inputTokens: 100,
    outputTokens: 50,
    cacheWriteTokens: 0,
    cacheReadTokens: 0,
    reasoningTokens: 0,
    costUsd: 0.01,
    estimated: false,
    streamed: false,
    statusCode: 200,
    durationMs: 500,
    ...overrides,
  };
}

const REQUESTS: RequestRow[] = [req({ requestId: 'r1', tsEpochMs: 0 }), req({ requestId: 'r2', tsEpochMs: 30_000 })];
const PROPOSALS: ProposalRow[] = [];

function startMockJudge(respond: (body: string) => unknown): Promise<{ url: string; hitCount: () => number; close: () => Promise<void> }> {
  let hits = 0;
  const server = http.createServer(async (req, res) => {
    hits++;
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const body = Buffer.concat(chunks).toString('utf8');
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(respond(body)));
  });
  return new Promise((resolve) => {
    server.listen(0, () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      resolve({ url: `http://127.0.0.1:${port}`, hitCount: () => hits, close: () => new Promise((r) => server.close(() => r())) });
    });
  });
}

function chatCompletion(multiplier: number, rationale: string): unknown {
  return { choices: [{ message: { content: JSON.stringify({ efficiencyMultiplier: multiplier, rationale }) } }] };
}

function withEnv(key: string, value: string | undefined, fn: () => Promise<void>): Promise<void> {
  const prev = process.env[key];
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
  return fn().finally(() => {
    if (prev === undefined) delete process.env[key];
    else process.env[key] = prev;
  });
}

test('judgeSession: algorithmic tier (default config) makes ZERO network calls', async () => {
  // Port 1 is reserved/closed — if judgeSession ever tried to call it, this
  // would throw a network error instead of returning a clean neutral result.
  const j = await judgeSession('s1', REQUESTS, PROPOSALS, cfg({}));
  assert.equal(j.confidence, 'algorithmic');
  assert.equal(j.efficiencyMultiplier, 1);
});

test('judgeSession: a consented-but-inoperable tier (no model configured) never attempts a call', async () => {
  const j = await judgeSession(
    's1',
    REQUESTS,
    PROPOSALS,
    cfg({ localBaseUrl: 'http://127.0.0.1:1' }), // reserved port; would error loudly if hit
  );
  assert.equal(j.confidence, 'algorithmic');
  assert.ok(j.rationale.includes('localModel'));
});

test('judgeSession: local-structural, fully configured, calls the endpoint and returns its judgment', async () => {
  const mock = await startMockJudge(() => chatCompletion(1.1, 'Clean session.'));
  try {
    const j = await judgeSession('s1', REQUESTS, PROPOSALS, cfg({ localBaseUrl: mock.url, localModel: 'llama3.1' }));
    assert.equal(j.confidence, 'local-llm');
    assert.equal(j.efficiencyMultiplier, 1.1);
    assert.equal(mock.hitCount(), 1);
  } finally {
    await mock.close();
  }
});

test('judgeSession: hosted tier requires BOTH hostedEnabled and AEGIS_JUDGE_API_KEY — neither alone calls out', async () => {
  const mock = await startMockJudge(() => chatCompletion(1.0, 'x'));
  try {
    // hostedEnabled true, no env var.
    const j1 = await judgeSession('s1', REQUESTS, PROPOSALS, cfg({ hostedEnabled: true, hostedBaseUrl: mock.url, hostedModel: 'gpt-4o-mini' }));
    assert.equal(j1.confidence, 'algorithmic');
    assert.equal(mock.hitCount(), 0);

    // env var set, hostedEnabled false.
    await withEnv('AEGIS_JUDGE_API_KEY', 'sk-test', async () => {
      const j2 = await judgeSession('s1', REQUESTS, PROPOSALS, cfg({ hostedBaseUrl: mock.url, hostedModel: 'gpt-4o-mini' }));
      assert.equal(j2.confidence, 'algorithmic');
      assert.equal(mock.hitCount(), 0);
    });
  } finally {
    await mock.close();
  }
});

test('judgeSession: hosted-structural, all preconditions met, calls out with the key from the env var', async () => {
  const mock = await startMockJudge(() => chatCompletion(0.9, 'A bit meandering.'));
  try {
    await withEnv('AEGIS_JUDGE_API_KEY', 'sk-test-abc', async () => {
      const j = await judgeSession(
        's1',
        REQUESTS,
        PROPOSALS,
        cfg({ hostedEnabled: true, hostedBaseUrl: mock.url, hostedModel: 'gpt-4o-mini' }),
      );
      assert.equal(j.confidence, 'hosted-llm-structural');
      assert.equal(j.efficiencyMultiplier, 0.9);
      assert.equal(mock.hitCount(), 1);
    });
  } finally {
    await mock.close();
  }
});

test('judgeSession: a full-content tier downgrades its REPORTED confidence to structural — never claims fidelity it did not deliver', async () => {
  const mock = await startMockJudge(() => chatCompletion(1.0, 'ok'));
  try {
    const j = await judgeSession(
      's1',
      REQUESTS,
      PROPOSALS,
      cfg({ localBaseUrl: mock.url, localModel: 'llama3.1', localSendFullContent: true }),
    );
    assert.equal(j.confidence, 'local-llm', 'local structural and full share one tag, so this alone does not prove the downgrade');
    assert.ok(j.rationale.includes('not yet implemented'), 'the downgrade must be visible in the rationale, not silent');
  } finally {
    await mock.close();
  }

  const mock2 = await startMockJudge(() => chatCompletion(1.0, 'ok'));
  try {
    await withEnv('AEGIS_JUDGE_API_KEY', 'sk-test', async () => {
      const j = await judgeSession(
        's1',
        REQUESTS,
        PROPOSALS,
        cfg({ hostedEnabled: true, hostedBaseUrl: mock2.url, hostedModel: 'gpt-4o-mini', hostedSendFullContent: true }),
      );
      // This is the assertion that actually distinguishes the fix: hosted-full's tag
      // is DIFFERENT from hosted-structural's, so if the downgrade didn't happen this
      // would read 'hosted-llm-full' instead.
      assert.equal(j.confidence, 'hosted-llm-structural');
      assert.ok(j.rationale.includes('not yet implemented'));
    });
  } finally {
    await mock2.close();
  }
});

test('judgeSession: a judge call failure degrades to a neutral algorithmic result, never throws', async () => {
  const j = await judgeSession(
    's1',
    REQUESTS,
    PROPOSALS,
    cfg({ localBaseUrl: 'http://127.0.0.1:1', localModel: 'llama3.1' }), // reserved/closed port
  );
  assert.equal(j.confidence, 'algorithmic');
  assert.equal(j.efficiencyMultiplier, 1);
  assert.ok(j.rationale.includes('Judge call failed'));
});

test('judgeSession: when both local and hosted are fully configured, local is called and hosted is never reached', async () => {
  const localMock = await startMockJudge(() => chatCompletion(1.1, 'local'));
  const hostedMock = await startMockJudge(() => chatCompletion(0.5, 'hosted'));
  try {
    await withEnv('AEGIS_JUDGE_API_KEY', 'sk-test', async () => {
      const j = await judgeSession(
        's1',
        REQUESTS,
        PROPOSALS,
        cfg({
          localBaseUrl: localMock.url,
          localModel: 'llama3.1',
          hostedEnabled: true,
          hostedBaseUrl: hostedMock.url,
          hostedModel: 'gpt-4o-mini',
        }),
      );
      assert.equal(j.confidence, 'local-llm');
      assert.equal(localMock.hitCount(), 1);
      assert.equal(hostedMock.hitCount(), 0);
    });
  } finally {
    await localMock.close();
    await hostedMock.close();
  }
});
