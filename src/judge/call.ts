/**
 * The actual outbound call to an OpenAI-compatible judge endpoint (local or
 * hosted — same wire shape either way, only baseUrl/apiKey differ). This module
 * is deliberately STRICT: it throws JudgeCallError on anything short of a
 * well-formed judgment, and never guesses. All graceful-degradation behavior
 * (falling back to the algorithmic signal on failure) lives one layer up in
 * judge/orchestrate.ts — this file either returns a trustworthy SessionJudgment
 * or throws, nothing in between.
 *
 * See docs/LIFT-AI-SIDE-JUDGE-DESIGN.md §3 for SessionJudgment's design and §2
 * for why the credential is a dedicated env var, never the metered proxy key.
 */

import type { JudgeConfidence } from './tier.ts';
import type { StructuralSessionSummary } from './payload.ts';
import type { TranscriptExcerpt } from './transcript.ts';
import { egressFetch, EgressError, type EgressErrorCode } from '../egress/transport.ts';
import { readBoundedResponseText, ResourceLimitError, RESOURCE_LIMITS } from '../util/resource-limits.ts';

export interface SessionJudgment {
  sessionId: string;
  efficiencyMultiplier: number; // clamped to [MULTIPLIER_FLOOR, MULTIPLIER_CAP]
  confidence: JudgeConfidence;
  rationale: string; // shown to the user — never silently trusted
}

export class JudgeCallError extends Error {
  readonly reason: 'network' | 'timeout' | 'http-status' | 'malformed-response' | 'egress-boundary';
  readonly egressCode?: EgressErrorCode;

  constructor(
    message: string,
    reason: 'network' | 'timeout' | 'http-status' | 'malformed-response' | 'egress-boundary',
    egressCode?: EgressErrorCode,
  ) {
    super(message);
    this.name = 'JudgeCallError';
    this.reason = reason;
    this.egressCode = egressCode;
  }
}

// Matches liftEfficiency.ts's algorithmic bound in spirit but wider, per the
// design doc's §3 sketch ("bounded to [0.5, 1.5]") — an LLM judge has more
// signal than the algorithmic pool, so its ceiling on how much it can move Lift
// is deliberately looser, while still being a REAL bound, never open-ended.
export const JUDGE_MULTIPLIER_FLOOR = 0.5;
export const JUDGE_MULTIPLIER_CAP = 1.5;

const CALL_TIMEOUT_MS = 30_000;

function judgePrompt(summary: StructuralSessionSummary, transcript: TranscriptExcerpt | null): string {
  const metrics = `Session metrics:\n${JSON.stringify(
    {
      requestCount: summary.requestCount,
      proposalCount: summary.proposalCount,
      proposalCaptureCoverage: summary.proposalCaptureCoverage ?? 'unknown',
      interTurnGapsSec: summary.interTurnGapsSec,
      requestSizeTrend: summary.requestSizeTrend,
      spanMinutes: Math.round(summary.spanMinutes * 10) / 10,
    },
    null,
    2,
  )}`;

  if (!transcript) {
    return (
      'You are judging how EFFICIENTLY an AI coding session used its time — not whether the code was good. ' +
      'You will NOT see any prompt or code content, only structural session metrics. Reply with ONLY a JSON ' +
      'object of the exact shape {"efficiencyMultiplier": number, "rationale": string}. ' +
      `efficiencyMultiplier must be between ${JUDGE_MULTIPLIER_FLOOR} and ${JUDGE_MULTIPLIER_CAP}, where 1.0 means ` +
      'no adjustment, above 1.0 means the session used AI-assisted time unusually well (few turns, tight timing, ' +
      'proposals converging rather than sprawling), and below 1.0 means it looks like it flailed (many turns, ' +
      'erratic or growing request sizes, few proposals relative to turns). rationale must be one short sentence.\n\n' +
      metrics
    );
  }

  // Full-content variant: same task, same JSON contract, same bounds — the
  // ONLY difference is a bounded transcript excerpt after the metrics, so a
  // model prompted either way is judging the same question on more evidence.
  const turnsBlock = transcript.turns.map((t) => `${t.role.toUpperCase()}: ${t.text}`).join('\n');
  const clipNote =
    transcript.clippedTurns > 0 || transcript.droppedTurns > 0 || (transcript.truncatedLines ?? 0) > 0
      ? `\n(Excerpt bounded: ${transcript.clippedTurns} turns clipped, ${transcript.droppedTurns} later turns dropped, ${transcript.truncatedLines ?? 0} oversized source lines skipped.)`
      : '';
  return (
    'You are judging how EFFICIENTLY an AI coding session used its time — not whether the code was good. ' +
    'You will see structural session metrics AND a bounded excerpt of the actual session transcript. Reply with ' +
    'ONLY a JSON object of the exact shape {"efficiencyMultiplier": number, "rationale": string}. ' +
    `efficiencyMultiplier must be between ${JUDGE_MULTIPLIER_FLOOR} and ${JUDGE_MULTIPLIER_CAP}, where 1.0 means ` +
    'no adjustment, above 1.0 means the session used AI-assisted time unusually well (clear asks, converging work, ' +
    'little repetition), and below 1.0 means it flailed (re-asking the same thing, going in circles, long confused ' +
    'stretches). Judge efficiency of the collaboration, not code quality. rationale must be one short sentence.\n\n' +
    `${metrics}\n\nTranscript excerpt (${transcript.turns.length} turns):\n${turnsBlock}${clipNote}`
  );
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

/**
 * Calls one OpenAI-compatible Chat Completions endpoint and returns a validated
 * SessionJudgment, or throws JudgeCallError. `apiKey` is null for local calls —
 * no Authorization header is sent in that case, matching how the reverse proxy's
 * own local-server support (x-fiscus-openai-base) never assumes a key either.
 */
export async function callJudgeApi(
  baseUrl: string,
  model: string,
  apiKey: string | null,
  summary: StructuralSessionSummary,
  confidence: JudgeConfidence,
  timeoutMs = CALL_TIMEOUT_MS,
  transcript: TranscriptExcerpt | null = null,
  purpose: 'local_judge' | 'hosted_judge' = 'local_judge',
): Promise<SessionJudgment> {
  const controller = new AbortController();
  const timeoutTimer = setTimeout(() => controller.abort(), timeoutMs);

  let res: Response;
  try {
    res = await egressFetch(baseUrl.replace(/\/$/, '') + '/chat/completions', {
      purpose,
      dataClass: transcript ? 'judge_transcript_excerpt' : 'judge_structural_summary',
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
      },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: judgePrompt(summary, transcript) }],
        response_format: { type: 'json_object' },
        temperature: 0,
      }),
      signal: controller.signal,
    });
  } catch (err) {
    const timedOut = controller.signal.aborted;
    if (err instanceof EgressError && err.code !== 'transport_failed') {
      const repair = err.code === 'receipt_integrity_failed' || err.code === 'receipt_persistence_failed'
        ? '; repair/restore the local receipt history before retrying'
        : '';
      throw new JudgeCallError(
        `Fiscus egress boundary refused the judge request (${err.code}): ${err.message}${repair}`,
        'egress-boundary',
        err.code,
      );
    }
    throw new JudgeCallError(
      timedOut ? `judge call timed out after ${timeoutMs}ms` : `judge endpoint unreachable: ${String(err)}`,
      timedOut ? 'timeout' : 'network',
    );
  } finally {
    clearTimeout(timeoutTimer);
  }

  if (!res.ok) {
    try {
      await readBoundedResponseText(res, RESOURCE_LIMITS.judgeResponseBytes, 'judge_response_bytes');
    } catch {
      // The status is still the primary failure classification; the body is
      // drained only up to the same bounded capture policy.
    }
    throw new JudgeCallError(`judge endpoint returned HTTP ${res.status}`, 'http-status');
  }

  let responseText: string;
  try {
    responseText = await readBoundedResponseText(res, RESOURCE_LIMITS.judgeResponseBytes, 'judge_response_bytes');
  } catch (error) {
    if (error instanceof ResourceLimitError) {
      throw new JudgeCallError('judge endpoint response exceeded the bounded response capture limit', 'malformed-response');
    }
    throw new JudgeCallError('judge endpoint response was not valid JSON', 'malformed-response');
  }
  let envelope: unknown;
  try {
    envelope = JSON.parse(responseText);
  } catch {
    throw new JudgeCallError('judge endpoint response was not valid JSON', 'malformed-response');
  }

  const content = (envelope as { choices?: Array<{ message?: { content?: unknown } }> })?.choices?.[0]?.message
    ?.content;
  if (typeof content !== 'string') {
    throw new JudgeCallError('judge endpoint response had no choices[0].message.content string', 'malformed-response');
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    throw new JudgeCallError('judge model reply was not valid JSON', 'malformed-response');
  }

  const rawMultiplier = (parsed as { efficiencyMultiplier?: unknown })?.efficiencyMultiplier;
  const rawRationale = (parsed as { rationale?: unknown })?.rationale;
  if (typeof rawMultiplier !== 'number' || !Number.isFinite(rawMultiplier)) {
    throw new JudgeCallError('judge model reply had a non-numeric or non-finite efficiencyMultiplier', 'malformed-response');
  }

  return {
    sessionId: summary.sessionId,
    efficiencyMultiplier: clamp(rawMultiplier, JUDGE_MULTIPLIER_FLOOR, JUDGE_MULTIPLIER_CAP),
    confidence,
    rationale: typeof rawRationale === 'string' && rawRationale.trim() ? rawRationale.trim().slice(0, 500) : '(judge gave no rationale)',
  };
}
