/**
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

function isSet(s: string | null | undefined): boolean {
  return typeof s === 'string' && s.trim().length > 0;
}

function neutralJudgment(sessionId: string, rationale: string): SessionJudgment {
  return { sessionId, efficiencyMultiplier: 1, confidence: 'algorithmic', rationale };
}

/**
 * Pure except for the outbound HTTP call itself (and reading
 * AEGIS_JUDGE_API_KEY, via hasHostedJudgeApiKey). Takes already-fetched rows so
 * it stays fully testable with synthetic data — see judgeSessionFromStore below
 * for the store-integrated convenience wrapper.
 */
export async function judgeSession(
  sessionId: string,
  requests: RequestRow[],
  proposals: ProposalRow[],
  cfg: JudgeConfig,
): Promise<SessionJudgment> {
  const decision = resolveJudgeTier(cfg, hasHostedJudgeApiKey());
  const notes = [...decision.notes];

  if (decision.tier === 'algorithmic') {
    return neutralJudgment(sessionId, notes.join(' ') || 'Judge tier: algorithmic (default).');
  }

  const isLocal = decision.tier === 'local-structural' || decision.tier === 'local-full';
  const baseUrl = isLocal ? cfg.localBaseUrl : cfg.hostedBaseUrl;
  const model = isLocal ? cfg.localModel : cfg.hostedModel;
  const apiKey = isLocal ? null : (process.env.AEGIS_JUDGE_API_KEY ?? null);

  if (!isSet(baseUrl) || !isSet(model)) {
    const field = isLocal ? 'judge.localModel' : 'judge.hostedModel';
    notes.push(`Judge tier ${decision.tier} is configured but missing a model name (${field}) — falling back to the algorithmic signal.`);
    return neutralJudgment(sessionId, notes.join(' '));
  }

  // Full-content judging is not implemented: the store never persists
  // prompt/response transcript text (payload.ts's docblock), so there is
  // nothing beyond the structural summary to honestly send. Downgrade the
  // ACTUAL payload (there is only ever a structural one to send) and the
  // REPORTED confidence together — never claim a higher-fidelity source than
  // what was truly sent.
  const wantsFullContent = decision.tier === 'local-full' || decision.tier === 'hosted-full';
  const confidence: JudgeConfidence = wantsFullContent
    ? isLocal
      ? 'local-llm'
      : 'hosted-llm-structural'
    : decision.confidence;
  if (wantsFullContent) {
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
        ? 'Judge tier: local LLM (full-content configured but downgraded to structural — stays on this machine either way).'
        : 'Judge tier: hosted API (full-content configured but downgraded to structural — only a structural summary leaves this machine, never raw content).',
    );
    notes.push(
      'Full-content judging is configured but not yet implemented (AegisFlow does not persist transcript text) — ' +
        'sent the structural summary instead, labeled accordingly.',
    );
  }

  const summary = buildStructuralSummary(requests, proposals, sessionId);
  try {
    const judgment = await callJudgeApi(baseUrl!, model!, apiKey, summary, confidence);
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
 */
export function judgeSessionFromStore(
  store: Store,
  project: string,
  sessionId: string,
  windowStartMs: number,
  windowEndMs: number,
  cfg: JudgeConfig,
): Promise<SessionJudgment> {
  const requests = store.requestsInRange(windowStartMs, windowEndMs);
  const proposals = store.proposalsInWindow(project, windowStartMs, windowEndMs);
  return judgeSession(sessionId, requests, proposals, cfg);
}
