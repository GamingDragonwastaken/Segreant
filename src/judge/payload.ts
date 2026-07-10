/**
 * The structural payload sent to an LLM judge tier — content-free by construction.
 * See docs/LIFT-AI-SIDE-JUDGE-DESIGN.md §1's bullet list for the three signal
 * types this draws from (proposal counts, turn/timing, request-size trend).
 *
 * Pure by design (plain rows in, a plain summary out — no store, no fetch) so it
 * composes with judge/tier.ts's gate and stays exhaustively unit-testable. The
 * store-integrated convenience wrapper lives in judge/orchestrate.ts, mirroring
 * how value/lift.ts stays pure and value/realization.ts bridges it to the store.
 *
 * IMPORTANT — what "structural" means here in practice: AegisFlow's store never
 * persists prompt text or the AI's response text (src/store/db.ts's RequestRow
 * has no content field; ProposalRow stores only the proposed file diffs for the
 * Acceptance lens). So this summary is not a redacted slice of a transcript —
 * it is genuinely ALL the session-level signal AegisFlow has ever captured, full
 * stop. See judge/orchestrate.ts for what that means for the "full content"
 * judge tiers.
 */

import type { RequestRow, ProposalRow } from '../store/db.ts';

export interface StructuralSessionSummary {
  sessionId: string;
  requestCount: number;
  proposalCount: number;
  /** Gaps between consecutive requests in the session, in seconds, chronological. */
  interTurnGapsSec: number[];
  /** input+output tokens per request, chronological — the "shrinking → narrowing
   * in, flat/growing → possible context-stuffing" trend from the design doc. */
  requestSizeTrend: number[];
  totalCostUsd: number;
  spanMinutes: number;
}

/**
 * Builds the summary for one session from already-fetched rows. Filters both
 * arrays to `sessionId` internally, so callers can pass a whole Lift-window's
 * worth of rows without pre-filtering.
 */
export function buildStructuralSummary(
  requests: RequestRow[],
  proposals: ProposalRow[],
  sessionId: string,
): StructuralSessionSummary {
  const sessionRequests = requests.filter((r) => r.sessionId === sessionId).sort((a, b) => a.tsEpochMs - b.tsEpochMs);
  const proposalCount = proposals.filter((p) => p.sessionId === sessionId).length;

  const interTurnGapsSec: number[] = [];
  for (let i = 1; i < sessionRequests.length; i++) {
    interTurnGapsSec.push((sessionRequests[i]!.tsEpochMs - sessionRequests[i - 1]!.tsEpochMs) / 1000);
  }
  const requestSizeTrend = sessionRequests.map((r) => r.inputTokens + r.outputTokens);
  const totalCostUsd = sessionRequests.reduce((s, r) => s + r.costUsd, 0);
  const spanMinutes =
    sessionRequests.length > 1
      ? (sessionRequests[sessionRequests.length - 1]!.tsEpochMs - sessionRequests[0]!.tsEpochMs) / 60_000
      : 0;

  return { sessionId, requestCount: sessionRequests.length, proposalCount, interTurnGapsSec, requestSizeTrend, totalCostUsd, spanMinutes };
}
