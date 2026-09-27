# The Realization Standard

> A unit of account for AI-assisted work. The thing tokens-per-developer never
> was, and "surviving lines" only pretended to be.

This document defines the measure Segreant exists to establish. It is the
product's reason to be trusted over a cost dashboard. Read it before changing
anything in `src/value/`.

---

## 1. The problem this fixes

AI coding spend is a **cost entry with no matching value entry.** Every team can
see the bill. Nobody can see what the bill *bought*. The two measures in the
wild both fail:

- **Tokens / spend** measures *consumption* — coal burned, not goods produced.
  It is what "token-maxxing" optimizes. Maximizing it is the disease.
- **Surviving lines ÷ cost** (our own first attempt) measures a *proxy of the
  artifact*. It is lines-of-code with a price tag: it rewards the author who
  keeps 100 lines over the one who solved it in 10, it ignores correctness, and
  it is two existing tools stapled together. Integration, not invention.

Neither answers the only question that matters: **did the spend turn into
verified, shipped, durable, correct work — and how directly?**

**Money is not the measure of production.** It is the *resource* axis — it
matters to whoever pays the bill, so the Standard reports it. But production is
*realized outcome*, and outcome is dollar-free. The Standard puts outcome first
and treats cost as a lens laid over it.

---

## 2. The unit of work

The atom is the **commit** — the smallest thing git makes objectively
verifiable. Commits group into **tasks** (a session's worth) and **periods**
(a sprint). Everything below is computed per commit and aggregated up.

---

## 3. The funnel — eight gates

A unit of work travels down a ladder of gates. Each gate is an **objective,
observable check**, and each is sourced from data Segreant can actually see:

| # | Gate | Proves | Source |
|---|------|--------|--------|
| 1 | **Proposed** | AI originated this work (a captured proposal touches these files) | proxy |
| 2 | **Accepted** | a human kept the AI output without heavy rewriting (edit-distance) | proxy |
| 3 | **Committed** | it entered version control | git |
| 4 | **Tested** | the test suite passed on it | signal |
| 5 | **Merged** | it passed review into the mainline | signal |
| 6 | **Shipped** | it reached production | signal |
| 7 | **Survived** | still in the codebase after the maturity window | git |
| 8 | **Clean** | never reverted, no linked incident | git |

Every gate returns one of three verdicts: **pass**, **fail**, or **unknown**.
`unknown` is first-class and load-bearing — see §5.

A unit is **realized** when it reaches the end of the ladder with no `fail`, and
the two durability gates (Survived, Clean) are confirmed `pass` (not merely
un-failed). Realization is the terminal state the whole product is built to
measure.

---

## 4. The signal nobody else has: Accepted (edit-distance)

Gates 3–8 can be reconstructed by anyone with git + CI hooks. Gates **1–2 can
only be measured from inside the request path**, which is exactly where
Segreant sits. This is the moat.

The proxy sees the agent's *proposed* edits (tool-call payloads in the response
body). Git sees what was *actually committed*. The overlap between them —
`acceptance = proposed lines that shipped ÷ proposed lines` — measures the
**quality of the human-AI collaboration loop directly**:

- AI proposes 40 lines, human commits them ~unchanged, it ships and survives →
  high-quality AI output.
- AI proposes 40 lines, human rewrites 35 before commit → the raw output was
  junk, *even if the final code survives*.

Survival can't tell these apart. Acceptance can. It is the first measure of "are
you using the AI efficiently" that is about the *interaction*, not the artifact —
and it is available in near-real-time, before survival has had weeks to mature.

`src/value/proposals.ts` extracts proposals across client shapes (Anthropic text
editor + Claude-Code Write/Edit tools, OpenAI function calls, fenced-code
fallback) and computes acceptance.

---

## 5. Honesty: `unknown` is not `fail`

A team that has wired only git gets verdicts on Committed / Survived / Clean and
`unknown` on Tested / Merged / Shipped. The Standard **never fabricates a gate it
can't observe.** Consequences:

- The **realization score** of a unit is `passes ÷ instrumented` where
  `instrumented = passes + fails` — *of the checks we could actually make, how
  many passed.* Uninstrumented gates don't inflate or deflate it. It is a
  **progress statistic, not a realization probability**: a unit with four early
  passes and four unknown gates scores 100% *of what was observed* while its
  realization is genuinely undetermined. Two companion quantities keep that
  honest at the aggregate level (`src/value/gates.ts`):
  - **Realization bounds** — the share *confirmed realized* up to the share
    *not observed dead*. The truth is provably inside this interval; its width
    is exactly the unmeasured region, and wiring more gates narrows it.
  - **Serial realization** `S_G = Π q_g` — realization as an ordered survival
    chain: each `q_g` is the pass rate at gate *g* among units still alive
    entering it, and the product prices the fact that realized work must
    survive *every* stage in sequence, not an unordered checklist. Gates with
    no observations among alive units are skipped **and named** — never
    silently assumed passed.
- Every report shows **instrumentation coverage**: "5 of 8 gates wired." The
  path to a higher-trust number is to wire more gates, not to game one.
- Maturing commits (younger than the window) get `unknown` on Survived and
  Clean, so they can never be counted as realized. We don't call this-morning's
  code durable.

This is what makes it "all-inclusive" without being dishonest: the **model**
covers the entire lifecycle; the **engine** fills in what it observes; the
**gaps are explicit and pluggable** (`segreant report` ingests test / merge /
ship / incident signals).

---

## 6. The three headline numbers

1. **Realization Rate** *(production, dollar-free)* — share of matured units that
   reached realized. The answer to "are we turning AI work into real outcomes?"
2. **Realized Value Rate** *(the money lens)* — share of *spend* that reached
   realized. Cost matched to outcome — the AI P&L. For the buyer.
3. **First-Pass Acceptance** *(collaboration)* — mean edit-distance acceptance.
   The answer to "how well are we working *with* the AI?", available immediately.

Plus the **waste-by-stage P&L**: for spend that did *not* realize, where in the
funnel did it die (rewritten? reverted? never shipped?). This is the actionable
part — it points at the specific leak.

---

## 7. The receipt — why this becomes a standard

A metric you compute privately is a dashboard. A **standard** is something others
can verify. Each realized (or failed) unit emits a **Value Receipt**: a
canonical, ed25519-signed record of `cost → gate verdicts → outcome`, with
content hashes.

Verification has two layers, and conflating them is how "verifiable" usually
lies:

- **Integrity** — the body wasn't altered after signing and the signature is
  valid. This holds from the receipt alone. But on its own it proves nothing
  about *who* signed: anyone can generate a keypair, sign fabricated claims, and
  embed their own public key. A self-consistent forgery passes an integrity-only
  check. (The verifier also recomputes the key fingerprint from the embedded key,
  so a forger can't even lie about which `keyId` signed it.)
- **Authenticity** — the receipt was signed by the party you expect. This
  requires a trust anchor obtained **out of band**: the publisher prints their
  identity once (`segreant receipt --pubkey` → a `keyId`), shares it, and the
  verifier pins it (`segreant receipt --verify <file> --key-id <id>`). Any
  receipt signed by a different key is rejected, and the verify command exits
  non-zero so CI and auditors can gate on it.

That is the difference between "our internal number" and "a unit of account":
receipts are portable and auditable, so a buyer, an auditor, or another tool can
trust the claim without trusting us — *and* without taking our word for who
signed it. `src/value/receipt.ts`.

---

## 8. What it deliberately is not

- **Not a per-developer leaderboard tied to comp.** It's a coaching and
  accounting instrument. (Gaming is a non-concern by design intent — the metric
  is about realized production; optimizing realized production *is the goal*.)
- **Not a quality grade of the code's internals.** It measures whether work got
  realized, not whether it is elegant. Complexity-delta is a future gate.
- **Not retrospective-only.** Acceptance and the early gates give same-session
  feedback; survival/clean mature over the window.

---

## 9. The self-reported ladder for work without a Git artifact

Chat answers, images, drafts and other outputs have a different unit of work:
one named result, identified by an operator-supplied outcome ID. They do not
inherit the coding gates. Their evidence is the person's own verdict and later
actions, retained as timestamped signals with `source: operator`. The
`non-coding-self-reported-v1` outcome adapter evaluates those signals through
the same `WorkUnit` and `OutcomeContract` machinery as the coding adapter.

| Stage | Pass | Fail | Unknown |
|---|---|---|---|
| Produced | A result record exists | Not representable by a result record | No result record |
| Reviewed | A rating or decision was reported | Not inferred from a low rating | Neither reported |
| Accepted | Accepted as-is or edited before use | Explicitly rejected | No decision |
| Used | Explicitly exported, copied, shipped or published | Explicitly marked not used | No use report |
| Still in use | Explicit later yes | Explicit later no | No durability report |

A 1–5 rating and its optional short note describe the person's assessment; a
rating never silently turns into acceptance. Regeneration and the number of
attempts until acceptance describe rework, and neither silently passes a stage.
The latest report of a mutable stage is the current verdict; every earlier
signal remains in the append-only ledger with its original source and time.
Unknown is never counted as fail or pass. A reported use does not establish
business impact, and “still in use” does not establish independent durability.

Each result carries exactly one spend link: a recorded request ID, a recorded
session ID, or a time window of at most 24 hours plus a tool/source name. The
last form is labelled **inferred** at every output. A recorded ID is still
operator-supplied association, not provider attestation. Unmatched links have
unknown attributed cost; they cannot make cost per accepted or used result
look artificially cheap. When several results claim one metered request, its
cost is divided equally among them, conserving that request's spend. A result
whose linked requests span models is reported under `mixed`; a result with no
matched request is `unlinked`. The cost-per-result denominator counts all
results in the cell's matched work population, including rejected attempts:

```
cost per accepted = attributed metered cost of all results / number explicitly accepted
cost per used     = attributed metered cost of all results / number explicitly used
```

These quotients are withheld when any result in the cell lacks matched spend or
the denominator is zero. Every cell carries the **self-reported** basis. Coding
git outcomes retain their separate git-verified basis; no combined “value”
number is formed from the two. The price is metered/list-price evidence, not a
provider bill; the verdict is a self-report, not an independent audit or a
causal estimate of benefit. The operator can preview `segreant outcome record`
without writing and append only with `--apply`. The local dashboard uses the
same preview/apply function behind its guarded POST route.
