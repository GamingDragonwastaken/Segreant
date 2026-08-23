/**
 * The Lift judge trust ladder — a single, pure gate deciding which judge tier is
 * active. See docs/LIFT-AI-SIDE-JUDGE-DESIGN.md §4 for the design.
 *
 * This is the one place that decision gets made. Everything above the always-on
 * algorithmic default (src/value/liftEfficiency.ts) is off unless the user has
 * taken an explicit action, and no two tiers can be conflated: local and hosted
 * are gated independently, and each has its own separate "send full content"
 * flag so opting one tier into full-content sending can never silently affect
 * the other. `resolveJudgeTier` takes plain data in and returns plain data out —
 * no network calls, no file reads, no env access — so the gating logic itself is
 * exhaustively testable without mocking anything. The one impure fact it needs
 * (whether FISCUS_JUDGE_API_KEY is set) is read by the separate
 * `hasHostedJudgeApiKey` below and passed in by the caller.
 */

import type { JudgeConfig } from '../config.ts';

export type JudgeTier = 'algorithmic' | 'local-structural' | 'local-full' | 'hosted-structural' | 'hosted-full';

/**
 * Matches SessionJudgment.confidence (LIFT-AI-SIDE-JUDGE-DESIGN.md §3). Local
 * structural and local full share one tag on purpose: the trust boundary ("your
 * machine") is identical either way, so downstream consumers of `confidence`
 * only need the structural/full distinction where it changes WHERE data goes
 * (hosted), not where it merely changes what a same-machine process reads.
 */
export type JudgeConfidence = 'algorithmic' | 'local-llm' | 'hosted-llm-structural' | 'hosted-llm-full';

export interface JudgeTierDecision {
  tier: JudgeTier;
  confidence: JudgeConfidence;
  /** True only for the two hosted tiers — the one bit a UI needs to decide
   * whether to show an egress warning. */
  sendsContentOffDevice: boolean;
  notes: string[];
}

function isSet(s: string | null | undefined): boolean {
  return typeof s === 'string' && s.trim().length > 0;
}

/**
 * Reads FISCUS_JUDGE_API_KEY — deliberately a DIFFERENT env var than any credential
 * the reverse proxy forwards. Reusing the metered key would be circular (using the
 * thing being measured to also measure itself) and would show judge calls up as
 * confusing extra spend on the same ledger they're supposed to be judging
 * (docs/LIFT-AI-SIDE-JUDGE-DESIGN.md §2). Never logged, never persisted to
 * config.json, never returned by this function — only whether it's set.
 */
export function hasHostedJudgeApiKey(): boolean {
  return isSet(process.env.FISCUS_JUDGE_API_KEY);
}

/**
 * The trust-ladder gate. Precedence when BOTH local and hosted are fully
 * configured: local wins. It selects the configured local endpoint and does not
 * select a hosted judge, so it is the strictly more conservative choice within
 * the declared Fiscus-process egress boundary; the loser is easy to switch (unset
 * judge.localBaseUrl) — the alternative (silently preferring hosted) would mean
 * a config that types out to "local is available" can still send content off
 * the user's machine, which is exactly the silent-escalation shape
 * docs/LIFT-AI-SIDE-JUDGE-DESIGN.md §4 rules out.
 */
export function resolveJudgeTier(cfg: JudgeConfig, hostedApiKeyPresent: boolean): JudgeTierDecision {
  const notes: string[] = [];
  const localOn = isSet(cfg.localBaseUrl);
  const hostedConsent = cfg.hostedEnabled && hostedApiKeyPresent;
  const hostedOperational = hostedConsent && isSet(cfg.hostedBaseUrl);

  if (cfg.hostedEnabled !== hostedApiKeyPresent) {
    notes.push(
      cfg.hostedEnabled
        ? 'Hosted judge tier: judge.hostedEnabled is true but FISCUS_JUDGE_API_KEY is not set — hosted judging stays off until both are true.'
        : 'Hosted judge tier: FISCUS_JUDGE_API_KEY is set but judge.hostedEnabled is false — hosted judging stays off until both are true.',
    );
  }

  if (localOn && hostedOperational) {
    notes.push(
      'Both local and hosted judge tiers are configured; using local endpoint (configured) and no hosted judge call. ' +
        'Unset judge.localBaseUrl to use the hosted tier instead.',
    );
  }

  if (localOn) {
    const full = cfg.localSendFullContent;
    notes.push(
      full
        ? 'Judge tier: local LLM endpoint, full session content; hosted tier is not selected.'
        : 'Judge tier: local LLM endpoint, structural summary only; hosted tier is not selected.',
    );
    return { tier: full ? 'local-full' : 'local-structural', confidence: 'local-llm', sendsContentOffDevice: false, notes };
  }

  if (hostedConsent && !isSet(cfg.hostedBaseUrl)) {
    notes.push(
      'Hosted judge tier: consented (hostedEnabled + FISCUS_JUDGE_API_KEY) but judge.hostedBaseUrl is not ' +
        'set — falling back to the algorithmic signal.',
    );
  }

  if (hostedOperational) {
    const full = cfg.hostedSendFullContent;
    notes.push(
      full
        ? 'Judge tier: hosted API, FULL session content leaves this machine.'
        : 'Judge tier: hosted API, a structural proposal-count/timing summary leaves this machine (never raw content).',
    );
    return {
      tier: full ? 'hosted-full' : 'hosted-structural',
      confidence: full ? 'hosted-llm-full' : 'hosted-llm-structural',
      sendsContentOffDevice: true,
      notes,
    };
  }

  notes.push('Judge tier: algorithmic (default) — no opt-in judge tier is fully configured.');
  return { tier: 'algorithmic', confidence: 'algorithmic', sendsContentOffDevice: false, notes };
}
