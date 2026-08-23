# AI-side session judge for Lift — design scope, mostly built

**Status, 2026-07-10:**
- **§1: one of three proposed sub-signals is BUILT** — the Acceptance-pooling
  piece only, in `src/value/liftEfficiency.ts`, wired through
  `liftFromData`/`liftOptionsFromStore`, documented in
  [RETURN-ON-INTELLIGENCE.md §7.2](RETURN-ON-INTELLIGENCE.md#72-ai-side-efficiency-the-acceptance-driven-lift-discount).
  The turn-count/inter-turn-gap and request-size-trend sub-signals sketched below
  were NOT built as PART OF §1's algorithmic discount, but their raw ingredients
  (timing gaps, token-size trend) ARE now computed as part of §2's structural
  payload — see the note there.
- **§4: the trust-ladder GATE is BUILT.** `src/config.ts`'s `JudgeConfig` and
  `src/judge/tier.ts`'s `resolveJudgeTier` implement the full decision table
  below as a pure, adversarially tested function (`test/judge-tier.test.ts`).
- **§2–§3: the STRUCTURAL call paths are BUILT. The FULL-CONTENT tiers are
  not, and can't honestly be yet — see the boxed note in §2.**
  `src/judge/payload.ts` (structural summary), `src/judge/call.ts` (the
  outbound OpenAI-compatible call, strictly parsed), and
  `src/judge/orchestrate.ts`'s `judgeSession` (gate → payload → call, with
  visible graceful degradation on any failure) are built and adversarially
  tested (`test/judge-payload.test.ts`, `test/judge-call.test.ts`,
  `test/judge-orchestrate.test.ts`, `test/judge-cli.test.ts` — 47 tests total across the five judge
  modules). **Not wired into the CLI or dashboard yet** — per §"What this doc
  does NOT decide," the exact invocation surface was always left open, and
  still is.

This is the research-and-design work named in
[docs/ARCHITECTURE.md §7](ARCHITECTURE.md), item 3. Sibling document to
[docs/TEAM-TIER-DESIGN.md](TEAM-TIER-DESIGN.md) — that one is still fully
design-only.

## What gap this actually closes

Lift compares two things: manual-baseline minutes, and measured time-with-AI
(`liftFromData`, METR-windowed request timestamps — see
[RETURN-ON-INTELLIGENCE.md §4](RETURN-ON-INTELLIGENCE.md)). The manual-baseline side
was the flat, unsourced input until this session's earlier work made it a cited METR
prior blended with personal git history (§7.1 of that doc, `src/value/liftBaseline.ts`
— see [[fiscus-real-lift-source-idea]]). **That upgrade never touched the other
side of the comparison.** Time-with-AI today is still just wall-clock duration
between a session's first and last request, windowed for concurrency — it can't tell
a focused, three-turn session that nailed the task from a forty-turn session that
flailed through it and eventually got there. Both would show identical time-with-AI,
identical Lift, even though the second one plainly used the time worse. That
distinction — how *well* the AI-assisted time was used, not just how much of it there
was — is what an AI-side judge would add.

**One clarification worth making precisely, since it affects what this document
actually is:** the baseline-minutes shrinkage work is itself algorithmic
(empirical-Bayes, `κ`-weighted blending) and may be what "we discussed doing
algorithmically" referred to — but it answers the manual-baseline question, not this
one. This document is a new algorithmic design for the AI-assisted-*side* question,
built in the same spirit (behavioral signal over self-report, reuse over invention,
sharpen the interval's inputs rather than fake a point estimate) but covering
different ground.

Three approaches, per the user's framing (2026-07-10): a pure algorithm (no LLM, no
content read), a user-supplied local LLM, or a user-supplied API key to a hosted LLM.
All three are in scope for this design; none are mutually exclusive — the intended
shape is a ladder the user opts up, not a single choice (§4).

## 1. Algorithmic signal — recommended default direction, no LLM involved

> **What actually shipped (2026-07-10).** Only the first bullet below — proposal
> Acceptance pooled and shrunk toward the ledger's own rate — was built, in
> `src/value/liftEfficiency.ts` (see
> [RETURN-ON-INTELLIGENCE.md §7.2](RETURN-ON-INTELLIGENCE.md#72-ai-side-efficiency-the-acceptance-driven-lift-discount)
> for the full writeup). The turn-count/inter-turn-gap bullet and the request-size-
> trend bullet were investigated and deliberately deferred, not built: both need a
> per-*session* grouping of requests, while `liftFromData` today reasons in terms of
> per-*work-unit* Acceptance rates pooled across a whole Lift window — turning them
> on would require session-boundary plumbing through `liftOptionsFromStore` that
> doesn't exist yet, and it was safer to ship the one clean, already-tested,
> already-computed signal than to build session segmentation and two new signals in
> the same pass. They remain good candidates for a follow-up slice. Separately, the
> "narrows or widens the interval" framing in the third paragraph below describes
> the *effect*, not the *mechanism* — the shipped version achieves it by feeding a
> fourth multiplier into `boundedLift` alongside the existing three discounts, not
> by adding new interval-width logic; see §7.2 for why that's the more consistent
> choice.

The existing Acceptance lens already measures something adjacent and directly
reusable: **Take Rate** — "did you keep what it gave you, first try?" — via
edit-distance between proposed and kept output
([RETURN-ON-INTELLIGENCE.md](RETURN-ON-INTELLIGENCE.md) §3's lens table). The
machinery already exists and is already tested: `extractProposals` (Anthropic
`tool_use`, OpenAI `tool_calls`, fenced-block fallback), `acceptanceRatio` (fraction
of proposed lines that shipped), `acceptanceForCommit` (all in
`src/value/proposals.ts`). Today this feeds the Acceptance lens of the RoI Index. It
was never wired into Lift, and it should be — a session with high first-pass
acceptance and few revision cycles is directly evidenced as an *efficient* session,
without reading a single token of what was actually proposed. Proposal survival is
structural (did this diff make it into the commit), never semantic (what did the diff
say) — the same content-free-behavioral-signal property that makes the acceptance
lens itself, and the Realization funnel, safe to compute with zero content exposure.

**Concrete proposal:** a per-session **efficiency signal**, derived entirely from
data already flowing through the pipeline —
- proposal count vs. accepted-proposal count for the session (reuses
  `acceptanceRatio`/`acceptanceForCommit` directly)
- turn count and inter-turn time gaps (already derivable from the existing
  METR-windowing timestamp data `liftFromData` already consumes)
- request-size trend across the session (shrinking → narrowing in; flat or growing →
  possible context-stuffing/confusion) — new, but computed from token counts already
  logged per request, no new instrumentation

— combined into a bounded multiplier that **narrows or widens the Lift interval's
confidence, never substitutes a point estimate for it.** A high-efficiency session
should tighten the existing Manski interval toward its upper (more favorable) bound
with more confidence; a low-efficiency one should widen it or pull it toward the
conservative bound. This preserves the exact discipline §7.1 states explicitly for
the baseline-minutes work — "none of this touches `liftFromData`, `boundedLift`, or
the Manski interval mechanics... it only sharpens one of their inputs" — applied to
the other input instead.

This is the only piece of the three that needs no opt-in gate: it's exactly as
content-free as the acceptance lens it reuses, so it can default on the same way
that lens already does.

## 2. Bring-your-own-LLM — strictly opt-in, off by default

> **What actually shipped (2026-07-10), and one real finding from building it.**
> The structural payload is built — `src/judge/payload.ts`'s
> `buildStructuralSummary` computes exactly the turn-count/inter-turn-gap and
> request-size-trend signals §1 sketched but didn't wire into the algorithmic
> discount, plus proposal/request counts, and sends them (never code, never
> prose) to whichever tier is active. The call itself is built too —
> `src/judge/call.ts`'s `callJudgeApi` (one shared OpenAI-compatible Chat
> Completions implementation for both local and hosted, since the wire shape
> is identical), orchestrated by `src/judge/orchestrate.ts`'s `judgeSession`,
> which consults the §4 gate first and degrades to the algorithmic signal —
> visibly, via `rationale` — on any failure.
>
> **The "full session content" tiers are now real (2026-07-16) — without the
> capture decision this note originally feared.** Fiscus's store STILL never
> persists prompt text or the AI's response text — `RequestRow` has no content
> field, and `ProposalRow` stores only the proposed file diffs that already
> feed the Acceptance lens. The resolution was noticing that no capture is
> needed: the tools Fiscus imports from already keep their own transcripts on
> disk (Claude Code writes `~/.claude/projects/<dir>/<sessionId>.jsonl` with
> full message content). `src/judge/transcript.ts` reads that file AT JUDGE
> TIME, read-only, into a bounded excerpt (per-turn and total character caps,
> clipping counted and disclosed) that lives only for the one judge call —
> nothing is ever written to Fiscus's store. All three importers' tools are
> covered: Claude Code (`<sessionId>.jsonl`), opencode (its session database's
> `part`/`message` tables, read-only WAL snapshot), and Codex (rollout JSONL
> located by the session uuid). Plain proxy traffic has no on-disk transcript
> and stays structural, with the rationale saying so. When no on-disk
> transcript exists for a session, `judgeSession`
> still downgrades honestly: it sends the structural summary and reports the
> STRUCTURAL confidence tag — never claiming a richer source than what was
> actually transmitted. And a structural-consent tier DROPS a transcript even
> when handed one — the tier the user consented to caps the payload, never the
> caller. `test/judge-orchestrate.test.ts` and `test/judge-transcript.test.ts`
> assert all of this directly.

Where the algorithmic signal is structurally blind (it can see *that* a session had
many proposal-revision cycles, not *why*, or whether a single long uninterrupted
turn was productive deep work or one long confused ramble), an LLM reading actual
session content could judge more than structure allows. This is real additional
insight — and a real, loud opt-in decision against the default hosted-judge egress
path, exactly as ARCHITECTURE.md §7 item 3 already says. Two sub-choices the user
raised, both worth supporting rather than picking one:

**Local model.** The proxy already speaks to arbitrary OpenAI-compatible endpoints
today — `x-fiscus-openai-base` / `config.upstreams.openai` already routes metered
traffic to Ollama and other local servers (README Status section). The same
mechanism is directly reusable for a judge call: point a separate config key
(`config.lift.judge.baseUrl`) at a local inference server, and nothing new has to be
invented to *reach* it. When that endpoint is literal loopback and the local_locked
egress mode is active, this tier can reasonably default to reading full session
content when enabled; the configured Fiscus-process destination remains explicit.

**User's own API key.** A separate, explicit credential
(`config.lift.judge.apiKey` / a dedicated env var) — never the same credential or
traffic path the proxy is metering. Reusing the metered key would be circular (using
the thing being measured to also measure itself) and would show judge calls up as
confusing extra spend on the same ledger they're supposed to be judging. Because
content now leaves the machine, this tier should default to a **structural-only**
payload — the same proposal-count/turn-count/timing summary the algorithmic signal
already computes, not raw transcript text — with full-content judging available only
behind a second, explicit opt-in on top of the first (see the trust ladder below).
This gets most of an LLM judge's qualitative lift (it can still reason about the
*pattern* of a session) while keeping the default hosted-judge payload no more
sensitive than what already gets computed locally for the algorithmic signal.

## 3. What the judge is actually asked to produce

**Built as sketched, plus a real prompt.** `src/judge/call.ts` implements this
exact interface (down to the `[0.5, 1.5]` bound) and additionally has the
prompt spec this section originally left open — a fixed, structural-metrics-only
instruction asking for this exact JSON shape via `response_format:
{type: 'json_object'}`, with every field defensively re-validated on the way
back in (non-numeric or non-finite multipliers are rejected outright, not
coerced; anything out of bounds is clamped, never trusted raw).

Whichever tier is active, the judge's output should be small and bounded, not a
free-text verdict the rest of the pipeline has to parse heuristically:

```ts
interface SessionJudgment {
  sessionId: string;
  // A bounded multiplier, not a replacement value — feeds the same role the
  // algorithmic signal (§1) does. An LLM judge and the algorithmic signal are
  // the same *kind* of input at different fidelity, not two different features.
  efficiencyMultiplier: number;  // e.g. bounded to [0.5, 1.5]
  confidence: 'algorithmic' | 'local-llm' | 'hosted-llm-structural' | 'hosted-llm-full';
  rationale: string;  // short, shown to the user — never silently trusted
}
```

The `confidence` tag matters more than it looks: every lens elsewhere in this
project already labels *which source* produced a number (§7.1's "every number is
labeled with which source produced it," the `basis`/`notes` pattern in
`liftBaseline.ts`). A judgment produced by a hosted LLM reading full content and one
produced by the zero-cost algorithmic signal should never be visually
indistinguishable in the dashboard — the honesty invariant this whole project holds
elsewhere (scan's "detected, not imported," the Manski interval instead of a fake
point) applies here too.

## 4. The trust ladder, made explicit

**BUILT, 2026-07-10** — `src/config.ts` (`JudgeConfig`) + `src/judge/tier.ts`
(`resolveJudgeTier`), adversarially tested in `test/judge-tier.test.ts`. Two
details differ from the original sketch below, both narrowing, not widening,
what the ladder allows:

- **Two independent `sendFullContent` flags, not one.** The sketch implied a
  single `judge.sendFullContent` flag; the built version has
  `judge.localSendFullContent` and `judge.hostedSendFullContent` as separate
  fields. A shared flag would mean turning on full-content for a local judge
  also silently turns it on for a hosted one configured later (or vice versa) —
  exactly the "silently escalates" failure mode the paragraph below already
  rules out in principle. Separate fields make that failure mode structurally
  impossible rather than merely undocumented.
- **Explicit precedence when both tiers are configured at once.** Not
  addressed in the original sketch. The built gate resolves this case (local
  AND hosted both fully opted into) by preferring the configured local endpoint
  and not selecting a hosted judge, so it is the strictly more conservative
  reading of an ambiguous config within the declared Fiscus-process egress
  config, and it's a one-line config change to reverse (unset
  `judge.localBaseUrl`).

| Tier | Default | What leaves the machine (as designed) | What leaves the machine (as built) | Gate (as built) |
|---|---|---|---|---|
| Algorithmic (§1) | **On** | No outbound judge request; reads the local structural record | Same | None — same posture as the Acceptance lens it reuses |
| Local LLM, structural input | Off | Bounded summary to the configured local endpoint; no hosted judge destination | Same | One opt-in: `judge.localBaseUrl` (+ `judge.localModel`) points at a local server |
| Local LLM, full content | Off | Bounded content to the configured local endpoint; no hosted judge destination | Same, but see ⚠ below — no richer payload actually exists to send | Same opt-in as above plus `judge.localSendFullContent` |
| Hosted API, structural input | Off | A proposal-count/timing summary only | Same | Two independent opt-ins: `judge.hostedEnabled: true` AND the `FISCUS_JUDGE_API_KEY` env var set (plus `judge.hostedBaseUrl` + `judge.hostedModel` configured — operationally required, not consent gates) |
| Hosted API, full content | Off | Actual session content | ⚠ Downgrades to the structural summary — see below | The above plus `judge.hostedSendFullContent` — the loudest tier, matching ARCHITECTURE §7 item 3's "real, loud opt-in decision" language exactly |

⚠ **The two "full content" rows now do what their name says — for Claude Code,
opencode, and Codex sessions.** The excerpt is read ephemerally from the
tool's own on-disk transcript at judge time (see the boxed note in §2); Fiscus
still never persists content. For sessions whose tool has no supported
on-disk transcript (plain proxy traffic), `judgeSession`
(`src/judge/orchestrate.ts`) degrades honestly: it sends the structural
payload and reports the STRUCTURAL confidence tag, never claiming the `-full`
tag for data that wasn't actually transmitted — and the rationale says a
transcript wasn't found rather than staying silent.

Every tier above "algorithmic" requires the user to have already taken an action
(configured a URL, set an env var, flipped an explicit flag) before anything is
sent anywhere — there's no single global "enable AI judging" switch that
silently escalates from local to hosted, or from structural to full-content.
Each step up the ladder is its own explicit decision, and `resolveJudgeTier`
is the one place that's decided — `test/judge-tier.test.ts` specifically checks
that a half-satisfied opt-in (the API key set without `hostedEnabled`, or vice
versa) never activates hosted judging, and that neither tier's full-content flag
can affect the other tier's behavior.

## What this doc does NOT decide

- **Whether to build any of it further.** Same posture as the team-tier doc:
  revisit on real signal, not speculative value. The structural tiers are
  built and usable now; going further (real full-content judging, wiring into
  the CLI/dashboard) waits on real signal.
- **How `efficiencyMultiplier` composes with the existing Manski interval
  bounds mathematically** beyond feeding `LiftDiscounts.efficiency` the same
  way §7.2's algorithmic signal does — whoever wires `judgeSession`'s output
  into `boundedLift` should read §7.2's "why a fourth point-multiplier, not a
  separate interval-narrowing mechanic" reasoning first.
- ~~**Real transcript-capture and full-content judging.**~~ BUILT 2026-07-16
  (Claude Code) and 2026-07-18 (opencode + Codex) without a capture decision:
  ephemeral read-at-judge-time from each tool's own on-disk log.
- **A dashboard trigger / automatic invocation from `fiscus lift`.** The
  `fiscus judge` subcommand exists (it judges real sessions looked up from the
  store; `--session <id>` to pick one), but nothing invokes judging
  automatically. Still an open question, not decided here.

## Revisit condition

Same as the team-tier doc: revisit only when there's a real signal to build this for,
not because the design exists. This document exists so that *if* that signal shows
up, the design work — especially the privacy/trust-ladder shape in §4, which is the
part most likely to be gotten wrong under time pressure — doesn't start from zero.
