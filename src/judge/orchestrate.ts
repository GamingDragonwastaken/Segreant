/**
 * ISSUANCE CLASS: display_only — see `src/epistemic/issuance-map.ts`. A judge
 * verdict is one model's opinion under a declared trust tier. It is never
 * converted into a supported quality Claim, and no canonical issuance boundary
 * consumes it.
 *
 * Ties the trust-ladder gate (tier.ts), the structural payload (payload.ts), and
 * the outbound call (call.ts) into one entry point: `judgeSession`. This is the
 * ONLY function anything else in the codebase should call to get a judgment —
 * it is also the ONLY place that swallows a judge failure into a neutral
 * result, and it does so visibly (via `rationale`), never silently.
 *
 * Safety property this file exists to guarantee: resolveJudgeTier is consulted
 * BEFORE any payload is built or any network call is attempted. When it returns
 * 'algorithmic', `judgeSession` returns immediately — no fetch, no summary
 * construction, nothing. test/judge-orchestrate.test.ts asserts this directly by
 * pointing an 'algorithmic'-tier config at an endpoint that would throw loudly
 * if it were ever actually called.
 */

import type { RequestRow, ProposalRow, Store } from '../store/db.ts';
import type { JudgeConfig } from '../config.ts';
import { resolveJudgeTier, hasHostedJudgeApiKey, type JudgeConfidence } from './tier.ts';
import { buildStructuralSummary } from './payload.ts';
import { callJudgeApi, JudgeCallError, type SessionJudgment } from './call.ts';
import { loadTranscriptExcerpt, transcriptSupport, type TranscriptExcerpt, type TranscriptRoots } from './transcript.ts';

function isSet(s: string | null | undefined): boolean {
  return typeof s === 'string' && s.trim().length > 0;
}

function neutralJudgment(sessionId: string, rationale: string): SessionJudgment {
  return { sessionId, efficiencyMultiplier: 1, confidence: 'algorithmic', rationale };
}

/**
 * Pure except for the outbound HTTP call itself (and reading
 * FISCUS_JUDGE_API_KEY, via hasHostedJudgeApiKey). Takes already-fetched rows so
 * it stays fully testable with synthetic data — see judgeSessionFromStore below
 * for the store-integrated convenience wrapper.
 */
export async function judgeSession(
  sessionId: string,
  requests: RequestRow[],
  proposals: ProposalRow[],
  cfg: JudgeConfig,
  transcript: TranscriptExcerpt | null = null,
): Promise<SessionJudgment> {
  const decision = resolveJudgeTier(cfg, hasHostedJudgeApiKey());
  const notes = [...decision.notes];

  if (decision.tier === 'algorithmic') {
    return neutralJudgment(sessionId, notes.join(' ') || 'Judge tier: algorithmic (default).');
  }

  const isLocal = decision.tier === 'local-structural' || decision.tier === 'local-full';
  const localEndpointIsOnDevice = isLocal && !decision.sendsContentOffDevice;
  const baseUrl = isLocal ? cfg.localBaseUrl : cfg.hostedBaseUrl;
  const model = isLocal ? cfg.localModel : cfg.hostedModel;
  const apiKey = isLocal ? null : (process.env.FISCUS_JUDGE_API_KEY ?? null);

  if (!isSet(baseUrl) || !isSet(model)) {
    const field = isLocal ? 'judge.localModel' : 'judge.hostedModel';
    notes.push(`Judge tier ${decision.tier} is configured but missing a model name (${field}) — falling back to the algorithmic signal.`);
    return neutralJudgment(sessionId, notes.join(' '));
  }

  // Full-content tiers send a real, bounded transcript excerpt when the caller
  // supplied one (read ephemerally from the tool's own on-disk log — the store
  // still never persists content). When no transcript exists for this session,
  // downgrade the ACTUAL payload and the REPORTED confidence together — never
  // claim a higher-fidelity source than what was truly sent. A transcript
  // passed to a STRUCTURAL tier is deliberately ignored: the tier the user
  // consented to caps what may be sent, never the other way around.
  const wantsFullContent = decision.tier === 'local-full' || decision.tier === 'hosted-full';
  const sendTranscript = wantsFullContent && transcript !== null && transcript.turns.length > 0 ? transcript : null;
  const confidence: JudgeConfidence = wantsFullContent
    ? sendTranscript
      ? decision.confidence // 'local-llm' or 'hosted-llm-full' — genuinely earned now
      : isLocal
        ? 'local-llm'
        : 'hosted-llm-structural'
    : decision.confidence;

  if (wantsFullContent && sendTranscript) {
    const bounds =
      sendTranscript.clippedTurns > 0 || sendTranscript.droppedTurns > 0
        ? ` — bounded: ${sendTranscript.clippedTurns} turns clipped, ${sendTranscript.droppedTurns} dropped`
        : '';
    notes.push(
      `Transcript excerpt (${sendTranscript.turns.length} turns) read ephemerally from the tool's own log${bounds}; nothing was persisted.`,
    );
  } else if (wantsFullContent) {
    // decision.notes was seeded by tier.ts based on CONFIGURED intent (before
    // this function knew the payload would be downgraded) and claims a
    // fidelity — "full session content" — that never actually gets sent.
    // Strip that claim rather than merely appending a correction after it, so
    // the rationale never asserts something that didn't happen even
    // momentarily within the same string.
    for (let i = notes.length - 1; i >= 0; i--) {
      if (/full session content/i.test(notes[i]!)) notes.splice(i, 1);
    }
    notes.push(
      isLocal
        ? localEndpointIsOnDevice
          ? 'Judge tier: local LLM (full-content configured but no on-disk transcript found for this session — the structural-summary request targets the validated loopback endpoint; it stays within the configured loopback boundary).'
          : 'Judge tier: local LLM (full-content configured but no on-disk transcript found for this session — the structural-summary request targets the configured endpoint; this destination is reported as remote/off-device).'
        : 'Judge tier: hosted API (full-content configured but no on-disk transcript found for this session — only a structural summary left this machine, never raw content).',
    );
  }

  const summary = buildStructuralSummary(requests, proposals, sessionId);
  try {
    const judgment = await callJudgeApi(baseUrl!, model!, apiKey, summary, confidence, undefined, sendTranscript, isLocal ? 'local_judge' : 'hosted_judge');
    return notes.length ? { ...judgment, rationale: `${judgment.rationale} (${notes.join(' ')})` } : judgment;
  } catch (err) {
    const reason = err instanceof JudgeCallError ? err.message : String(err);
    notes.push(`Judge call failed (${reason}) — falling back to the algorithmic signal (multiplier 1, no adjustment).`);
    return neutralJudgment(sessionId, notes.join(' '));
  }
}

/**
 * Store-integrated convenience wrapper, mirroring liftOptionsFromStore's
 * relationship to liftFromData in src/value/. Project-scoped because the
 * store's only range query over proposals (Store.proposalsInWindow) is.
 *
 * When (and only when) the resolved tier is a full-content one, this attempts
 * the ephemeral transcript read: the session's recorded tool says whether an
 * on-disk transcript can exist (claude-code names its files by session id),
 * and the excerpt — if found — is passed to judgeSession, never persisted.
 * The tier check happens BEFORE any file is touched, so a structural-tier or
 * algorithmic-tier run never reads a transcript it would not be allowed to send.
 */
export async function judgeSessionFromStore(
  store: Store,
  project: string,
  sessionId: string,
  windowStartMs: number,
  windowEndMs: number,
  cfg: JudgeConfig,
  transcriptRoots?: TranscriptRoots,
): Promise<SessionJudgment> {
  const requests = store.requestsInRange(windowStartMs, windowEndMs);
  const proposals = store.proposalsInWindow(project, windowStartMs, windowEndMs);

  let transcript: TranscriptExcerpt | null = null;
  const decision = resolveJudgeTier(cfg, hasHostedJudgeApiKey());
  if (decision.tier === 'local-full' || decision.tier === 'hosted-full') {
    const meta = store.getSessionMeta(sessionId);
    const tool = meta?.tool ?? null;
    if (transcriptSupport(tool) === 'supported') {
      transcript = await loadTranscriptExcerpt(sessionId, tool, transcriptRoots ?? {});
    }
  }
  return judgeSession(sessionId, requests, proposals, cfg, transcript);
}
